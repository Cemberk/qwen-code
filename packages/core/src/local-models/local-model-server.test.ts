/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { LocalModelEngine, LocalModelEngineOptions } from './engine.js';
import type { LocalModelConfig } from './local-models.js';
import { LocalModelServer } from './local-model-server.js';
import { promptStateFile } from './prompt-cache.js';

const a: LocalModelConfig = { id: 'a', repo: 'o/a', file: 'a.gguf' };
const b: LocalModelConfig = { id: 'b', repo: 'o/b', file: 'b.gguf' };

// Records engine starts and stops; each start gets its own port.
function fakeEngines() {
  const events: string[] = [];
  const engines: Array<LocalModelEngine & { die(): void }> = [];
  const options: LocalModelEngineOptions[] = [];
  let failNext: Error | undefined;
  const start = async (
    model: LocalModelConfig,
    _apiKey: string,
    engineOptions: LocalModelEngineOptions,
  ) => {
    if (failNext) {
      const error = failNext;
      failNext = undefined;
      throw error;
    }
    events.push(`start ${model.id}`);
    options.push(engineOptions);
    let alive = true;
    const engine = {
      model,
      baseUrl: `http://127.0.0.1:${1000 + engines.length}/v1`,
      stateKey: `key-${model.id}`,
      async slot(action: 'save' | 'restore', file: string) {
        events.push(`${action} ${file}`);
        return true;
      },
      get alive() {
        return alive;
      },
      async stop() {
        events.push(`stop ${model.id}`);
        alive = false;
      },
      die() {
        alive = false;
      },
    };
    engines.push(engine);
    return engine;
  };
  return {
    events,
    engines,
    options,
    start,
    failNextStart(error: Error) {
      failNext = error;
    },
  };
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

describe('LocalModelServer', () => {
  it('starts the engine once for concurrent requests on the same model', async () => {
    const fake = fakeEngines();
    const server = new LocalModelServer(fake.start);
    server.setModels([a, b]);
    const [first, second] = await Promise.all([
      server.acquire('a'),
      server.acquire('a'),
    ]);
    expect(first.baseUrl).toBe('http://127.0.0.1:1000/v1');
    expect(second.baseUrl).toBe(first.baseUrl);
    expect(first.apiKey).toBe(server.apiKey);
    expect(fake.events).toEqual(['start a']);
  });

  it('switches models only after the requests on the loaded one finish', async () => {
    const fake = fakeEngines();
    const server = new LocalModelServer(fake.start);
    server.setModels([a, b]);
    const onA = await server.acquire('a');
    let onB: Awaited<ReturnType<typeof server.acquire>> | undefined;
    void server.acquire('b').then((lease) => (onB = lease));
    // A later request for the loaded model queues behind the switch.
    let laterA: Awaited<ReturnType<typeof server.acquire>> | undefined;
    void server.acquire('a').then((lease) => (laterA = lease));
    await tick();
    expect(onB).toBeUndefined();
    expect(fake.events).toEqual(['start a']);

    onA.release();
    onA.release(); // Idempotent.
    await tick();
    expect(onB?.baseUrl).toBe('http://127.0.0.1:1001/v1');
    expect(laterA).toBeUndefined();
    expect(fake.events).toEqual(['start a', 'stop a', 'start b']);

    onB!.release();
    await tick();
    expect(laterA?.baseUrl).toBe('http://127.0.0.1:1002/v1');
    expect(fake.events).toEqual([
      'start a',
      'stop a',
      'start b',
      'stop b',
      'start a',
    ]);
  });

  it('restarts an engine that exited', async () => {
    const fake = fakeEngines();
    const server = new LocalModelServer(fake.start);
    server.setModels([a]);
    (await server.acquire('a')).release();
    fake.engines[0].die();
    const lease = await server.acquire('a');
    expect(lease.baseUrl).toBe('http://127.0.0.1:1001/v1');
    expect(fake.events).toEqual(['start a', 'stop a', 'start a']);
  });

  it('restarts when the entry of the loaded model changes', async () => {
    const fake = fakeEngines();
    const server = new LocalModelServer(fake.start);
    server.setModels([a]);
    (await server.acquire('a')).release();
    server.setModels([{ ...a, repo: 'o/a-v2' }]);
    await server.acquire('a');
    expect(fake.events).toEqual(['start a', 'stop a', 'start a']);
    expect(fake.engines[1].model.repo).toBe('o/a-v2');
  });

  it('restarts with speculation switched once the request in flight finishes', async () => {
    const fake = fakeEngines();
    const server = new LocalModelServer(fake.start);
    server.setModels([a]);
    expect(server.isSpeculationEnabled()).toBe(true);
    const inFlight = await server.acquire('a');

    server.setSpeculation(false);
    expect(server.isSpeculationEnabled()).toBe(false);
    let next: Awaited<ReturnType<typeof server.acquire>> | undefined;
    void server.acquire('a').then((lease) => (next = lease));
    await tick();
    expect(next).toBeUndefined();

    inFlight.release();
    await tick();
    expect(next?.baseUrl).toBe('http://127.0.0.1:1001/v1');
    expect(fake.events).toEqual(['start a', 'stop a', 'start a']);
    expect(fake.options).toEqual([
      { speculation: true },
      { speculation: false },
    ]);

    // Setting the same value again keeps the engine.
    next!.release();
    server.setSpeculation(false);
    await server.acquire('a');
    expect(fake.events).toHaveLength(3);
  });

  it('rejects the waiting request when its engine cannot start, then serves the next', async () => {
    const fake = fakeEngines();
    const server = new LocalModelServer(fake.start);
    server.setModels([a, b]);
    fake.failNextStart(new Error('a is not downloaded'));
    const failed = server.acquire('a');
    const next = server.acquire('b');
    await expect(failed).rejects.toThrow('a is not downloaded');
    expect((await next).baseUrl).toBe('http://127.0.0.1:1000/v1');
  });

  it('rejects a model that is not in localModels', async () => {
    const server = new LocalModelServer(fakeEngines().start);
    server.setModels([a]);
    await expect(server.acquire('gpt-4')).rejects.toThrow(
      '"gpt-4" is not one of the models in localModels.',
    );
  });

  it('drops a queued request when it is aborted', async () => {
    const fake = fakeEngines();
    const server = new LocalModelServer(fake.start);
    server.setModels([a, b]);
    const onA = await server.acquire('a');
    const controller = new AbortController();
    const onB = server.acquire('b', controller.signal);
    controller.abort(new Error('user cancelled'));
    await expect(onB).rejects.toThrow('user cancelled');
    onA.release();
    await tick();
    // Nothing waits for b any more, so a stays loaded.
    expect(fake.events).toEqual(['start a']);
  });

  it('stops the engine', async () => {
    const fake = fakeEngines();
    const server = new LocalModelServer(fake.start);
    server.setModels([a]);
    (await server.acquire('a')).release();
    await server.stop();
    expect(fake.events).toEqual(['start a', 'stop a']);
  });

  describe('prompt cache', () => {
    let dir: string;
    afterEach(() => rmSync(dir, { recursive: true, force: true }));
    const withCache = (session = 's1') => {
      dir = mkdtempSync(path.join(os.tmpdir(), 'local-model-server-'));
      const fake = fakeEngines();
      const server = new LocalModelServer(fake.start);
      server.setModels([a]);
      server.setPromptCache({
        directory: dir,
        context: () => ({ project: '/p', session }),
      });
      return { fake, server, file: promptStateFile('/p', 'key-a', session) };
    };

    it("restores the session's saved prompt before the first request", async () => {
      const { fake, server, file } = withCache();
      writeFileSync(path.join(dir, file), 'state');
      await server.acquire('a');
      expect(fake.events).toEqual(['start a', `restore ${file}`]);
    });

    it('saves at the end of a turn, after the requests in flight and before the next', async () => {
      const { fake, server, file } = withCache();
      const turn = await server.acquire('a');
      const sideQuery = await server.acquire('a');
      turn.release({ saveState: true });
      await tick();
      expect(fake.events).toEqual(['start a']);

      let next: Awaited<ReturnType<typeof server.acquire>> | undefined;
      void server.acquire('a').then((lease) => (next = lease));
      await tick();
      expect(next).toBeUndefined();

      sideQuery.release();
      await tick();
      expect(fake.events).toEqual(['start a', `save ${file}`]);
      expect(next).toBeDefined();
    });

    it('serves requests without the cache when its folder cannot be created', async () => {
      dir = mkdtempSync(path.join(os.tmpdir(), 'local-model-server-'));
      writeFileSync(path.join(dir, 'file'), 'not a folder');
      const fake = fakeEngines();
      const server = new LocalModelServer(fake.start);
      server.setModels([a]);
      server.setPromptCache({
        directory: path.join(dir, 'file', 'cache'),
        context: () => ({ project: '/p', session: 's1' }),
      });
      const lease = await server.acquire('a');
      expect(lease.pinSlots).toBe(false);
      lease.release({ saveState: true });
      await tick();
      expect(fake.events).toEqual(['start a']);
    });

    it('saves nothing for a lease without saveState', async () => {
      const { fake, server } = withCache();
      (await server.acquire('a')).release();
      await tick();
      expect(fake.events).toEqual(['start a']);
    });
  });

  it('saves nothing without a prompt cache', async () => {
    const fake = fakeEngines();
    const server = new LocalModelServer(fake.start);
    server.setModels([a]);
    (await server.acquire('a')).release({ saveState: true });
    await tick();
    expect(fake.events).toEqual(['start a']);
  });
});
