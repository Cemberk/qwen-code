/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { Config, ContentGeneratorConfig } from '@qwen-code/qwen-code-core';
import { REASONING_EFFORT_TIERS } from '@qwen-code/qwen-code-core';
import { describe, expect, it } from 'vitest';
import {
  getConfiguredModelReasoning,
  getReasoningForDisplay,
  getModelConfiguration,
  getGptReasoningOverrideState,
  getReasoningEffortsForConfig,
} from './model-configuration.js';

describe('model configuration manifest', () => {
  it.each([
    ['gpt-5.1', ['low', 'medium', 'high'], 'medium', false, true],
    ['gpt-5.4', ['low', 'medium', 'high', 'xhigh'], 'medium', false, true],
    ['gpt-5.5', ['low', 'medium', 'high', 'xhigh'], 'medium', true, true],
    [
      'gpt-5.6',
      ['low', 'medium', 'high', 'xhigh', 'max'],
      'medium',
      true,
      true,
    ],
    [
      'gpt-6-astra',
      ['low', 'medium', 'high', 'xhigh', 'max'],
      'medium',
      true,
      false,
    ],
    [
      'gpt-5.3-codex',
      ['low', 'medium', 'high', 'xhigh'],
      'medium',
      true,
      false,
    ],
    ['gpt-5-pro', ['high'], 'high', true, false],
  ] as const)(
    'projects the supported efforts and defaults for %s',
    (model, efforts, defaultEffort, defaultEnabled, canDisable) => {
      const reasoning = getModelConfiguration(model)?.reasoning;
      expect(reasoning).toMatchObject({
        thinking: true,
        efforts,
        defaultEffort,
        defaultEnabled,
      });
      expect(reasoning?.canDisable !== false).toBe(canDisable);
    },
  );

  it.each(['gpt-5.3-codex', 'gpt-6-astra'])(
    'requires thinking for %s',
    (model) => {
      expect(getModelConfiguration(model)?.reasoning?.canDisable).toBe(false);
    },
  );

  it('keeps configured GPT tiers and defaults ahead of the built-in fallback', () => {
    const reasoning = {
      thinking: true,
      efforts: ['medium', 'max'],
      defaultEffort: 'max',
      disableField: 'reasoning_effort',
    } as const;
    const configured = getModelConfiguration('gpt-5.4', reasoning)?.reasoning;
    expect(configured).toMatchObject({
      efforts: ['medium', 'max'],
      defaultEffort: 'max',
    });
    expect(configured?.canDisable).not.toBe(false);
    expect(
      getModelConfiguration('gpt-6-astra', reasoning)?.reasoning,
    ).toMatchObject({
      efforts: ['medium', 'max'],
      defaultEffort: 'max',
      canDisable: false,
    });
  });

  it('projects reasoning declared by the resolved provider model', () => {
    const reasoning = {
      thinking: true,
      efforts: ['high', 'max'],
      defaultEffort: 'high',
      disableField: 'thinking',
    } as const;
    const config = {
      getModel: () => 'deepseek-v4-pro',
      getAuthType: () => 'openai',
      getContentGeneratorConfig: () => ({
        model: 'deepseek-v4-pro',
        authType: 'openai',
        baseUrl: 'http://127.0.0.1:11434/v1',
      }),
      getResolvedModelConfig: () => ({ capabilities: { reasoning } }),
    } as unknown as Config;

    expect(getConfiguredModelReasoning(config)).toBe(reasoning);
    expect(
      getConfiguredModelReasoning({
        ...config,
        getActiveRuntimeModelSnapshot: () => ({ id: 'runtime-model' }),
      } as unknown as Config),
    ).toBeUndefined();
    const projected = getModelConfiguration(
      'deepseek-v4-pro',
      reasoning,
    )?.reasoning;
    expect(projected).toMatchObject({
      efforts: ['high', 'max'],
      defaultEffort: 'high',
    });
    expect(projected?.canDisable).not.toBe(false);
  });

  it('ignores an incomplete user-provided reasoning capability', () => {
    const config = {
      getModel: () => 'custom-model',
      getAuthType: () => 'openai',
      getResolvedModelConfig: () => ({
        capabilities: { reasoning: { thinking: true } },
      }),
    } as unknown as Config;
    expect(getConfiguredModelReasoning(config)).toBeUndefined();
  });

  it('registers the exact stable qwen3.8-max reasoning controls', () => {
    expect(getModelConfiguration('qwen3.8-max')).toEqual({
      reasoning: {
        thinking: true,
        efforts: ['low', 'medium', 'xhigh'],
        defaultEffort: 'xhigh',
      },
    });
  });

  it.each([
    'qwen3.5-plus',
    'qwen3.6-plus',
    'qwen3.6-flash',
    'qwen3.7-plus',
    'qwen3.7-max',
  ])('registers toggle-only reasoning for %s', (modelId) => {
    expect(getModelConfiguration(modelId)).toEqual({
      reasoning: {
        thinking: true,
        toggleOnly: true,
      },
    });
  });

  it.each([
    undefined,
    'qwen3.8-max-preview',
    'qwen3.8-max-latest',
    'qwen3.8-max-2026-08-12',
    'vendor/qwen3.8-max',
    'qwen3.7-plus-latest',
    'vendor/qwen3.7-plus',
    'QWEN3.7-PLUS',
    'qwen3-max-2026-01-23',
    'qwen3-coder-plus',
    'qwen3-coder-next',
  ])('does not broaden the manifest to %s', (modelId) => {
    expect(getModelConfiguration(modelId)).toBeUndefined();
  });
});

