/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import http from 'node:http';
import type { LocalModelConfig } from '../local-models.js';
import {
  DEFAULT_ENGINE_OPTIONS,
  type LocalModelEngineOptions,
} from '../engine.js';
import type {
  LeaseKind,
  LocalModelHost,
  LocalModelLease,
  PromptCacheConfig,
} from '../local-model-server.js';
import { LEASE_HEADER, poolAnswers } from './daemon.js';
import type { PoolRequest } from './engine-host.js';
import { poolAddress, poolDir, poolKey } from './paths.js';

/** How long a stopping daemon may take to go before a new one is started. */
const POOL_GONE_WAIT_MS = 15_000;

/** How long a newly started daemon may take to listen. */
const DAEMON_START_MS = 15_000;

export interface PoolClientOptions {
  dir?: string;
  address?: string;
  /** Start the daemon, detached; by default `<node> <qwen cli> pool serve`. */
  spawnDaemon?: () => void;
  /** Used when no daemon can be reached or started. */
  fallback: LocalModelHost;
  /** Told once when the pool cannot be used and the fallback runs models. */
  onFallback?: (reason: string) => void;
}

/** Start `qwen pool serve` from this qwen, detached from it. */
export function spawnPoolDaemon(): void {
  const cli = process.argv[1];
  if (!cli) throw new Error('cannot tell where the qwen CLI is');
  const child = spawn(
    process.execPath,
    [
      ...process.execArgv.filter((arg) => !arg.startsWith('--inspect')),
      cli,
      'pool',
      'serve',
    ],
    {
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
    },
  );
  child.unref();
}

/**
 * Runs this process's local models in the machine's pool daemon, which every
 * qwen shares: one engine per model for all of them, each conversation in
 * its own slot. Holds an attach connection for the life of the process, so
 * the daemon knows when this qwen is gone however it ends.
 *
 * When the daemon cannot be reached or started, everything goes to the
 * fallback (the in-process server), as before the pool existed.
 */
export class PoolClient implements LocalModelHost {
  readonly id = randomBytes(8).toString('hex');
  private readonly dir: string;
  private readonly address: string;
  private models: readonly LocalModelConfig[] = [];
  private options: LocalModelEngineOptions = DEFAULT_ENGINE_OPTIONS;
  private promptCache?: PromptCacheConfig;
  private attachment?: Promise<boolean>;
  private attachRequest?: http.ClientRequest;
  private usingFallback = false;
  private stopped = false;

  constructor(private readonly config: PoolClientOptions) {
    this.dir = config.dir ?? poolDir();
    this.address = config.address ?? poolAddress(this.dir);
  }

  setModels(models: readonly LocalModelConfig[]): void {
    this.models = models;
    this.config.fallback.setModels(models);
  }

  setSpeculation(enabled: boolean): void {
    this.options = { ...this.options, speculation: enabled };
    this.config.fallback.setSpeculation(enabled);
  }

  isSpeculationEnabled(): boolean {
    return this.options.speculation;
  }

  setEnginePath(enginePath: string | undefined): void {
    const { enginePath: _previous, ...rest } = this.options;
    this.options = enginePath ? { ...rest, enginePath } : rest;
    this.config.fallback.setEnginePath(enginePath);
  }

  getEnginePath(): string | undefined {
    return this.options.enginePath;
  }

  setEngineArgs(args: readonly string[] | undefined): void {
    const { extraArgs: _previous, ...rest } = this.options;
    this.options =
      args && args.length > 0 ? { ...rest, extraArgs: [...args] } : rest;
    this.config.fallback.setEngineArgs(args);
  }

  getEngineOptions(): LocalModelEngineOptions {
    return this.options;
  }

  setPromptCache(cache: PromptCacheConfig | undefined): void {
    this.promptCache = cache;
    this.config.fallback.setPromptCache(cache);
  }

  async acquire(
    modelId: string,
    signal?: AbortSignal,
    kind: LeaseKind = 'main',
  ): Promise<LocalModelLease> {
    try {
      return await this.acquireOnce(modelId, signal, kind);
    } catch (error) {
      // The pool was stopping (`qwen pool stop`, an update): wait for it to
      // go, then start a new one and ask again, once.
      if (
        !(error instanceof Error) ||
        !/stopping|ECONNRESET|EPIPE/.test(error.message) ||
        signal?.aborted
      ) {
        throw error;
      }
      this.attachRequest?.destroy();
      this.attachRequest = undefined;
      this.attachment = undefined;
      const deadline = Date.now() + POOL_GONE_WAIT_MS;
      while (Date.now() < deadline && (await poolAnswers(this.address))) {
        await new Promise((resolve) => setTimeout(resolve, 250));
      }
      return this.acquireOnce(modelId, signal, kind);
    }
  }

  private async acquireOnce(
    modelId: string,
    signal: AbortSignal | undefined,
    kind: LeaseKind,
  ): Promise<LocalModelLease> {
    const model = this.models.find((candidate) => candidate.id === modelId);
    if (!model) {
      throw new Error(`"${modelId}" is not one of the models in localModels.`);
    }
    signal?.throwIfAborted();
    if (!this.usingFallback && (await this.attach())) {
      const context = this.promptCache?.context();
      const request: PoolRequest = {
        client: this.id,
        model,
        options: this.options,
        ...(this.promptCache
          ? { promptCacheDir: this.promptCache.directory }
          : {}),
        ...(context ? { context } : {}),
        kind,
      };
      const { lease } = (await this.call(
        'POST',
        '/pool/acquire',
        request,
        signal,
      )) as {
        lease: string;
      };
      return this.leaseFor(lease);
    }
    return this.config.fallback.acquire(modelId, signal, kind);
  }

