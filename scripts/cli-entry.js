#!/usr/bin/env node

/**
 * @license
 * Copyright 2025 Qwen Code
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Production bin entry wrapper.
 *
 * For most commands, global.gc() must be available for the memory-pressure
 * monitor's critical-tier cleanup. On POSIX under Node the entry exposes gc at
 * runtime and imports cli.js in this process; on Windows and under Bun it
 * launches the bundled CLI as a child with --expose-gc.
 *
 * For bootstrap fast paths: imports cli.js directly in-process, skipping the
 * spawnSync overhead. These paths do not need global.gc().
 */

const cliArgs = process.argv.slice(2);
delete process.env['QWEN_CODE_PENDING_COMPILE_CACHE'];

function hasFlag(flag, alias) {
  for (const arg of cliArgs) {
    if (arg === '--') {
      return false;
    }
    if (arg === flag || arg === alias) {
      return true;
    }
  }
  return false;
}

function isInProcessFastPath() {
  const first = cliArgs[0];
  if (first === 'mcp') {
    return true;
  }
  if (first === undefined || first.startsWith('-')) {
    return hasFlag('--help', '-h') || hasFlag('--version', '-v');
  }
  return false;
}

const isTopLevelVersion =
  (cliArgs[0] === undefined || cliArgs[0].startsWith('-')) &&
  hasFlag('--version', '-v');

if (isTopLevelVersion && process.env['CLI_VERSION']) {
  process.stdout.write(`${process.env['CLI_VERSION']}\n`);
  process.exit(0);
}

const { existsSync, readFileSync } = await import('node:fs');
const { fileURLToPath, pathToFileURL } = await import('node:url');
const { dirname, join } = await import('node:path');

const __dirname = dirname(fileURLToPath(import.meta.url));

// The entry a subprocess should call to reach THIS build.
//
// A skill that shells out to `qwen …` gets whatever `qwen` PATH resolves to, which
// is not necessarily the code that launched it (an older global install, say).
// This file is the executable entry and the one thing that knows its own path, so
// it publishes it; `getShellContextEnvVars` passes it to every shell subprocess,
// and a caller prefers it over a bare `qwen`.
//
// Assignment, not `||=`: an inherited value is another session's CLI — an outer
// qwen shelling out to this one — and honouring it re-creates the same skew, one
// level up. Each entry stamps itself, so nested sessions each call their own
// build.
process.env['QWEN_CODE_CLI'] = fileURLToPath(import.meta.url);
const cliPathCandidates = [
  join(__dirname, 'cli.js'),
  join(__dirname, '..', 'dist', 'cli.js'),
];
const packageJsonPathCandidates = [
  join(__dirname, 'package.json'),
  join(__dirname, '..', 'package.json'),
];
const cliPath =
  cliPathCandidates.find((candidate) => existsSync(candidate)) ??
  cliPathCandidates[0];
const packageJsonPath =
  packageJsonPathCandidates.find((candidate) => existsSync(candidate)) ??
  packageJsonPathCandidates[0];

if (isTopLevelVersion) {
  try {
    const pkg = JSON.parse(readFileSync(packageJsonPath, 'utf8'));
    process.stdout.write(`${pkg.version || 'unknown'}\n`);
    process.exit(0);
  } catch {
    // Fall through to cli.js, which has its own version fallback.
  }
}

if (isInProcessFastPath()) {
  const { default: module } = await import('node:module');
  module.enableCompileCache?.();
  process.argv[1] = cliPath;
  await import(pathToFileURL(cliPath).href);
} else {
  const { spawnSync } = await import('node:child_process');

  // A fresh Node image (the spawned or relaunched CLI) reaches the cache only
  // through NODE_COMPILE_CACHE; enabling it here also resolves the default
  // directory and honours NODE_DISABLE_COMPILE_CACHE. The value then reaches
  // tool subprocesses too.
  const { default: module } = await import('node:module');
  const compileCache = module.enableCompileCache?.();
  const compileCacheEnv =
    !process.env['NODE_COMPILE_CACHE'] &&
    compileCache?.status === module.constants?.compileCacheStatus?.ENABLED &&
    compileCache?.directory
      ? { NODE_COMPILE_CACHE: compileCache.directory }
      : {};

  // Bun cannot expose gc at runtime (no v8.setFlagsFromString), so it keeps
  // the child with --expose-gc in argv, as Windows does.
  if (process.platform !== 'win32' && !process.versions.bun) {
    // Running the CLI in this process instead of a child saves a Node boot and
    // the idle launcher's memory for the whole session. The memory-pressure
    // monitor's global.gc() comes from the runtime flag instead of argv.
    const [{ setFlagsFromString }, { runInNewContext }] = await Promise.all([
      import('node:v8'),
      import('node:vm'),
    ]);
    setFlagsFromString('--expose-gc');
    globalThis.gc ??= runInNewContext('gc');
    Object.assign(process.env, compileCacheEnv);
    process.argv.splice(1, Infinity, cliPath, ...cliArgs);
    await import(pathToFileURL(cliPath).href);
  } else {
    const result = spawnSync(
      process.execPath,
      ['--expose-gc', cliPath, ...cliArgs],
      {
        stdio: 'inherit',
        env: {
          ...process.env,
          ...compileCacheEnv,
        },
      },
    );
    if (result.signal) {
      process.kill(process.pid, result.signal);
    } else {
      process.exit(result.status ?? 1);
    }
  }
}
