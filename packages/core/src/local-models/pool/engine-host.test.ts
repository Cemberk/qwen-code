/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { LocalModelEngine, LocalModelEngineOptions } from '../engine.js';
import { DEFAULT_ENGINE_OPTIONS } from '../engine.js';
import type { LocalModelConfig } from '../local-models.js';
import { promptStateFile, sharedPromptStateFile } from '../prompt-cache.js';
import {
  EngineHost,
  POOL_CONVERSATION_SLOTS,
  POOL_SIDE_SLOTS,
  type PoolRequest,
} from './engine-host.js';

const a: LocalModelConfig = { id: 'a', repo: 'o/a', file: 'a.gguf' };
const b: LocalModelConfig = { id: 'b', repo: 'o/b', file: 'b.gguf' };

function fakeEngines() {
  const events: string[] = [];
  const options: LocalModelEngineOptions[] = [];
  const start = async (
    model: LocalModelConfig,
    _apiKey: string,
    engineOptions: LocalModelEngineOptions,
  ): Promise<LocalModelEngine> => {
    events.push(`start ${model.id}`);
    options.push(engineOptions);
    let alive = true;
    return {
      model,
      baseUrl: 'http://127.0.0.1:1/v1',
      stateKey: `key-${model.id}`,
      async slot(action, file, slot) {
        events.push(`${action} ${slot} ${file}`);
        return true;
      },
      get alive() {
        return alive;
      },
      async stop() {
        events.push(`stop ${model.id}`);
        alive = false;
      },
    };
  };
  return { events, options, start };
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 10));

describe('EngineHost', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(path.join(os.tmpdir(), 'engine-host-'));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  const request = (
    client: string,
    session: string,
    kind: 'main' | 'side' = 'main',
    model = a,
  ): PoolRequest => ({
    client,
    model,
    options: DEFAULT_ENGINE_OPTIONS,
    promptCacheDir: dir,
    context: { project: `/p/${client}`, session },
    kind,
  });

  it('serves two clients from one engine, each conversation in its own slot', async () => {
    const fake = fakeEngines();
    const host = new EngineHost(fake.start, 'k', () => 4);
    const [one, two] = await Promise.all([
      host.acquire(request('c1', 's1')),
      host.acquire(request('c2', 's2')),
    ]);
    expect(fake.events.filter((e) => e.startsWith('start'))).toEqual([
      'start a',
    ]);
    expect(fake.options[0].slots).toBe(
      POOL_CONVERSATION_SLOTS + POOL_SIDE_SLOTS,
    );
    expect(one.slot).not.toBe(two.slot);
    expect(one.engine).toBe(two.engine);
    const side = await host.acquire(request('c1', 's1', 'side'));
    expect(side.slot).toBeGreaterThanOrEqual(POOL_CONVERSATION_SLOTS);
    await host.stop();
  });

  it('saves a turn in its slot, and the first one of a fresh session as the shared prefix', async () => {
    const fake = fakeEngines();
    const host = new EngineHost(fake.start, 'k', () => 4);
    const lease = await host.acquire(request('c1', 's1'));
    host.release(lease.id, true);
    await tick();
    const file = promptStateFile('/p/c1', 'key-a', 's1');
    expect(fake.events).toContain(
      `save ${lease.slot} ${sharedPromptStateFile('key-a')}`,
    );
    expect(fake.events).toContain(`save ${lease.slot} ${file}`);
    // The next turn stays in the slot: nothing to restore.
    fake.events.length = 0;
    const again = await host.acquire(request('c1', 's1'));
    expect(again.slot).toBe(lease.slot);
    expect(fake.events.filter((e) => e.startsWith('restore'))).toEqual([]);
    await host.stop();
  });

  it('gives the idle-longest slot to a new conversation, saving and restoring', async () => {
    const fake = fakeEngines();
    const host = new EngineHost(fake.start, 'k', () => 4);
    const leases = [];
    for (let i = 0; i < POOL_CONVERSATION_SLOTS; i++) {
      const lease = await host.acquire(request(`c${i}`, `s${i}`));
      host.release(lease.id);
      leases.push(lease);
    }
    fake.events.length = 0;
    const newcomer = await host.acquire(request('cx', 'sx'));
    // c0 was idle the longest.
    expect(newcomer.slot).toBe(leases[0].slot);
    // c0 never finished a turn: what it read so far is saved (and, as its
    // session was fresh, is the shared prefix too) before cx takes the slot.
    expect(fake.events).toEqual([
      `save ${leases[0].slot} ${sharedPromptStateFile('key-a')}`,
      `save ${leases[0].slot} ${promptStateFile('/p/c0', 'key-a', 's0')}`,
      // (no restore: the stand-in engine writes no state files)
    ]);
    await host.stop();
  });

  it('makes a turn wait while every conversation slot is running', async () => {
    const fake = fakeEngines();
    const host = new EngineHost(fake.start, 'k', () => 4);
    const running = [];
    for (let i = 0; i < POOL_CONVERSATION_SLOTS; i++) {
      running.push(await host.acquire(request(`c${i}`, `s${i}`)));
    }
    let granted = false;
    const waiting = host.acquire(request('cx', 'sx')).then((lease) => {
      granted = true;
      return lease;
    });
    await tick();
    expect(granted).toBe(false);
    // A side query does not wait for conversation slots... but the queue is
    // first come, first served.
    host.release(running[1].id);
    const lease = await waiting;
    expect(lease.slot).toBe(running[1].slot);
    await host.stop();
  });

  it('runs no more requests at once than the shared cache holds contexts', async () => {
    const fake = fakeEngines();
    const host = new EngineHost(fake.start, 'k', () => 2);
    const one = await host.acquire(request('c1', 's1'));
    await host.acquire(request('c2', 's2', 'side'));
    expect(fake.options[0].contexts).toBe(2);
    let granted = false;
    const third = host.acquire(request('c3', 's3')).then((lease) => {
      granted = true;
      return lease;
    });
    await tick();
    expect(granted).toBe(false);
    host.release(one.id);
    expect((await third).slot).not.toBe(undefined);
    await host.stop();
  });

  it('restarts for another model only when no request runs', async () => {
    const fake = fakeEngines();
    const host = new EngineHost(fake.start, 'k', () => 4);
    const first = await host.acquire(request('c1', 's1'));
    let switched = false;
    const other = host.acquire(request('c2', 's2', 'main', b)).then((lease) => {
      switched = true;
      return lease;
    });
    await tick();
    expect(switched).toBe(false);
    host.release(first.id);
    const lease = await other;
    expect(lease.engine.model.id).toBe('b');
    expect(fake.events).toContain('stop a');
    await host.stop();
  });

  it('frees what a client that went away held', async () => {
    const fake = fakeEngines();
    const host = new EngineHost(fake.start, 'k', () => 4);
    const lease = await host.acquire(request('c1', 's1'));
    const waiting = host.acquire(request('c1', 's2', 'main', b));
    host.forgetClient('c1');
    await expect(waiting).rejects.toThrow(/went away/);
    expect(host.lease(lease.id)).toBeUndefined();
    expect(host.activeLeases).toBe(0);
    expect(host.status().conversations).toBe(0);
    await host.stop();
  });
});
