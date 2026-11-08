/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { randomBytes, timingSafeEqual } from 'node:crypto';
import {
  closeSync,
  openSync,
  readFileSync,
  rmSync,
  writeSync,
  appendFileSync,
  writeFileSync,
} from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import {
  DEFAULT_ENGINE_OPTIONS,
  startLocalModelEngine,
  type LocalModelEngineOptions,
} from '../engine.js';
import type { LocalModelConfig } from '../local-models.js';
import type { StartEngine } from '../local-model-server.js';
import { promptCacheDir } from '../prompt-cache.js';
import type { PoolRequest } from './engine-host.js';
import { HostPool, POOL_MAX_ENGINES, type FitsBeside } from './host-pool.js';
import type { ContextsFor } from './engine-host.js';
import { Discovery } from './net/discovery.js';
import {
  isPrivateAddress,
  POOL_WIRE_VERSION,
  readMembership,
  writeMembership,
  type PoolMembership,
} from './net/membership.js';
import { peerOf, peerServerOptions } from './net/peer-link.js';
import { Router, type CanRun } from './net/router.js';
import {
  fetchModelFromMember,
  localModelInfo,
  serveModelFile,
} from './net/model-transfer.js';
import { huggingFaceHubCacheDir } from '../hf-cache.js';
import path from 'node:path';
import {
  ensurePoolDir,
  poolAddress,
  poolDir,
  poolKey,
  poolLockFile,
  poolLogFile,
} from './paths.js';

/** Header naming the lease an engine request runs under. */
export const LEASE_HEADER = 'x-qwen-lease';

/** After the last client leaves, wait this long before stopping everything. */
export const POOL_IDLE_EXIT_MS = 30_000;

/** A daemon nobody attached to yet waits at least this long. */
const STARTUP_GRACE_MS = 10_000;

/** Heartbeat on attach connections, so a dead link is noticed. */
const HEARTBEAT_MS = 15_000;

/** Largest request body accepted (a long conversation as JSON). */
const MAX_BODY_BYTES = 64 * 1024 * 1024;

export interface PoolDaemonOptions {
  dir?: string;
  address?: string;
  startEngine?: StartEngine;
  /** Whether an engine may start beside the running ones (the planner's verdict by default). */
  fitsBeside?: FitsBeside;
  /** Full contexts each engine's shared cache holds (the planner's by default). */
  contextsFor?: ContextsFor;
  idleExitMs?: number;
  /** Where the listener for other members binds: every interface by default (tests: loopback). */
  peerHost?: string;
  /** Find members by multicast on the LAN (default); tests turn it off. */
  discovery?: boolean;
  /** The Hugging Face cache models are read from and copied into (tests). */
  hfCacheDir?: string;
  /** Whether this machine can run a model (the planner's verdict by default). */
  canRun?: (host: HostPool, request: PoolRequest) => CanRun;
  /**
   * This machine's pool membership; read from the pool folder by default.
   * `null` for none.
   */
  membership?: PoolMembership | null;
  /** Called once everything is stopped; the CLI exits the process. */
  onExit?: () => void;
}

export interface PoolDaemon {
  readonly address: string;
  /** host:port of the listener for other pool members, when sharing. */
  readonly peerAddress?: string;
  /** Tell the daemon about a member to reach (tests; discovery does it on a LAN). */
  addPeer(address: string): Promise<void>;
  /** Stop engines, close the address, remove the lock. Idempotent. */
  close(): Promise<void>;
  /** Resolves when the daemon has stopped. */
  readonly closed: Promise<void>;
}

/**
 * Whether a daemon answers at `address`. Connecting is enough: only a
 * daemon listens there.
 */
export function poolAnswers(
  address: string,
  timeoutMs = 1000,
): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.connect(address);
    const done = (ok: boolean) => {
      socket.destroy();
      resolve(ok);
    };
    socket.setTimeout(timeoutMs, () => done(false));
    socket.once('connect', () => done(true));
    socket.once('error', () => done(false));
  });
}

/**
 * Take the lock: false when a live daemon holds it. A lock left by a daemon
 * that died is taken over (its pid is gone, or nothing answers at the
 * address: a pid may have been reused by an unrelated program).
 */
