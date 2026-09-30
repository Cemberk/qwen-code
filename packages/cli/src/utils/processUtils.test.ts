/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, beforeAll, beforeEach, vi } from 'vitest';
import {
  RELAUNCH_EXIT_CODE,
  getRelaunchExecArgv,
  relaunchApp,
  superviseInProcess,
} from './processUtils.js';
import * as cleanup from './cleanup.js';

describe('processUtils', () => {
  const processExit = vi
    .spyOn(process, 'exit')
    .mockReturnValue(undefined as never);
  const runExitCleanup = vi.spyOn(cleanup, 'runExitCleanup');

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should run cleanup and exit with the relaunch code', async () => {
    await relaunchApp();
    expect(runExitCleanup).toHaveBeenCalledTimes(1);
    expect(processExit).toHaveBeenCalledWith(RELAUNCH_EXIT_CODE);
  });

  describe('getRelaunchExecArgv', () => {
    const originalGc = globalThis.gc;
    const originalExecArgv = [...process.execArgv];

    afterEach(() => {
      globalThis.gc = originalGc;
      process.execArgv = [...originalExecArgv];
    });

    it('adds --expose-gc when gc was exposed at runtime', () => {
      process.execArgv = ['--trace-warnings'];
      globalThis.gc = vi.fn() as unknown as typeof globalThis.gc;
      expect(getRelaunchExecArgv()).toEqual([
        '--trace-warnings',
        '--expose-gc',
      ]);
    });

    it('does not repeat --expose-gc from the command line', () => {
      process.execArgv = ['--expose-gc'];
      globalThis.gc = vi.fn() as unknown as typeof globalThis.gc;
      expect(getRelaunchExecArgv()).toEqual(['--expose-gc']);
    });

    it('keeps the flags as they are when gc is not exposed', () => {
      process.execArgv = ['--trace-warnings'];
      globalThis.gc = undefined;
      expect(getRelaunchExecArgv()).toEqual(['--trace-warnings']);
    });
  });

  // Last: superviseInProcess switches module state for the rest of the file.
  describe('without a supervising parent', () => {
    const execve = vi.fn();
    const originalExecve = process.execve;

    beforeAll(() => {
      superviseInProcess();
    });

    beforeEach(() => {
      process.execve = execve as unknown as typeof process.execve;
    });

    afterEach(() => {
      process.execve = originalExecve;
    });

    it('re-execs this process in place after cleanup', async () => {
      await relaunchApp();
      expect(runExitCleanup).toHaveBeenCalledTimes(1);
      expect(execve).toHaveBeenCalledWith(process.execPath, [
        process.execPath,
        ...process.execArgv,
        ...process.argv.slice(1),
      ]);
    });

    it('keeps gc the launcher exposed at runtime across the restart', async () => {
      const originalGc = globalThis.gc;
      globalThis.gc = vi.fn() as unknown as typeof globalThis.gc;
      try {
        await relaunchApp();
        expect(execve).toHaveBeenCalledWith(process.execPath, [
          process.execPath,
          ...process.execArgv,
          '--expose-gc',
          ...process.argv.slice(1),
        ]);
      } finally {
        globalThis.gc = originalGc;
      }
    });
  });
});
