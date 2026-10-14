/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { randomBytes } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import type { LocalModelConfig } from './local-models.js';
import {
  DEFAULT_ENGINE_OPTIONS,
  startLocalModelEngine,
  type LocalModelEngine,
  type LocalModelEngineOptions,
} from './engine.js';

/** Permission to send requests to the engine while it serves the leased model. */
export interface LocalModelLease {
  /** The engine's OpenAI-compatible `/v1` root. */
  readonly baseUrl: string;
  readonly apiKey: string;
  /** Idempotent. */
  release(): void;
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
) => Promise<LocalModelEngine>;

/**
 * Runs one engine for this process and loads the model each request needs.
 * Requests take leases in order. A lease for the loaded model is granted at
 * once; a lease for another model waits until the outstanding leases are
 * released, then the engine restarts with that model. The same happens when
 * the engine options changed. An engine that exited is restarted by the next
 * lease.
 */
export class LocalModelServer {
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
      apiKey: this.apiKey,
      release: () => {
        if (released) return;
        released = true;
        this.active--;
        void this.pump();
      },
    };
  }

  private async pump(): Promise<void> {
    if (this.pumping) return;
    this.pumping = true;
    try {
      while (this.queue.length > 0) {
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
          this.engine = await this.startEngine(
            head.model,
            this.apiKey,
            options,
          );
          this.engineOptions = options;
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
}

let server: LocalModelServer | undefined;

/** The process's local model server. */
export function getLocalModelServer(): LocalModelServer {
  server ??= new LocalModelServer();
  return server;
}
