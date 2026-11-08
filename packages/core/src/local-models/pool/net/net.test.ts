/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type {
  LocalModelEngine,
  LocalModelEngineOptions,
} from '../../engine.js';
import type { LocalModelConfig } from '../../local-models.js';
import { LocalModelServer } from '../../local-model-server.js';
import { PoolClient } from '../client.js';
import { startPoolDaemon, type PoolDaemon } from '../daemon.js';
import { poolKey } from '../paths.js';
import {
  createPool,
  inviteToken,
  isPrivateAddress,
  joinPool,
  readMembership,
  type PoolMembership,
} from './membership.js';
import { PeerLink } from './peer-link.js';
import type { CanRun } from './router.js';

const model: LocalModelConfig = { id: 'm', repo: 'o/m', file: 'm.gguf' };

describe('membership', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(path.join(os.tmpdir(), 'pool-member-'));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('creates a pool, and another device joins it with an invitation', () => {
    const first = createPool(path.join(dir, 'a'));
    const token = inviteToken(first, ['192.168.1.5:52450']);
    expect(token.startsWith('qwen-pool:')).toBe(true);
    const second = joinPool(token, path.join(dir, 'b'));
    expect(second.poolId).toBe(first.poolId);
    expect(second.key).toBe(first.key);
    expect(second.nodeId).not.toBe(first.nodeId);
    expect(second.peers).toEqual(['192.168.1.5:52450']);
    expect(readMembership(path.join(dir, 'b'))).toEqual(second);
  });

  it('refuses tokens that are not invitations, or are damaged', () => {
    expect(() => joinPool('hello', dir)).toThrow(/not a pool join token/);
    expect(() => joinPool('qwen-pool:!!!', dir)).toThrow(/damaged/);
    const other = Buffer.from(
      JSON.stringify({ v: 99, poolId: 'p', key: 'k', peers: [] }),
    ).toString('base64url');
    expect(() => joinPool(`qwen-pool:${other}`, dir)).toThrow(
      /another version/,
    );
  });

  it('knows private addresses from public ones', () => {
    for (const address of [
      '10.0.0.2',
      '172.20.1.1',
      '192.168.0.10',
      '127.0.0.1',
      '::ffff:192.168.1.2',
      'fe80::1',
      'fd12::3',
    ]) {
      expect(isPrivateAddress(address)).toBe(true);
    }
    for (const address of ['8.8.8.8', '172.32.0.1', '2001:db8::1']) {
      expect(isPrivateAddress(address)).toBe(false);
    }
  });
});

/** Stand-in engines that record what reaches them. */
function fakeEngines() {
  const seen: Array<Record<string, unknown>> = [];
  const options: LocalModelEngineOptions[] = [];
  let starts = 0;
  const start = async (
    m: LocalModelConfig,
    _key: string,
    engineOptions: LocalModelEngineOptions,
  ): Promise<LocalModelEngine> => {
    starts++;
    options.push(engineOptions);
    const server = http.createServer((req, res) => {
      let data = '';
      req.on('data', (chunk) => (data += chunk));
      req.on('end', () => {
        seen.push(data ? (JSON.parse(data) as Record<string, unknown>) : {});
        res.setHeader('content-type', 'text/event-stream');
        res.write('data: {"ok":1}\n\n');
        res.end('data: [DONE]\n\n');
      });
    });
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
        return alive;
      },
      async stop() {
        alive = false;
        await new Promise<void>((resolve) => server.close(() => resolve()));
      },
    };
  };
  return {
    seen,
    options,
    start,
    get starts() {
      return starts;
    },
  };
}

