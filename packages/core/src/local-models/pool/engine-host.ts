/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { randomBytes } from 'node:crypto';
import { statSync } from 'node:fs';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import type { LocalModelConfig } from '../local-models.js';
import type { LocalModelEngine, LocalModelEngineOptions } from '../engine.js';
import { planLocalModel } from '../engine.js';
import { contextsThatFit } from '../gpu-memory.js';
import { DEFAULT_LOCAL_MODEL_CONTEXT_SIZE } from '../local-models.js';
import type { StartEngine } from '../local-model-server.js';
import {
  ensurePromptCacheDir,
  pickPromptState,
  promptStateFile,
  prunePromptStates,
  sharedPromptStateFile,
} from '../prompt-cache.js';
import { SlotTable } from './slots.js';

/** What a client asks the pool for. */
export interface PoolRequest {
  /** The client (one qwen process) asking. */
  client: string;
  model: LocalModelConfig;
  options: LocalModelEngineOptions;
  /** Prompt cache folder; none turns saving prompts off. */
  promptCacheDir?: string;
  /** The project and session the request belongs to, for saved prompts. */
  context?: { project: string; session: string };
  /** A conversation turn, or a side query (memory, summary, subagent). */
  kind: 'main' | 'side';
}

/** A request's right to use the engine, in one slot. */
export interface PoolLease {
  readonly id: string;
  readonly client: string;
  readonly engine: LocalModelEngine;
  readonly slot: number;
  readonly kind: 'main' | 'side';
  /** The conversation the slot belongs to (main turns). */
  readonly conversation?: string;
  readonly context?: { project: string; session: string };
}

interface Waiter {
  request: PoolRequest;
  resolve: (lease: PoolLease) => void;
  reject: (error: unknown) => void;
}

/** How the engine was started: a different one means a restart. */
interface EngineSetup {
  model: LocalModelConfig;
  options: LocalModelEngineOptions;
  promptCacheDir?: string;
}

/** Slots of a pool engine: conversations side by side, plus side queries. */
export const POOL_CONVERSATION_SLOTS = 3;
export const POOL_SIDE_SLOTS = 1;

/** A shared prefix older than this is saved again from a fresh session. */
const SHARED_PREFIX_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

/** Decides how many full contexts an engine's shared cache holds. */
export type ContextsFor = (request: PoolRequest, most: number) => number;

/**
 * As many full contexts as fit in GPU memory beside the model, from the
 * planner: Qwen3.6 35B A3B (640 MiB per 32K context) gets several on a 16 GB
 * GPU, Qwen3 4B (4.5 GiB) one.
 */
export const plannerContextsFor: ContextsFor = (request, most) => {
  try {
    const planned = planLocalModel(request.model, request.options);
    const perToken = planned.capabilities?.contextBytesPerToken;
    const contextBytes = perToken
      ? perToken *
        (request.model.contextSize ?? DEFAULT_LOCAL_MODEL_CONTEXT_SIZE)
      : undefined;
    return 'problem' in planned.fit || planned.fit.partial
      ? 1
      : contextsThatFit(
          planned.gpu?.limit,
          planned.bytes,
          planned.headroomBytes,
          contextBytes,
          most,
        );
  } catch {
    return 1;
  }
};

const conversationKey = (request: PoolRequest) =>
  `${request.client}\0${request.context?.session ?? ''}`;

/**
 * Runs the pool's engine and hands out leases to the requests of every
 * client. One model at a time: a lease for another model (or other engine
 * options) waits until no request runs, then the engine restarts.
 *
 * Each conversation keeps a slot of its own between turns, so several
 * agents on one machine share one copy of the model, batched together by
 * the engine. A conversation's prompt is saved at the end of each turn and
 * restored when it gets a slot back (after another conversation took it, or
 * an engine restart), as the in-process server did for its one slot.
 */
export class EngineHost {
  private engine?: LocalModelEngine;
  private setup?: EngineSetup;
  private slots?: SlotTable;
  private readonly leases = new Map<string, PoolLease>();
  private readonly queue: Waiter[] = [];
  private pumping = false;
  /** Saves and restores run one at a time, before the next grant. */
  private ops: Promise<void> = Promise.resolve();
  /** Slots whose conversation had no saved state: their first save is also the shared prefix. */
  private readonly freshSlots = new Set<number>();
  /** The project and session of each conversation holding a slot. */
  private readonly contexts = new Map<
    string,
    { project: string; session: string }
  >();
  /** When the engine last served a request, for unloading idle engines. */
  lastUsed = Date.now();