async function takeLock(dir: string, address: string): Promise<boolean> {
  const file = poolLockFile(dir);
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = openSync(file, 'wx', 0o600);
      writeSync(
        fd,
        JSON.stringify({ pid: process.pid, started: Date.now(), address }),
      );
      closeSync(fd);
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    }
    let holder: { pid?: number } = {};
    try {
      holder = JSON.parse(readFileSync(file, 'utf8')) as { pid?: number };
    } catch {
      // Unreadable: a daemon that died while writing it.
    }
    if (
      holder.pid !== undefined &&
      processExists(holder.pid) &&
      (await poolAnswers(address))
    ) {
      return false;
    }
    rmSync(file, { force: true });
  }
  return false;
}

function processExists(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

function readBody(req: http.IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error('request too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function sendJson(res: http.ServerResponse, status: number, body: unknown) {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json',
    'content-length': Buffer.byteLength(text),
  });
  res.end(text);
}

/**
 * Start the local model pool daemon of this user: the one process that runs
 * engines for every qwen on the machine. Resolves to undefined when another
 * daemon already runs.
 *
 * Teardown: each client holds an attach connection for its lifetime; when
 * the last one closes (however its process ended), the daemon waits
 * `idleExitMs`, then stops its engines, removes its lock and address, and
 * exits. Engines it starts exit with it (`--exit-with-parent`, and Node's
 * job object on Windows). A machine that shares its models with the other
 * members of its pool (`qwen pool share on`) stays up for them.
 *
 * Pool members: when this machine belongs to a pool, requests go to whichever
 * member should serve them (see Router), and, when it shares, a TLS listener
 * on the LAN serves the other members.
 */
