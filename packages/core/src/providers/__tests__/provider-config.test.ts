/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import { AuthType } from '../../core/contentGenerator.js';
import {
  customProvider,
  findProviderByCredentials,
  generateCustomEnvKey,
} from '../all-providers.js';
import {
  buildInstallPlan,
  findExistingProviderModels,
  getProviderModels,
  providerMatchesCredentials,
} from '../provider-config.js';
import type { ProviderConfig, ProviderModelConfig } from '../types.js';

const BASE_URL = 'http://127.0.0.1:11434/v1';

function makeConfig(overrides: Partial<ProviderConfig> = {}): ProviderConfig {
  return {
    id: 'test',
    label: 'Test',
    description: 'A test provider',
    protocol: AuthType.USE_OPENAI,
    envKey: () => 'TEST_API_KEY',
    ownsModel: (model) => model.envKey === 'TEST_API_KEY',
    ...overrides,
  };
}

describe('buildInstallPlan', () => {
  it('builds a plan for the given models at the local base URL', () => {
    const plan = buildInstallPlan(makeConfig(), {
      baseUrl: BASE_URL,
      apiKey: 'sk-test',
      modelIds: ['model-a', 'model-b'],
    });

    expect(plan).toEqual({
      providerId: 'test',
      authType: AuthType.USE_OPENAI,
      env: { TEST_API_KEY: 'sk-test' },
      modelSelection: { modelId: 'model-a', baseUrl: BASE_URL },
      modelProviders: [
        {
          authType: AuthType.USE_OPENAI,
          models: [
            {
              id: 'model-a',
              name: 'model-a',
              baseUrl: BASE_URL,
              envKey: 'TEST_API_KEY',
            },
            {
              id: 'model-b',
              name: 'model-b',
              baseUrl: BASE_URL,
              envKey: 'TEST_API_KEY',
            },
          ],
        },
      ],
    });
  });

  it('trims the base URL before storing it', () => {
    const plan = buildInstallPlan(makeConfig(), {
      baseUrl: `  ${BASE_URL}  `,
      apiKey: 'sk-test',
      modelIds: ['model-a'],
    });

    expect(plan.modelSelection).toEqual({
      modelId: 'model-a',
      baseUrl: BASE_URL,
    });
    expect(plan.modelProviders?.[0]?.models[0]?.baseUrl).toBe(BASE_URL);
  });

  it.each(['', '   '])('throws for a blank base URL (%j)', (baseUrl) => {
    expect(() =>
      buildInstallPlan(makeConfig(), {
        baseUrl,
        apiKey: 'sk-test',
        modelIds: ['model-a'],
      }),
    ).toThrow(/No model server base URL is configured/);
  });

  it.each([
    'https://api.openai.com/v1',
    'http://192.168.1.5:8000/v1',
    'http://localhost.evil.com/v1',
    'http://127.0.0.1@evil.com/v1',
  ])('throws for the non-loopback base URL %s', (baseUrl) => {
    expect(() =>
      buildInstallPlan(makeConfig(), {
        baseUrl,
        apiKey: 'sk-test',
        modelIds: ['model-a'],
      }),
    ).toThrow(
      /is not allowed: the host must be 127\.0\.0\.1, ::1 or localhost/,
    );
  });

  it('builds model configs with advancedConfig', () => {
    const plan = buildInstallPlan(makeConfig(), {
      baseUrl: BASE_URL,
      apiKey: 'sk-test',
      modelIds: ['m1', 'm2'],
      advancedConfig: {
        enableThinking: true,
        multimodal: { image: true, video: false, audio: false },
        contextWindowSize: 131072,
        maxTokens: 4096,
      },
    });

    const models = plan.modelProviders?.[0]?.models;
    expect(models).toHaveLength(2);
    expect(models?.[0]?.generationConfig).toEqual({
      extra_body: { enable_thinking: true },
      modalities: { image: true, video: false, audio: false },
      contextWindowSize: 131072,
      samplingParams: { max_tokens: 4096 },
    });
  });

  it('omits generationConfig when advancedConfig sets nothing', () => {
    const plan = buildInstallPlan(makeConfig(), {
      baseUrl: BASE_URL,
      apiKey: 'sk-test',
      modelIds: ['m1'],
      advancedConfig: {
        enableThinking: false,
        multimodal: { image: false },
        contextWindowSize: 0,
      },
    });

    expect(
      plan.modelProviders?.[0]?.models[0]?.generationConfig,
    ).toBeUndefined();
  });

  it('produces independent generationConfig objects per model', () => {
    const plan = buildInstallPlan(makeConfig(), {
      baseUrl: BASE_URL,
      apiKey: 'sk-test',
      modelIds: ['m1', 'm2'],
      advancedConfig: { enableThinking: true },
    });

    const models = plan.modelProviders?.[0]?.models;
    expect(models?.[0]?.generationConfig).toEqual(
      models?.[1]?.generationConfig,
    );
    expect(models?.[0]?.generationConfig).not.toBe(
      models?.[1]?.generationConfig,
    );
  });

  it('throws when the model list is empty', () => {
    expect(() =>
      buildInstallPlan(makeConfig(), {
        baseUrl: BASE_URL,
        apiKey: 'sk-test',
        modelIds: [],
      }),
    ).toThrow(/No models configured for provider "test"/);
  });

  it('derives the env key from the provider protocol and base URL', () => {
    const plan = buildInstallPlan(customProvider, {
      baseUrl: BASE_URL,
      apiKey: 'sk-local',
      modelIds: ['m1'],
    });

    const envKey = generateCustomEnvKey(AuthType.USE_OPENAI, BASE_URL);
    expect(plan.env).toEqual({ [envKey]: 'sk-local' });
    expect(plan.modelProviders?.[0]?.models[0]?.envKey).toBe(envKey);
  });

  it('merges a reconnected model with its saved entry at the same base URL', () => {
    const existing: ProviderModelConfig[] = [
      {
        id: 'model-a',
        name: 'Hand-named',
        baseUrl: BASE_URL,
        envKey: 'SAVED_KEY',
        description: 'kept',
        generationConfig: { contextWindowSize: 65536, timeout: 12345 },
      },
      {
        id: 'model-a',
        baseUrl: 'http://localhost:1234/v1',
        envKey: 'OTHER_ENDPOINT_KEY',
      },
    ];
    const before = structuredClone(existing);

    const plan = buildInstallPlan(
      makeConfig(),
      { baseUrl: BASE_URL, apiKey: 'sk-new', modelIds: ['model-a'] },
      existing,
    );

    expect(plan.env).toEqual({ SAVED_KEY: 'sk-new' });
    expect(plan.modelProviders?.[0]?.models).toEqual([
      {
        id: 'model-a',
        name: 'Hand-named',
        baseUrl: BASE_URL,
        envKey: 'SAVED_KEY',
        description: 'kept',
        generationConfig: { contextWindowSize: 65536, timeout: 12345 },
      },
    ]);
    expect(existing).toEqual(before);
  });

  it('refuses one API key for models saved under different credential references', () => {
    const existing: ProviderModelConfig[] = [
      { id: 'model-a', baseUrl: BASE_URL, envKey: 'KEY_A' },
      { id: 'model-b', baseUrl: BASE_URL, envKey: 'KEY_B' },
    ];

    expect(() =>
      buildInstallPlan(
        makeConfig(),
        {
          baseUrl: BASE_URL,
          apiKey: 'sk-new',
          modelIds: ['model-a', 'model-b'],
        },
        existing,
      ),
    ).toThrow(/different credential references/);
  });

  it('clears explicitly submitted advanced controls without losing unrelated settings', () => {
    const inputs = {
      baseUrl: BASE_URL,
      apiKey: 'new-key',
      modelIds: ['custom-model'],
    };
    const initial = buildInstallPlan(customProvider, {
      ...inputs,
      advancedConfig: {
        enableThinking: true,
        multimodal: { image: true, audio: true },
        contextWindowSize: 131072,
        maxTokens: 8192,
      },
    });
    const existing = initial.modelProviders![0]!.models;
    existing[0]!.generationConfig = {
      ...existing[0]!.generationConfig,
      extra_body: {
        ...existing[0]!.generationConfig?.extra_body,
        custom_flag: 'retained',
      },
      samplingParams: { max_tokens: 8192, temperature: 0.2 },
      customHeaders: { 'X-Route': 'paid' },
      timeout: 12345,
    };
    const before = structuredClone(existing);
    expect(
      buildInstallPlan(customProvider, inputs, existing).modelProviders![0]!
        .models,
    ).toEqual(existing);
    for (const advancedConfig of [{}, { contextWindowSize: 65536 }]) {
      const partial = buildInstallPlan(
        customProvider,
        { ...inputs, advancedConfig },
        existing,
      ).modelProviders![0]!.models[0]!;
      expect(partial.generationConfig).toEqual({
        ...existing[0]!.generationConfig,
        ...(advancedConfig.contextWindowSize
          ? { contextWindowSize: 65536 }
          : {}),
      });
    }
    const disabled = buildInstallPlan(
      customProvider,
      { ...inputs, advancedConfig: { enableThinking: false } },
      existing,
    ).modelProviders![0]!.models[0]!;
    const expectedDisabled = structuredClone(existing[0]!.generationConfig!);
    delete expectedDisabled.extra_body!['enable_thinking'];
    expect(disabled.generationConfig).toEqual(expectedDisabled);
    const withoutModalities = buildInstallPlan(
      customProvider,
      { ...inputs, advancedConfig: { multimodal: {} } },
      existing,
    ).modelProviders![0]!.models[0]!;
    const expectedModalities = structuredClone(existing[0]!.generationConfig!);
    delete expectedModalities.modalities;
    expect(withoutModalities.generationConfig).toEqual(expectedModalities);
    const cleared = buildInstallPlan(
      customProvider,
      { ...inputs, advancedConfig: { replaceExisting: true } },
      existing,
    ).modelProviders![0]!.models[0]!;
    expect(cleared.generationConfig).toEqual({
      extra_body: { custom_flag: 'retained' },
      samplingParams: { temperature: 0.2 },
      customHeaders: { 'X-Route': 'paid' },
      timeout: 12345,
    });
    expect(cleared.envKey).toBe(existing[0]!.envKey);
    const enabled = buildInstallPlan(
      customProvider,
      { ...inputs, advancedConfig: { enableThinking: true } },
      existing,
    ).modelProviders![0]!.models[0]!;
    expect(enabled.generationConfig?.extra_body).toEqual({
      custom_flag: 'retained',
      enable_thinking: true,
    });
    expect(enabled.generationConfig).toEqual(existing[0]!.generationConfig);
    const replaced = buildInstallPlan(
      customProvider,
      {
        ...inputs,
        advancedConfig: {
          replaceExisting: true,
          contextWindowSize: 32768,
          maxTokens: 4096,
        },
      },
      existing,
    ).modelProviders![0]!.models[0]!;
    expect(replaced.generationConfig).toEqual({
      ...cleared.generationConfig,
      contextWindowSize: 32768,
      samplingParams: { temperature: 0.2, max_tokens: 4096 },
    });
    expect(existing).toEqual(before);
  });
});

