#!/usr/bin/env node
/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

// End-to-end check of the qwen CLI with a local model: runs the built CLI
// headless (-p) in a temporary home whose settings name only the local model
// and the engine, so the user's own ~/.qwen is neither read nor changed.
//
//   npm run build
//   node scripts/local-cli-e2e.mjs [--engine PATH] [--model ID] [--timeout SECONDS]
//
// --engine   the llama-server to run (localModelEngine; default: the first on PATH)
// --model    a built-in local model id (default: qwen3-4b), downloaded to the
//            Hugging Face cache of this user
// --timeout  seconds before giving up (default 900): the first prompt of a
//            session reads qwen's whole system prompt, minutes on a small GPU
//
// Exits with 1 unless the model answers with the expected words.

import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const option = (name) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : undefined;
};

const { BUILT_IN_LOCAL_MODELS } = await import(
  pathToFileURL(
    path.join(
      root,
      'packages',
      'core',
      'dist',
      'src',
      'local-models',
      'local-models.js',
    ),
  ).href
).catch((error) => {
  console.error(
    `Cannot load packages/core/dist: run npm run build first.\n${error}`,
  );
  process.exit(1);
});
const id = option('model') ?? 'qwen3-4b';
const model = BUILT_IN_LOCAL_MODELS.find((m) => m.id === id);
if (!model) {
  console.error(`${id} is not a built-in local model.`);
  process.exit(2);
}

// The model stays in this user's Hugging Face cache, found before HOME moves.
const hfCache =
  process.env['HF_HUB_CACHE'] ??
  (process.env['HF_HOME']
    ? path.join(process.env['HF_HOME'], 'hub')
    : path.join(os.homedir(), '.cache', 'huggingface', 'hub'));

const home = mkdtempSync(path.join(os.tmpdir(), 'qwen-cli-e2e-'));
const work = path.join(home, 'work');
mkdirSync(path.join(home, '.qwen'), { recursive: true });
mkdirSync(work);
writeFileSync(
  path.join(home, '.qwen', 'settings.json'),
  JSON.stringify(
    {
      localModels: [model],
      ...(option('engine')
        ? { localModelEngine: path.resolve(option('engine')) }
        : {}),
      model: { name: model.id },
    },
    null,
    2,
  ),
);

const expected = 'local engine works';
const timeoutMs = Number(option('timeout') ?? 900) * 1000;
const started = Date.now();
const child = spawn(
  process.execPath,
  [
    path.join(root, 'packages', 'cli', 'dist', 'index.js'),
    '-p',
    `Reply with exactly: ${expected}`,
  ],
  {
    cwd: work,
    env: {
      ...process.env,
      HOME: home,
      USERPROFILE: home,
      HF_HUB_CACHE: hfCache,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  },
);
let output = '';
child.stdout.on('data', (d) => (output += d));
child.stderr.on('data', (d) => (output += d));
const timer = setTimeout(() => child.kill(), timeoutMs);
const code = await new Promise((resolve) => child.once('exit', resolve));
clearTimeout(timer);
const seconds = ((Date.now() - started) / 1000).toFixed(0);
console.log(output.trim().split('\n').slice(-15).join('\n'));
rmSync(home, { recursive: true, force: true });
if (code === 0 && output.toLowerCase().includes(expected)) {
  console.log(`\nOK: the CLI answered with the local model in ${seconds} s.`);
  process.exit(0);
}
console.log(`\nFAIL: exit ${code} after ${seconds} s without "${expected}".`);
process.exit(1);
