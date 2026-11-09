/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

// Print the llama-server command qwen would run for a local model, one
// argument per line, so it can be run by hand (to see the engine's own log
// when something goes wrong).
//
//   npm run build
//   node scripts/local-engine-command.mjs --engine PATH [--model ID] [--ctx TOKENS] [--port N] [--args OPTION...]

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
  ...(await load('engine.js')),
  ...(await load('local-models.js')),
};

const argv = process.argv.slice(2);
const argsAt = argv.indexOf('--args');
const own = argsAt >= 0 ? argv.slice(0, argsAt) : argv;
const extraArgs = argsAt >= 0 ? argv.slice(argsAt + 1) : undefined;
const option = (name) => {
  const i = own.indexOf(`--${name}`);
  return i >= 0 ? own[i + 1] : undefined;
};
const id = option('model') ?? 'qwen3.6-35b-a3b';
const builtIn = core.BUILT_IN_LOCAL_MODELS.find((m) => m.id === id);
const model =
  builtIn && option('ctx')
    ? { ...builtIn, contextSize: Number(option('ctx')) }
    : builtIn;
const options = {
  ...core.DEFAULT_ENGINE_OPTIONS,
  ...(option('engine') ? { enginePath: path.resolve(option('engine')) } : {}),
  ...(extraArgs ? { extraArgs } : {}),
};
const planned = core.planLocalModel(model, options);
const command = core.engineCommand(
  model,
  planned.modelPath,
  Number(option('port') ?? 8080),
  'k',
  options,
  process.env,
  process.platform,
  {
    ...(planned.draftPath ? { draftPath: planned.draftPath } : {}),
    planArgs: planned.plan.args,
  },
);
console.log(command.command);
for (const arg of command.args) console.log(arg);