describe('getProviderModels', () => {
  it('returns the well-formed entries of the openai bucket', () => {
    expect(
      getProviderModels({
        openai: [{ id: 'a' }, null, { name: 'no id' }, 'text', { id: 'b' }],
        anthropic: [{ id: 'ignored' }],
      }),
    ).toEqual([{ id: 'a' }, { id: 'b' }]);
  });

  it('returns an empty list for a missing or malformed bucket', () => {
    expect(getProviderModels(undefined)).toEqual([]);
    expect(getProviderModels({})).toEqual([]);
    expect(getProviderModels({ openai: { id: 'a' } })).toEqual([]);
  });
});

describe('findExistingProviderModels', () => {
  const config = makeConfig();

  it('returns the user-saved models owned by the provider', () => {
    const result = findExistingProviderModels(config, {
      [AuthType.USE_OPENAI]: [
        { id: 'custom-model', envKey: 'TEST_API_KEY' },
        { id: 'default-model', envKey: 'TEST_API_KEY' },
        { id: 'other-provider-model', envKey: 'OTHER_API_KEY' },
      ],
    });
    expect(result).toEqual({
      protocol: AuthType.USE_OPENAI,
      models: [
        { id: 'custom-model', envKey: 'TEST_API_KEY' },
        { id: 'default-model', envKey: 'TEST_API_KEY' },
      ],
    });
  });

  it('returns undefined when no saved models are owned by the provider', () => {
    expect(
      findExistingProviderModels(config, {
        [AuthType.USE_OPENAI]: [{ id: 'x', envKey: 'OTHER_API_KEY' }],
      }),
    ).toBeUndefined();
  });

  it('returns undefined when modelProviders is empty or missing', () => {
    expect(findExistingProviderModels(config, {})).toBeUndefined();
    expect(findExistingProviderModels(config, undefined)).toBeUndefined();
  });

  it('ignores entries outside the openai bucket', () => {
    expect(
      findExistingProviderModels(config, {
        anthropic: [{ id: 'x', envKey: 'TEST_API_KEY' }],
      }),
    ).toBeUndefined();
  });
});

