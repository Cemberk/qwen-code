/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  createContentGenerator,
  createContentGeneratorConfig,
  AuthType,
  preloadContentGenerator,
  resetPreloadedContentGenerator,
  validateModelConfig,
} from './contentGenerator.js';
import type { Config } from '../config/config.js';
import type {
  ContentGenerator,
  ContentGeneratorConfig,
} from './contentGenerator.js';
import { InvalidBaseUrlError } from '../models/modelConfigErrors.js';

const LOCAL_BASE_URL = 'http://127.0.0.1:11434/v1';

const openaiMockState = vi.hoisted(() => ({
  generatorError: null as Error | null,
  createCount: 0,
}));

const openaiLoggerMockState = vi.hoisted(() => ({
  constructorCalls: [] as Array<{
    customLogDir: string | undefined;
    cwd: string | undefined;
  }>,
}));

vi.mock('./openaiContentGenerator/index.js', () => ({
  createOpenAIContentGenerator: () => {
    if (openaiMockState.generatorError) {
      throw openaiMockState.generatorError;
    }
    openaiMockState.createCount += 1;
    return {
      generateContent: async () => ({}),
      generateContentStream: async () =>
        (async function* () {
          yield {};
        })(),
      embedContent: async () => ({ embeddings: [] }),
    };
  },
}));

vi.mock('../utils/openaiLogger.js', () => ({
  OpenAILogger: class {
    constructor(customLogDir?: string, cwd?: string) {
      openaiLoggerMockState.constructorCalls.push({ customLogDir, cwd });
    }
  },
}));

