/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

// End-to-end check of a model split across pool members, on one machine:
// a sharing member daemon (loopback only) serves rpc-server through the
// members' TLS link, and an engine runs the model with part of its layers
// there (--rpc through the tunnel). Runs both /models bench workloads split
// and whole, to show what the tunnel costs per token. On one machine both
// halves share its GPU: this checks the mechanism, not a speed-up.
//
//   npm run build
//   node scripts/local-split-e2e.mjs --engine PATH [--model ID] [--ctx TOKENS] [--member-device CPU]
//
// --engine  the fork's llama-server; ggml-rpc-server must be next to it
//           (cmake -DGGML_RPC=ON, target rpc-server)

import { mkdtempSync, rmSync } from 'node:fs';
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

const argv = process.argv.slice(2);
const option = (name) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : undefined;
};

const core = {
  ...(await load('engine.js')),
  ...(await load('bench.js')),
  ...(await load('local-models.js')),
  ...(await load('pool/daemon.js')),
  ...(await load('pool/net/membership.js')),
  ...(await load('pool/net/peer-link.js')),
  ...(await load('pool/net/rpc-tunnel.js')),
};

const enginePath = option('engine') && path.resolve(option('engine'));
if (!enginePath || !core.rpcServerBinary(enginePath)) {
  console.error(
    'Give --engine, the fork llama-server with rpc-server next to it.',
  );
  process.exit(1);
}
const id = option('model') ?? 'qwen3-4b';
const builtIn = core.BUILT_IN_LOCAL_MODELS.find((m) => m.id === id);
const model =
  builtIn && option('ctx')
    ? { ...builtIn, contextSize: Number(option('ctx')) }
    : builtIn;
if (!model) {
  console.error(`${id} is not a built-in local model.`);
  process.exit(1);
}
const options = { ...core.DEFAULT_ENGINE_OPTIONS, enginePath };

async function measure(label, rpc) {
  let engine;
  try {
    engine = await core.startLocalModelEngine(model, 'k', {
      ...options,
      ...(rpc ? { rpc } : {}),
    });
  } catch (error) {
    const lines = error.message.split('\n');
    console.log(`  ${label}: did not start (${lines[0]})`);
    if (argv.includes('--verbose')) console.log(lines.slice(-40).join('\n'));
    return;
  }
  try {
    const lease = {
      baseUrl: engine.baseUrl,
      ...(engine.socketPath ? { socketPath: engine.socketPath } : {}),
      apiKey: 'k',
      pinSlots: false,
      release() {},
    };
    for (const workload of ['prose', 'edit']) {
      const r = await core.runBench(lease, workload);
      console.log(
        `  ${label} ${workload}: prompt ${r.promptPerSecond.toFixed(1)} tok/s, generation ${r.generatedPerSecond.toFixed(1)} tok/s`,
      );
    }
  } finally {
    await engine.stop();
  }
}

const dir = mkdtempSync(path.join(os.tmpdir(), 'qwen-split-'));
let daemon;
let tunnel;
let link;
try {
  const first = core.createPool(path.join(dir, 'b'));
  const sharing = {
    ...first,
    share: true,
    port: 0,
    engine: { enginePath, speculation: true },
  };
  const head = core.joinPool(core.inviteToken(first, []), path.join(dir, 'a'));
  daemon = await core.startPoolDaemon({
    dir: path.join(dir, 'b'),
    membership: sharing,
    peerHost: '127.0.0.1',
    discovery: false,
    // --member-device CPU: one machine cannot always drive its GPU from two
    // processes at once (Vulkan device lost on a Radeon 780M).
    ...(option('member-device') ? { rpcDevices: option('member-device') } : {}),
  });
  link = new core.PeerLink(head, daemon.peerAddress);
  tunnel = new core.RpcTunnel(link);
  const rpc = await tunnel.open();
  console.log(`model ${model.id}; member rpc-server through ${rpc}`);
  await measure('whole', undefined);
  // The member's GPU adds to this one's; llama.cpp gives the RPC device
  // layers in proportion to its free memory.
  const planned = core.planLocalModel(model, options);
  await measure('split', {
    servers: [rpc],
    remoteBytes: planned.gpu?.limit ?? 0,
  });
} catch (error) {
  console.error(`failed: ${error instanceof Error ? error.message : error}`);
  process.exitCode = 1;
} finally {
  tunnel?.close();
  link?.close();
  await daemon?.close();
  if (argv.includes('--verbose')) {
    const { readFileSync } = await import('node:fs');
    try {
      console.log('member daemon log:');
      console.log(readFileSync(path.join(dir, 'b', 'daemon.log'), 'utf8'));
    } catch {
      // No log.
    }
  }
  rmSync(dir, { recursive: true, force: true });
}
