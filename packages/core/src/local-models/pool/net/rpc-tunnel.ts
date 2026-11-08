/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import type http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import path from 'node:path';
import type { Duplex } from 'node:stream';
import type { PeerLink } from './peer-link.js';

/**
 * Splitting one model across members: the member that runs it (the head)
 * starts its llama-server with `--rpc` pointing at a loopback port of its
 * own daemon; each connection there becomes a tunnel over the members' TLS
 * link to an `rpc-server` the other member starts on its loopback for that
 * connection alone. Neither the engine nor rpc-server ever listens on the
 * network, and ggml-rpc's unauthenticated protocol only travels inside the
 * encrypted, authenticated link.
 */

/** The upgrade token on the members' link. */
export const RPC_UPGRADE = 'qwen-rpc';

/**
 * The RPC server next to a `llama-server`, if the build has one: named
 * `ggml-rpc-server` in current llama.cpp, `rpc-server` before.
 */
export function rpcServerBinary(
  enginePath: string | undefined,
): string | undefined {
  if (!enginePath) return undefined;
  const ext = process.platform === 'win32' ? '.exe' : '';
  for (const name of ['ggml-rpc-server', 'rpc-server']) {
    const binary = path.join(path.dirname(enginePath), name + ext);
    if (existsSync(binary)) return binary;
  }
  return undefined;
}

function freeLoopbackPort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address() as net.AddressInfo;
      probe.close(() => resolve(port));
    });
  });
}

function connectWhenUp(port: number, deadline: number): Promise<net.Socket> {
  return new Promise((resolve, reject) => {
    const attempt = () => {
      const socket = net.connect(port, '127.0.0.1');
      socket.once('connect', () => resolve(socket));
      socket.once('error', () => {
        socket.destroy();
        if (Date.now() > deadline)
          reject(new Error('rpc-server did not start'));
        else setTimeout(attempt, 100);
      });
    };
    attempt();
  });
}

/**
 * The member's side: an upgraded connection from the head becomes the one
 * client of a fresh rpc-server on loopback; it stops when the tunnel
 * closes, and with this daemon (--exit-with-parent).
 */
export async function serveRpcTunnel(
  socket: Duplex,
  binary: string,
  log: (line: string) => void,
  /** Bytes that came with the upgrade, before the socket was handed over. */
  head: Buffer = Buffer.alloc(0),
  /** rpc-server's devices (`-d`); its GPUs when unset. */
  devices?: string,
  cacheWeights = true,
): Promise<void> {
  socket.pause();
  const port = await freeLoopbackPort();
  const child: ChildProcess = spawn(
    binary,
    [
      '--host',
      '127.0.0.1',
      '--port',
      String(port),
      ...(cacheWeights ? ['--cache'] : []),
      ...(devices ? ['--device', devices] : []),
      '--exit-with-parent',
    ],
    { stdio: ['pipe', 'ignore', 'pipe'], windowsHide: true },
  );
  child.stdin?.on('error', () => {});
  let output = '';
  child.stderr?.on('data', (chunk: Buffer) => {
    output = (output + chunk.toString('utf8')).slice(-2000);
  });
  const stop = () => {
    if (child.exitCode === null) child.kill();
  };
  socket.on('close', stop);
  socket.on('error', () => {
    socket.destroy();
    stop();
  });
  try {
    const upstream = await connectWhenUp(port, Date.now() + 30_000);
    upstream.setNoDelay(true);
    log(`rpc tunnel open to rpc-server on port ${port}`);
    if (head.length > 0) upstream.write(head);
    upstream.pipe(socket);
    socket.pipe(upstream);
    socket.resume();
    upstream.on('close', () => {
      socket.destroy();
      stop();
    });
    upstream.on('error', () => socket.destroy());
  } catch (error) {
    log(`rpc-server failed: ${output.trim()}`);
    socket.destroy();
    stop();
    throw error;
  }
}

/**
 * The head's side: a loopback port whose every connection is tunnelled to
 * an rpc-server on `link`'s member. Give `127.0.0.1:<port>` to the engine's
 * `--rpc`.
 */
export class RpcTunnel {
  private readonly server: net.Server;
  private readonly sockets = new Set<net.Socket>();
  port = 0;

  constructor(private readonly link: PeerLink) {
    this.server = net.createServer((local) => this.tunnel(local));
  }

  async open(): Promise<string> {
    await new Promise<void>((resolve, reject) => {
      this.server.once('error', reject);
      this.server.listen(0, '127.0.0.1', () => resolve());
    });
    this.port = (this.server.address() as net.AddressInfo).port;
    return `127.0.0.1:${this.port}`;
  }

  close(): void {
    for (const socket of this.sockets) socket.destroy();
    this.server.close();
  }

  private tunnel(local: net.Socket): void {
    local.setNoDelay(true);
    this.sockets.add(local);
    // The engine stopping resets its connections: not an error here.
    local.on('error', () => local.destroy());
    local.on('close', () => this.sockets.delete(local));
    const request = https.request({
      host: this.link.host,
      port: this.link.port,
      path: '/pool/rpc',
      agent: this.link.freshAgent(),
      headers: { connection: 'Upgrade', upgrade: RPC_UPGRADE },
    });
    // The engine connected and may already have sent its first command:
    // keep it until the tunnel is up.
    local.pause();
    request.on(
      'upgrade',
      (_response: http.IncomingMessage, remote: Duplex, head: Buffer) => {
        (remote as net.Socket).setNoDelay?.(true);
        if (head.length > 0) local.write(head);
        remote.pipe(local);
        local.pipe(remote);
        local.resume();
        remote.on('close', () => local.destroy());
        remote.on('error', () => local.destroy());
        local.on('close', () => remote.destroy());
      },
    );
    request.on('response', (response) => {
      // Not upgraded: the member refused (no rpc-server there).
      response.resume();
      local.destroy();
    });
    request.on('error', () => local.destroy());
    request.end();
  }
}
