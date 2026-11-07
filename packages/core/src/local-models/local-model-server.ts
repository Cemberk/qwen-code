/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { randomBytes } from 'node:crypto';
import { mkdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import type { LocalModelConfig } from './local-models.js';
import {
  DEFAULT_ENGINE_OPTIONS,
  startLocalModelEngine,
  type LocalModelEngine,
  type LocalModelEngineOptions,
} from './engine.js';
import {
  ensurePromptCacheDir,
  moeProfileFile,
  pickPromptState,
  promptStateFile,
  sharedPromptStateFile,
  prunePromptStates,
} from './prompt-cache.js';
import { wantsMoeProfile } from './planner.js';

/** Permission to send requests to the engine while it serves the leased model. */
export interface LocalModelLease {
  /** The engine's OpenAI-compatible `/v1` root. */
  readonly baseUrl: string;
  /** The Unix socket that reaches `baseUrl`, when the engine listens on one. */
  readonly socketPath?: string;
  readonly apiKey: string;
  /**
   * The engine has a prompt cache: conversation turns must run in
   * CONVERSATION_SLOT and side queries in SIDE_QUERY_SLOT.
   */
  readonly pinSlots: boolean;
  /**
   * Idempotent. `saveState` marks the end of a conversation turn: the
   * engine's prompt is saved before the next request runs.
   */
  release(options?: { saveState?: boolean }): void;
  /** Headers every request under this lease carries (the pool's lease id). */
  readonly headers?: Readonly<Record<string, string>>;
}

/** A conversation turn, or a side query (memory, summary, subagent). */
export type LeaseKind = 'main' | 'side';

/**
 * Runs local models for this process: in the process itself
 * (LocalModelServer), or through the machine's shared pool daemon
 * (PoolClient).
 */
export interface LocalModelHost {
  setModels(models: readonly LocalModelConfig[]): void;
  setSpeculation(enabled: boolean): void;
  isSpeculationEnabled(): boolean;
  setEnginePath(enginePath: string | undefined): void;
  getEnginePath(): string | undefined;
  setEngineArgs(args: readonly string[] | undefined): void;
  getEngineOptions(): LocalModelEngineOptions;
  setPromptCache(cache: PromptCacheConfig | undefined): void;
  acquire(
    modelId: string,
    signal?: AbortSignal,
    kind?: LeaseKind,
  ): Promise<LocalModelLease>;
  stop(): Promise<void>;
}

/** Where saved prompt states go, and which project and session is running. */
export interface PromptCacheConfig {
  directory: string;
  context: () => { project: string; session: string } | undefined;
}

interface Waiter {
  model: LocalModelConfig;
  resolve: (lease: LocalModelLease) => void;
  reject: (error: unknown) => void;
}

export type StartEngine = (
  model: LocalModelConfig,
  apiKey: string,
  options: LocalModelEngineOptions,
  promptCacheDir?: string,
  moeProfile?: string,
) => Promise<LocalModelEngine>;

/**
 * Runs one engine for this process and loads the model each request needs.
 * Requests take leases in order. A lease for the loaded model is granted at
 * once; a lease for another model waits until the outstanding leases are
 * released, then the engine restarts with that model. The same happens when
 * the engine options changed. An engine that exited is restarted by the next
 * lease.
 *
 * With a prompt cache, a started engine first restores the session's saved
 * prompt (or the project's latest one), and the prompt is saved again at the
 * end of each conversation turn, before any other request runs.
 */
export class LocalModelServer implements LocalModelHost {
  /** Engines started by this server accept only this key. */
  readonly apiKey = randomBytes(24).toString('hex');
  private models: readonly LocalModelConfig[] = [];
  private options: LocalModelEngineOptions = DEFAULT_ENGINE_OPTIONS;
  private engine?: LocalModelEngine;
  /** The options the running engine started with. */
  private engineOptions?: LocalModelEngineOptions;
  private active = 0;
  private readonly queue: Waiter[] = [];
  private pumping = false;
  private promptCache?: PromptCacheConfig;
  private saveRequested = false;
  /** The running engine was started with a prompt cache folder. */
  private engineCaches = false;
  /** The running engine serves a session that had no saved state. */
  private freshSession = false;

  constructor(
    private readonly startEngine: StartEngine = startLocalModelEngine,
  ) {}

  setModels(models: readonly LocalModelConfig[]): void {
    this.models = models;
  }

  /**
   * Turn n-gram speculative decoding on or off. A running engine started
   * with the other setting restarts at the next request, once the requests
   * in flight finish.
   */
  setSpeculation(enabled: boolean): void {
    this.options = { ...this.options, speculation: enabled };
  }

  isSpeculationEnabled(): boolean {
    return this.options.speculation;
  }

  /**
   * The llama-server to run (`localModelEngine`); `undefined` uses the one on
   * PATH. A running engine started with another one restarts at the next
   * request, once the requests in flight finish.
   */
  setEnginePath(enginePath: string | undefined): void {
    const { enginePath: _previous, ...rest } = this.options;
    this.options = enginePath ? { ...rest, enginePath } : rest;
  }

  getEnginePath(): string | undefined {
    return this.options.enginePath;
  }

  /**
   * The user's own llama-server options (`localModelEngineArgs`), already
   * validated. A running engine started with others restarts at the next
   * request, once the requests in flight finish.
   */
  setEngineArgs(args: readonly string[] | undefined): void {
    const { extraArgs: _previous, ...rest } = this.options;
    this.options =
      args && args.length > 0 ? { ...rest, extraArgs: [...args] } : rest;
  }

  getEngineOptions(): LocalModelEngineOptions {
    return this.options;
  }

  /**
   * Save and restore the engine's processed prompt per session. Applies to
   * engines started from now on; `undefined` turns it off.
   */
  setPromptCache(cache: PromptCacheConfig | undefined): void {
    this.promptCache = cache;
  }

  /**
   * Wait until the engine serves `modelId`.
   *
   * @throws Error when `modelId` is not a local model, or its engine cannot start.
   */
  acquire(modelId: string, signal?: AbortSignal): Promise<LocalModelLease> {
    const model = this.models.find((candidate) => candidate.id === modelId);
    if (!model) {
      return Promise.reject(
        new Error(`"${modelId}" is not one of the models in localModels.`),
      );
    }
    signal?.throwIfAborted();
    return new Promise<LocalModelLease>((resolve, reject) => {
      const waiter: Waiter = { model, resolve, reject };
      const onAbort = () => {
        const index = this.queue.indexOf(waiter);
        if (index !== -1) {
          this.queue.splice(index, 1);
          reject(signal!.reason);
        }
      };
      signal?.addEventListener('abort', onAbort, { once: true });
      waiter.resolve = (lease) => {
        signal?.removeEventListener('abort', onAbort);
        resolve(lease);
      };
      waiter.reject = (error) => {
        signal?.removeEventListener('abort', onAbort);
        reject(error);
      };
      this.queue.push(waiter);
      void this.pump();
    });
  }

  /** Stop the engine. Outstanding requests fail. */
  async stop(): Promise<void> {
    const engine = this.engine;
    this.engine = undefined;
    await engine?.stop();
  }

  private lease(engine: LocalModelEngine): LocalModelLease {
    this.active++;
    let released = false;
    return {
      baseUrl: engine.baseUrl,
      ...(engine.socketPath ? { socketPath: engine.socketPath } : {}),
      apiKey: this.apiKey,
      pinSlots: this.engineCaches,
      release: (options) => {
        if (released) return;
        released = true;
        this.active--;
        if (options?.saveState && this.engineCaches) this.saveRequested = true;
        void this.pump();
      },
    };
  }

  private async pump(): Promise<void> {
    if (this.pumping) return;
    this.pumping = true;
    try {
      for (;;) {
        // Save the turn's prompt before the slot serves anything else.
        if (this.saveRequested) {
          if (this.active > 0) return;
          this.saveRequested = false;
          await this.savePrompt();
          continue;
        }
        if (this.queue.length === 0) break;
        const head = this.queue[0];
        const engine = this.engine;
        if (
          engine?.alive &&
          isDeepStrictEqual(engine.model, head.model) &&
          isDeepStrictEqual(this.engineOptions, this.options)
        ) {
          this.queue.shift();
          head.resolve(this.lease(engine));
          continue;
        }
        // Restarting would cut off requests still on the running engine.
        if (this.active > 0) return;
        this.engine = undefined;
        try {
          await engine?.stop();
          const options = this.options;
          const directory = this.usablePromptCacheDir();
          const started = await this.startEngine(
            head.model,
            this.apiKey,
            options,
            directory,
            this.moeProfileFor(head.model, options),
          );
          await this.restorePrompt(started);
          this.engine = started;
          this.engineOptions = options;
          this.engineCaches = directory !== undefined;
        } catch (error) {
          // The waiter may have been aborted while the engine started.
          const index = this.queue.indexOf(head);
          if (index !== -1) this.queue.splice(index, 1);
          head.reject(error);
        }
      }
    } finally {
      this.pumping = false;
    }
  }

  /**
   * The project's MoE cache profile for `model`, when the user turned the
   * fork's MoE cache on; its folder is created. None without a prompt cache
   * folder or a project.
   */
  private moeProfileFor(
    model: LocalModelConfig,
    options: LocalModelEngineOptions,
  ): string | undefined {
    const directory = this.promptCache?.directory;
    const project = this.promptCache?.context()?.project;
    if (!directory || !project || !wantsMoeProfile(options.extraArgs)) {
      return undefined;
    }
    const file = moeProfileFile(directory, project, model);
    try {
      mkdirSync(path.dirname(file), { recursive: true });
    } catch {
      return undefined;
    }
    return file;
  }

  /** The prompt cache folder, created if needed; none if it cannot be. */
  private usablePromptCacheDir(): string | undefined {
    const directory = this.promptCache?.directory;
    if (!directory) return undefined;
    try {
      ensurePromptCacheDir(directory);
      return directory;
    } catch {
      return undefined;
    }
  }

  private async restorePrompt(engine: LocalModelEngine): Promise<void> {
    const cache = this.promptCache;
    const context = cache?.context();
    if (!cache || !context) return;
    // A missing, unreadable or stale state only means the prompt is read in
    // full, so nothing here may fail the request.
    try {
      const file = pickPromptState(
        cache.directory,
        context.project,
        engine.stateKey,
        context.session,
      );
      // The first turn of a session that started from nothing becomes the
      // shared prefix; so does one that started from a shared prefix older
      // than a week, which a newer qwen's system prompt may have outdated.
      const shared = sharedPromptStateFile(engine.stateKey);
      this.freshSession =
        file === undefined ||
        (file === shared &&
          Date.now() - statSync(path.join(cache.directory, shared)).mtimeMs >
            SHARED_PREFIX_MAX_AGE_MS);
      if (file) await engine.slot('restore', file);
    } catch {
      // Read the prompt in full.
    }
  }

  private async savePrompt(): Promise<void> {
    const engine = this.engine;
    const cache = this.promptCache;
    const context = cache?.context();
    if (!engine?.alive || !this.engineCaches || !cache || !context) return;
    const file = promptStateFile(
      context.project,
      engine.stateKey,
      context.session,
    );
    // The first turn of a fresh session also becomes the engine's shared
    // prefix, which new projects start from.
    if (this.freshSession) {
      this.freshSession = false;
      await engine.slot('save', sharedPromptStateFile(engine.stateKey));
    }
    if (await engine.slot('save', file)) {
      try {
        prunePromptStates(cache.directory);
      } catch {
        // Pruning is best effort; the next save tries again.
      }
    }
  }
}

/** A shared prefix older than this is saved again from a fresh session. */
const SHARED_PREFIX_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

let server: LocalModelHost | undefined;

/**
 * The process's local model host: the in-process server unless
 * `setLocalModelHost` installed another (the pool client).
 */
export function getLocalModelServer(): LocalModelHost {
  server ??= new LocalModelServer();
  return server;
}

/** Install the process's local model host, before any request uses it. */
export function setLocalModelHost(host: LocalModelHost | undefined): void {
  server = host;
}