export async function startPoolDaemon(
  options: PoolDaemonOptions = {},
): Promise<PoolDaemon | undefined> {
  const dir = ensurePoolDir(options.dir ?? poolDir());
  const address = options.address ?? poolAddress(dir);
  if (!(await takeLock(dir, address))) return undefined;

  const logFile = poolLogFile(dir);
  writeFileSync(logFile, '');
  const log = (line: string) => {
    try {
      appendFileSync(logFile, `${new Date().toISOString()} ${line}\n`);
    } catch {
      // Logging is best effort.
    }
  };

  const membership =
    options.membership === null
      ? undefined
      : (options.membership ?? readMembership(dir));
  const key = Buffer.from(poolKey(dir));
  const host = new HostPool(
    options.startEngine ?? startLocalModelEngine,
    randomBytes(24).toString('hex'),
    options.fitsBeside,
    POOL_MAX_ENGINES,
    options.contextsFor,
  );
  /** The engine options of this machine's own qwens, last seen. */
  let ownOptions: LocalModelEngineOptions | undefined = membership?.engine
    ? { ...DEFAULT_ENGINE_OPTIONS, ...membership.engine }
    : undefined;
  const router = new Router(host, membership, () => ownOptions, options.canRun);
  const sharing = membership?.share === true;
  const hfCacheDir = options.hfCacheDir ?? huggingFaceHubCacheDir();
  const idleExitMs = options.idleExitMs ?? POOL_IDLE_EXIT_MS;
  /** Attached clients: id -> their connections (a client may reconnect). */
  const clients = new Map<string, Set<http.ServerResponse>>();
  let idleTimer: NodeJS.Timeout | undefined;
  let closing: Promise<void> | undefined;
  let resolveClosed!: () => void;
  const closed = new Promise<void>((resolve) => (resolveClosed = resolve));

  const authorized = (req: http.IncomingMessage) => {
    const header = req.headers['authorization'] ?? '';
    const given = Buffer.from(
      header.startsWith('Bearer ') ? header.slice(7) : '',
    );
    return given.length === key.length && timingSafeEqual(given, key);
  };

  const scheduleIdleExit = (delayMs = idleExitMs) => {
    // A sharing member stays up for the others.
    if (idleTimer || closing || sharing) return;
    if (clients.size > 0) return;
    log(`no clients: stopping in ${delayMs} ms unless one attaches`);
    idleTimer = setTimeout(() => {
      idleTimer = undefined;
      if (clients.size === 0) void close('no clients');
    }, delayMs);
    idleTimer.unref?.();
  };

  const cancelIdleExit = () => {
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = undefined;
  };

  const attach = (res: http.ServerResponse, client: string) => {
    cancelIdleExit();
    let connections = clients.get(client);
    if (!connections) {
      connections = new Set();
      clients.set(client, connections);
      log(`client ${client} attached (${clients.size} now)`);
    }
    connections.add(res);
    res.writeHead(200, { 'content-type': 'text/plain' });
    res.write('attached\n');
    const heartbeat = setInterval(() => res.write('\n'), HEARTBEAT_MS);
    heartbeat.unref?.();
    // The OS closes the connection when the client's process ends, however
    // it ends: that is how the daemon knows a client is gone.
    res.on('close', () => {
      clearInterval(heartbeat);
      connections.delete(res);
      if (connections.size > 0) return;
      clients.delete(client);
      router.forgetClient(client);
      log(`client ${client} detached (${clients.size} left)`);
      scheduleIdleExit();
    });
  };

  const acquire = async (
    req: http.IncomingMessage,
    res: http.ServerResponse,
    peer: string | undefined,
  ) => {
    const request = JSON.parse(
      (await readBody(req)).toString('utf8'),
    ) as PoolRequest;
    if (!clients.has(request.client)) {
      sendJson(res, 409, { error: 'attach first' });
      return;
    }
    if (peer !== undefined) {
      // Another member's request: this machine's own engine and cache.
      request.options = ownOptions ?? DEFAULT_ENGINE_OPTIONS;
      request.promptCacheDir = promptCacheDir();
    } else if (request.options) {
      rememberOwnOptions(request.options);
    }
    const abort = new AbortController();
    res.on('close', () => {
      if (!res.writableFinished) abort.abort(new Error('client gone'));
    });
    try {
      const lease = await router.acquire(
        request,
        abort.signal,
        peer !== undefined,
      );
      if (abort.signal.aborted) {
        router.release(lease.id, false);
        return;
      }
      sendJson(res, 200, {
        lease: lease.id,
        slot: lease.slot,
        where: lease.where,
      });
    } catch (error) {
      if (!abort.signal.aborted) {
        sendJson(res, 500, {
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  };

  /** What this machine serves other members with: its own qwens' settings. */
  const rememberOwnOptions = (seen: LocalModelEngineOptions) => {
    const { slots: _slots, contexts: _contexts, ...rest } = seen;
    if (JSON.stringify(rest) === JSON.stringify(ownOptions)) return;
    ownOptions = rest;
    if (membership && sharing) {
      try {
        writeMembership(
          {
            ...membership,
            engine: {
              ...(rest.enginePath ? { enginePath: rest.enginePath } : {}),
              ...(rest.extraArgs ? { extraArgs: rest.extraArgs } : {}),
              speculation: rest.speculation,
            },
          },
          dir,
        );
      } catch {
        // Remembered for this run.
      }
    }
  };

  /** Forward an engine request (`/v1/...`, `/metrics`) to the lease's engine, in its slot. */
  const proxy = async (req: http.IncomingMessage, res: http.ServerResponse) => {
    const id = req.headers[LEASE_HEADER];
    if (typeof id !== 'string') {
      sendJson(res, 409, { error: 'no such lease' });
      return;
    }
    let body = await readBody(req);
    // A lease on another member: it fills in the slot itself.
    if (router.forward(id, req, body, res, LEASE_HEADER)) return;
    const lease = router.localLease(id);
    if (!lease || !lease.engine.alive) {
      sendJson(res, 409, { error: 'no such lease' });
      return;
    }
    if (
      body.length > 0 &&
      (req.headers['content-type'] ?? '').includes('json')
    ) {
      try {
        const json = JSON.parse(body.toString('utf8')) as Record<
          string,
          unknown
        >;
        json['id_slot'] = lease.slot;
        body = Buffer.from(JSON.stringify(json));
      } catch {
        // Not JSON after all: forward as is.
      }
    }
    const engineUrl = new URL(lease.engine.baseUrl);
    const target: http.RequestOptions = lease.engine.socketPath
      ? { socketPath: lease.engine.socketPath }
      : { host: engineUrl.hostname, port: Number(engineUrl.port) };
    const upstream = http.request(
      {
        ...target,
        method: req.method,
        path: req.url,
        headers: {
          ...(req.headers['content-type']
            ? { 'content-type': req.headers['content-type'] }
            : {}),
          accept: req.headers['accept'] ?? '*/*',
          authorization: `Bearer ${host.engineKey}`,
          'content-length': body.length,
        },
      },
      (response) => {
        res.writeHead(response.statusCode ?? 502, response.headers);
        response.pipe(res);
      },
    );
    upstream.on('error', (error) => {
      if (!res.headersSent) sendJson(res, 502, { error: error.message });
      else res.destroy();
    });
    // The client gave up (abort, or its process ended): stop generating.
    res.on('close', () => {
      if (!res.writableFinished) upstream.destroy();
    });
    upstream.end(body);
  };

  /**
   * One handler for both listeners: `peer` is the member a request came
   * from over TLS (its handshake proved it holds the pool's key), or
   * undefined for this machine's own qwens (who show the user's key).
   */
  const handle =
    (fromPeers: boolean) =>
    (req: http.IncomingMessage, res: http.ServerResponse) => {
      void (async () => {
        try {
          const peer = fromPeers ? peerOf(req) : undefined;
          if (fromPeers ? peer === undefined : !authorized(req)) {
            sendJson(res, 401, { error: 'unauthorized' });
            return;
          }
          const url = new URL(req.url ?? '/', 'http://pool');
          if (closing) {
            sendJson(res, 503, { error: 'stopping' });
            return;
          }
          if (url.pathname === '/pool/hello' && req.method === 'GET') {
            return sendJson(res, 200, {
              nodeId: membership?.nodeId,
              name: membership?.name,
              wire: POOL_WIRE_VERSION,
            });
          }
          if (url.pathname === '/pool/attach' && req.method === 'GET') {
            const client = url.searchParams.get('client');
            if (!client) return sendJson(res, 400, { error: 'client missing' });
            // A member attaches as itself only.
            if (peer !== undefined && client !== `peer:${peer}`) {
              return sendJson(res, 403, { error: 'not that member' });
            }
            return attach(res, client);
          }
          if (url.pathname === '/pool/acquire' && req.method === 'POST') {
            return await acquire(req, res, peer);
          }
          if (url.pathname === '/pool/release' && req.method === 'POST') {
            const { lease, saveState } = JSON.parse(
              (await readBody(req)).toString('utf8'),
            ) as { lease: string; saveState?: boolean };
            router.release(lease, saveState === true);
            return sendJson(res, 200, {});
          }
          if (
            fromPeers &&
            url.pathname === '/pool/model-info' &&
            req.method === 'POST'
          ) {
            const { model } = JSON.parse(
              (await readBody(req)).toString('utf8'),
            ) as { model: LocalModelConfig };
            const info = await localModelInfo(
              model,
              path.join(dir, 'model-hashes.json'),
              hfCacheDir,
            );
            return info
              ? sendJson(res, 200, info)
              : sendJson(res, 404, { error: 'not downloaded here' });
          }
          if (
            fromPeers &&
            url.pathname === '/pool/model-file' &&
            req.method === 'GET'
          ) {
            const model = JSON.parse(
              url.searchParams.get('model') ?? '{}',
            ) as LocalModelConfig;
            return serveModelFile(
              model,
              url.searchParams.get('name') ?? '',
              req,
              res,
              hfCacheDir,
            );
          }
          if (
            !fromPeers &&
            url.pathname === '/pool/fetch' &&
            req.method === 'POST'
          ) {
            const { model } = JSON.parse(
              (await readBody(req)).toString('utf8'),
            ) as { model: LocalModelConfig };
            return await fetchFromMembers(model, res);
          }
          if (url.pathname === '/pool/can-run' && req.method === 'POST') {
            const { model } = JSON.parse(
              (await readBody(req)).toString('utf8'),
            ) as { model: LocalModelConfig };
            return sendJson(res, 200, router.canRun(model));
          }
          if (fromPeers) {
            // Only this machine's own qwens may see its status or stop it.
            if (url.pathname.startsWith('/pool/')) {
              return sendJson(res, 403, { error: 'members cannot do that' });
            }
            return await proxy(req, res);
          }
          if (url.pathname === '/pool/status' && req.method === 'GET') {
            return sendJson(res, 200, {
              pid: process.pid,
              clients: clients.size,
              ...(membership
                ? {
                    pool: {
                      name: membership.name,
                      nodeId: membership.nodeId,
                      sharing,
                      ...(peerServerAddress
                        ? { listening: peerServerAddress }
                        : {}),
                    },
                  }
                : {}),
              ...router.status(),
            });
          }
          if (url.pathname === '/pool/stop' && req.method === 'POST') {
            sendJson(res, 200, {});
            void close('asked to stop');
            return;
          }
          return await proxy(req, res);
        } catch (error) {
          if (!res.headersSent) {
            sendJson(res, 500, {
              error: error instanceof Error ? error.message : String(error),
            });
          } else {
            res.destroy();
          }
        }
      })();
    };

  /**
   * Copy a model from the first member that has it, telling the client how
   * far it got, one line at a time: `progress <done> <total>`, then `done`,
   * `none` (no member has it) or `error <message>`.
   */
  const fetchFromMembers = async (
    model: LocalModelConfig,
    res: http.ServerResponse,
  ) => {
    res.writeHead(200, { 'content-type': 'text/plain' });
    for (const { name, link } of router.compatiblePeers()) {
      const has = await link
        .call('POST', '/pool/model-info', { model }, { timeoutMs: 600_000 })
        .catch(() => undefined);
      if (has?.status !== 200) continue;
      res.write(`from ${name}\n`);
      let last = 0;
      try {
        await fetchModelFromMember(
          link,
          model,
          (done, total) => {
            // A line per 1% at most.
            if (done - last >= total / 100 || done === total) {
              last = done;
              res.write(`progress ${done} ${total}\n`);
            }
          },
          hfCacheDir,
        );
        res.end('done\n');
      } catch (error) {
        res.end(
          `error ${error instanceof Error ? error.message : String(error)}\n`,
        );
      }
      return;
    }
    res.end('none\n');
  };

  const server = http.createServer(handle(false));

  // The listener for other members: TLS with the pool's key, on the LAN only.
  let peerServer: https.Server | undefined;
  let peerServerAddress: string | undefined;
  let discovery: Discovery | undefined;
  let peerRefresh: NodeJS.Timeout | undefined;

  const close = (reason: string): Promise<void> => {
    closing ??= (async () => {
      log(`stopping: ${reason}`);
      cancelIdleExit();
      discovery?.stop();
      if (peerRefresh) clearInterval(peerRefresh);
      await router.stop().catch(() => {});
      for (const connections of clients.values()) {
        for (const res of connections) res.destroy();
      }
      clients.clear();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      server.closeAllConnections?.();
      if (peerServer) {
        const listener = peerServer;
        await new Promise<void>((resolve) => listener.close(() => resolve()));
        listener.closeAllConnections?.();
      }
      if (process.platform !== 'win32') rmSync(address, { force: true });
      rmSync(poolLockFile(dir), { force: true });
      log('stopped');
      resolveClosed();
      options.onExit?.();
    })();
    return closing;
  };

  // A socket file left by a daemon that died would make listen fail.
  if (process.platform !== 'win32') rmSync(address, { force: true });
  try {
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(address, () => {
        server.off('error', reject);
        resolve();
      });
    });
    if (membership && sharing) {
      const listener = https.createServer(
        peerServerOptions(membership),
        handle(true),
      );
      // Members are on the LAN: anything else is turned away at once.
      listener.on('connection', (socket: net.Socket) => {
        if (!isPrivateAddress(socket.remoteAddress ?? '')) socket.destroy();
      });
      listener.on('tlsClientError', () => {
        // A wrong key or a scanner: nothing to do.
      });
      await new Promise<void>((resolve, reject) => {
        listener.once('error', reject);
        listener.listen(membership.port, options.peerHost, () => {
          listener.off('error', reject);
          resolve();
        });
      });
      peerServer = listener;
      peerServerAddress = `127.0.0.1:${(listener.address() as net.AddressInfo).port}`;
      log(
        `serving pool members on port ${(listener.address() as net.AddressInfo).port}`,
      );
    }
  } catch (error) {
    server.close();
    rmSync(poolLockFile(dir), { force: true });
    throw error;
  }
  if (membership) {
    if (options.discovery !== false) {
      discovery = new Discovery(membership, sharing, (found) => {
        if (found.wire === POOL_WIRE_VERSION) {
          void router.addPeer(found.address);
        }
      });
      discovery.start();
    }
    const refresh = () => {
      for (const peer of membership.peers) void router.addPeer(peer);
    };
    refresh();
    peerRefresh = setInterval(refresh, 60_000);
    peerRefresh.unref?.();
  }
  log(`listening on ${address}, pid ${process.pid}`);
  // Started for a client that attaches next (it polls until we listen);
  // if none does, stop.
  scheduleIdleExit(Math.max(idleExitMs, STARTUP_GRACE_MS));

  return {
    address,
    ...(peerServerAddress ? { peerAddress: peerServerAddress } : {}),
    addPeer: (peer) => router.addPeer(peer),
    close: () => close('closed'),
    closed,
  };
}