describe('createContentGenerator', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    openaiMockState.generatorError = null;
    openaiMockState.createCount = 0;
    openaiLoggerMockState.constructorCalls = [];
  });

  it('loads a provider once across concurrent first calls', async () => {
    const mockConfig = {
      getContentGeneratorConfig: () => ({}),
      getCliVersion: () => '1.0.0',
      getTelemetryEnabled: () => false,
      getSessionId: () => 'test-session',
    } as unknown as Config;
    const generator = await createContentGenerator(
      {
        model: 'test-model',
        apiKey: 'test-key',
        baseUrl: LOCAL_BASE_URL,
        authType: AuthType.USE_OPENAI,
      },
      mockConfig,
    );

    expect(openaiMockState.createCount).toBe(0);
    await Promise.all([
      generator.embedContent({ model: 'test-model', contents: 'one' }),
      generator.embedContent({ model: 'test-model', contents: 'two' }),
    ]);
    expect(openaiMockState.createCount).toBe(1);
  });

  it('does not preload non-lazy content generators', async () => {
    const generator: ContentGenerator = {
      generateContent: vi.fn(),
      generateContentStream: vi.fn(),
      embedContent: vi.fn(),
    };

    await expect(preloadContentGenerator(generator)).resolves.toBeUndefined();
    resetPreloadedContentGenerator(generator);
    expect(generator.generateContent).not.toHaveBeenCalled();
    expect(generator.generateContentStream).not.toHaveBeenCalled();
    expect(generator.embedContent).not.toHaveBeenCalled();
  });

  it('loads a provider once across concurrent preload and first use', async () => {
    const mockConfig = {
      getContentGeneratorConfig: () => ({}),
      getCliVersion: () => '1.0.0',
      getTelemetryEnabled: () => false,
      getSessionId: () => 'test-session',
    } as unknown as Config;
    const generator = await createContentGenerator(
      {
        model: 'test-model',
        apiKey: 'test-key',
        baseUrl: LOCAL_BASE_URL,
        authType: AuthType.USE_OPENAI,
      },
      mockConfig,
    );

    await Promise.all([
      preloadContentGenerator(generator),
      generator.embedContent({ model: 'test-model', contents: 'hello' }),
    ]);

    expect(openaiMockState.createCount).toBe(1);
  });

  it('discards an unused preload after session configuration changes', async () => {
    const mockConfig = {
      getContentGeneratorConfig: () => ({}),
      getCliVersion: () => '1.0.0',
      getTelemetryEnabled: () => false,
      getSessionId: () => 'test-session',
    } as unknown as Config;
    const generator = await createContentGenerator(
      {
        model: 'test-model',
        apiKey: 'test-key',
        baseUrl: LOCAL_BASE_URL,
        authType: AuthType.USE_OPENAI,
      },
      mockConfig,
    );

    await preloadContentGenerator(generator);
    resetPreloadedContentGenerator(generator);
    await generator.embedContent({
      model: 'test-model',
      contents: 'hello',
    });

    expect(openaiMockState.createCount).toBe(2);
  });

  it('does not discard a generator that has already been used', async () => {
    const mockConfig = {
      getContentGeneratorConfig: () => ({}),
      getCliVersion: () => '1.0.0',
      getTelemetryEnabled: () => false,
      getSessionId: () => 'test-session',
    } as unknown as Config;
    const generator = await createContentGenerator(
      {
        model: 'test-model',
        apiKey: 'test-key',
        baseUrl: LOCAL_BASE_URL,
        authType: AuthType.USE_OPENAI,
      },
      mockConfig,
    );

    await preloadContentGenerator(generator);
    await generator.embedContent({
      model: 'test-model',
      contents: 'first',
    });
    resetPreloadedContentGenerator(generator);
    await generator.embedContent({
      model: 'test-model',
      contents: 'second',
    });

    expect(openaiMockState.createCount).toBe(1);
  });

  it('rebuilds OpenAI logging with the relocated working directory', async () => {
    let workingDir = '/workspace/before';
    const mockConfig = {
      getContentGeneratorConfig: () => ({}),
      getCliVersion: () => '1.0.0',
      getTelemetryEnabled: () => false,
      getSessionId: () => 'test-session',
      getWorkingDir: () => workingDir,
    } as unknown as Config;
    const generator = await createContentGenerator(
      {
        model: 'test-model',
        apiKey: 'test-key',
        baseUrl: LOCAL_BASE_URL,
        authType: AuthType.USE_OPENAI,
        enableOpenAILogging: true,
        openAILoggingDir: 'logs',
      },
      mockConfig,
    );

    await preloadContentGenerator(generator);
    workingDir = '/workspace/after';
    resetPreloadedContentGenerator(generator);
    await generator.embedContent({
      model: 'test-model',
      contents: 'hello',
    });

    expect(openaiLoggerMockState.constructorCalls).toEqual([
      { customLogDir: 'logs', cwd: '/workspace/before' },
      { customLogDir: 'logs', cwd: '/workspace/after' },
    ]);
  });

  it('memoizes preload rejection for the first use', async () => {
    const mockConfig = {
      getContentGeneratorConfig: () => ({}),
      getCliVersion: () => '1.0.0',
      getTelemetryEnabled: () => false,
      getSessionId: () => 'test-session',
    } as unknown as Config;
    const moduleError = new Error(
      "Cannot find module './openaiContentGenerator-STALE.js'",
    );
    (moduleError as NodeJS.ErrnoException).code = 'ERR_MODULE_NOT_FOUND';
    openaiMockState.generatorError = moduleError;
    const generator = await createContentGenerator(
      {
        model: 'test-model',
        apiKey: 'test-key',
        baseUrl: LOCAL_BASE_URL,
        authType: AuthType.USE_OPENAI,
      },
      mockConfig,
    );

    const preloadError = await preloadContentGenerator(generator).catch(
      (error: unknown) => error,
    );
    const firstUseError = await generator
      .embedContent({ model: 'test-model', contents: 'hello' })
      .catch((error: unknown) => error);

    expect(preloadError).toBeInstanceOf(Error);
    expect(firstUseError).toBe(preloadError);
    expect((preloadError as Error).cause).toBe(moduleError);
  });

  it('should throw on an unsupported authType', async () => {
    const mockConfig = {
      getContentGeneratorConfig: () => ({}),
      getCliVersion: () => '1.0.0',
      getTelemetryEnabled: () => false,
      getSessionId: () => 'test-session',
    } as unknown as Config;

    await expect(
      createContentGenerator(
        {
          model: 'test-model',
          apiKey: 'test-key',
          baseUrl: LOCAL_BASE_URL,
          authType: 'bogus',
        } as unknown as Parameters<typeof createContentGenerator>[0],
        mockConfig,
      ),
    ).rejects.toThrow("Auth type 'bogus' is not supported");
  });

  it.each([
    ['a cloud base URL', 'https://api.openai.com/v1', 'is not allowed'],
    ['a missing base URL', undefined, 'No model server base URL'],
  ])('rejects %s before loading a provider', async (_label, baseUrl, error) => {
    const mockConfig = {
      getContentGeneratorConfig: () => ({}),
    } as unknown as Config;

    await expect(
      createContentGenerator(
        {
          model: 'test-model',
          apiKey: 'test-key',
          baseUrl,
          authType: AuthType.USE_OPENAI,
        },
        mockConfig,
      ),
    ).rejects.toThrow(error);
    expect(openaiMockState.createCount).toBe(0);
  });
});