describe('GPT raw reasoning reporting', () => {
  it.each([
    [{ model: 'custom-model', extra_body: { reasoning: false } }, undefined],
    [{ reasoning: false, extra_body: { reasoning: false } }, undefined],
    [
      { extra_body: { reasoning: false } },
      { enabled: true, useDefaultEffort: true },
    ],
    [
      { extra_body: { reasoning: null } },
      { enabled: true, useDefaultEffort: true },
    ],
    [
      { model: 'gpt-5.4', extra_body: { reasoning: { effort: 'high' } } },
      { enabled: false, useDefaultEffort: true },
    ],
    [
      { extra_body: { reasoning: { effort: 'high' } } },
      { enabled: true, useDefaultEffort: true },
    ],
    [
      { extra_body: { reasoning: false, reasoning_effort: 'none' } },
      { enabled: false, useDefaultEffort: true },
    ],
    [
      { extra_body: { reasoning_effort: 'high' } },
      { enabled: true, effort: 'high', useDefaultEffort: false },
    ],
    [
      { samplingParams: { reasoning_effort: 'high' } },
      { enabled: true, effort: 'high', useDefaultEffort: false },
    ],
    [
      {
        samplingParams: { reasoning_effort: 'high' },
        extra_body: { reasoning_effort: 'low' },
      },
      { enabled: true, effort: 'low', useDefaultEffort: false },
    ],
    [
      {
        samplingParams: { reasoning_effort: 'high' },
        extra_body: { reasoning_effort: null },
      },
      undefined,
    ],
    [
      { model: 'gpt-6-astra', extra_body: { reasoning_effort: 'none' } },
      { enabled: true, useDefaultEffort: true },
    ],
    [
      {
        model: 'gpt-5.5',
        thinkingMandatory: true,
        extra_body: { reasoning_effort: 'none' },
      },
      { enabled: true, useDefaultEffort: true },
    ],
  ] as const)(
    'reports effective raw precedence for %j',
    (overrides, expected) => {
      expect(
        getGptReasoningOverrideState({
          model: 'gpt-5.5',
          baseUrl: 'http://127.0.0.1:11434/v1',
          reasoning: { effort: 'xhigh' },
          ...overrides,
        } as ContentGeneratorConfig),
      ).toEqual(expected ? { ...expected, blocksTierChange: true } : undefined);
    },
  );
});

// `/effort` and a workflow agent's per-call effort share one tier rule (core's
// reasoningEffortsForCapability); these pin it at the `/effort` read site.
describe('getReasoningEffortsForConfig', () => {
  const configWith = (reasoning: unknown) =>
    ({
      getModel: () => 'custom-model',
      getAuthType: () => 'openai',
      getContentGeneratorConfig: () => ({
        model: 'custom-model',
        authType: 'openai',
        baseUrl: 'http://127.0.0.1:11434/v1',
      }),
      getResolvedModelConfig: () => ({ capabilities: { reasoning } }),
    }) as unknown as Config;

  it('offers nothing for a toggle-only model', () => {
    expect(
      getReasoningEffortsForConfig(
        configWith({
          thinking: true,
          toggleOnly: true,
          disableField: 'enable_thinking',
        }),
      ),
    ).toEqual([]);
  });

  it('offers exactly the declared tiers', () => {
    expect(
      getReasoningEffortsForConfig(
        configWith({
          thinking: true,
          disableField: 'reasoning_effort',
          efforts: ['low', 'high'],
        }),
      ),
    ).toEqual(['low', 'high']);
  });

  it('offers every tier for a model that declares none', () => {
    expect(getReasoningEffortsForConfig(configWith(undefined))).toEqual(
      REASONING_EFFORT_TIERS,
    );
  });
});

describe('external reasoning controls', () => {
  const declaration = {
    profile: 'openai-effort',
    efforts: ['low', 'medium', 'high'],
    defaultEffort: 'medium',
  } as const;
  const generation = {
    model: 'company-alias',
    authType: 'openai',
    baseUrl: 'http://127.0.0.1:11434/v1',
  } as ContentGeneratorConfig;

  it('uses the captured exact route while live settings change', () => {
    const active = {
      ...generation,
      reasoningRouteBaseUrl: null,
      reasoningSnapshot: [
        {
          id: generation.model,
          authType: generation.authType!,
          baseUrl: generation.baseUrl,
          reasoning: declaration,
        },
        {
          id: generation.model,
          authType: generation.authType!,
          baseUrl: generation.baseUrl,
          registryBaseUrl: generation.baseUrl,
          reasoning: { ...declaration, defaultEffort: 'high' as const },
        },
      ],
    };
    const config = {
      getModel: () => generation.model,
      getContentGeneratorConfig: () => active,
      getResolvedModelConfig: () => {
        throw new Error('must not read live registry');
      },
    } as unknown as Config;
    expect(getReasoningForDisplay(config, active)).toEqual({
      effort: 'medium',
    });
    expect(
      getReasoningForDisplay(config, {
        ...active,
        reasoningRouteBaseUrl: generation.baseUrl,
      }),
    ).toEqual({ effort: 'high' });
  });
});
