/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { runExitCleanup } from './cleanup.js';

/**
 * Exit code used to signal that the CLI should be relaunched.
 */
export const RELAUNCH_EXIT_CODE = 42;

export const CUSTOM_SANDBOX_IMAGE_ENV_VAR = 'QWEN_CODE_CUSTOM_SANDBOX_IMAGE';

let supervisedInProcess = false;

/**
 * Marks this process as running without a supervising parent: restarts
 * re-exec this process in place.
 */
export function superviseInProcess() {
  supervisedInProcess = true;
}

/**
 * Node flags to relaunch this process with. On POSIX the bin launcher exposes
 * gc at runtime rather than via argv, so `process.execArgv` alone would start
 * the relaunched CLI without the gc the memory-pressure monitor calls.
 */
export function getRelaunchExecArgv(): string[] {
  const needsExposeGc =
    typeof globalThis.gc === 'function' &&
    !process.execArgv.includes('--expose-gc');
  return needsExposeGc
    ? [...process.execArgv, '--expose-gc']
    : [...process.execArgv];
}

/**
 * Exits the process with a special code to signal that the parent process should relaunch it.
 */
export async function relaunchApp(): Promise<void> {
  await runExitCleanup();
  // Read loosely: some workspaces' @types/node predate process.execve.
  const proc = process as typeof process & {
    execve?: (file: string, args: string[]) => never;
  };
  if (supervisedInProcess && proc.execve) {
    proc.execve(process.execPath, [
      process.execPath,
      ...getRelaunchExecArgv(),
      ...process.argv.slice(1),
    ]);
  }
  process.exit(RELAUNCH_EXIT_CODE);
}
