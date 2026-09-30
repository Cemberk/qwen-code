/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { AuthType } from '@qwen-code/qwen-code-core';
import { vi } from 'vitest';
import { validateAuthMethod } from './auth.js';
import * as settings from './settings.js';

const LOCAL_BASE_URL = 'http://127.0.0.1:11434/v1';

vi.mock('./settings.js', () => ({
  loadEnvironment: vi.fn(),
  loadSettings: vi.fn().mockReturnValue({
    merged: {},
  }),
}));

describe('validateAuthMethod', () => {
  beforeEach(() => {
    vi.resetModules();
    // Reset mock to default
    vi.mocked(settings.loadSettings).mockReturnValue({
      merged: {},
    } as ReturnType<typeof settings.loadSettings>);
    vi.stubEnv('OPENAI_BASE_URL', LOCAL_BASE_URL);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    delete process.env['OPENAI_API_KEY'];
    delete process.env['CUSTOM_API_KEY'];
    delete process.env['LMSTUDIO_KEY'];
    delete process.env['OLLAMA_KEY'];
  });

  it('should return null for USE_OPENAI with default env key', () => {
    process.env['OPENAI_API_KEY'] = 'fake-key';
    expect(validateAuthMethod(AuthType.USE_OPENAI)).toBeNull();
  });

  it('should return an error message for USE_OPENAI if no API key is available', () => {
    expect(validateAuthMethod(AuthType.USE_OPENAI)).toBe(
      "Missing API key for OpenAI-compatible auth. Set settings.security.auth.apiKey, or set the 'OPENAI_API_KEY' environment variable.",
    );
  });

  it('should return null for USE_OPENAI with custom envKey from modelProviders', () => {
    vi.mocked(settings.loadSettings).mockReturnValue({
      merged: {
        model: { name: 'custom-model' },
        modelProviders: {
          openai: [{ id: 'custom-model', envKey: 'CUSTOM_API_KEY' }],
        },
      },
    } as unknown as ReturnType<typeof settings.loadSettings>);
    process.env['CUSTOM_API_KEY'] = 'custom-key';

    expect(validateAuthMethod(AuthType.USE_OPENAI)).toBeNull();
  });

  it('should return null for USE_OPENAI with custom envKey stored in settings.env', () => {
    vi.mocked(settings.loadSettings).mockReturnValue({
      merged: {
        env: { CUSTOM_API_KEY: 'settings-env-key' },
        model: { name: 'custom-model' },
        modelProviders: {
          openai: [{ id: 'custom-model', envKey: 'CUSTOM_API_KEY' }],
        },
      },
    } as unknown as ReturnType<typeof settings.loadSettings>);

    expect(validateAuthMethod(AuthType.USE_OPENAI)).toBeNull();
  });

  it('disambiguates by settings.model.baseUrl when providers share a model id', () => {
    // Two providers with the same id; the persisted baseUrl selects the second.
    // Only the second provider's env key is set, so validation passes only if
    // the lookup honors baseUrl rather than matching the first id entry.
    vi.mocked(settings.loadSettings).mockReturnValue({
      merged: {
        model: {
          name: 'qwen3-coder',
          baseUrl: 'http://localhost:1234/v1',
        },
        modelProviders: {
          openai: [
            {
              id: 'qwen3-coder',
              baseUrl: 'http://127.0.0.1:11434/v1',
              envKey: 'OLLAMA_KEY',
            },
            {
              id: 'qwen3-coder',
              baseUrl: 'http://localhost:1234/v1',
              envKey: 'LMSTUDIO_KEY',
            },
          ],
        },
      },
    } as unknown as ReturnType<typeof settings.loadSettings>);
    process.env['LMSTUDIO_KEY'] = 'lmstudio-key';

    expect(validateAuthMethod(AuthType.USE_OPENAI)).toBeNull();
  });

  it('reports the selected provider env key when providers share a model id', () => {
    vi.mocked(settings.loadSettings).mockReturnValue({
      merged: {
        model: {
          name: 'qwen3-coder',
          baseUrl: 'http://localhost:1234/v1',
        },
        modelProviders: {
          openai: [
            {
              id: 'qwen3-coder',
              baseUrl: 'http://127.0.0.1:11434/v1',
              envKey: 'OLLAMA_KEY',
            },
            {
              id: 'qwen3-coder',
              baseUrl: 'http://localhost:1234/v1',
              envKey: 'LMSTUDIO_KEY',
            },
          ],
        },
      },
    } as unknown as ReturnType<typeof settings.loadSettings>);

    // No env keys set → error must name the selected (LM Studio) provider's key.
    const result = validateAuthMethod(AuthType.USE_OPENAI);
    expect(result).toContain('LMSTUDIO_KEY');
    expect(result).not.toContain('OLLAMA_KEY');
  });

  it('should return error with custom envKey hint when modelProviders envKey is set but env var is missing', () => {
    vi.mocked(settings.loadSettings).mockReturnValue({
      merged: {
        model: { name: 'custom-model' },
        modelProviders: {
          openai: [{ id: 'custom-model', envKey: 'CUSTOM_API_KEY' }],
        },
      },
    } as unknown as ReturnType<typeof settings.loadSettings>);

    const result = validateAuthMethod(AuthType.USE_OPENAI);
    expect(result).toContain('CUSTOM_API_KEY');
  });

  it('should use config.getModelsConfig().getModel() when Config is provided', () => {
    // Settings has a different model
    vi.mocked(settings.loadSettings).mockReturnValue({
      merged: {
        model: { name: 'settings-model' },
        modelProviders: {
          openai: [
            { id: 'settings-model', envKey: 'SETTINGS_API_KEY' },
            { id: 'cli-model', envKey: 'CLI_API_KEY' },
          ],
        },
      },
    } as unknown as ReturnType<typeof settings.loadSettings>);

    // Mock Config object that returns a different model (e.g., from CLI args)
    const mockConfig = {
      getModelsConfig: vi.fn().mockReturnValue({
        getModel: vi.fn().mockReturnValue('cli-model'),
        getGenerationConfig: vi
          .fn()
          .mockReturnValue({ baseUrl: LOCAL_BASE_URL }),
      }),
    } as unknown as import('@qwen-code/qwen-code-core').Config;

    // Set the env key for the CLI model, not the settings model
    process.env['CLI_API_KEY'] = 'cli-key';

    // Should use 'cli-model' from config.getModelsConfig().getModel(), not 'settings-model'
    const result = validateAuthMethod(AuthType.USE_OPENAI, mockConfig);
    expect(result).toBeNull();
    expect(mockConfig.getModelsConfig).toHaveBeenCalled();
  });

  it('should fail validation when Config provides different model without matching env key', () => {
    // Clean up any existing env keys first
    delete process.env['CLI_API_KEY'];
    delete process.env['SETTINGS_API_KEY'];
    delete process.env['OPENAI_API_KEY'];

    vi.mocked(settings.loadSettings).mockReturnValue({
      merged: {
        model: { name: 'settings-model' },
        modelProviders: {
          openai: [
            { id: 'settings-model', envKey: 'SETTINGS_API_KEY' },
            { id: 'cli-model', envKey: 'CLI_API_KEY' },
          ],
        },
      },
    } as unknown as ReturnType<typeof settings.loadSettings>);

    const mockConfig = {
      getModelsConfig: vi.fn().mockReturnValue({
        getModel: vi.fn().mockReturnValue('cli-model'),
        getGenerationConfig: vi
          .fn()
          .mockReturnValue({ baseUrl: LOCAL_BASE_URL }),
      }),
    } as unknown as import('@qwen-code/qwen-code-core').Config;

    // Don't set CLI_API_KEY - validation should fail
    const result = validateAuthMethod(AuthType.USE_OPENAI, mockConfig);
    expect(result).not.toBeNull();
    expect(result).toContain('CLI_API_KEY');
  });

  // Regression test for #3171: validation must accept the API key resolved
  // into generationConfig.apiKey (e.g. from --openai-api-key) instead of
  // requiring an OPENAI_API_KEY env var.
  it('should accept API key resolved into generationConfig from CLI flag', () => {
    delete process.env['OPENAI_API_KEY'];
    vi.mocked(settings.loadSettings).mockReturnValue({
      merged: {},
    } as unknown as ReturnType<typeof settings.loadSettings>);

    const mockConfig = {
      getModelsConfig: vi.fn().mockReturnValue({
        getModel: vi.fn().mockReturnValue('gpt-4'),
        getGenerationConfig: vi.fn().mockReturnValue({
          apiKey: 'cli-provided-key',
          baseUrl: LOCAL_BASE_URL,
        }),
      }),
    } as unknown as import('@qwen-code/qwen-code-core').Config;

    const result = validateAuthMethod(AuthType.USE_OPENAI, mockConfig);
    expect(result).toBeNull();
  });

  // Regression test for #3171: when a modelProvider has a custom envKey but
  // the user passes --openai-api-key on the CLI, the resolver picks the CLI
  // value. Validation should match the resolver and accept it instead of
  // demanding the env var.
  it('should accept CLI-resolved key even when modelProvider declares a custom envKey', () => {
    delete process.env['CUSTOM_API_KEY'];
    vi.mocked(settings.loadSettings).mockReturnValue({
      merged: {
        model: { name: 'custom-model' },
        modelProviders: {
          openai: [{ id: 'custom-model', envKey: 'CUSTOM_API_KEY' }],
        },
      },
    } as unknown as ReturnType<typeof settings.loadSettings>);

    const mockConfig = {
      getModelsConfig: vi.fn().mockReturnValue({
        getModel: vi.fn().mockReturnValue('custom-model'),
        getGenerationConfig: vi.fn().mockReturnValue({
          apiKey: 'cli-provided-key',
          baseUrl: LOCAL_BASE_URL,
        }),
      }),
    } as unknown as import('@qwen-code/qwen-code-core').Config;

    const result = validateAuthMethod(AuthType.USE_OPENAI, mockConfig);
    expect(result).toBeNull();
  });

  it('should accept runtime-resolved settings key when modelProvider declares a custom envKey', () => {
    delete process.env['CUSTOM_API_KEY'];
    vi.mocked(settings.loadSettings).mockReturnValue({
      merged: {
        security: { auth: { apiKey: 'settings-fallback-key' } },
        model: { name: 'custom-model' },
        modelProviders: {
          openai: [{ id: 'custom-model', envKey: 'CUSTOM_API_KEY' }],
        },
      },
    } as unknown as ReturnType<typeof settings.loadSettings>);

    const mockConfig = {
      getModelsConfig: vi.fn().mockReturnValue({
        getModel: vi.fn().mockReturnValue('custom-model'),
        getGenerationConfig: vi.fn().mockReturnValue({
          apiKey: 'settings-fallback-key',
          baseUrl: LOCAL_BASE_URL,
        }),
      }),
    } as unknown as import('@qwen-code/qwen-code-core').Config;

    const result = validateAuthMethod(AuthType.USE_OPENAI, mockConfig);
    expect(result).toBeNull();
  });

  it('should keep no-config validation strict for missing custom envKey', () => {
    delete process.env['CUSTOM_API_KEY'];
    vi.mocked(settings.loadSettings).mockReturnValue({
      merged: {
        security: { auth: { apiKey: 'settings-fallback-key' } },
        model: { name: 'custom-model' },
        modelProviders: {
          openai: [{ id: 'custom-model', envKey: 'CUSTOM_API_KEY' }],
        },
      },
    } as unknown as ReturnType<typeof settings.loadSettings>);

    const result = validateAuthMethod(AuthType.USE_OPENAI);
    expect(result).toContain('CUSTOM_API_KEY');
  });

  it.each([
    'qwen-oauth',
    'gemini',
    'vertex-ai',
    'anthropic',
    'openai-responses',
    'invalid-method',
  ])('rejects the unsupported %s auth type', (authType) => {
    process.env['OPENAI_API_KEY'] = 'fake-key';

    expect(validateAuthMethod(authType)).toBe(
      `Auth type "${authType}" is not supported. Only a local OpenAI-compatible server is supported: run /auth, or set security.auth.selectedType to "openai".`,
    );
  });

  describe('base URL', () => {
    beforeEach(() => {
      process.env['OPENAI_API_KEY'] = 'fake-key';
    });

    it.each(['http://127.0.0.1:11434/v1', 'http://localhost:1234/v1'])(
      'accepts the loopback base URL %s',
      (baseUrl) => {
        vi.stubEnv('OPENAI_BASE_URL', baseUrl);

        expect(validateAuthMethod(AuthType.USE_OPENAI)).toBeNull();
      },
    );

    it.each(['https://api.openai.com/v1', 'http://192.168.1.5:8000/v1'])(
      'rejects OPENAI_BASE_URL %s',
      (baseUrl) => {
        vi.stubEnv('OPENAI_BASE_URL', baseUrl);

        expect(validateAuthMethod(AuthType.USE_OPENAI)).toBe(
          `Model server base URL "${baseUrl}" is not allowed: the host must be 127.0.0.1, ::1 or localhost.`,
        );
      },
    );

    it.each(['https://api.openai.com/v1', 'http://192.168.1.5:8000/v1'])(
      'rejects settings.security.auth.baseUrl %s',
      (baseUrl) => {
        vi.stubEnv('OPENAI_BASE_URL', '');
        vi.mocked(settings.loadSettings).mockReturnValue({
          merged: { security: { auth: { baseUrl } } },
        } as unknown as ReturnType<typeof settings.loadSettings>);

        expect(validateAuthMethod(AuthType.USE_OPENAI)).toContain(
          `"${baseUrl}" is not allowed`,
        );
      },
    );

    it('rejects a non-loopback base URL on the selected modelProviders entry', () => {
      vi.mocked(settings.loadSettings).mockReturnValue({
        merged: {
          model: { name: 'gpt-4o' },
          modelProviders: {
            openai: [{ id: 'gpt-4o', baseUrl: 'https://api.openai.com/v1' }],
          },
        },
      } as unknown as ReturnType<typeof settings.loadSettings>);

      expect(validateAuthMethod(AuthType.USE_OPENAI)).toContain(
        '"https://api.openai.com/v1" is not allowed',
      );
    });

    it('rejects a non-loopback base URL resolved into the live Config', () => {
      const mockConfig = {
        getModelsConfig: vi.fn().mockReturnValue({
          getModel: vi.fn().mockReturnValue('gpt-4o'),
          getGenerationConfig: vi.fn().mockReturnValue({
            apiKey: 'key',
            baseUrl: 'https://api.openai.com/v1',
          }),
        }),
      } as unknown as import('@qwen-code/qwen-code-core').Config;

      expect(validateAuthMethod(AuthType.USE_OPENAI, mockConfig)).toContain(
        '"https://api.openai.com/v1" is not allowed',
      );
    });

    it('never defaults the base URL when none is configured', () => {
      vi.stubEnv('OPENAI_BASE_URL', '');

      expect(validateAuthMethod(AuthType.USE_OPENAI)).toBe(
        'No model server base URL is configured. Set the base URL of a local OpenAI-compatible server, for example http://127.0.0.1:11434/v1.',
      );
    });

    it('reports a missing base URL even when the live Config has an API key', () => {
      const mockConfig = {
        getModelsConfig: vi.fn().mockReturnValue({
          getModel: vi.fn().mockReturnValue('local-model'),
          getGenerationConfig: vi.fn().mockReturnValue({ apiKey: 'key' }),
        }),
      } as unknown as import('@qwen-code/qwen-code-core').Config;

      expect(validateAuthMethod(AuthType.USE_OPENAI, mockConfig)).toContain(
        'No model server base URL is configured',
      );
    });
  });
});
