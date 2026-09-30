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
  isTlsVerificationDisabled,
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

describe('TLS verification opt-out (insecure)', () => {
  const savedEnv = {
    QWEN_TLS_INSECURE: process.env['QWEN_TLS_INSECURE'],
    NODE_TLS_REJECT_UNAUTHORIZED: process.env['NODE_TLS_REJECT_UNAUTHORIZED'],
  };

  beforeEach(() => {
    resetDispatcherCache();
    delete process.env['QWEN_TLS_INSECURE'];
    delete process.env['NODE_TLS_REJECT_UNAUTHORIZED'];
  });

  afterEach(() => {
    if (savedEnv.QWEN_TLS_INSECURE === undefined) {
      delete process.env['QWEN_TLS_INSECURE'];
    } else {
      process.env['QWEN_TLS_INSECURE'] = savedEnv.QWEN_TLS_INSECURE;
    }
    if (savedEnv.NODE_TLS_REJECT_UNAUTHORIZED === undefined) {
      delete process.env['NODE_TLS_REJECT_UNAUTHORIZED'];
    } else {
      process.env['NODE_TLS_REJECT_UNAUTHORIZED'] =
        savedEnv.NODE_TLS_REJECT_UNAUTHORIZED;
    }
  });

  it('does not set connect options on the Agent by default', () => {
    const options = getDispatcherOptions(buildRuntimeFetchOptions());
    expect(options?.['connect']).toBeUndefined();
  });

  it('disables verification on the Agent via QWEN_TLS_INSECURE', () => {
    process.env['QWEN_TLS_INSECURE'] = '1';
    const options = getDispatcherOptions(buildRuntimeFetchOptions());
    expect(options?.['connect']).toEqual({ rejectUnauthorized: false });
  });

  it('honors NODE_TLS_REJECT_UNAUTHORIZED=0 for parity', () => {
    process.env['NODE_TLS_REJECT_UNAUTHORIZED'] = '0';
    const options = getDispatcherOptions(buildRuntimeFetchOptions());
    expect(options?.['connect']).toEqual({ rejectUnauthorized: false });
  });

  it('ignores falsy QWEN_TLS_INSECURE values', () => {
    process.env['QWEN_TLS_INSECURE'] = '0';
    const options = getDispatcherOptions(buildRuntimeFetchOptions());
    expect(options?.['connect']).toBeUndefined();
  });

  it('rebuilds the cached dispatcher when the insecure setting changes', () => {
    const secure = buildRuntimeFetchOptions().fetchOptions?.dispatcher;
    process.env['QWEN_TLS_INSECURE'] = '1';
    const insecure = buildRuntimeFetchOptions().fetchOptions?.dispatcher;
    expect(insecure).not.toBe(secure);
  });

  describe('isTlsVerificationDisabled', () => {
    it.each(['1', 'true', 'TRUE', 'Yes', 'on', '  1  '])(
      'treats QWEN_TLS_INSECURE=%j as enabled',
      (value) => {
        process.env['QWEN_TLS_INSECURE'] = value;
        expect(isTlsVerificationDisabled()).toBe(true);
      },
    );

    it.each(['0', 'false', 'no', 'off', '', 'enabled'])(
      'treats QWEN_TLS_INSECURE=%j as disabled',
      (value) => {
        process.env['QWEN_TLS_INSECURE'] = value;
        expect(isTlsVerificationDisabled()).toBe(false);
      },
    );

    it('honors NODE_TLS_REJECT_UNAUTHORIZED=0', () => {
      process.env['NODE_TLS_REJECT_UNAUTHORIZED'] = '0';
      expect(isTlsVerificationDisabled()).toBe(true);
    });

    it('ignores NODE_TLS_REJECT_UNAUTHORIZED values other than "0"', () => {
      process.env['NODE_TLS_REJECT_UNAUTHORIZED'] = '1';
      expect(isTlsVerificationDisabled()).toBe(false);
    });

    it('returns false when neither variable is set', () => {
      expect(isTlsVerificationDisabled()).toBe(false);
    });
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
