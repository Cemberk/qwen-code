/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect } from 'vitest';
import { AuthType, type Config } from '@qwen-code/qwen-code-core';
import {
  isInlineModelOverrideAllowed,
  parseAcpModelOption,
  sanitizeProviderBaseUrl,
} from './acpModelUtils.js';

describe('acpModelUtils', () => {
  it('parses modelId and validates authType', () => {
    expect(parseAcpModelOption(` qwen3(${AuthType.USE_OPENAI}) `)).toEqual({
      modelId: 'qwen3',
      authType: AuthType.USE_OPENAI,
    });
  });

  it('returns trimmed input as modelId when authType is invalid', () => {
    expect(parseAcpModelOption('qwen3(not-a-real-auth)')).toEqual({
      modelId: 'qwen3(not-a-real-auth)',
    });
  });

  it.each([
    ['not-a-url', 'not-a-url'],
    ['https://api.example/v1', 'https://api.example/v1'],
    ['https://api.example/v1/@scope', 'https://api.example/v1/@scope'],
    ['https://host:99999/path@domain', 'https://host:99999/path@domain'],
    ['https://user@api.example/v1', 'https://api.example/v1'],
    ['https://user@host:99999', 'https://host:99999'],
    ['https://user:secret@api.example/v1', 'https://api.example/v1'],
    [
      'https://user:secret@api.example/v1/@scope',
      'https://api.example/v1/@scope',
    ],
    ['https://user:p ass@api.example/v1', 'https://api.example/v1'],
    [`https://user:p'ass@api.example/v1`, 'https://api.example/v1'],
    ['https://user:p%2Fx@api.example/v1', 'https://api.example/v1'],
    ['https://user:p/x@api.example/v1', 'https://api.example/v1'],
    ['https://user:p?x@api.example/v1', 'https://api.example/v1'],
    ['https://user:p#x@api.example/v1', 'https://api.example/v1'],
    ['https://user:secret@api.example', 'https://api.example'],
  ])('sanitizes provider base URL credentials for %s', (input, expected) => {
    expect(sanitizeProviderBaseUrl(input)).toBe(expected);
  });

  describe('isInlineModelOverrideAllowed', () => {
    const makeConfig = (
      contentGeneratorConfig: unknown,
      available: unknown[],
    ): Config =>
      ({
        getContentGeneratorConfig: () => contentGeneratorConfig,
        getAvailableModelsForAuthType: () => available,
      }) as unknown as Config;

    it('allows a model that matches the active provider identity', () => {
      const config = makeConfig(
        {
          authType: AuthType.USE_OPENAI,
          baseUrl: 'http://127.0.0.1:11434/v1',
          apiKeyEnvKey: 'PROVIDER_A_KEY',
        },
        [
          {
            id: 'shared-id',
            authType: AuthType.USE_OPENAI,
            baseUrl: 'http://127.0.0.1:11434/v1',
            envKey: 'PROVIDER_A_KEY',
          },
        ],
      );
      expect(isInlineModelOverrideAllowed(config, 'shared-id')).toBe(true);
    });

    it('allows a model when both sides have no envKey', () => {
      const config = makeConfig(
        { authType: AuthType.USE_OPENAI, baseUrl: 'http://127.0.0.1:11434/v1' },
        [
          {
            id: 'local-model',
            authType: AuthType.USE_OPENAI,
            baseUrl: 'http://127.0.0.1:11434/v1',
          },
        ],
      );
      expect(isInlineModelOverrideAllowed(config, 'local-model')).toBe(true);
    });

    it('rejects a same-id model with a different baseUrl', () => {
      const config = makeConfig(
        {
          authType: AuthType.USE_OPENAI,
          baseUrl: 'http://127.0.0.1:11434/v1',
          apiKeyEnvKey: 'PROVIDER_A_KEY',
        },
        [
          {
            id: 'shared-id',
            authType: AuthType.USE_OPENAI,
            baseUrl: 'http://localhost:1234/v1',
            envKey: 'PROVIDER_A_KEY',
          },
        ],
      );
      expect(isInlineModelOverrideAllowed(config, 'shared-id')).toBe(false);
    });

    it('rejects a same-id model with a different credential env key', () => {
      const config = makeConfig(
        {
          authType: AuthType.USE_OPENAI,
          baseUrl: 'http://127.0.0.1:11434/v1',
          apiKeyEnvKey: 'PROVIDER_A_KEY',
        },
        [
          {
            id: 'shared-id',
            authType: AuthType.USE_OPENAI,
            baseUrl: 'http://127.0.0.1:11434/v1',
            envKey: 'PROVIDER_B_KEY',
          },
        ],
      );
      expect(isInlineModelOverrideAllowed(config, 'shared-id')).toBe(false);
    });

    it('rejects an unknown model id', () => {
      const config = makeConfig({ authType: AuthType.USE_OPENAI }, [
        { id: 'local-model', authType: AuthType.USE_OPENAI },
      ]);
      expect(isInlineModelOverrideAllowed(config, 'missing')).toBe(false);
    });

    it('does not match selector-only models', () => {
      const config = makeConfig({ authType: AuthType.USE_OPENAI }, [
        { id: 'local-fast', authType: AuthType.USE_OPENAI, fastOnly: true },
      ]);
      expect(isInlineModelOverrideAllowed(config, 'local-fast')).toBe(false);
    });

    it('rejects when no active auth type is available', () => {
      const config = makeConfig(undefined, []);
      expect(isInlineModelOverrideAllowed(config, 'anything')).toBe(false);
    });
  });
});
