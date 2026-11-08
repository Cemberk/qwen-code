/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import type { LocalModelEngine } from '../engine.js';
import { DEFAULT_ENGINE_OPTIONS } from '../engine.js';
import type { LocalModelConfig } from '../local-models.js';
import type { PoolRequest } from './engine-host.js';
import { HostPool } from './host-pool.js';

const model = (id: string): LocalModelConfig => ({
  id,
  repo: `o/${id}`,
  file: `${id}.gguf`,
});

function fakeEngines() {
  const events: string[] = [];
  const start = async (m: LocalModelConfig): Promise<LocalModelEngine> => {
    events.push(`start ${m.id}`);
    let alive = true;
    return {
      model: m,
      baseUrl: 'http://127.0.0.1:1/v1',
      stateKey: `key-${m.id}`,
      slot: async () => true,
      get alive() {
        return alive;
      },
      async stop() {
        events.push(`stop ${m.id}`);
        alive = false;
      },
    };
  };
  return { events, start };
}

const request = (client: string, id: string): PoolRequest => ({
  client,
  model: model(id),
  options: DEFAULT_ENGINE_OPTIONS,
  kind: 'main',
  context: { project: '/p', session: client },
});

const tick = () => new Promise((resolve) => setTimeout(resolve, 10));

describe('HostPool', () => {
  it('runs two models side by side when they fit', async () => {
    const fake = fakeEngines();
    const pool = new HostPool(fake.start, 'k', () => true);
    const a = await pool.acquire(request('c1', 'a'));
    const b = await pool.acquire(request('c2', 'b'));
    expect(a.engine.model.id).toBe('a');
    expect(b.engine.model.id).toBe('b');
    expect(fake.events).toEqual(['start a', 'start b']);
    expect(pool.status()).toHaveLength(2);
    // Another conversation on a running model shares its engine.
    const a2 = await pool.acquire(request('c3', 'a'));
    expect(a2.engine).toBe(a.engine);
    expect(pool.lease(b.id)).toBe(b);
    await pool.stop();
  });

  it('stops the engine idle the longest when a model does not fit beside it', async () => {
    const fake = fakeEngines();
    const pool = new HostPool(fake.start, 'k', () => false);
    const a = await pool.acquire(request('c1', 'a'));
    pool.release(a.id);
    await tick();
    const b = await pool.acquire(request('c1', 'b'));
    expect(b.engine.model.id).toBe('b');
    expect(fake.events).toEqual(['start a', 'stop a', 'start b']);
    await pool.stop();
  });

  it('waits while the engine in the way is serving a request', async () => {
    const fake = fakeEngines();
    const pool = new HostPool(fake.start, 'k', () => false);
    const a = await pool.acquire(request('c1', 'a'));
    let granted = false;
    const waiting = pool.acquire(request('c2', 'b')).then((lease) => {
      granted = true;
      return lease;
    });
    await tick();
    expect(granted).toBe(false);
    pool.release(a.id);
    expect((await waiting).engine.model.id).toBe('b');
    await pool.stop();
  });

  it('keeps to the most engines it may run', async () => {
    const fake = fakeEngines();
    const pool = new HostPool(fake.start, 'k', () => true, 2);
    const a = await pool.acquire(request('c1', 'a'));
    await pool.acquire(request('c2', 'b'));
    pool.release(a.id);
    await tick();
    await pool.acquire(request('c3', 'c'));
    expect(fake.events).toEqual(['start a', 'start b', 'stop a', 'start c']);
    await pool.stop();
  });

  it('drops what a departed client was waiting for', async () => {
    const fake = fakeEngines();
    const pool = new HostPool(fake.start, 'k', () => false);
    await pool.acquire(request('c1', 'a'));
    const waiting = pool.acquire(request('c2', 'b'));
    pool.forgetClient('c2');
    await expect(waiting).rejects.toThrow(/went away/);
    await pool.stop();
  });
});
