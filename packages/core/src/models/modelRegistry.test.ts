/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  ModelRegistry,
  modelRegistryKey,
  validateModelProvidersConfig,
} from './modelRegistry.js';
import { AuthType } from '../core/contentGenerator.js';
import type { ModelProvidersConfig } from './types.js';

const debugLoggerWarnSpy = vi.hoisted(() => vi.fn());

vi.mock('../utils/debugLogger.js', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('../utils/debugLogger.js')>();
  return {
    ...actual,
    createDebugLogger: () => ({
      debug: vi.fn(),
      info: vi.fn(),
      warn: debugLoggerWarnSpy,
      error: vi.fn(),
      isEnabled: () => false,
    }),
  };
});

const LOCAL_URL = 'http://127.0.0.1:11434/v1';
const OTHER_LOCAL_URL = 'http://localhost:1234/v1';
const THIRD_LOCAL_URL = 'http://[::1]:8000/v1';

beforeEach(() => {
  debugLoggerWarnSpy.mockClear();
});

describe('ModelRegistry', () => {
  describe('initialization', () => {
    it('should initialize with empty config', () => {
      const registry = new ModelRegistry();
      expect(registry.getModelsForAuthType(AuthType.USE_OPENAI)).toEqual([]);
      expect(
        registry.getDefaultModelForAuthType(AuthType.USE_OPENAI),
      ).toBeUndefined();
    });

    it('should not register any built-in model', () => {
      const registry = new ModelRegistry();
      expect(
        registry.getModel(AuthType.USE_OPENAI, 'coder-model'),
      ).toBeUndefined();
    });

    it('should initialize with custom models config', () => {
      const modelProvidersConfig: ModelProvidersConfig = {
        openai: [
          {
            id: 'qwen3-coder:30b',
            name: 'Qwen3 Coder',
            baseUrl: LOCAL_URL,
          },
        ],
      };

      const registry = new ModelRegistry(modelProvidersConfig);

      const openaiModels = registry.getModelsForAuthType(AuthType.USE_OPENAI);
      expect(openaiModels.length).toBe(1);
      expect(openaiModels[0].id).toBe('qwen3-coder:30b');
    });
  });

  describe('getModelsForAuthType', () => {
    let registry: ModelRegistry;

    beforeEach(() => {
      const modelProvidersConfig: ModelProvidersConfig = {
        openai: [
          {
            id: 'gpt-4-turbo',
            name: 'GPT-4 Turbo',
            description: 'Most capable GPT-4',
            baseUrl: LOCAL_URL,
            capabilities: { vision: true },
          },
          {
            id: 'gpt-3.5-turbo',
            name: 'GPT-3.5 Turbo',
            baseUrl: OTHER_LOCAL_URL,
            capabilities: { vision: false },
          },
        ],
      };
      registry = new ModelRegistry(modelProvidersConfig);
    });

    it('should return the configured models', () => {
      const models = registry.getModelsForAuthType(AuthType.USE_OPENAI);
      expect(models.length).toBe(2);
    });

    it('should return AvailableModel format with correct fields', () => {
      const models = registry.getModelsForAuthType(AuthType.USE_OPENAI);
      const gpt4 = models.find((m) => m.id === 'gpt-4-turbo');

      expect(gpt4).toBeDefined();
      expect(gpt4?.label).toBe('GPT-4 Turbo');
      expect(gpt4?.description).toBe('Most capable GPT-4');
      expect(gpt4?.isVision).toBe(true);
      expect(gpt4?.authType).toBe(AuthType.USE_OPENAI);
      expect(gpt4?.baseUrl).toBe(LOCAL_URL);
      expect(gpt4?.registryBaseUrl).toBe(LOCAL_URL);
      expect(
        models.find((m) => m.id === 'gpt-3.5-turbo')?.registryBaseUrl,
      ).toBe(OTHER_LOCAL_URL);
    });
  });

  describe('getModel', () => {
    let registry: ModelRegistry;

    beforeEach(() => {
      const modelProvidersConfig: ModelProvidersConfig = {
        openai: [
          {
            id: 'gpt-4-turbo',
            name: 'GPT-4 Turbo',
            baseUrl: LOCAL_URL,
            generationConfig: {
              streamIdleTimeoutMs: 600000,
              samplingParams: {
                temperature: 0.8,
                max_tokens: 4096,
              },
            },
          },
        ],
      };
      registry = new ModelRegistry(modelProvidersConfig);
    });

    it('should return resolved model config', () => {
      const model = registry.getModel(AuthType.USE_OPENAI, 'gpt-4-turbo');

      expect(model).toBeDefined();
      expect(model?.id).toBe('gpt-4-turbo');
      expect(model?.name).toBe('GPT-4 Turbo');
      expect(model?.authType).toBe(AuthType.USE_OPENAI);
      expect(model?.baseUrl).toBe(LOCAL_URL);
    });

    it('should preserve generationConfig without applying defaults', () => {
      const model = registry.getModel(AuthType.USE_OPENAI, 'gpt-4-turbo');

      expect(model?.generationConfig.samplingParams?.temperature).toBe(0.8);
      expect(model?.generationConfig.samplingParams?.max_tokens).toBe(4096);
      expect(model?.generationConfig.streamIdleTimeoutMs).toBe(600000);
      // No defaults are applied - only the configured values are present
      expect(model?.generationConfig.samplingParams?.top_p).toBeUndefined();
      expect(model?.generationConfig.timeout).toBeUndefined();
    });

    it('should return undefined for non-existent model', () => {
      const model = registry.getModel(AuthType.USE_OPENAI, 'non-existent');
      expect(model).toBeUndefined();
    });

    it('matches an entry by its exact baseUrl only', () => {
      expect(
        registry.getModel(AuthType.USE_OPENAI, 'gpt-4-turbo', LOCAL_URL),
      ).toBeDefined();
      expect(
        registry.getModel(AuthType.USE_OPENAI, 'gpt-4-turbo', OTHER_LOCAL_URL),
      ).toBeUndefined();
    });

    it('returns undefined for the implicit (null) route', () => {
      expect(
        registry.getModel(AuthType.USE_OPENAI, 'gpt-4-turbo', null),
      ).toBeUndefined();
    });
  });

  describe('modalities auto-fill', () => {
    // Sub-agents that read straight from the registry (e.g. via
    // getResolvedModel) need the registry to populate modalities for them;
    // otherwise they inherit the parent session's modalities and fail the
    // image/pdf/video gates set on tools like ReadFile.
    it('populates modalities from the model name when not provided', () => {
      const registry = new ModelRegistry({
        openai: [
          {
            id: 'gpt-4-turbo',
            name: 'GPT-4 Turbo',
            baseUrl: LOCAL_URL,
            generationConfig: {},
          },
        ],
      });

      const model = registry.getModel(AuthType.USE_OPENAI, 'gpt-4-turbo');
      expect(model?.generationConfig.modalities).toEqual({ image: true });
    });

    it('preserves caller-provided modalities verbatim', () => {
      const explicitModalities = { image: true, pdf: true };
      const registry = new ModelRegistry({
        openai: [
          {
            id: 'gpt-4-turbo',
            name: 'GPT-4 Turbo',
            baseUrl: LOCAL_URL,
            generationConfig: { modalities: explicitModalities },
          },
        ],
      });

      const model = registry.getModel(AuthType.USE_OPENAI, 'gpt-4-turbo');
      expect(model?.generationConfig.modalities).toEqual(explicitModalities);
    });

    it('returns text-only ({}) for models with no multimodal default', () => {
      const registry = new ModelRegistry({
        openai: [
          {
            id: 'qwen3-coder-plus',
            name: 'Qwen3 Coder Plus',
            baseUrl: LOCAL_URL,
            generationConfig: {},
          },
        ],
      });

      const model = registry.getModel(AuthType.USE_OPENAI, 'qwen3-coder-plus');
      expect(model?.generationConfig.modalities).toEqual({});
    });

    it('populates MiniMax-M3 metadata when entries omit generationConfig', () => {
      const registry = new ModelRegistry({
        openai: [
          {
            id: 'MiniMax-M3',
            name: 'MiniMax-M3',
            baseUrl: LOCAL_URL,
          },
        ],
      });

      const model = registry.getModel(AuthType.USE_OPENAI, 'MiniMax-M3');
      expect(model?.generationConfig.modalities).toEqual({
        image: true,
        video: true,
      });

      const available = registry
        .getModelsForAuthType(AuthType.USE_OPENAI)
        .find((m) => m.id === 'MiniMax-M3');
      expect(available?.contextWindowSize).toBe(1000000);
      expect(available?.modalities).toEqual({
        image: true,
        video: true,
      });
    });

    it('normalizes stale MiniMax-M3 modalities to image + video', () => {
      const registry = new ModelRegistry({
        openai: [
          {
            id: 'MiniMax-M3',
            name: 'MiniMax-M3',
            baseUrl: LOCAL_URL,
            generationConfig: {
              modalities: { image: true },
            },
          },
        ],
      });

      const model = registry.getModel(AuthType.USE_OPENAI, 'MiniMax-M3');
      expect(model?.generationConfig.modalities).toEqual({
        image: true,
        video: true,
      });
    });
  });

  describe('hasModel', () => {
    let registry: ModelRegistry;

    beforeEach(() => {
      registry = new ModelRegistry({
        openai: [{ id: 'gpt-4', name: 'GPT-4', baseUrl: LOCAL_URL }],
      });
    });

    it('should return true for existing model', () => {
      expect(registry.hasModel(AuthType.USE_OPENAI, 'gpt-4')).toBe(true);
    });

    it('should return false for non-existent model', () => {
      expect(registry.hasModel(AuthType.USE_OPENAI, 'non-existent')).toBe(
        false,
      );
    });
  });

  describe('getDefaultModelForAuthType', () => {
    it('should return the first configured model', () => {
      const registry = new ModelRegistry({
        openai: [
          { id: 'gpt-4', name: 'GPT-4', baseUrl: LOCAL_URL },
          { id: 'gpt-3.5', name: 'GPT-3.5', baseUrl: LOCAL_URL },
        ],
      });

      const defaultModel = registry.getDefaultModelForAuthType(
        AuthType.USE_OPENAI,
      );
      expect(defaultModel?.id).toBe('gpt-4');
    });
  });

  describe('validation', () => {
    it('should throw error for model without id', () => {
      expect(
        () =>
          new ModelRegistry({
            openai: [{ id: '', name: 'No ID', baseUrl: LOCAL_URL }],
          }),
      ).toThrow('missing required field: id');
    });
  });

  describe('base URLs', () => {
    it('should use the configured loopback baseUrl', () => {
      const registry = new ModelRegistry({
        openai: [{ id: 'deepseek', name: 'DeepSeek', baseUrl: LOCAL_URL }],
      });

      const model = registry.getModel(AuthType.USE_OPENAI, 'deepseek');
      expect(model?.baseUrl).toBe(LOCAL_URL);
    });

    it('should never fill in a default baseUrl', () => {
      expect(
        () =>
          new ModelRegistry({
            openai: [{ id: 'gpt-4', name: 'GPT-4' }],
          }),
      ).toThrow('No model server base URL is configured');
    });
  });

  describe('duplicate model id handling', () => {
    it('should skip duplicate when both id and baseUrl match', () => {
      const registry = new ModelRegistry({
        openai: [
          { id: 'gpt-4', name: 'First', baseUrl: LOCAL_URL },
          { id: 'gpt-4', name: 'Second', baseUrl: LOCAL_URL },
          { id: 'gpt-3.5', name: 'GPT-3.5', baseUrl: LOCAL_URL },
        ],
      });

      const models = registry.getModelsForAuthType(AuthType.USE_OPENAI);
      expect(models.length).toBe(2);
      expect(registry.getModel(AuthType.USE_OPENAI, 'gpt-4')?.name).toBe(
        'First',
      );
      expect(debugLoggerWarnSpy).toHaveBeenCalledWith(
        expect.stringContaining('Duplicate model id "gpt-4"'),
      );
    });

    it('should allow same id with different baseUrls as distinct models', () => {
      const registry = new ModelRegistry({
        openai: [
          { id: 'gpt-4', name: 'GPT-4 Ollama', baseUrl: LOCAL_URL },
          { id: 'gpt-4', name: 'GPT-4 LM Studio', baseUrl: OTHER_LOCAL_URL },
        ],
      });

      const models = registry.getModelsForAuthType(AuthType.USE_OPENAI);
      expect(models.length).toBe(2);
      expect(models[0].label).toBe('GPT-4 Ollama');
      expect(models[1].label).toBe('GPT-4 LM Studio');
      expect(models.map((model) => model.registryBaseUrl)).toEqual([
        LOCAL_URL,
        OTHER_LOCAL_URL,
      ]);
    });

    it('should retrieve model by id and baseUrl precisely', () => {
      const registry = new ModelRegistry({
        openai: [
          { id: 'gpt-4', name: 'GPT-4 Ollama', baseUrl: LOCAL_URL },
          { id: 'gpt-4', name: 'GPT-4 LM Studio', baseUrl: OTHER_LOCAL_URL },
        ],
      });

      expect(
        registry.getModel(AuthType.USE_OPENAI, 'gpt-4', LOCAL_URL)?.name,
      ).toBe('GPT-4 Ollama');
      expect(
        registry.getModel(AuthType.USE_OPENAI, 'gpt-4', OTHER_LOCAL_URL)?.name,
      ).toBe('GPT-4 LM Studio');
    });

    it('should return first match when getModel is called without baseUrl', () => {
      const registry = new ModelRegistry({
        openai: [
          { id: 'gpt-4', name: 'GPT-4 Ollama', baseUrl: LOCAL_URL },
          { id: 'gpt-4', name: 'GPT-4 LM Studio', baseUrl: OTHER_LOCAL_URL },
        ],
      });

      expect(registry.getModel(AuthType.USE_OPENAI, 'gpt-4')?.name).toBe(
        'GPT-4 Ollama',
      );
    });

    it('should handle hasModel with and without baseUrl', () => {
      const registry = new ModelRegistry({
        openai: [
          { id: 'gpt-4', name: 'GPT-4 Ollama', baseUrl: LOCAL_URL },
          { id: 'gpt-4', name: 'GPT-4 LM Studio', baseUrl: OTHER_LOCAL_URL },
        ],
      });

      expect(registry.hasModel(AuthType.USE_OPENAI, 'gpt-4')).toBe(true);
      expect(registry.hasModel(AuthType.USE_OPENAI, 'gpt-4', LOCAL_URL)).toBe(
        true,
      );
      expect(
        registry.hasModel(AuthType.USE_OPENAI, 'gpt-4', OTHER_LOCAL_URL),
      ).toBe(true);
      expect(
        registry.hasModel(AuthType.USE_OPENAI, 'gpt-4', THIRD_LOCAL_URL),
      ).toBe(false);
    });

    it('should handle multiple duplicate ids', () => {
      const registry = new ModelRegistry({
        openai: [
          { id: 'model-a', name: 'Model A First', baseUrl: LOCAL_URL },
          { id: 'model-a', name: 'Model A Second', baseUrl: LOCAL_URL },
          { id: 'model-b', name: 'Model B First', baseUrl: LOCAL_URL },
          { id: 'model-b', name: 'Model B Second', baseUrl: LOCAL_URL },
          { id: 'model-c', name: 'Model C', baseUrl: LOCAL_URL },
        ],
      });

      const models = registry.getModelsForAuthType(AuthType.USE_OPENAI);
      expect(models.length).toBe(3);

      expect(registry.getModel(AuthType.USE_OPENAI, 'model-a')?.name).toBe(
        'Model A First',
      );
      expect(registry.getModel(AuthType.USE_OPENAI, 'model-b')?.name).toBe(
        'Model B First',
      );
      expect(registry.getModel(AuthType.USE_OPENAI, 'model-c')?.name).toBe(
        'Model C',
      );
    });
  });

  describe('reloadModels', () => {
    it('should reload models from new config', () => {
      const registry = new ModelRegistry({
        openai: [{ id: 'gpt-4', name: 'GPT-4', baseUrl: LOCAL_URL }],
      });

      expect(registry.getModelsForAuthType(AuthType.USE_OPENAI).length).toBe(1);
      expect(registry.getModel(AuthType.USE_OPENAI, 'gpt-4')).toBeDefined();
      expect(registry.getModel(AuthType.USE_OPENAI, 'gpt-3.5')).toBeUndefined();

      registry.reloadModels({
        openai: [{ id: 'gpt-3.5', name: 'GPT-3.5', baseUrl: LOCAL_URL }],
      });

      // After reload, only new models should exist
      expect(registry.getModelsForAuthType(AuthType.USE_OPENAI).length).toBe(1);
      expect(registry.getModel(AuthType.USE_OPENAI, 'gpt-4')).toBeUndefined();
      expect(registry.getModel(AuthType.USE_OPENAI, 'gpt-3.5')).toBeDefined();
    });

    it('should clear configured models when reloaded with empty config', () => {
      const registry = new ModelRegistry({
        openai: [{ id: 'gpt-4', name: 'GPT-4', baseUrl: LOCAL_URL }],
      });

      registry.reloadModels({});

      expect(registry.getModelsForAuthType(AuthType.USE_OPENAI)).toEqual([]);
    });

    it('should clear configured models when reloaded with undefined config', () => {
      const registry = new ModelRegistry({
        openai: [{ id: 'gpt-4', name: 'GPT-4', baseUrl: LOCAL_URL }],
      });

      registry.reloadModels(undefined);

      expect(registry.getModelsForAuthType(AuthType.USE_OPENAI)).toEqual([]);
    });

    it('keeps the previous registry when a replacement model is invalid', () => {
      const registry = new ModelRegistry({
        openai: [{ id: 'old-model', baseUrl: LOCAL_URL }],
      });

      expect(() =>
        registry.reloadModels({
          openai: [
            { id: 'new-model', baseUrl: LOCAL_URL },
            { id: '', baseUrl: LOCAL_URL },
          ],
        }),
      ).toThrow('missing required field: id');

      expect(registry.getModel(AuthType.USE_OPENAI, 'old-model')).toBeDefined();
      expect(
        registry.getModel(AuthType.USE_OPENAI, 'new-model'),
      ).toBeUndefined();
    });

    it('keeps the previous registry when a replacement names a cloud endpoint', () => {
      const boot: ModelProvidersConfig = {
        openai: [{ id: 'old-model', baseUrl: LOCAL_URL }],
      };
      const registry = new ModelRegistry(boot);

      expect(() =>
        registry.reloadModels({
          openai: [{ id: 'gpt-4o', baseUrl: 'https://api.openai.com/v1' }],
        }),
      ).toThrow('the host must be 127.0.0.1, ::1 or localhost');

      expect(registry.getModel(AuthType.USE_OPENAI, 'old-model')).toBeDefined();
      expect(registry.getModel(AuthType.USE_OPENAI, 'gpt-4o')).toBeUndefined();
      expect(registry.getModelProvidersConfig()).toBe(boot);
    });

    it('should correctly reload same-id different-baseUrl models', () => {
      const registry = new ModelRegistry({
        openai: [{ id: 'gpt-4', name: 'Old Ollama', baseUrl: LOCAL_URL }],
      });

      registry.reloadModels({
        openai: [
          { id: 'gpt-4', name: 'New Ollama', baseUrl: LOCAL_URL },
          { id: 'gpt-4', name: 'New LM Studio', baseUrl: OTHER_LOCAL_URL },
        ],
      });

      const models = registry.getModelsForAuthType(AuthType.USE_OPENAI);
      expect(models.length).toBe(2);
      expect(
        registry.getModel(AuthType.USE_OPENAI, 'gpt-4', LOCAL_URL)?.name,
      ).toBe('New Ollama');
      expect(
        registry.getModel(AuthType.USE_OPENAI, 'gpt-4', OTHER_LOCAL_URL)?.name,
      ).toBe('New LM Studio');
    });

    it('should handle reload replacing same-id entries when baseUrls change', () => {
      const registry = new ModelRegistry({
        openai: [
          { id: 'gpt-4', name: 'GPT-4 v1', baseUrl: LOCAL_URL },
          { id: 'gpt-4', name: 'GPT-4 Old', baseUrl: OTHER_LOCAL_URL },
        ],
      });

      registry.reloadModels({
        openai: [
          { id: 'gpt-4', name: 'GPT-4 v1 updated', baseUrl: LOCAL_URL },
          { id: 'gpt-4', name: 'GPT-4 New', baseUrl: THIRD_LOCAL_URL },
        ],
      });

      expect(registry.getModelsForAuthType(AuthType.USE_OPENAI).length).toBe(2);
      expect(
        registry.getModel(AuthType.USE_OPENAI, 'gpt-4', OTHER_LOCAL_URL),
      ).toBeUndefined();
      expect(
        registry.getModel(AuthType.USE_OPENAI, 'gpt-4', THIRD_LOCAL_URL)?.name,
      ).toBe('GPT-4 New');
    });

    it('should apply duplicate model id handling during reload', () => {
      const registry = new ModelRegistry();

      registry.reloadModels({
        openai: [
          { id: 'model-a', name: 'Model A First', baseUrl: LOCAL_URL },
          { id: 'model-a', name: 'Model A Second', baseUrl: LOCAL_URL },
        ],
      });

      const models = registry.getModelsForAuthType(AuthType.USE_OPENAI);
      expect(models.length).toBe(1);
      expect(registry.getModel(AuthType.USE_OPENAI, 'model-a')?.name).toBe(
        'Model A First',
      );
    });

    it('exposes the applied providers config so hot-reload can diff against registry state', () => {
      const boot: ModelProvidersConfig = {
        openai: [{ id: 'gpt-4', name: 'GPT-4', baseUrl: LOCAL_URL }],
      };
      const registry = new ModelRegistry(boot);
      expect(registry.getModelProvidersConfig()).toBe(boot);

      const next: ModelProvidersConfig = {
        openai: [{ id: 'gpt-5', name: 'GPT-5', baseUrl: LOCAL_URL }],
      };
      registry.reloadModels(next);
      // The copy in reloadModels is load-bearing: without it the hot-reload
      // gate in registerModelProvidersHotReload would diff against a stale
      // value and rebuild the registry on every settings event.
      expect(registry.getModelProvidersConfig()).toBe(next);

      registry.reloadModels(undefined);
      expect(registry.getModelProvidersConfig()).toBeUndefined();
    });
  });
});

