/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import { AuthType } from '../../../core/contentGenerator.js';
import { buildInstallPlan } from '../../provider-config.js';
import {
  CUSTOM_API_KEY_ENV_PREFIX,
  customProvider,
  generateCustomEnvKey,
} from '../../presets/custom-provider.js';

describe('generateCustomEnvKey', () => {
  it('produces a deterministic URL-based key with a stable hash suffix', () => {
    const key1 = generateCustomEnvKey(
      AuthType.USE_OPENAI,
      'http://127.0.0.1:11434/v1',
    );
    const key2 = generateCustomEnvKey(
      AuthType.USE_OPENAI,
      'http://127.0.0.1:11434/v1',
    );
    expect(key1).toBe(key2);
    // Readable prefix + 12-hex-char SHA-256 suffix.
    expect(key1).toMatch(
      new RegExp(
        `^${CUSTOM_API_KEY_ENV_PREFIX}OPENAI_HTTP_127_0_0_1_11434_V1_[0-9A-F]{12}$`,
      ),
    );
  });

  it('ignores trailing slashes', () => {
    expect(
      generateCustomEnvKey(AuthType.USE_OPENAI, 'http://127.0.0.1:11434/v1/'),
    ).toBe(
      generateCustomEnvKey(AuthType.USE_OPENAI, 'http://127.0.0.1:11434/v1'),
    );
  });

  it('produces different keys for different base URLs', () => {
    const k1 = generateCustomEnvKey(
      AuthType.USE_OPENAI,
      'http://127.0.0.1:11434/v1',
    );
    const k2 = generateCustomEnvKey(
      AuthType.USE_OPENAI,
      'http://127.0.0.1:1234/v1',
    );
    expect(k1).not.toBe(k2);
  });

  it('disambiguates structurally distinct URLs that normalize identically', () => {
    // Without the hash suffix `a.b`, `a-b` and `a_b` all collapse to `A_B`,
    // so two different endpoints would overwrite each other's API key.
    const dotted = generateCustomEnvKey(
      AuthType.USE_OPENAI,
      'http://localhost:8000/a.b',
    );
    const dashed = generateCustomEnvKey(
      AuthType.USE_OPENAI,
      'http://localhost:8000/a-b',
    );
    const underscored = generateCustomEnvKey(
      AuthType.USE_OPENAI,
      'http://localhost:8000/a_b',
    );
    expect(dotted).not.toBe(dashed);
    expect(dotted).not.toBe(underscored);
    expect(dashed).not.toBe(underscored);
  });

  it('handles empty strings', () => {
    const key = generateCustomEnvKey('' as AuthType, '');
    expect(key).toMatch(new RegExp(`^${CUSTOM_API_KEY_ENV_PREFIX}`));
  });
});

describe('customProvider', () => {
  it('has correct config shape', () => {
    expect(customProvider).toMatchObject({
      id: 'custom-openai-compatible',
      label: 'Local OpenAI-compatible server',
      protocol: AuthType.USE_OPENAI,
      supportsModelDiscovery: true,
      showAdvancedConfig: true,
    });
  });

  it('detects models by the custom env-key namespace', () => {
    expect(
      customProvider.ownsModel({
        id: 'whatever',
        envKey: `${CUSTOM_API_KEY_ENV_PREFIX}OPENAI_HTTP_127_0_0_1_ABCDEF`,
      }),
    ).toBe(true);
    expect(
      customProvider.ownsModel({ id: 'other', envKey: 'OPENAI_API_KEY' }),
    ).toBe(false);
    expect(customProvider.ownsModel({ id: 'no-key' })).toBe(false);
  });

  it('creates an install plan with custom inputs', () => {
    const plan = buildInstallPlan(customProvider, {
      baseUrl: 'http://127.0.0.1:11434/v1',
      apiKey: 'sk-my-key',
      modelIds: ['qwen3'],
      advancedConfig: { enableThinking: true, maxTokens: 8192 },
    });

    expect(plan.authType).toBe(AuthType.USE_OPENAI);
    const envKey = Object.keys(plan.env ?? {})[0]!;
    expect(envKey).toBe(
      generateCustomEnvKey(AuthType.USE_OPENAI, 'http://127.0.0.1:11434/v1'),
    );
    expect(plan.env?.[envKey]).toBe('sk-my-key');
    expect(plan.modelProviders?.[0]?.authType).toBe(AuthType.USE_OPENAI);
    expect(plan.modelSelection).toEqual({
      modelId: 'qwen3',
      baseUrl: 'http://127.0.0.1:11434/v1',
    });

    const models = plan.modelProviders?.[0]?.models;
    expect(models?.[0]).toMatchObject({
      id: 'qwen3',
      baseUrl: 'http://127.0.0.1:11434/v1',
      envKey,
    });
    expect(customProvider.ownsModel(models![0]!)).toBe(true);
    expect(models?.[0]?.generationConfig?.extra_body).toEqual({
      enable_thinking: true,
    });
    expect(models?.[0]?.generationConfig?.samplingParams).toEqual({
      max_tokens: 8192,
    });
  });
});
