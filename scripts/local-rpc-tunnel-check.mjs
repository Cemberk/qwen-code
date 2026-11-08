/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

// Byte-level check of the pool's RPC tunnel: sends ggml-rpc's HELLO to an
// rpc-server directly and through a member's tunnel, and prints both
// answers, which must be the same.
//
//   npm run build
//   node scripts/local-rpc-tunnel-check.mjs --engine PATH

import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const load = (name) =>
  import(
    pathToFileURL(
      path.join(root, 'packages', 'core', 'dist', 'src', 'local-models', name),
    ).href
  );
const core = {
  ...(await load('pool/daemon.js')),
  ...(await load('pool/net/membership.js')),
  ...(await load('pool/net/peer-link.js')),
  ...(await load('pool/net/rpc-tunnel.js')),
};
const argv = process.argv.slice(2);
const enginePath = path.resolve(argv[argv.indexOf('--engine') + 1]);
const binary = core.rpcServerBinary(enginePath);

/** HELLO: command 14, then the request's size (8 bytes) and 24 bytes of connection capabilities (none). */
const HELLO = Buffer.concat([
  Buffer.from([14, 24, 0, 0, 0, 0, 0, 0, 0]),
  Buffer.alloc(24),
]);

function hello(port) {
  return new Promise((resolve, reject) => {
    const socket = net.connect(port, '127.0.0.1', () => socket.write(HELLO));
    let data = Buffer.alloc(0);
    socket.on('data', (chunk) => {
      data = Buffer.concat([data, chunk]);
      if (
        data.length >= 8 &&
        data.length >= 8 + Number(data.readBigUInt64LE(0))
      ) {
        socket.destroy();
        resolve(data.toString('hex'));
      }
    });
    socket.on('error', reject);
    setTimeout(() => {
      socket.destroy();
      resolve(`timeout after ${data.length} bytes: ${data.toString('hex')}`);
    }, 15000);
  });
}

const direct = spawn(binary, ['--host', '127.0.0.1', '--port', '50075'], {
  stdio: 'ignore',
});
await new Promise((resolve) => setTimeout(resolve, 3000));
console.log(`direct:  ${await hello(50075)}`);
direct.kill();

const dir = mkdtempSync(path.join(os.tmpdir(), 'qwen-rpc-check-'));
const first = core.createPool(path.join(dir, 'b'));
const daemon = await core.startPoolDaemon({
  dir: path.join(dir, 'b'),
  membership: {
    ...first,
    share: true,
    port: 0,
    engine: { enginePath, speculation: true },
  },
  peerHost: '127.0.0.1',
  discovery: false,
});
const head = core.joinPool(core.inviteToken(first, []), path.join(dir, 'a'));
const link = new core.PeerLink(head, daemon.peerAddress);
const tunnel = new core.RpcTunnel(link);
await tunnel.open();
console.log(`tunnel:  ${await hello(tunnel.port)}`);
// llama-server opens more than one connection: one after another, and at once.
console.log(`again:   ${await hello(tunnel.port)}`);
const both = await Promise.all([hello(tunnel.port), hello(tunnel.port)]);
console.log(`at once: ${both.map((b) => b.slice(0, 16)).join(' ')}`);
tunnel.close();
link.close();
await daemon.close();
rmSync(dir, { recursive: true, force: true });