  constructor(
    private readonly startEngine: StartEngine,
    /** The key the pool's engines accept; only the daemon holds it. */
    readonly engineKey: string,
    private readonly contextsFor: ContextsFor = plannerContextsFor,
  ) {}

  /** Wait for a lease on an engine serving `request.model`. */
  acquire(request: PoolRequest, signal?: AbortSignal): Promise<PoolLease> {
    signal?.throwIfAborted();
    return new Promise<PoolLease>((resolve, reject) => {
      const waiter: Waiter = { request, resolve, reject };
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

  /**
   * End a lease. `saveState` marks the end of a conversation turn: its
   * prompt is saved before its slot serves anything else.
   */
  release(id: string, saveState = false): void {
    const lease = this.leases.get(id);
    if (!lease) return;
    this.leases.delete(id);
    this.lastUsed = Date.now();
    this.slots?.end(lease.slot);
    if (saveState && lease.kind === 'main' && lease.engine === this.engine) {
      this.queueOp(() => this.save(lease));
    }
    void this.pump();
  }

  /** A client went away: end its leases and free its conversations' slots. */
  forgetClient(client: string): void {
    for (const lease of [...this.leases.values()]) {
      if (lease.client === client) this.release(lease.id);
    }
    for (const entry of this.slots?.conversations() ?? []) {
      if (entry.conversation.startsWith(`${client}\0`)) {
        this.slots?.forget(entry.conversation);
        this.contexts.delete(entry.conversation);
      }
    }
    // A waiter of that client would get a lease nobody uses.
    for (const waiter of [...this.queue]) {
      if (waiter.request.client === client) {
        this.queue.splice(this.queue.indexOf(waiter), 1);
        waiter.reject(new Error('The client went away.'));
      }
    }
  }

  lease(id: string): PoolLease | undefined {
    return this.leases.get(id);
  }

  get running(): boolean {
    return this.engine?.alive === true;
  }

  get activeLeases(): number {
    return this.leases.size;
  }

  get waiting(): number {
    return this.queue.length;
  }

  status() {
    return {
      model: this.engine?.alive ? this.engine.model.id : undefined,
      leases: this.leases.size,
      waiting: this.queue.length,
      conversations: this.slots?.conversations().length ?? 0,
    };
  }

  /** Stop the engine; leases fail, waiters are rejected. */
  async stop(): Promise<void> {
    for (const waiter of this.queue.splice(0)) {
      waiter.reject(new Error('The local model pool is stopping.'));
    }
    this.leases.clear();
    const engine = this.engine;
    this.engine = undefined;
    this.slots = undefined;
    await this.ops.catch(() => {});
    await engine?.stop();
  }

  private queueOp(op: () => Promise<void>): void {
    this.ops = this.ops.then(op, op).catch(() => {});
  }

  private async pump(): Promise<void> {
    if (this.pumping) return;
    this.pumping = true;
    try {
      for (;;) {
        // Saves first: a slot is handed out only with its prompt saved.
        await this.ops;
        const head = this.queue[0];
        if (!head) break;
        const setup = setupOf(head.request);
        if (this.engine?.alive && isDeepStrictEqual(this.setup, setup)) {
          if (!this.slots!.canRun) break; // the shared cache is full
          const granted = this.grant(head.request);
          if (!granted) break; // every conversation slot runs a request
          this.queue.shift();
          const { lease } = granted;
          // The conversation that gave the slot up may be mid-turn: keep
          // what it has read so far.
          if (granted.evicted) {
            const context = this.contexts.get(granted.evicted);
            this.contexts.delete(granted.evicted);
            if (context) {
              await this.saveSlot(lease.engine, lease.slot, context).catch(
                () => {},
              );
            }
          }
          if (lease.conversation && lease.context) {
            this.contexts.set(lease.conversation, lease.context);
          }
          if (granted.restore) {
            await this.restore(lease).catch(() => {});
          }
          head.resolve(lease);
          continue;
        }
        // Restarting would cut off requests still running.
        if (this.leases.size > 0) break;
        const previous = this.engine;
        this.engine = undefined;
        this.slots = undefined;
        this.freshSlots.clear();
        this.contexts.clear();
        try {
          await previous?.stop();
          if (setup.promptCacheDir) {
            try {
              ensurePromptCacheDir(setup.promptCacheDir);
            } catch {
              setup.promptCacheDir = undefined;
            }
          }
          const slots = new SlotTable(POOL_CONVERSATION_SLOTS, POOL_SIDE_SLOTS);
          // The slots share one cache: run at most as many requests at once
          // as it holds full contexts, so none runs out of room.
          const contexts = this.contextsFor(head.request, slots.size);
          slots.maxRunning = contexts;
          this.engine = await this.startEngine(
            setup.model,
            this.engineKey,
            { ...setup.options, slots: slots.size, contexts },
            setup.promptCacheDir,
          );
          this.setup = setupOf(head.request);
          this.slots = slots;
        } catch (error) {
          const index = this.queue.indexOf(head);
          if (index !== -1) this.queue.splice(index, 1);
          head.reject(error);
        }
      }
    } finally {
      this.pumping = false;
    }
  }

  /** A lease in the right slot, or undefined when the request must wait. */
  private grant(
    request: PoolRequest,
  ): { lease: PoolLease; restore: boolean; evicted?: string } | undefined {
    const engine = this.engine!;
    const slots = this.slots!;
    let slot: number;
    let restore = false;
    let evicted: string | undefined;
    let conversation: string | undefined;
    if (request.kind === 'main') {
      conversation = conversationKey(request);
      const granted = slots.conversation(conversation);
      if (!granted) return undefined;
      slot = granted.slot;
      restore = granted.restore;
      evicted = granted.evicted;
    } else {
      slot = slots.side();
    }
    slots.begin(slot);
    this.lastUsed = Date.now();
    const lease: PoolLease = {
      id: randomBytes(12).toString('hex'),
      client: request.client,
      engine,
      slot,
      kind: request.kind,
      ...(conversation ? { conversation } : {}),
      ...(request.context ? { context: request.context } : {}),
    };
    this.leases.set(lease.id, lease);
    return { lease, restore, ...(evicted ? { evicted } : {}) };
  }

  /** Load the conversation's saved prompt into its new slot. */
  private async restore(lease: PoolLease): Promise<void> {
    const directory = this.setup?.promptCacheDir;
    const context = lease.context;
    this.freshSlots.delete(lease.slot);
    if (!directory || !context) return;
    const file = pickPromptState(
      directory,
      context.project,
      lease.engine.stateKey,
      context.session,
    );
    const shared = sharedPromptStateFile(lease.engine.stateKey);
    // The first turn of a session that started from nothing becomes the
    // shared prefix; so does one that started from a shared prefix older
    // than a week, which a newer qwen's system prompt may have outdated.
    let fresh = file === undefined;
    if (file === shared) {
      try {
        fresh =
          Date.now() - statSync(path.join(directory, shared)).mtimeMs >
          SHARED_PREFIX_MAX_AGE_MS;
      } catch {
        fresh = true;
      }
    }
    if (fresh) this.freshSlots.add(lease.slot);
    if (file) await lease.engine.slot('restore', file, lease.slot);
  }

  /** Save the conversation's prompt at the end of its turn. */
  private async save(lease: PoolLease): Promise<void> {
    const directory = this.setup?.promptCacheDir;
    const context = lease.context;
    if (!directory || !context || !lease.engine.alive) return;
    // The slot may have gone to another conversation meanwhile: then this
    // one's prompt is no longer there to save.
    if (
      lease.conversation === undefined ||
      this.slots?.slotOf(lease.conversation) !== lease.slot
    ) {
      return;
    }
    await this.saveSlot(lease.engine, lease.slot, context);
  }

  private async saveSlot(
    engine: LocalModelEngine,
    slot: number,
    context: { project: string; session: string },
  ): Promise<void> {
    const directory = this.setup?.promptCacheDir;
    if (!directory || !engine.alive) return;
    if (this.freshSlots.delete(slot)) {
      await engine.slot('save', sharedPromptStateFile(engine.stateKey), slot);
    }
    const file = promptStateFile(
      context.project,
      engine.stateKey,
      context.session,
    );
    if (await engine.slot('save', file, slot)) {
      try {
        prunePromptStates(directory);
      } catch {
        // Best effort; the next save tries again.
      }
    }
  }
}

function setupOf(request: PoolRequest): EngineSetup {
  return {
    model: request.model,
    options: request.options,
    ...(request.promptCacheDir
      ? { promptCacheDir: request.promptCacheDir }
      : {}),
  };
}