describe('providerMatchesCredentials', () => {
  const envKey = generateCustomEnvKey(AuthType.USE_OPENAI, BASE_URL);

  it('matches when the env key derives from the base URL', () => {
    expect(providerMatchesCredentials(customProvider, BASE_URL, envKey)).toBe(
      true,
    );
  });

  it('rejects a mismatched env key', () => {
    expect(
      providerMatchesCredentials(customProvider, BASE_URL, 'OTHER_KEY'),
    ).toBe(false);
    expect(
      providerMatchesCredentials(customProvider, BASE_URL, undefined),
    ).toBe(false);
  });

  it('rejects a mismatched or missing base URL', () => {
    expect(
      providerMatchesCredentials(
        customProvider,
        'http://localhost:1234/v1',
        envKey,
      ),
    ).toBe(false);
    expect(providerMatchesCredentials(customProvider, undefined, envKey)).toBe(
      false,
    );
  });
});

describe('findProviderByCredentials', () => {
  it('finds the local provider by its derived env key', () => {
    expect(
      findProviderByCredentials(
        BASE_URL,
        generateCustomEnvKey(AuthType.USE_OPENAI, BASE_URL),
      )?.id,
    ).toBe('custom-openai-compatible');
  });

  it('returns undefined for an unknown env key or mismatched base URL', () => {
    expect(
      findProviderByCredentials(BASE_URL, 'NOT_A_REAL_KEY'),
    ).toBeUndefined();
    expect(
      findProviderByCredentials(
        'http://localhost:1234/v1',
        generateCustomEnvKey(AuthType.USE_OPENAI, BASE_URL),
      ),
    ).toBeUndefined();
  });
});