describe('validateModelProvidersConfig', () => {
  it('accepts an openai provider whose models name loopback base URLs', () => {
    expect(() =>
      validateModelProvidersConfig({
        openai: [
          { id: 'a', baseUrl: LOCAL_URL },
          { id: 'b', baseUrl: OTHER_LOCAL_URL },
          { id: 'c', baseUrl: THIRD_LOCAL_URL },
          { id: 'd', baseUrl: 'https://localhost:8443/v1' },
        ],
      }),
    ).not.toThrow();
    expect(() => validateModelProvidersConfig(undefined)).not.toThrow();
    expect(() => validateModelProvidersConfig({})).not.toThrow();
  });

  it.each(['anthropic', 'gemini', 'qwen-oauth', 'openai-responses'])(
    'rejects the removed provider key "%s"',
    (providerId) => {
      const config = {
        [providerId]: [{ id: 'some-model', baseUrl: LOCAL_URL }],
      } as ModelProvidersConfig;
      expect(() => validateModelProvidersConfig(config)).toThrow(
        `modelProviders.${providerId} is not supported`,
      );
      expect(() => new ModelRegistry(config)).toThrow(
        `modelProviders.${providerId} is not supported`,
      );
    },
  );

  it('rejects wireApi "responses"', () => {
    const config = {
      openai: [{ id: 'gpt-5', baseUrl: LOCAL_URL, wireApi: 'responses' }],
    } as unknown as ModelProvidersConfig;
    expect(() => validateModelProvidersConfig(config)).toThrow(
      'wireApi "responses" is not supported',
    );
  });

  it('accepts an explicit wireApi "chat-completions"', () => {
    const config = {
      openai: [
        { id: 'gpt-5', baseUrl: LOCAL_URL, wireApi: 'chat-completions' },
      ],
    } as unknown as ModelProvidersConfig;
    expect(() => validateModelProvidersConfig(config)).not.toThrow();
  });

  it('rejects a model without a baseUrl', () => {
    expect(() =>
      validateModelProvidersConfig({ openai: [{ id: 'qwen3' }] }),
    ).toThrow(
      'No model server base URL is configured (from modelProviders.openai[0] (qwen3).baseUrl)',
    );
  });

  it('rejects a model with a blank baseUrl', () => {
    expect(() =>
      validateModelProvidersConfig({
        openai: [{ id: 'qwen3', baseUrl: '  ' }],
      }),
    ).toThrow('No model server base URL is configured');
  });

  it('rejects a model pointing at a cloud endpoint', () => {
    expect(() =>
      validateModelProvidersConfig({
        openai: [
          { id: 'local', baseUrl: LOCAL_URL },
          { id: 'gpt-4o', baseUrl: 'https://api.openai.com/v1' },
        ],
      }),
    ).toThrow(
      'Model server base URL "https://api.openai.com/v1" (from modelProviders.openai[1] (gpt-4o).baseUrl) is not allowed: the host must be 127.0.0.1, ::1 or localhost.',
    );
  });

  it('rejects a model pointing at a LAN address', () => {
    expect(() =>
      validateModelProvidersConfig({
        openai: [{ id: 'lan', baseUrl: 'http://192.168.1.5:8000/v1' }],
      }),
    ).toThrow('is not allowed');
  });
});

