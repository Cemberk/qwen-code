/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { isDeepStrictEqual } from 'node:util';
import { planLocalModel } from '../engine.js';
import type { StartEngine } from '../local-model-server.js';
import { EngineHost, type PoolLease, type PoolRequest } from './engine-host.js';

/** Engines the pool runs side by side at most, memory permitting. */
export const POOL_MAX_ENGINES = 3;

/** What decides whether an engine may start beside the running ones. */
export type FitsBeside = (
  request: PoolRequest,
  running: readonly PoolRequest[],
) => boolean;

/** What an engine for `request` must match to serve it. */
function setupOf(request: PoolRequest) {
  return {
    model: request.model,
    options: request.options,
    promptCacheDir: request.promptCacheDir,
  };
}

/**
 * Whether the model fits in GPU memory beside the engines already running,
 * from the planner. On a GPU that shares system memory the planner measures
 * what other programs hold, our engines included, so its verdict stands as
 * is; elsewhere the running engines' sizes are subtracted.
 */
export const plannerFitsBeside: FitsBeside = (request, running) => {
  try {
    const planned = planLocalModel(request.model, request.options);
    if ('problem' in planned.fit) return false;
    const gpu = planned.gpu;
    // No GPU: models run from RAM, which the planner checked for this one.
    if (!gpu) return running.length === 0;
    if (gpu.othersBytes !== undefined) return !planned.fit.partial;
    let used = 0;
    for (const other of running) {
      const plan = planLocalModel(other.model, other.options);
      used += plan.bytes + plan.headroomBytes;
    }
    return planned.bytes + planned.headroomBytes + used <= gpu.limit;
  } catch {
    return false;
  }
};

interface Pending {
  request: PoolRequest;
  signal?: AbortSignal;
  resolve: (lease: PoolLease) => void;
  reject: (error: unknown) => void;
}

/**
 * The pool's engines: one EngineHost per model setup. A request for a model
 * no engine serves starts one beside the others if it fits; otherwise the
 * engine idle the longest stops first, and when none is idle the request
 * waits for one to be.
 */
export class HostPool {
  private readonly hosts: Array<{ request: PoolRequest; host: EngineHost }> =
    [];
  private readonly pending: Pending[] = [];

  constructor(
    private readonly startEngine: StartEngine,
    readonly engineKey: string,
    private readonly fitsBeside: FitsBeside = plannerFitsBeside,
    private readonly maxEngines = POOL_MAX_ENGINES,
  ) {}

  acquire(request: PoolRequest, signal?: AbortSignal): Promise<PoolLease> {
    signal?.throwIfAborted();
    const existing = this.hostFor(request);
    if (existing) return existing.acquire(request, signal);
    return new Promise<PoolLease>((resolve, reject) => {
      const pending: Pending = { request, resolve, reject };
      if (signal) {
        pending.signal = signal;
        signal.addEventListener(
          'abort',
          () => {
            const index = this.pending.indexOf(pending);
            if (index !== -1) {
              this.pending.splice(index, 1);
              reject(signal.reason);
            }
          },
          { once: true },
        );
      }
      this.pending.push(pending);
      void this.place();
    });
  }

  release(id: string, saveState = false): void {
    for (const { host } of this.hosts) {
      if (host.lease(id)) {
        host.release(id, saveState);
        break;
      }
    }
    void this.place();
  }

  lease(id: string): PoolLease | undefined {
    for (const { host } of this.hosts) {
      const lease = host.lease(id);
      if (lease) return lease;
    }
    return undefined;
  }

  forgetClient(client: string): void {
    for (const { host } of this.hosts) host.forgetClient(client);
    for (const pending of [...this.pending]) {
      if (pending.request.client === client) {
        this.pending.splice(this.pending.indexOf(pending), 1);
        pending.reject(new Error('The client went away.'));
      }
    }
    void this.place();
  }

  status() {
    return this.hosts.map(({ host }) => host.status());
  }

  async stop(): Promise<void> {
    for (const pending of this.pending.splice(0)) {
      pending.reject(new Error('The local model pool is stopping.'));
    }
    const hosts = this.hosts.splice(0);
    await Promise.all(hosts.map(({ host }) => host.stop()));
  }

  private hostFor(request: PoolRequest): EngineHost | undefined {
    const setup = setupOf(request);
    return this.hosts.find((entry) =>
      isDeepStrictEqual(setupOf(entry.request), setup),
    )?.host;
  }

  private placing = false;

  /** Give each waiting request an engine: start one, after stopping idle ones. */
  private async place(): Promise<void> {
    if (this.placing) return;
    this.placing = true;
    try {
      while (this.pending.length > 0) {
        const next = this.pending[0];
        const existing = this.hostFor(next.request);
        if (existing) {
          this.pending.shift();
          existing
            .acquire(next.request, next.signal)
            .then(next.resolve, next.reject);
          continue;
        }
        // Engines that stopped (crashed) free their place.
        for (const entry of [...this.hosts]) {
          if (
            !entry.host.running &&
            entry.host.activeLeases === 0 &&
            entry.host.waiting === 0
          ) {
            this.hosts.splice(this.hosts.indexOf(entry), 1);
            await entry.host.stop();
          }
        }
        const fits = () =>
          this.hosts.length < this.maxEngines &&
          (this.hosts.length === 0 ||
            this.fitsBeside(
              next.request,
              this.hosts.map((entry) => entry.request),
            ));
        while (!fits()) {
          const idle = this.hosts
            .filter(({ host }) => host.activeLeases === 0 && host.waiting === 0)
            .sort((a, b) => a.host.lastUsed - b.host.lastUsed)[0];
          if (!idle) return; // wait for a request to end
          this.hosts.splice(this.hosts.indexOf(idle), 1);
          await idle.host.stop();
        }
        this.pending.shift();
        const host = new EngineHost(this.startEngine, this.engineKey);
        const entry = { request: next.request, host };
        this.hosts.push(entry);
        host.acquire(next.request, next.signal).then(next.resolve, (error) => {
          // An engine that failed to start gives its place back.
          const index = this.hosts.indexOf(entry);
          if (index !== -1 && host.activeLeases === 0) {
            this.hosts.splice(index, 1);
            void host.stop();
          }
          next.reject(error);
        });
      }
    } finally {
      this.placing = false;
    }
  }
}
