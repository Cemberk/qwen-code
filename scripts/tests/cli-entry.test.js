/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fileURLToPath } from 'node:url';

const { spawnSyncMock, existsSyncMock, enableCompileCacheMock } = vi.hoisted(
  () => ({
    spawnSyncMock: vi.fn(() => ({ status: 0, signal: null })),
    existsSyncMock: vi.fn(() => false),
    enableCompileCacheMock: vi.fn(() => ({
      status: 1,
      directory: '/tmp/node-compile-cache',
    })),
  }),
);

vi.mock('node:child_process', () => ({
  spawnSync: spawnSyncMock,
}));

vi.mock('node:fs', async (importOriginal) => ({
  ...(await importOriginal()),
  existsSync: existsSyncMock,
  readFileSync: vi.fn(() => JSON.stringify({ version: '0.0.0-test' })),
}));

// Mocked so the launcher never enables a real compile cache in the test worker.
vi.mock('node:module', () => ({
  default: {
    enableCompileCache: enableCompileCacheMock,
    constants: { compileCacheStatus: { ENABLED: 1, ALREADY_ENABLED: 2 } },
  },
}));

const normalizePath = (path) => String(path).replaceAll('\\', '/');

describe('scripts/cli-entry.js production entry', () => {
  const originalArgv = process.argv;
  const originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform');
  let exitSpy;

  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    // A non-fast-path command on Windows, so the entry takes the spawnSync
    // branch (mocked) instead of importing the real dist/cli.js in-process.
    process.argv = ['node', 'scripts/cli-entry.js', 'extensions', 'list'];
    Object.defineProperty(process, 'platform', { value: 'win32' });
    // The entry exits after its child returns; the import must survive that.
    exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => undefined);
  });

  afterEach(() => {
    process.argv = originalArgv;
    Object.defineProperty(process, 'platform', originalPlatform);
    exitSpy.mockRestore();
  });

  it('stamps QWEN_CODE_CLI with its own path, overriding an inherited one', async () => {
    // The dev and start launchers had this pin; the production entry — the one
    // every npm install actually runs — did not, so a regression back to
    // honouring an inherited value would route installed subprocesses to an
    // outer or stale CLI with every test green.
    const inherited = process.env.QWEN_CODE_CLI;
    process.env.QWEN_CODE_CLI = '/somewhere/else/entirely/qwen';
    try {
      await import('../cli-entry.js?stamps-own-cli');
      expect(normalizePath(process.env.QWEN_CODE_CLI)).toMatch(
        /scripts\/cli-entry\.js$/,
      );
    } finally {
      if (inherited === undefined) delete process.env.QWEN_CODE_CLI;
      else process.env.QWEN_CODE_CLI = inherited;
    }
  });

  it('hands the compile cache to the spawned CLI', async () => {
    // Without it every spawned run — one-shot `-p` included — recompiles the
    // whole bundle; only the in-process fast paths used to enable the cache.
    const inherited = process.env.NODE_COMPILE_CACHE;
    delete process.env.NODE_COMPILE_CACHE;
    try {
      await import('../cli-entry.js?compile-cache');
      const spawnEnv = spawnSyncMock.mock.calls.at(-1)?.[2]?.env;
      expect(spawnEnv.NODE_COMPILE_CACHE).toBe('/tmp/node-compile-cache');
    } finally {
      if (inherited === undefined) delete process.env.NODE_COMPILE_CACHE;
      else process.env.NODE_COMPILE_CACHE = inherited;
    }
  });

  it('keeps an inherited compile cache and a disabled one', async () => {
    const inherited = process.env.NODE_COMPILE_CACHE;
    process.env.NODE_COMPILE_CACHE = '/custom/cache';
    try {
      await import('../cli-entry.js?inherited-compile-cache');
      expect(spawnSyncMock.mock.calls.at(-1)?.[2]?.env.NODE_COMPILE_CACHE).toBe(
        '/custom/cache',
      );

      delete process.env.NODE_COMPILE_CACHE;
      // NODE_DISABLE_COMPILE_CACHE=1 makes Node report the cache as disabled.
      enableCompileCacheMock.mockReturnValueOnce({ status: 3 });
      vi.resetModules();
      await import('../cli-entry.js?disabled-compile-cache');
      expect(
        'NODE_COMPILE_CACHE' in spawnSyncMock.mock.calls.at(-1)[2].env,
      ).toBe(false);
    } finally {
      if (inherited === undefined) delete process.env.NODE_COMPILE_CACHE;
      else process.env.NODE_COMPILE_CACHE = inherited;
    }
  });

  describe('outside Windows', () => {
    const cliPath = fileURLToPath(new URL('../cli.js', import.meta.url));

    const inheritedCompileCache = process.env.NODE_COMPILE_CACHE;

    beforeEach(() => {
      Object.defineProperty(process, 'platform', { value: 'linux' });
      vi.doMock(cliPath, () => ({}));
      delete process.env.NODE_COMPILE_CACHE;
    });

    afterEach(() => {
      vi.doUnmock(cliPath);
      if (inheritedCompileCache === undefined) {
        delete process.env.NODE_COMPILE_CACHE;
      } else {
        process.env.NODE_COMPILE_CACHE = inheritedCompileCache;
      }
    });

    it('runs the CLI in this process with gc exposed', async () => {
      await import('../cli-entry.js?in-process');

      expect(spawnSyncMock).not.toHaveBeenCalled();
      expect(process.argv.slice(1)).toEqual([cliPath, 'extensions', 'list']);
      expect(typeof globalThis.gc).toBe('function');
      // Supervised relaunches and tool subprocesses inherit it from here.
      expect(process.env.NODE_COMPILE_CACHE).toBe('/tmp/node-compile-cache');
    });

    it('keeps the spawned child with --expose-gc under Bun', async () => {
      Object.defineProperty(process.versions, 'bun', {
        value: '1.3.14',
        configurable: true,
      });
      try {
        await import('../cli-entry.js?bun');

        expect(spawnSyncMock).toHaveBeenCalledWith(
          process.execPath,
          [
            '--expose-gc',
            expect.stringMatching(/cli\.js$/),
            'extensions',
            'list',
          ],
          expect.anything(),
        );
      } finally {
        delete process.versions.bun;
      }
    });
  });
});
