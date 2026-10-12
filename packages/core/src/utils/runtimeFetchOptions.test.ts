/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  describe,
  it,
  expect,
  vi,
  beforeAll,
  beforeEach,
  afterEach,
} from 'vitest';

const { mockUndiciFetch } = vi.hoisted(() => ({
  mockUndiciFetch: vi.fn(),
}));

vi.mock('undici', () => {
  class MockAgent {
    options: UndiciOptions;
    constructor(options: UndiciOptions) {
      this.options = options;
    }
  }

  return {
    Agent: MockAgent,
    fetch: mockUndiciFetch,
  };
});

import {
  buildRuntimeFetchOptions,
  preloadRuntimeFetchModule,
  resetDispatcherCache,
} from './runtimeFetchOptions.js';

type UndiciOptions = Record<string, unknown>;

const getDispatcherOptions = (result: unknown): UndiciOptions | undefined =>
  (
    result as {
      fetchOptions?: { dispatcher?: { options?: UndiciOptions } };
    }
  ).fetchOptions?.dispatcher?.options;

// The sync option builders require undici to be preloaded (issue #7264);
// vi.mock('undici') intercepts the dynamic import, so this loads the mock.
beforeAll(async () => {
  await preloadRuntimeFetchModule();
});

describe('buildRuntimeFetchOptions (node runtime)', () => {
  const savedEnv = {
    HTTP_PROXY: process.env['HTTP_PROXY'],
    HTTPS_PROXY: process.env['HTTPS_PROXY'],
  };

  beforeEach(() => {
    resetDispatcherCache();
    mockUndiciFetch.mockReset();
  });

  afterEach(() => {
    for (const [key, value] of Object.entries(savedEnv)) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  });

  it('returns an Agent with disabled timeouts', () => {
    const result = buildRuntimeFetchOptions();
    expect(getDispatcherOptions(result)).toEqual({
      headersTimeout: 0,
      bodyTimeout: 0,
      keepAliveTimeout: 60_000,
    });
  });

  it('reuses the cached dispatcher across calls', () => {
    const first = buildRuntimeFetchOptions().fetchOptions?.dispatcher;
    const second = buildRuntimeFetchOptions().fetchOptions?.dispatcher;
    expect(first).toBeDefined();
    expect(second).toBe(first);
  });

  it('ignores proxy environment variables', () => {
    process.env['HTTP_PROXY'] = 'http://proxy.example.com:8080';
    process.env['HTTPS_PROXY'] = 'http://proxy.example.com:8080';

    const options = getDispatcherOptions(buildRuntimeFetchOptions());

    expect(options).toEqual({
      headersTimeout: 0,
      bodyTimeout: 0,
      keepAliveTimeout: 60_000,
    });
  });

  it('routes requests through the bundled undici fetch with redirect: error', async () => {
    const response = new Response('ok');
    mockUndiciFetch.mockResolvedValue(response);
    const { fetch } = buildRuntimeFetchOptions();

    await expect(
      fetch('http://127.0.0.1:11434/v1/chat/completions', {
        method: 'POST',
        body: '{}',
      }),
    ).resolves.toBe(response);

    expect(mockUndiciFetch).toHaveBeenCalledWith(
      'http://127.0.0.1:11434/v1/chat/completions',
      { method: 'POST', body: '{}', redirect: 'error' },
    );
  });

  it.each(['follow', 'manual'] as const)(
    'overrides a caller-supplied redirect: %s with redirect: error',
    async (redirect) => {
      mockUndiciFetch.mockResolvedValue(new Response('ok'));
      const { fetch } = buildRuntimeFetchOptions();

      await fetch('http://127.0.0.1:11434/v1/models', { redirect });

      expect(mockUndiciFetch).toHaveBeenCalledWith(
        'http://127.0.0.1:11434/v1/models',
        { redirect: 'error' },
      );
    },
  );
});

describe('TLS verification', () => {
  const saved = process.env['NODE_TLS_REJECT_UNAUTHORIZED'];

  beforeEach(() => {
    resetDispatcherCache();
  });

  afterEach(() => {
    if (saved === undefined) {
      delete process.env['NODE_TLS_REJECT_UNAUTHORIZED'];
    } else {
      process.env['NODE_TLS_REJECT_UNAUTHORIZED'] = saved;
    }
  });

  it('never turns certificate verification off on the Agent', () => {
    // The removed --insecure switch read these; nothing reads them now.
    process.env['NODE_TLS_REJECT_UNAUTHORIZED'] = '0';
    vi.stubEnv('QWEN_TLS_INSECURE', '1');
    try {
      const options = getDispatcherOptions(buildRuntimeFetchOptions());
      expect(options?.['connect']).toBeUndefined();
    } finally {
      vi.unstubAllEnvs();
    }
  });
});

describe('requireUndici guard', () => {
  it('throws an actionable error when a sync builder runs before preload', async () => {
    vi.resetModules();
    const fresh = await import('./runtimeFetchOptions.js');
    expect(() => fresh.buildRuntimeFetchOptions()).toThrow(
      /undici is not loaded yet; await preloadRuntimeFetchModule\(\)/,
    );
  });
});