describe('createContentGenerator - ERR_MODULE_NOT_FOUND handling', () => {
  const mockConfig = {
    getContentGeneratorConfig: () => ({}),
    getCliVersion: () => '1.0.0',
    getTelemetryEnabled: () => false,
    getSessionId: () => 'test-session',
  } as unknown as Config;

  beforeEach(() => {
    openaiMockState.generatorError = null;
    openaiMockState.createCount = 0;
    openaiLoggerMockState.constructorCalls = [];
    vi.resetModules();
  });

  it('should re-throw non-module errors unchanged', async () => {
    openaiMockState.generatorError = new Error('network timeout');

    const generator = await createContentGenerator(
      {
        model: 'test-model',
        apiKey: 'test-key',
        baseUrl: LOCAL_BASE_URL,
        authType: AuthType.USE_OPENAI,
      },
      mockConfig,
    );
    await expect(
      generator.embedContent({ model: 'test-model', contents: 'hello' }),
    ).rejects.toThrow('network timeout');
  });

  it('should throw friendly restart message with cause when dynamic import fails with ERR_MODULE_NOT_FOUND', async () => {
    const moduleError = new Error(
      "Cannot find module './openaiContentGenerator-STALE.js'",
    );
    (moduleError as NodeJS.ErrnoException).code = 'ERR_MODULE_NOT_FOUND';
    vi.doMock('./openaiContentGenerator/index.js', () => {
      throw moduleError;
    });
    const { createContentGenerator: createWithMissingProvider } = await import(
      './contentGenerator.js'
    );

    try {
      const generator = await createWithMissingProvider(
        {
          model: 'test-model',
          apiKey: 'test-key',
          baseUrl: LOCAL_BASE_URL,
          authType: AuthType.USE_OPENAI,
        },
        mockConfig,
      );
      await generator.embedContent({ model: 'test-model', contents: 'hello' });
      expect.unreachable('should have thrown');
    } catch (error) {
      expect(error).toBeInstanceOf(Error);
      const err = error as Error;
      expect(err.message).toMatch(
        /updated in the background and needs to be restarted/,
      );
      expect(err.cause).toBe(moduleError);
    }
  });
});

describe('createContentGeneratorConfig', () => {
  it('preserves provided fields and sets the authType', () => {
    const cfg = createContentGeneratorConfig(
      {} as Config,
      AuthType.USE_OPENAI,
      {
        model: 'qwen3:8b',
        apiKey: 'local-key',
        baseUrl: LOCAL_BASE_URL,
      },
    );

    expect(cfg.authType).toBe(AuthType.USE_OPENAI);
    expect(cfg.model).toBe('qwen3:8b');
    expect(cfg.apiKey).toBe('local-key');
    expect(cfg.baseUrl).toBe(LOCAL_BASE_URL);
  });

  it('does not fill in a default base URL', () => {
    expect(() =>
      createContentGeneratorConfig({} as Config, AuthType.USE_OPENAI, {
        model: 'qwen3:8b',
        apiKey: 'local-key',
      }),
    ).toThrow('No model server base URL is configured');
  });
});

describe('validateModelConfig - base URL', () => {
  const validConfig: ContentGeneratorConfig = {
    authType: AuthType.USE_OPENAI,
    model: 'qwen3:8b',
    apiKey: 'local-key',
    baseUrl: LOCAL_BASE_URL,
  };

  it.each([
    'http://127.0.0.1:11434/v1',
    'http://localhost:1234/v1',
    'http://[::1]:8000/v1',
  ])('accepts the loopback base URL %s', (baseUrl) => {
    expect(validateModelConfig({ ...validConfig, baseUrl })).toEqual({
      valid: true,
      errors: [],
    });
    expect(validateModelConfig({ ...validConfig, baseUrl }, true).valid).toBe(
      true,
    );
  });

  it.each(['https://api.openai.com/v1', 'http://192.168.1.5:8000/v1'])(
    'rejects the non-loopback base URL %s',
    (baseUrl) => {
      const result = validateModelConfig({ ...validConfig, baseUrl });

      expect(result.valid).toBe(false);
      expect(result.errors).toHaveLength(1);
      expect(result.errors[0]).toBeInstanceOf(InvalidBaseUrlError);
      expect(result.errors[0]).toMatchObject({ code: 'INVALID_BASE_URL' });
      expect(result.errors[0].message).toContain(
        'the host must be 127.0.0.1, ::1 or localhost',
      );
    },
  );

  it.each([undefined, '', '   '])(
    'rejects a missing base URL (%j) instead of defaulting it',
    (baseUrl) => {
      const config = { ...validConfig, baseUrl };
      const result = validateModelConfig(config);

      expect(result.valid).toBe(false);
      expect(result.errors).toHaveLength(1);
      expect(result.errors[0]).toBeInstanceOf(InvalidBaseUrlError);
      expect(result.errors[0].message).toContain(
        'No model server base URL is configured',
      );
      expect(config.baseUrl).toBe(baseUrl);
    },
  );

  it('rejects an auth type other than openai', () => {
    const result = validateModelConfig({
      ...validConfig,
      authType: 'anthropic' as AuthType,
    });

    expect(result.valid).toBe(false);
    expect(result.errors[0].message).toContain(
      "Auth type 'anthropic' is not supported",
    );
  });
});
