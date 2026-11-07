#!/usr/bin/env node
/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

// Helpers for scripts/install-local.sh and install-local.ps1, from the built
// qwen-code (run `npm run build` first), so the install uses the same choices
// as /models setup:
//
//   node scripts/local-setup.mjs backend          the GPU backend for this machine
//   node scripts/local-setup.mjs cmake-args       its llama.cpp configure options, one per line
//   node scripts/local-setup.mjs set-engine PATH  set localModelEngine in ~/.qwen/settings.json
//
// set-engine edits the settings file only when it holds plain JSON: a file
// with comments would lose them, so it prints the line to add instead.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const load = async (name) => {
  try {
    return await import(
      pathToFileURL(
        path.join(
          root,
          'packages',
          'core',
          'dist',
          'src',
          'local-models',
          name,
        ),
      ).href
    );
  } catch (error) {
    console.error(
      `Cannot load packages/core/dist: run npm run build first.\n${error}`,
    );
    process.exit(1);
  }
};

const [command, value] = process.argv.slice(2);

if (command === 'backend' || command === 'cmake-args') {
  const { getHardwareProfile } = await load('hardware.js');
  const { recommendedBackend, engineCmakeArgs } = await load('engine-setup.js');
  const profile = getHardwareProfile();
  if (command === 'backend') {
    console.log(recommendedBackend(profile));
  } else {
    console.log(engineCmakeArgs(profile).join('\n'));
  }
} else if (command === 'set-engine' && value) {
  const engine = path.resolve(value);
  if (!existsSync(engine)) {
    console.error(`${engine} does not exist.`);
    process.exit(1);
  }
  const dir = path.join(os.homedir(), '.qwen');
  const file = path.join(dir, 'settings.json');
  const line = `"localModelEngine": ${JSON.stringify(engine)}`;
  let settings = {};
  if (existsSync(file)) {
    const text = readFileSync(file, 'utf8').replace(/^\uFEFF/, '');
    try {
      settings = JSON.parse(text);
    } catch {
      console.log(
        `${file} is not plain JSON (it may have comments), so it was left as it is. Add this line to it:\n  ${line}`,
      );
      process.exit(0);
    }
  }
  if (settings.localModelEngine === engine) {
    console.log(`${file} already names ${engine}.`);
  } else {
    settings.localModelEngine = engine;
    mkdirSync(dir, { recursive: true });
    writeFileSync(file, `${JSON.stringify(settings, null, 2)}\n`);
    console.log(`Set localModelEngine in ${file} to ${engine}.`);
  }
} else {
  console.error(
    'usage: local-setup.mjs backend | cmake-args | set-engine PATH',
  );
  process.exit(2);
}
