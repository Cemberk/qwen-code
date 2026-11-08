/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { LocalModelEngine } from '../engine.js';
import type { LocalModelConfig } from '../local-models.js';
import { LocalModelServer } from '../local-model-server.js';
import { PoolClient } from './client.js';
import { startPoolDaemon, type PoolDaemon } from './daemon.js';
import { poolAddress, poolKey, poolLockFile } from './paths.js';

const model: LocalModelConfig = { id: 'm', repo: 'o/m', file: 'm.gguf' };

interface Seen {
  path: string;
  authorization?: string;
  body: Record<string, unknown>;
}

/** Stand-in engines: loopback HTTP servers that record what reaches them. */
function fakeEngines() {
  const seen: Seen[] = [];
  const servers: http.Server[] = [];
  let starts = 0;
  let stops = 0;
  const start = async (
    m: LocalModelConfig,
    apiKey: string,
  ): Promise<LocalModelEngine> => {
    starts++;
    const server = http.createServer((req, res) => {
      let data = '';
      req.on('data', (chunk) => (data += chunk));
      req.on('end', () => {
        seen.push({
          path: req.url ?? '',
          authorization: req.headers['authorization'],
          body: data ? (JSON.parse(data) as Record<string, unknown>) : {},
        });
        res.setHeader('content-type', 'text/event-stream');
        res.write('data: {"ok":1}\n\n');
        res.end('data: [DONE]\n\n');
      });
    });
    servers.push(server);
    await new Promise<void>((resolve) =>
      server.listen(0, '127.0.0.1', resolve),
    );
    const { port } = server.address() as { port: number };
    let alive = true;
    return {
      model: m,
      baseUrl: `http://127.0.0.1:${port}/v1`,
      stateKey: 'key',
      slot: async () => true,
      get alive() {
        return alive && apiKey.length > 0;
      },
      async stop() {
        stops++;
        alive = false;
        await new Promise<void>((resolve) => server.close(() => resolve()));
      },
    };
  };
  return {
    seen,
    start,
    get starts() {
      return starts;
    },
    get stops() {
      return stops;
    },
  };
}

/** POST through a lease, as the OpenAI client does: over the pool's address. */
function post(
  lease: {
    socketPath?: string;
    apiKey: string;
    headers?: Record<string, string>;
  },
  body: unknown,
): Promise<{ status: number; text: string }> {
  const text = JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const request = http.request(
      {
        socketPath: lease.socketPath,
        path: '/v1/chat/completions',
        method: 'POST',
        headers: {
          ...lease.headers,
          authorization: `Bearer ${lease.apiKey}`,
          'content-type': 'application/json',
          'content-length': Buffer.byteLength(text),
        },
      },
      (response) => {
        let data = '';
        response.on('data', (chunk) => (data += chunk));
        response.on('end', () =>
          resolve({ status: response.statusCode ?? 0, text: data }),
        );
      },
    );
    request.on('error', reject);
    request.end(text);
  });
}

describe('local model pool', () => {
  let dir: string;
  let daemon: PoolDaemon | undefined;
  beforeEach(() => {
    dir = mkdtempSync(path.join(os.tmpdir(), 'qwen-pool-'));
  });
  afterEach(async () => {
    await daemon?.close();
    daemon = undefined;
    rmSync(dir, { recursive: true, force: true });
  });

  const client = (spawnDaemon: () => void) => {
    const c = new PoolClient({
      dir,
      spawnDaemon,
      fallback: new LocalModelServer(async () => {
        throw new Error('the fallback must not run');
      }),
    });
    c.setModels([model]);
    return c;
  };

  it('serves two qwens from one engine, each conversation in its own slot', async () => {
    const engines = fakeEngines();
    const start = () => {
      void startPoolDaemon({
        dir,
        startEngine: engines.start,
        contextsFor: () => 4,
      }).then((started) => (daemon ??= started));
    };
    const one = client(start);
    const two = client(start);
    one.setPromptCache({
      directory: path.join(dir, 'cache'),
      context: () => ({ project: '/p1', session: 's1' }),
    });
    two.setPromptCache({
      directory: path.join(dir, 'cache'),
      context: () => ({ project: '/p2', session: 's2' }),
    });
    const a = await one.acquire('m');
    const b = await two.acquire('m');
    expect(engines.starts).toBe(1);

    expect((await post(a, { messages: [] })).status).toBe(200);
    expect((await post(b, { messages: [] })).status).toBe(200);
    const [first, second] = engines.seen;
    expect(first.path).toBe('/v1/chat/completions');
    expect(first.body['id_slot']).not.toBe(second.body['id_slot']);
    // The engine's own key, not the pool's.
    expect(first.authorization).not.toBe(`Bearer ${poolKey(dir)}`);
    a.release();
    b.release();
    await one.stop();
    await two.stop();
  });

  it('refuses requests without the key, and a second daemon', async () => {
    const engines = fakeEngines();
    daemon = await startPoolDaemon({
      dir,
      startEngine: engines.start,
      contextsFor: () => 4,
    });
    expect(daemon).toBeDefined();
    expect(
      await startPoolDaemon({
        dir,
        startEngine: engines.start,
        contextsFor: () => 4,
      }),
    ).toBe(undefined);
    const response = await post(
      { socketPath: poolAddress(dir), apiKey: 'wrong' },
      {},
    );
    expect(response.status).toBe(401);
  });

  it('stops its engine and cleans up once the last qwen is gone', async () => {
    const engines = fakeEngines();
    const start = () => {
      void startPoolDaemon({
        dir,
        startEngine: engines.start,
        contextsFor: () => 4,
        idleExitMs: 100,
      }).then((started) => (daemon ??= started));
    };
    const one = client(start);
    const lease = await one.acquire('m', undefined, 'side');
    expect((await post(lease, {})).status).toBe(200);
    expect(existsSync(poolLockFile(dir))).toBe(true);
    // Leaving without releasing, as a qwen that was killed would.
    await one.stop();
    await daemon!.closed;
    expect(engines.stops).toBe(1);
    expect(existsSync(poolLockFile(dir))).toBe(false);
    if (process.platform !== 'win32') {
      expect(existsSync(poolAddress(dir))).toBe(false);
    }
  });

  it('runs models in-process when no daemon can be started', async () => {
    const fallbackLeases: string[] = [];
    const fallback = {
      setModels() {},
      setSpeculation() {},
      isSpeculationEnabled: () => true,
      setEnginePath() {},
      getEnginePath: () => undefined,
      setEngineArgs() {},
      getEngineOptions: () => ({ speculation: true }),
      setPromptCache() {},
      async acquire(id: string) {
        fallbackLeases.push(id);
        return {
          baseUrl: 'http://127.0.0.1:1/v1',
          apiKey: 'k',
          pinSlots: true,
          release() {},
        };
      },
      async stop() {},
    };
    const reasons: string[] = [];
    const c = new PoolClient({
      dir,
      spawnDaemon: () => {
        throw new Error('no qwen CLI here');
      },
      fallback,
      onFallback: (reason) => reasons.push(reason),
    });
    c.setModels([model]);
    const lease = await c.acquire('m');
    expect(lease.pinSlots).toBe(true);
    expect(fallbackLeases).toEqual(['m']);
    expect(reasons).toEqual(['no qwen CLI here']);
  });
});
