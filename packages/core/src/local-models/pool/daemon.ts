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
import net from 'node:net';
import { startLocalModelEngine } from '../engine.js';
import type { StartEngine } from '../local-model-server.js';
import type { PoolRequest } from './engine-host.js';
import { HostPool, type FitsBeside } from './host-pool.js';
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
  idleExitMs?: number;
  /** Called once everything is stopped; the CLI exits the process. */
  onExit?: () => void;
}

export interface PoolDaemon {
  readonly address: string;
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
 * job object on Windows).
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

  const key = Buffer.from(poolKey(dir));
  const host = new HostPool(
    options.startEngine ?? startLocalModelEngine,
    randomBytes(24).toString('hex'),
    options.fitsBeside,
  );
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
    if (idleTimer || closing) return;
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

  const attach = (
    req: http.IncomingMessage,
    res: http.ServerResponse,
    client: string,
  ) => {
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
      host.forgetClient(client);
      log(`client ${client} detached (${clients.size} left)`);
      scheduleIdleExit();
    });
  };

  const acquire = async (
    req: http.IncomingMessage,
    res: http.ServerResponse,
  ) => {
    const request = JSON.parse(
      (await readBody(req)).toString('utf8'),
    ) as PoolRequest;
    if (!clients.has(request.client)) {
      sendJson(res, 409, { error: 'attach first' });
      return;
    }
    const abort = new AbortController();
    res.on('close', () => {
      if (!res.writableFinished) abort.abort(new Error('client gone'));
    });
    try {
      const lease = await host.acquire(request, abort.signal);
      if (abort.signal.aborted) {
        host.release(lease.id);
        return;
      }
      sendJson(res, 200, { lease: lease.id, slot: lease.slot });
    } catch (error) {
      if (!abort.signal.aborted) {
        sendJson(res, 500, {
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  };

  /** Forward an engine request (`/v1/...`, `/metrics`) to the lease's engine, in its slot. */
  const proxy = async (req: http.IncomingMessage, res: http.ServerResponse) => {
    const id = req.headers[LEASE_HEADER];
    const lease = typeof id === 'string' ? host.lease(id) : undefined;
    if (!lease || !lease.engine.alive) {
      sendJson(res, 409, { error: 'no such lease' });
      return;
    }
    let body = await readBody(req);
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

  const server = http.createServer((req, res) => {
    void (async () => {
      try {
        if (!authorized(req)) {
          sendJson(res, 401, { error: 'unauthorized' });
          return;
        }
        const url = new URL(req.url ?? '/', 'http://pool');
        if (closing) {
          sendJson(res, 503, { error: 'stopping' });
          return;
        }
        if (url.pathname === '/pool/attach' && req.method === 'GET') {
          const client = url.searchParams.get('client');
          if (!client) return sendJson(res, 400, { error: 'client missing' });
          return attach(req, res, client);
        }
        if (url.pathname === '/pool/acquire' && req.method === 'POST') {
          return await acquire(req, res);
        }
        if (url.pathname === '/pool/release' && req.method === 'POST') {
          const { lease, saveState } = JSON.parse(
            (await readBody(req)).toString('utf8'),
          ) as { lease: string; saveState?: boolean };
          host.release(lease, saveState === true);
          return sendJson(res, 200, {});
        }
        if (url.pathname === '/pool/status' && req.method === 'GET') {
          return sendJson(res, 200, {
            pid: process.pid,
            clients: clients.size,
            engines: host.status(),
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
  });

  const close = (reason: string): Promise<void> => {
    closing ??= (async () => {
      log(`stopping: ${reason}`);
      cancelIdleExit();
      await host.stop().catch(() => {});
      for (const connections of clients.values()) {
        for (const res of connections) res.destroy();
      }
      clients.clear();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      server.closeAllConnections?.();
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
  } catch (error) {
    rmSync(poolLockFile(dir), { force: true });
    throw error;
  }
  log(`listening on ${address}, pid ${process.pid}`);
  // Started for a client that attaches next (it polls until we listen);
  // if none does, stop.
  scheduleIdleExit(Math.max(idleExitMs, STARTUP_GRACE_MS));

  return {
    address,
    close: () => close('closed'),
    closed,
  };
}