function post(
  lease: {
    socketPath?: string;
    apiKey: string;
    headers?: Readonly<Record<string, string>>;
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

describe('pool members on the LAN', () => {
  let dir: string;
  const daemons: PoolDaemon[] = [];
  beforeEach(() => {
    dir = mkdtempSync(path.join(os.tmpdir(), 'pool-net-'));
  });
  afterEach(async () => {
    for (const daemon of daemons.splice(0)) await daemon.close();
    rmSync(dir, { recursive: true, force: true });
  });

  /** Two members of one pool: B shares and can run the model, A cannot. */
  async function twoMembers(
    canRun: {
      a?: () => CanRun;
      b?: () => CanRun;
    } = {},
  ) {
    const first = createPool(path.join(dir, 'b'));
    const sharing: PoolMembership = { ...first, share: true, port: 0 };
    const second: PoolMembership = {
      ...joinPool(inviteToken(first, []), path.join(dir, 'a')),
      port: 0,
    };
    const engines = { a: fakeEngines(), b: fakeEngines() };
    const b = (await startPoolDaemon({
      dir: path.join(dir, 'b'),
      membership: sharing,
      // Loopback only: no firewall prompt for a test.
      peerHost: '127.0.0.1',
      discovery: false,
      startEngine: engines.b.start,
      contextsFor: () => 4,
      canRun:
        canRun.b ?? (() => ({ running: false, downloaded: true, fits: true })),
      hfCacheDir: path.join(dir, 'hf-b'),
    }))!;
    daemons.push(b);
    const a = (await startPoolDaemon({
      dir: path.join(dir, 'a'),
      membership: second,
      discovery: false,
      startEngine: engines.a.start,
      contextsFor: () => 4,
      canRun:
        canRun.a ??
        (() => ({ running: false, downloaded: false, fits: false })),
      hfCacheDir: path.join(dir, 'hf-a'),
    }))!;
    daemons.push(a);
    await a.addPeer(b.peerAddress!);
    return { a, b, engines, first, second };
  }

  it('runs a model on the member that has room for it, and streams the answer back', async () => {
    const { engines } = await twoMembers();
    const client = new PoolClient({
      dir: path.join(dir, 'a'),
      spawnDaemon: () => {},
      fallback: new LocalModelServer(async () => {
        throw new Error('the fallback must not run');
      }),
    });
    client.setModels([model]);
    const lease = await client.acquire('m');
    const answer = await post(lease, { messages: [] });
    expect(answer.status).toBe(200);
    expect(answer.text).toContain('[DONE]');
    // It ran on B, in a slot B chose.
    expect(engines.a.starts).toBe(0);
    expect(engines.b.starts).toBe(1);
    expect(typeof engines.b.seen[0]['id_slot']).toBe('number');
    lease.release();
    await client.stop();
  });

  it("copies a model from a member's cache into this one's, checked", async () => {
    // B has the model, as hf download leaves it.
    const commit = 'a'.repeat(40);
    const repoB = path.join(dir, 'hf-b', 'models--o--m');
    mkdirSync(path.join(repoB, 'refs'), { recursive: true });
    mkdirSync(path.join(repoB, 'snapshots', commit), { recursive: true });
    writeFileSync(path.join(repoB, 'refs', 'main'), commit);
    const content = Buffer.alloc(3 * 1024 * 1024, 7);
    writeFileSync(path.join(repoB, 'snapshots', commit, 'm.gguf'), content);
    const { a } = await twoMembers();

    const fetch = () =>
      new Promise<string>((resolve, reject) => {
        const body = JSON.stringify({ model });
        const request = http.request(
          {
            socketPath: a.address,
            path: '/pool/fetch',
            method: 'POST',
            headers: {
              authorization: `Bearer ${poolKey(path.join(dir, 'a'))}`,
              'content-type': 'application/json',
              'content-length': Buffer.byteLength(body),
            },
          },
          (response) => {
            let text = '';
            response.on('data', (chunk) => (text += chunk));
            response.on('end', () => resolve(text));
          },
        );
        request.on('error', reject);
        request.end(body);
      });

    const lines = (await fetch()).trim().split('\n');
    expect(lines[0]).toMatch(/^from /);
    expect(lines.at(-1)).toBe('done');
    expect(lines).toContain(`progress ${content.length} ${content.length}`);
    const repoA = path.join(dir, 'hf-a', 'models--o--m');
    expect(readFileSync(path.join(repoA, 'refs', 'main'), 'utf8')).toBe(commit);
    expect(
      readFileSync(path.join(repoA, 'snapshots', commit, 'm.gguf')).equals(
        content,
      ),
    ).toBe(true);
    // Already here: nothing to copy again.
    expect((await fetch()).trim().split('\n').at(-1)).toBe('done');
  });

  it('splits a model that fits nowhere alone across this member and one that lends its GPU', async () => {
    const GIB = 1024 ** 3;
    const { engines } = await twoMembers({
      // A has the file but only 4 GiB of the 10 it needs; B lends 8.
      a: () => ({
        running: false,
        downloaded: true,
        fits: false,
        needBytes: 10 * GIB,
        gpuBytes: 4 * GIB,
        rpc: true,
      }),
      b: () => ({
        running: false,
        downloaded: false,
        fits: false,
        gpuBytes: 8 * GIB,
        rpc: true,
      }),
    });
    const client = new PoolClient({
      dir: path.join(dir, 'a'),
      spawnDaemon: () => {},
      fallback: new LocalModelServer(async () => {
        throw new Error('the fallback must not run');
      }),
    });
    client.setModels([model]);
    const lease = await client.acquire('m');
    // It runs here, with B's GPU behind a tunnel on this machine's loopback.
    expect(engines.a.starts).toBe(1);
    expect(engines.b.starts).toBe(0);
    const rpc = engines.a.options[0].rpc!;
    expect(rpc.remoteBytes).toBe(8 * GIB);
    expect(rpc.servers).toHaveLength(1);
    expect(rpc.servers[0]).toMatch(/^127\.0\.0\.1:\d+$/);
    lease.release();
    await client.stop();
  });

  it('turns away a device without the pool key', async () => {
    const { b } = await twoMembers();
    const stranger = createPool(path.join(dir, 'c'));
    const link = new PeerLink(stranger, b.peerAddress!);
    await expect(link.call('GET', '/pool/hello')).rejects.toThrow();
    link.close();
  });

  it("does not let members see a member's status or stop it", async () => {
    const { b, second } = await twoMembers();
    const link = new PeerLink(second, b.peerAddress!);
    expect((await link.call('GET', '/pool/hello')).status).toBe(200);
    expect((await link.call('GET', '/pool/status')).status).toBe(403);
    expect((await link.call('POST', '/pool/stop')).status).toBe(403);
    link.close();
  });
});
