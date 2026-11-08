/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

// Print how a downloaded local model would run on this machine now, without
// starting it: the plan /models plan shows, with the fit and the drive's
// limit when experts stream from it.
//
//   npm run build
//   node scripts/local-plan.mjs [--engine PATH] [--model ID] [--ctx TOKENS]

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
  ...(await load('local-models.js')),
};
const id = option('model') ?? 'qwen3.6-35b-a3b';
const builtIn = core.BUILT_IN_LOCAL_MODELS.find((m) => m.id === id);
// --ctx TOKENS: the model's context size, instead of its default.
const model =
  builtIn && option('ctx')
    ? { ...builtIn, contextSize: Number(option('ctx')) }
    : builtIn;
if (!model) {
  console.error(`${id} is not a built-in local model.`);
  process.exit(1);
}
const engine = option('engine');
const planned = core.planLocalModel(model, {
  ...core.DEFAULT_ENGINE_OPTIONS,
  ...(engine ? { enginePath: path.resolve(engine) } : {}),
});
const gb = (bytes) => `${(bytes / 1e9).toFixed(1)} GB`;
console.log(`model ${model.id}: ${gb(planned.bytes)}`);
if (planned.gpu) {
  console.log(
    `GPU budget ${gb(planned.gpu.limit)}${planned.gpu.unified ? ', shares system memory' : ''}`,
  );
}
console.log(`fit ${JSON.stringify(planned.fit)}`);
console.log(`context and buffers ${gb(planned.headroomBytes)}`);
if (planned.streaming) {
  const s = planned.streaming;
  console.log(
    `streams ${gb(s.onDriveBytes)} of experts from the drive at ${gb(s.driveBytesPerSecond)}/s: ${Math.round(s.hitRate * 100)}% hits, ${(s.driveBytesPerToken / 1e6).toFixed(0)} MB per token, at most ${s.maxTokensPerSecond.toFixed(1)} tok/s`,
  );
}
console.log(`args ${planned.plan.args.join(' ') || '(defaults)'}`);
for (const note of planned.plan.notes) console.log(`  - ${note}`);
