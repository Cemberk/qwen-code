#!/usr/bin/env node
/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

// End-to-end check of the local model engine on this machine, through the
// same code qwen-code runs (packages/core/dist): probe the hardware, plan the
// model, start llama-server, run both /models bench workloads, stop.
//
//   npm run build
//   node scripts/local-engine-e2e.mjs [--engine PATH] [--model ID] [--no-spec] [--args OPTION...]
//
// --engine   the llama-server to run (default: the first on PATH)
// --model    a built-in local model id (default: qwen3-4b); it must be
//            downloaded: hf download <repo> <file>, as /models download does
// --no-spec  speculative decoding off
// --args     llama-server options after the planned ones (localModelEngineArgs)
//
// Exits with 1 when the engine does not start or a benchmark fails.

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
const argsAt = argv.indexOf('--args');
const extraArgs = argsAt >= 0 ? argv.slice(argsAt + 1) : undefined;

let core;
try {
  core = {
    ...(await load('engine.js')),
    ...(await load('bench.js')),
    ...(await load('hardware.js')),
    ...(await load('model-inspector.js')),
    ...(await load('local-models.js')),
  };
} catch (error) {
  console.error(
    `Cannot load packages/core/dist: run npm run build first.\n${error}`,
  );
  process.exit(1);
}

const id = option('model') ?? 'qwen3-4b';
const model = core.BUILT_IN_LOCAL_MODELS.find((m) => m.id === id);
if (!model) {
  console.error(
    `${id} is not a built-in local model: ${core.BUILT_IN_LOCAL_MODELS.map((m) => m.id).join(', ')}`,
  );
  process.exit(2);
}
const options = {
  speculation: !argv.includes('--no-spec'),
  ...(option('engine') ? { enginePath: path.resolve(option('engine')) } : {}),
  ...(extraArgs ? { extraArgs } : {}),
};

console.log(core.describeHardware(core.getHardwareProfile()).join('\n'));
let planned;
try {
  planned = core.planLocalModel(model, options);
} catch (error) {
  console.error(String(error));
  process.exit(1);
}
console.log(
  `model: ${model.id}, ${planned.capabilities ? core.describeCapabilities(planned.capabilities) : 'metadata unreadable'}`,
);
if (planned.devices) {
  console.log(
    `engine devices: ${planned.devices.map((d) => d.name).join(', ') || 'none (CPU build)'}`,
  );
}
console.log(`plan: ${planned.plan.args.join(' ') || '(llama.cpp defaults)'}`);
for (const note of planned.plan.notes) console.log(`  - ${note}`);

const started = Date.now();
let engine;
try {
  engine = await core.startLocalModelEngine(model, 'e2e-key', options);
} catch (error) {
  console.error(`engine did not start: ${error}`);
  process.exit(1);
}
console.log(
  `engine up in ${((Date.now() - started) / 1000).toFixed(1)} s at ${engine.socketPath ?? engine.baseUrl}`,
);
let failed = false;
try {
  for (const workload of core.BENCH_WORKLOADS) {
    try {
      const result = await core.runBench(
        {
          baseUrl: engine.baseUrl,
          ...(engine.socketPath ? { socketPath: engine.socketPath } : {}),
          apiKey: 'e2e-key',
          pinSlots: false,
          release: () => {},
        },
        workload,
      );
      console.log(
        `${workload}: prompt ${result.promptPerSecond.toFixed(1)} tok/s (${result.promptTokens}), ` +
          `generation ${result.generatedPerSecond.toFixed(1)} tok/s (${result.generatedTokens})` +
          (result.draftAcceptance !== undefined
            ? `, ${(100 * result.draftAcceptance).toFixed(1)}% of drafts accepted`
            : '') +
          (result.moeCacheHitRate !== undefined
            ? `, MoE cache hit rate ${(100 * result.moeCacheHitRate).toFixed(1)}%`
            : ''),
      );
    } catch (error) {
      failed = true;
      console.error(`${workload}: ${error}`);
    }
  }
} finally {
  await engine.stop();
  console.log(`engine stopped (alive: ${engine.alive})`);
}
process.exit(failed ? 1 : 0);
