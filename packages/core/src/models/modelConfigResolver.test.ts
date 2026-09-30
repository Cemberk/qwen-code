/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect } from 'vitest';
import {
  resolveModelConfig,
  validateModelConfig,
} from './modelConfigResolver.js';
import { AuthType } from '../core/contentGenerator.js';

describe('modelConfigResolver', () => {
  describe('resolveModelConfig', () => {
    describe('OpenAI auth type', () => {
      it('resolves from CLI with highest priority', () => {
        const result = resolveModelConfig({
          authType: AuthType.USE_OPENAI,
          cli: {
            model: 'cli-model',
            apiKey: 'cli-key',
            baseUrl: 'http://127.0.0.1:8001',
          },
          settings: {
            model: 'settings-model',
            apiKey: 'settings-key',
            baseUrl: 'http://127.0.0.1:8002',
          },
          env: {
            OPENAI_MODEL: 'env-model',
            OPENAI_API_KEY: 'env-key',
            OPENAI_BASE_URL: 'http://127.0.0.1:8003',
          },
        });

        expect(result.config.model).toBe('cli-model');
        expect(result.config.apiKey).toBe('cli-key');
        expect(result.config.baseUrl).toBe('http://127.0.0.1:8001');

        expect(result.sources['model'].kind).toBe('cli');
        expect(result.sources['apiKey'].kind).toBe('cli');
        expect(result.sources['baseUrl'].kind).toBe('cli');
      });

      it('falls back to env when CLI not provided', () => {
        const result = resolveModelConfig({
          authType: AuthType.USE_OPENAI,
          cli: {},
          settings: {
            model: 'settings-model',
          },
          env: {
            OPENAI_MODEL: 'env-model',
            OPENAI_API_KEY: 'env-key',
          },
        });

        expect(result.config.model).toBe('env-model');
        expect(result.config.apiKey).toBe('env-key');

        expect(result.sources['model'].kind).toBe('env');
        expect(result.sources['apiKey'].kind).toBe('env');
      });

      it('falls back to settings when env not provided', () => {
        const result = resolveModelConfig({
          authType: AuthType.USE_OPENAI,
          cli: {},
          settings: {
            model: 'settings-model',
            apiKey: 'settings-key',
            baseUrl: 'http://127.0.0.1:8002',
          },
          env: {},
        });

        expect(result.config.model).toBe('settings-model');
        expect(result.config.apiKey).toBe('settings-key');
        expect(result.config.baseUrl).toBe('http://127.0.0.1:8002');

        expect(result.sources['model'].kind).toBe('settings');
        expect(result.sources['apiKey'].kind).toBe('settings');
        expect(result.sources['baseUrl'].kind).toBe('settings');
      });

      it('leaves the model empty when nothing provided (no default model)', () => {
        const result = resolveModelConfig({
          authType: AuthType.USE_OPENAI,
          cli: {},
          settings: {},
          env: {
            OPENAI_API_KEY: 'some-key', // need key to be valid
          },
        });

        expect(result.config.model).toBe('');
        expect(result.sources['model'].kind).toBe('default');
        expect(result.config.baseUrl).toBeUndefined();
      });

      it('prioritizes modelProvider over CLI', () => {
        const result = resolveModelConfig({
          authType: AuthType.USE_OPENAI,
          cli: {
            model: 'cli-model',
          },
          settings: {},
          env: {
            MY_CUSTOM_KEY: 'provider-key',
          },
          modelProvider: {
            id: 'provider-model',
            name: 'Provider Model',
            envKey: 'MY_CUSTOM_KEY',
            baseUrl: 'http://127.0.0.1:8004',
            generationConfig: {},
          },
        });

        expect(result.config.model).toBe('provider-model');
        expect(result.config.apiKey).toBe('provider-key');
        expect(result.config.baseUrl).toBe('http://127.0.0.1:8004');

        expect(result.sources['model'].kind).toBe('modelProviders');
        expect(result.sources['apiKey'].kind).toBe('env');
        expect(result.sources['apiKey'].via?.kind).toBe('modelProviders');
      });

      it('reads QWEN_MODEL as fallback for OPENAI_MODEL', () => {
        const result = resolveModelConfig({
          authType: AuthType.USE_OPENAI,
          cli: {},
          settings: {},
          env: {
            QWEN_MODEL: 'qwen-model',
            OPENAI_API_KEY: 'key',
          },
        });

        expect(result.config.model).toBe('qwen-model');
        expect(result.sources['model'].envKey).toBe('QWEN_MODEL');
      });

      it('ignores credentials and endpoints of removed providers', () => {
        const result = resolveModelConfig({
          authType: AuthType.USE_OPENAI,
          cli: {},
          settings: {},
          env: {
            ANTHROPIC_API_KEY: 'anthropic-key',
            ANTHROPIC_BASE_URL: 'https://api.anthropic.com',
            ANTHROPIC_MODEL: 'claude-3',
            GEMINI_API_KEY: 'gemini-key',
            GEMINI_MODEL: 'gemini-pro',
            GOOGLE_API_KEY: 'google-key',
          },
        });

        expect(result.config.apiKey).toBeUndefined();
        expect(result.config.baseUrl).toBeUndefined();
        expect(result.config.model).toBe('');
      });
    });

    describe('generation config resolution', () => {
      it('merges generation config from settings', () => {
        const result = resolveModelConfig({
          authType: AuthType.USE_OPENAI,
          cli: {},
          settings: {
            apiKey: 'key',
            generationConfig: {
              timeout: 60000,
              streamIdleTimeoutMs: 300000,
              maxRetries: 5,
              samplingParams: {
                temperature: 0.7,
              },
            },
          },
          env: {},
        });

        expect(result.config.timeout).toBe(60000);
        expect(result.config.streamIdleTimeoutMs).toBe(300000);
        expect(result.config.maxRetries).toBe(5);
        expect(result.config.retryInitialDelayMs).toBeUndefined();
        expect(result.config.retryMaxDelayMs).toBeUndefined();
        expect(result.config.samplingParams?.temperature).toBe(0.7);

        expect(result.sources['timeout'].kind).toBe('settings');
        expect(result.sources['streamIdleTimeoutMs'].kind).toBe('settings');
        expect(result.sources['samplingParams'].kind).toBe('settings');
      });

      it('modelProvider config overrides settings', () => {
        const result = resolveModelConfig({
          authType: AuthType.USE_OPENAI,
          cli: {},
          settings: {
            generationConfig: {
              timeout: 30000,
              streamIdleTimeoutMs: 300000,
              retryInitialDelayMs: 60_000,
              retryMaxDelayMs: 300_000,
            },
          },
          env: {
            MY_KEY: 'key',
          },
          modelProvider: {
            id: 'model',
            name: 'Model',
            envKey: 'MY_KEY',
            baseUrl: 'http://127.0.0.1:8005',
            generationConfig: {
              timeout: 60000,
              streamIdleTimeoutMs: 0,
              retryInitialDelayMs: 3_000,
              retryMaxDelayMs: 30_000,
            },
          },
        });

        expect(result.config.timeout).toBe(60000);
        expect(result.config.streamIdleTimeoutMs).toBe(0);
        expect(result.config.retryInitialDelayMs).toBe(3_000);
        expect(result.config.retryMaxDelayMs).toBe(30_000);
        expect(result.sources['timeout'].kind).toBe('modelProviders');
        expect(result.sources['streamIdleTimeoutMs'].kind).toBe(
          'modelProviders',
        );
        expect(result.sources['retryInitialDelayMs'].kind).toBe(
          'modelProviders',
        );
        expect(result.sources['retryMaxDelayMs'].kind).toBe('modelProviders');
      });

      it('resolves stream retry delay config from settings', () => {
        const result = resolveModelConfig({
          authType: AuthType.USE_OPENAI,
          cli: {},
          settings: {
            apiKey: 'key',
            generationConfig: {
              maxRetries: 4,
              retryInitialDelayMs: 3000,
              retryMaxDelayMs: 30000,
            },
          },
          env: {},
        });

        expect(result.config.maxRetries).toBe(4);
        expect(result.config.retryInitialDelayMs).toBe(3000);
        expect(result.config.retryMaxDelayMs).toBe(30000);
        expect(result.sources['retryInitialDelayMs'].kind).toBe('settings');
        expect(result.sources['retryMaxDelayMs'].kind).toBe('settings');
      });

      it('QWEN_CODE_API_TIMEOUT_MS env var overrides settings timeout', () => {
        const result = resolveModelConfig({
          authType: AuthType.USE_OPENAI,
          cli: {},
          settings: {
            apiKey: 'key',
            generationConfig: {
              timeout: 30000,
            },
          },
          env: {
            OPENAI_API_KEY: 'key',
            QWEN_CODE_API_TIMEOUT_MS: '900000',
          },
        });

        expect(result.config.timeout).toBe(900000);
        expect(result.sources['timeout'].kind).toBe('env');
        expect(result.sources['timeout'].envKey).toBe(
          'QWEN_CODE_API_TIMEOUT_MS',
        );
      });

      it('modelProvider timeout wins over QWEN_CODE_API_TIMEOUT_MS', () => {
        const result = resolveModelConfig({
          authType: AuthType.USE_OPENAI,
          cli: {},
          settings: {},
          env: {
            MY_KEY: 'key',
            QWEN_CODE_API_TIMEOUT_MS: '900000',
          },
          modelProvider: {
            id: 'model',
            name: 'Model',
            envKey: 'MY_KEY',
            baseUrl: 'http://127.0.0.1:8005',
            generationConfig: {
              timeout: 60000,
            },
          },
        });

        // modelProvider > env: modelProvider timeout should win
        expect(result.config.timeout).toBe(60000);
        expect(result.sources['timeout'].kind).toBe('modelProviders');
      });

      it('QWEN_CODE_API_TIMEOUT_MS applies when modelProvider has no timeout', () => {
        const result = resolveModelConfig({
          authType: AuthType.USE_OPENAI,
          cli: {},
          settings: {},
          env: {
            MY_KEY: 'key',
            QWEN_CODE_API_TIMEOUT_MS: '900000',
          },
          modelProvider: {
            id: 'model',
            name: 'Model',
            envKey: 'MY_KEY',
            baseUrl: 'http://127.0.0.1:8005',
            generationConfig: {},
          },
        });

        expect(result.config.timeout).toBe(900000);
        expect(result.sources['timeout'].kind).toBe('env');
        expect(result.sources['timeout'].envKey).toBe(
          'QWEN_CODE_API_TIMEOUT_MS',
        );
      });

      it('ignores invalid QWEN_CODE_API_TIMEOUT_MS values', () => {
        const result = resolveModelConfig({
          authType: AuthType.USE_OPENAI,
          cli: {},
          settings: {
            apiKey: 'key',
            generationConfig: {
              timeout: 30000,
            },
          },
          env: {
            OPENAI_API_KEY: 'key',
            QWEN_CODE_API_TIMEOUT_MS: 'invalid',
          },
        });

        // Should fall back to settings value
        expect(result.config.timeout).toBe(30000);
        expect(result.sources['timeout'].kind).toBe('settings');
      });

      it('accepts zero QWEN_CODE_API_TIMEOUT_MS and overrides settings (disables timeout downstream)', () => {
        const result = resolveModelConfig({
          authType: AuthType.USE_OPENAI,
          cli: {},
          settings: {
            apiKey: 'key',
            generationConfig: {
              timeout: 30000,
            },
          },
          env: {
            OPENAI_API_KEY: 'key',
            QWEN_CODE_API_TIMEOUT_MS: '0',
          },
        });

        // 0 is a valid disable sentinel; env overrides settings.
        expect(result.config.timeout).toBe(0);
        expect(result.sources['timeout'].kind).toBe('env');
        expect(result.sources['timeout'].envKey).toBe(
          'QWEN_CODE_API_TIMEOUT_MS',
        );
      });

      it('timeout is undefined when not configured, default applied in buildClient', () => {
        const result = resolveModelConfig({
          authType: AuthType.USE_OPENAI,
          cli: {},
          settings: {
            apiKey: 'key',
          },
          env: {
            OPENAI_API_KEY: 'key',
          },
        });

        // timeout is undefined here; DEFAULT_TIMEOUT (120000) is applied in
        // the provider's buildClient() when timeout is not set.
        expect(result.config.timeout).toBeUndefined();
      });

      it('env var actually changes resolved timeout value', () => {
        // Integration-style test: proves the env var flows through to the resolved config
        const result = resolveModelConfig({
          authType: AuthType.USE_OPENAI,
          cli: {},
          settings: {
            apiKey: 'key',
            generationConfig: {
              timeout: 30000,
            },
          },
          env: {
            OPENAI_API_KEY: 'key',
            QWEN_CODE_API_TIMEOUT_MS: '900000',
          },
        });

        // Timeout should be the env var value, not the settings value
        expect(result.config.timeout).toBe(900000);
        expect(result.sources['timeout'].kind).toBe('env');
        expect(result.sources['timeout'].envKey).toBe(
          'QWEN_CODE_API_TIMEOUT_MS',
        );

        // Prove it would be used by the client (default.ts:48 reads config.timeout)
        const clientTimeout = result.config.timeout;
        expect(clientTimeout).toBe(900000);
      });

      it('handles extremely large timeout values safely', () => {
        const result = resolveModelConfig({
          authType: AuthType.USE_OPENAI,
          cli: {},
          settings: { apiKey: 'key' },
          env: {
            OPENAI_API_KEY: 'key',
            QWEN_CODE_API_TIMEOUT_MS: '999999999',
          },
        });

        expect(result.config.timeout).toBe(999999999);
        expect(result.sources['timeout'].kind).toBe('env');
      });

      it('handles whitespace-padded env values', () => {
        const result = resolveModelConfig({
          authType: AuthType.USE_OPENAI,
          cli: {},
          settings: { apiKey: 'key' },
          env: {
            OPENAI_API_KEY: 'key',
            QWEN_CODE_API_TIMEOUT_MS: ' 300000 ',
          },
        });

        expect(result.config.timeout).toBe(300000);
        expect(result.sources['timeout'].kind).toBe('env');
      });

      it('ignores negative QWEN_CODE_API_TIMEOUT_MS values', () => {
        const result = resolveModelConfig({
          authType: AuthType.USE_OPENAI,
          cli: {},
          settings: {
            apiKey: 'key',
            generationConfig: { timeout: 30000 },
          },
          env: {
            OPENAI_API_KEY: 'key',
            QWEN_CODE_API_TIMEOUT_MS: '-100',
          },
        });

        expect(result.config.timeout).toBe(30000);
        expect(result.sources['timeout'].kind).toBe('settings');
      });
    });
  });

  describe('validateModelConfig', () => {
    const baseUrl = 'http://127.0.0.1:11434/v1';

    it('passes for valid OpenAI config', () => {
      const result = validateModelConfig({
        authType: AuthType.USE_OPENAI,
        model: 'gpt-4',
        apiKey: 'sk-xxx',
        baseUrl,
      });

      expect(result.valid).toBe(true);
      expect(result.errors).toHaveLength(0);
    });

    it('fails when API key missing', () => {
      const result = validateModelConfig({
        authType: AuthType.USE_OPENAI,
        model: 'gpt-4',
        baseUrl,
      });

      expect(result.valid).toBe(false);
      expect(result.errors).toHaveLength(1);
      expect(result.errors[0].message).toContain('Missing API key');
    });

    it('fails when model missing', () => {
      const result = validateModelConfig({
        authType: AuthType.USE_OPENAI,
        model: '',
        apiKey: 'sk-xxx',
        baseUrl,
      });

      expect(result.valid).toBe(false);
      expect(result.errors).toHaveLength(1);
      expect(result.errors[0].message).toContain('Missing model');
    });

    it('uses strict error messages for modelProvider', () => {
      const result = validateModelConfig(
        {
          authType: AuthType.USE_OPENAI,
          model: 'my-model',
          baseUrl,
          // missing apiKey
        },
        true, // isStrictModelProvider
      );

      expect(result.valid).toBe(false);
      expect(result.errors[0].message).toContain('modelProviders');
      expect(result.errors[0].message).toContain('envKey');
    });

    it.each([undefined, '', 'https://api.openai.com/v1'])(
      'fails when baseUrl is %s',
      (invalidBaseUrl) => {
        const result = validateModelConfig({
          authType: AuthType.USE_OPENAI,
          model: 'gpt-4',
          apiKey: 'sk-xxx',
          baseUrl: invalidBaseUrl,
        });

        expect(result.valid).toBe(false);
        expect(result.errors).toHaveLength(1);
        expect(result.errors[0]).toMatchObject({ code: 'INVALID_BASE_URL' });
      },
    );
  });

  describe('[Regression] timeout env override refactor', () => {
    it('[Regression] must apply QWEN_CODE_API_TIMEOUT_MS', () => {
      const result = resolveModelConfig({
        authType: AuthType.USE_OPENAI,
        cli: {},
        settings: { apiKey: 'key' },
        env: {
          OPENAI_API_KEY: 'key',
          QWEN_CODE_API_TIMEOUT_MS: '900000',
        },
      });

      expect(result.config.timeout).toBe(900000);
      expect(result.sources['timeout'].kind).toBe('env');
      expect(result.sources['timeout'].envKey).toBe('QWEN_CODE_API_TIMEOUT_MS');
    });

    it('[Regression] modelProvider timeout must win over env', () => {
      const result = resolveModelConfig({
        authType: AuthType.USE_OPENAI,
        cli: {},
        settings: {},
        env: {
          MY_KEY: 'key',
          QWEN_CODE_API_TIMEOUT_MS: '900000',
        },
        modelProvider: {
          id: 'model',
          name: 'Model',
          envKey: 'MY_KEY',
          baseUrl: 'http://127.0.0.1:8005',
          generationConfig: { timeout: 60000 },
        },
      });
      expect(result.config.timeout).toBe(60000);
      expect(result.sources['timeout'].kind).toBe('modelProviders');
    });

    it('[Regression] refactor must not alter precedence: env > settings', () => {
      const result = resolveModelConfig({
        authType: AuthType.USE_OPENAI,
        cli: {},
        settings: {
          apiKey: 'key',
          generationConfig: { timeout: 30000 },
        },
        env: {
          OPENAI_API_KEY: 'key',
          QWEN_CODE_API_TIMEOUT_MS: '900000',
        },
      });

      // env must override settings
      expect(result.config.timeout).toBe(900000);
      expect(result.sources['timeout'].kind).toBe('env');
    });
  });

  describe('[Additional] timeout env override edge cases', () => {
    it.each([
      ['scientific notation', '1.5e5'],
      ['hex values', '0x2BF20'],
      ['fractional values', '12345.67'],
      ['unsafe integers', String(Number.MAX_SAFE_INTEGER + 1)],
    ])('ignores %s in QWEN_CODE_API_TIMEOUT_MS', (_label, value) => {
      const result = resolveModelConfig({
        authType: AuthType.USE_OPENAI,
        cli: {},
        settings: { apiKey: 'key', generationConfig: { timeout: 30000 } },
        env: {
          OPENAI_API_KEY: 'key',
          QWEN_CODE_API_TIMEOUT_MS: value,
        },
      });

      expect(result.config.timeout).toBe(30000);
      expect(result.sources['timeout'].kind).toBe('settings');
    });

    it('ignores empty string QWEN_CODE_API_TIMEOUT_MS', () => {
      const result = resolveModelConfig({
        authType: AuthType.USE_OPENAI,
        cli: {},
        settings: { apiKey: 'key', generationConfig: { timeout: 30000 } },
        env: {
          OPENAI_API_KEY: 'key',
          QWEN_CODE_API_TIMEOUT_MS: '',
        },
      });

      expect(result.config.timeout).toBe(30000);
      expect(result.sources['timeout'].kind).toBe('settings');
    });
  });

  describe('[Regression] issue-4219 — env-var-only path must call defaultModalities()', () => {
    it('[Regression] env-var-only path: modalities auto-detected for qwen3.6-35b-a3b', () => {
      // REPRODUCES issue-4219:
      // When the model is supplied only via OPENAI_MODEL (no modelProviders entry),
      // resolveGenerationConfig() iterates MODEL_GENERATION_CONFIG_FIELDS but never
      // calls defaultModalities(). This leaves config.modalities undefined, causing
      // image attachments to be silently dropped with an "Unsupported <modality>"
      // message even though the model supports images.
      //
      // The modelRegistry path (resolveModelConfig -> resolveModelConfig in modelRegistry.ts)
      // and the modelsConfig path (applyResolvedModelDefaults) both call defaultModalities()
      // when generationConfig.modalities is undefined. The env-var-only path does not.
      const result = resolveModelConfig({
        authType: AuthType.USE_OPENAI,
        cli: {},
        settings: {},
        env: {
          OPENAI_API_KEY: 'test-key',
          OPENAI_BASE_URL: 'http://localhost:8000/v1',
          OPENAI_MODEL: 'qwen3.6-35b-a3b',
        },
        // No modelProvider — this is the env-var-only path
      });

      expect(result.config.model).toBe('qwen3.6-35b-a3b');

      // The qwen3.6-35b pattern in modalityDefaults.ts maps to { image: true, video: true }.
      // The env-var-only path must auto-detect this — just as the modelProviders path does
      // in modelsConfig.ts applyResolvedModelDefaults() lines 791-797.
      expect(result.config.modalities).toBeDefined();
      expect(result.config.modalities?.image).toBe(true);
      expect(result.config.modalities?.video).toBe(true);
      expect(result.sources['modalities'].kind).toBe('computed');
    });

    it('env-var-only path: modalities defaults to {} for unknown model (text-only)', () => {
      // Locks the invariant: defaultModalities() returns {} (text-only) for
      // unknown model patterns, never undefined. After this fix, env-var-only
      // setups never re-expose `modalities === undefined` for downstream
      // consumers to misinterpret as "unresolved" (issue #4219).
      const result = resolveModelConfig({
        authType: AuthType.USE_OPENAI,
        cli: {},
        settings: {},
        env: {
          OPENAI_API_KEY: 'test-key',
          OPENAI_BASE_URL: 'http://localhost:8000/v1',
          OPENAI_MODEL: 'some-unknown-model-xyz',
        },
      });

      expect(result.config.modalities).toEqual({});
      expect(result.sources['modalities'].kind).toBe('computed');
    });

    it('env-var-only path: explicit settings.generationConfig.modalities is not overridden by fallback', () => {
      // Locks the `=== undefined` guard: when user explicitly configures
      // modalities in settings, the fallback must not clobber them with
      // defaultModalities() — even for a model whose name would otherwise
      // auto-resolve to multimodal.
      const result = resolveModelConfig({
        authType: AuthType.USE_OPENAI,
        cli: {},
        settings: {
          generationConfig: {
            modalities: {
              image: false,
              pdf: false,
              video: false,
              audio: false,
            },
          },
        },
        env: {
          OPENAI_API_KEY: 'test-key',
          OPENAI_BASE_URL: 'http://localhost:8000/v1',
          OPENAI_MODEL: 'qwen3.6-35b-a3b', // defaultModalities → { image: true, video: true }
        },
      });

      expect(result.config.modalities?.image).toBe(false);
      expect(result.config.modalities?.video).toBe(false);
      expect(result.sources['modalities'].kind).toBe('settings');
    });
  });

  describe('[Regression] env-var-only path must apply model context defaults', () => {
    it('env-var-only path: contextWindowSize auto-detected for claude-opus-4-6', () => {
      const result = resolveModelConfig({
        authType: AuthType.USE_OPENAI,
        cli: {},
        settings: {},
        env: {
          OPENAI_API_KEY: 'test-key',
          OPENAI_BASE_URL: 'http://localhost:8000/v1',
          OPENAI_MODEL: 'claude-opus-4-6',
        },
      });

      expect(result.config.model).toBe('claude-opus-4-6');
      expect(result.config.contextWindowSize).toBe(1_000_000);
      expect(result.sources['contextWindowSize'].kind).toBe('computed');
    });

    it('env-var-only path: contextWindowSize auto-detected for a model whose limit differs from the global default', () => {
      // gpt-4o resolves to 131,072 ≠ DEFAULT_TOKEN_LIMIT (200,000), so this
      // assertion fails if the fallback applies the generic default instead
      // of the model-specific limit.
      const result = resolveModelConfig({
        authType: AuthType.USE_OPENAI,
        cli: {},
        settings: {},
        env: {
          OPENAI_API_KEY: 'test-key',
          OPENAI_BASE_URL: 'http://localhost:8000/v1',
          OPENAI_MODEL: 'gpt-4o',
        },
      });

      expect(result.config.model).toBe('gpt-4o');
      expect(result.config.contextWindowSize).toBe(131_072);
      expect(result.sources['contextWindowSize'].kind).toBe('computed');
    });

    it('env-var-only path: unknown model keeps contextWindowSize undefined', () => {
      // Unknown models must not be stamped with an explicit window and an
      // 'auto-detected' source — downstream `?? DEFAULT_TOKEN_LIMIT`
      // consumers apply the generic default instead.
      const result = resolveModelConfig({
        authType: AuthType.USE_OPENAI,
        cli: {},
        settings: {},
        env: {
          OPENAI_API_KEY: 'test-key',
          OPENAI_BASE_URL: 'http://localhost:8000/v1',
          OPENAI_MODEL: 'totally-unknown-model-xyz',
        },
      });

      expect(result.config.model).toBe('totally-unknown-model-xyz');
      expect(result.config.contextWindowSize).toBeUndefined();
      expect(result.sources['contextWindowSize']).toBeUndefined();
    });

    it('env-var-only path: explicit settings contextWindowSize is not overridden by fallback', () => {
      const result = resolveModelConfig({
        authType: AuthType.USE_OPENAI,
        cli: {},
        settings: {
          generationConfig: {
            contextWindowSize: 32_000,
          },
        },
        env: {
          OPENAI_API_KEY: 'test-key',
          OPENAI_BASE_URL: 'http://localhost:8000/v1',
          OPENAI_MODEL: 'claude-opus-4-6',
        },
      });

      expect(result.config.contextWindowSize).toBe(32_000);
      expect(result.sources['contextWindowSize'].kind).toBe('settings');
    });
  });
});