describe('modelRegistryKey', () => {
  it('should return id when no baseUrl is provided', () => {
    expect(modelRegistryKey('gpt-4')).toBe('gpt-4');
    expect(modelRegistryKey('gpt-4', undefined)).toBe('gpt-4');
    expect(modelRegistryKey('gpt-4', '')).toBe('gpt-4');
  });

  it('should return composite key when baseUrl is provided', () => {
    const key = modelRegistryKey('gpt-4', LOCAL_URL);
    expect(key).toBe(`gpt-4\0${LOCAL_URL}`);
    expect(key).not.toBe('gpt-4');
  });

  it('should produce different keys for same id with different baseUrls', () => {
    const key1 = modelRegistryKey('gpt-4', LOCAL_URL);
    const key2 = modelRegistryKey('gpt-4', OTHER_LOCAL_URL);
    expect(key1).not.toBe(key2);
  });

  it('should produce same key for identical id and baseUrl', () => {
    const key1 = modelRegistryKey('gpt-4', LOCAL_URL);
    const key2 = modelRegistryKey('gpt-4', LOCAL_URL);
    expect(key1).toBe(key2);
  });
});

describe('fastOnly and visionOnly flags', () => {
  it('should propagate fastOnly flag to AvailableModel', () => {
    const config: ModelProvidersConfig = {
      openai: [
        { id: 'gpt-4o', name: 'GPT-4o', baseUrl: LOCAL_URL },
        {
          id: 'gpt-4o-mini',
          name: 'GPT-4o Mini',
          baseUrl: LOCAL_URL,
          fastOnly: true,
        },
      ],
    };
    const registry = new ModelRegistry(config);
    const models = registry.getModelsForAuthType(AuthType.USE_OPENAI);
    expect(models.find((m) => m.id === 'gpt-4o')?.fastOnly).toBeUndefined();
    expect(models.find((m) => m.id === 'gpt-4o-mini')?.fastOnly).toBe(true);
  });

  it('should propagate visionOnly flag to AvailableModel', () => {
    const config: ModelProvidersConfig = {
      openai: [
        { id: 'gpt-4o', name: 'GPT-4o', baseUrl: LOCAL_URL },
        {
          id: 'vision-bridge',
          name: 'Vision Bridge',
          baseUrl: LOCAL_URL,
          visionOnly: true,
        },
      ],
    };
    const registry = new ModelRegistry(config);
    const models = registry.getModelsForAuthType(AuthType.USE_OPENAI);
    expect(models.find((m) => m.id === 'gpt-4o')?.visionOnly).toBeUndefined();
    expect(models.find((m) => m.id === 'vision-bridge')?.visionOnly).toBe(true);
  });

  it('should warn when both fastOnly and visionOnly are set', () => {
    const config: ModelProvidersConfig = {
      openai: [
        {
          id: 'unreachable-model',
          baseUrl: LOCAL_URL,
          fastOnly: true,
          visionOnly: true,
        },
      ],
    };
    const registry = new ModelRegistry(config);
    const models = registry.getModelsForAuthType(AuthType.USE_OPENAI);
    expect(models).toHaveLength(1);
    expect(models[0].fastOnly).toBe(true);
    expect(models[0].visionOnly).toBe(true);
    expect(debugLoggerWarnSpy).toHaveBeenCalledWith(
      expect.stringContaining('has both fastOnly and visionOnly set'),
    );
  });
});

describe('malformed modelProviders tolerance', () => {
  it('skips a non-array provider value instead of throwing (legacy V5 { protocol, models })', () => {
    // A settings file still in the reverted #5089 V5 shape can deliver a
    // { protocol, models } object here instead of a ModelConfig[].
    const registry = new ModelRegistry({
      openai: {
        protocol: 'openai',
        models: [{ id: 'gpt-4o', baseUrl: LOCAL_URL }],
      },
    } as unknown as ModelProvidersConfig);

    // Must not throw "models is not iterable"; the malformed entry is skipped.
    expect(registry.getModelsForAuthType(AuthType.USE_OPENAI)).toEqual([]);
    expect(debugLoggerWarnSpy).toHaveBeenCalledWith(
      expect.stringContaining('modelProviders.openai is not an array'),
    );
  });
});