  /** Detach: the daemon frees this client's slots, and stops if it was the last. */
  async stop(): Promise<void> {
    this.stopped = true;
    this.attachRequest?.destroy();
    this.attachRequest = undefined;
    this.attachment = undefined;
    await this.config.fallback.stop();
  }

  private leaseFor(id: string): LocalModelLease {
    let released = false;
    return {
      // The URL only names the API: the pipe or socket carries it.
      baseUrl: 'http://localhost/v1',
      socketPath: this.address,
      apiKey: poolKey(this.dir),
      pinSlots: false,
      headers: { [LEASE_HEADER]: id },
      release: (options) => {
        if (released) return;
        released = true;
        void this.call('POST', '/pool/release', {
          lease: id,
          saveState: options?.saveState === true,
        }).catch(() => {
          // The daemon is gone: its leases went with it.
        });
      },
    };
  }

  /** Attach to the daemon, starting it if needed; false when it cannot be used. */
  private attach(): Promise<boolean> {
    if (this.stopped) return Promise.resolve(false);
    this.attachment ??= this.connect().then(
      (ok) => {
        if (!ok) this.fallBack('the local model pool could not be started');
        return ok;
      },
      (error: unknown) => {
        this.fallBack(error instanceof Error ? error.message : String(error));
        return false;
      },
    );
    return this.attachment;
  }

  private fallBack(reason: string): void {
    if (this.usingFallback) return;
    this.usingFallback = true;
    this.config.onFallback?.(reason);
  }

  private async connect(): Promise<boolean> {
    if (!(await poolAnswers(this.address))) {
      (this.config.spawnDaemon ?? spawnPoolDaemon)();
      const deadline = Date.now() + DAEMON_START_MS;
      while (!(await poolAnswers(this.address))) {
        if (Date.now() > deadline) return false;
        await new Promise((resolve) => setTimeout(resolve, 200));
      }
    }
    return new Promise<boolean>((resolve) => {
      const request = http.get(
        {
          socketPath: this.address,
          path: `/pool/attach?client=${this.id}`,
          headers: { authorization: `Bearer ${poolKey(this.dir)}` },
        },
        (response) => {
          if (response.statusCode !== 200) {
            response.resume();
            resolve(false);
            return;
          }
          // The first line confirms the attach; the rest are heartbeats.
          response.once('data', () => resolve(true));
          response.on('close', () => {
            // The daemon went away (it crashed, or was stopped): attach
            // again, to a new one, at the next request.
            if (this.attachRequest === request) {
              this.attachRequest = undefined;
              this.attachment = undefined;
            }
          });
        },
      );
      request.on('error', () => resolve(false));
      // Never keeps qwen alive by itself.
      request.on('socket', (socket) => socket.unref());
      this.attachRequest = request;
    });
  }

  private call(
    method: 'GET' | 'POST',
    path: string,
    body?: unknown,
    signal?: AbortSignal,
  ): Promise<unknown> {
    const text = body === undefined ? undefined : JSON.stringify(body);
    return new Promise((resolve, reject) => {
      const request = http.request(
        {
          socketPath: this.address,
          path,
          method,
          headers: {
            authorization: `Bearer ${poolKey(this.dir)}`,
            ...(text === undefined
              ? {}
              : {
                  'content-type': 'application/json',
                  'content-length': Buffer.byteLength(text),
                }),
          },
          ...(signal ? { signal } : {}),
        },
        (response) => {
          let data = '';
          response.setEncoding('utf8');
          response.on('data', (chunk: string) => (data += chunk));
          response.on('end', () => {
            let json: { error?: string } = {};
            try {
              json = JSON.parse(data) as { error?: string };
            } catch {
              // Keep the status.
            }
            if (response.statusCode === 200) resolve(json);
            else
              reject(
                new Error(
                  json.error ?? `local model pool: HTTP ${response.statusCode}`,
                ),
              );
          });
        },
      );
      request.on('error', reject);
      request.end(text);
    });
  }
}

/**
 * Copy `model` from a member of this machine's pool into the local Hugging
 * Face cache, through the running pool daemon. Resolves to `done`, or `none`
 * when no member has it (or no daemon runs); rejects with the reason a copy
 * failed. `onProgress` gets the bytes copied so far and the total.
 */
export async function fetchModelFromPool(
  model: LocalModelConfig,
  onProgress: (done: number, total: number, from: string) => void = () => {},
  dir: string = poolDir(),
): Promise<'done' | 'none'> {
  const address = poolAddress(dir);
  if (!(await poolAnswers(address))) return 'none';
  const body = JSON.stringify({ model });
  return new Promise((resolve, reject) => {
    const request = http.request(
      {
        socketPath: address,
        path: '/pool/fetch',
        method: 'POST',
        headers: {
          authorization: `Bearer ${poolKey(dir)}`,
          'content-type': 'application/json',
          'content-length': Buffer.byteLength(body),
        },
      },
      (response) => {
        let pending = '';
        let from = '';
        let outcome: 'done' | 'none' | undefined;
        let failure: string | undefined;
        response.setEncoding('utf8');
        response.on('data', (chunk: string) => {
          pending += chunk;
          const lines = pending.split('\n');
          pending = lines.pop() ?? '';
          for (const line of lines) {
            if (line.startsWith('from ')) from = line.slice(5);
            else if (line.startsWith('progress ')) {
              const [, done, total] = line.split(' ');
              onProgress(Number(done), Number(total), from);
            } else if (line === 'done' || line === 'none') outcome = line;
            else if (line.startsWith('error ')) failure = line.slice(6);
          }
        });
        response.on('end', () => {
          if (failure) reject(new Error(failure));
          else resolve(outcome ?? 'none');
        });
      },
    );
    request.on('error', () => resolve('none'));
    request.end(body);
  });
}
