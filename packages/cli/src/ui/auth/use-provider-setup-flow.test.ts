/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */
// @vitest-environment jsdom

import { act, renderHook } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { buildInstallPlan, customProvider } from '@qwen-code/qwen-code-core';
import { useProviderSetupFlow } from './useProviderSetupFlow.js';
import { maskApiKey } from './useAuth.js';

const LOCAL_BASE_URL = 'http://127.0.0.1:11434/v1';

describe('useProviderSetupFlow base URL step', () => {
  const startFlow = () => {
    const submit = vi.fn().mockResolvedValue(undefined);
    const hook = renderHook(() => useProviderSetupFlow(submit));
    act(() => hook.result.current.start(customProvider));
    return hook.result;
  };

  it('opens on the base URL step with no default value', () => {
    const result = startFlow();
    expect(result.current.state.step).toBe('baseUrl');
    expect(result.current.state.stepIndex).toBe(1);
    expect(result.current.state.totalSteps).toBe(5);
    expect(result.current.state.baseUrl).toBe('');
    expect(result.current.state.baseUrlError).toBeNull();
  });

  it('shows an error for an empty base URL instead of falling back', () => {
    const result = startFlow();
    let accepted = true;
    act(() => {
      accepted = result.current.submitBaseUrl();
    });
    expect(accepted).toBe(false);
    expect(result.current.state.step).toBe('baseUrl');
    expect(result.current.state.baseUrl).toBe('');
    expect(result.current.state.baseUrlError).toContain(
      'No model server base URL is configured',
    );
  });

  it.each(['https://api.openai.com/v1', 'http://192.168.1.5:8000/v1'])(
    'rejects the non-loopback base URL %s',
    (url) => {
      const result = startFlow();
      act(() => result.current.changeBaseUrl(url));
      let accepted = true;
      act(() => {
        accepted = result.current.submitBaseUrl();
      });
      expect(accepted).toBe(false);
      expect(result.current.state.step).toBe('baseUrl');
      expect(result.current.state.baseUrlError).toContain(
        'the host must be 127.0.0.1, ::1 or localhost',
      );
    },
  );

  it.each(['http://127.0.0.1:11434/v1', 'http://localhost:1234/v1'])(
    'accepts the loopback base URL %s',
    (url) => {
      const result = startFlow();
      let accepted = false;
      act(() => {
        accepted = result.current.submitBaseUrl(`  ${url}  `);
      });
      expect(accepted).toBe(true);
      expect(result.current.state.baseUrlError).toBeNull();
      expect(result.current.state.baseUrl).toBe(url);
      expect(result.current.state.step).toBe('apiKey');
    },
  );

  it('clears the base URL error once the field is edited', () => {
    const result = startFlow();
    act(() => {
      result.current.submitBaseUrl('https://api.openai.com/v1');
    });
    expect(result.current.state.baseUrlError).not.toBeNull();
    act(() => result.current.changeBaseUrl('http://localhost'));
    expect(result.current.state.baseUrlError).toBeNull();
  });
});

describe('useProviderSetupFlow preview', () => {
  it('prefills saved model ids but never a base URL', () => {
    const { result } = renderHook(() => useProviderSetupFlow(vi.fn()));
    act(() => result.current.start(customProvider, ['a', 'b']));
    expect(result.current.state.modelIds).toBe('a, b');
    expect(result.current.state.baseUrl).toBe('');
  });

  it('previews the same model configuration that it submits', () => {
    const submit = vi.fn().mockResolvedValue(undefined);
    const { result } = renderHook(() => useProviderSetupFlow(submit));
    act(() => result.current.start(customProvider));
    act(() => result.current.changeBaseUrl(LOCAL_BASE_URL));
    act(() => result.current.submitBaseUrl());
    act(() => result.current.submitApiKey('sk-secret-test'));
    act(() => result.current.changeModelIds('model'));
    act(() => result.current.submitModelIds());
    act(() => result.current.toggleFocusedAdvancedOption());
    act(() => result.current.changeContextWindowSize('272000'));
    act(() => result.current.submitAdvancedConfig());
    expect(result.current.state.step).toBe('review');
    const preview = JSON.parse(result.current.state.previewJson);
    act(() => result.current.submit());
    const [provider, inputs] = submit.mock.calls[0]!;
    expect(inputs).toEqual({
      baseUrl: LOCAL_BASE_URL,
      apiKey: 'sk-secret-test',
      modelIds: ['model'],
      advancedConfig: {
        enableThinking: true,
        multimodal: undefined,
        contextWindowSize: 272000,
      },
    });
    const plan = buildInstallPlan(provider, inputs);
    expect(preview.modelProviders).toEqual({
      openai: plan.modelProviders![0]!.models,
    });
    expect(preview.modelProviders.openai[0]).toMatchObject({
      baseUrl: LOCAL_BASE_URL,
      generationConfig: {
        extra_body: { enable_thinking: true },
        contextWindowSize: 272000,
      },
    });
    expect(preview.security.auth.selectedType).toBe(plan.authType);
    expect(preview.model).toEqual({ name: 'model', baseUrl: LOCAL_BASE_URL });
    expect(Object.values(preview.env)).toEqual([maskApiKey(inputs.apiKey)]);
    expect(result.current.state.previewJson).not.toContain(inputs.apiKey);
  });

  it('uses the saved canonical model metadata in both preview and submit', () => {
    const inputs = {
      baseUrl: LOCAL_BASE_URL,
      apiKey: 'test-secret',
      modelIds: ['same'],
    };
    const models = buildInstallPlan(customProvider, inputs).modelProviders![0]!
      .models;
    models[0] = {
      ...models[0]!,
      name: 'Saved name',
      generationConfig: {
        contextWindowSize: 32000,
        samplingParams: { temperature: 0.25 },
      },
    };
    const submit = vi.fn().mockResolvedValue(undefined);
    const { result } = renderHook(() =>
      useProviderSetupFlow(submit, { openai: models }),
    );
    act(() => result.current.start(customProvider));
    act(() => result.current.changeBaseUrl(inputs.baseUrl));
    act(() => result.current.submitBaseUrl());
    act(() => result.current.submitApiKey(inputs.apiKey));
    act(() => result.current.changeModelIds('same'));
    act(() => result.current.submitModelIds());
    act(() => result.current.submitAdvancedConfig());
    const preview = JSON.parse(result.current.state.previewJson);
    act(() => result.current.submit());
    const [provider, submittedInputs] = submit.mock.calls[0]!;
    expect(preview.modelProviders.openai).toEqual(
      buildInstallPlan(provider, submittedInputs, models).modelProviders![0]!
        .models,
    );
    expect(preview.modelProviders.openai[0]).toMatchObject({
      name: 'Saved name',
      generationConfig: {
        contextWindowSize: 32000,
        samplingParams: { temperature: 0.25 },
      },
    });
    expect(result.current.state.previewJson).not.toContain(inputs.apiKey);
  });

  // Reconnect the local server at `baseUrl` with the given ids and stop on
  // the review step, where the preview is computed.
  const reviewCustomReconnect = (
    submit: ReturnType<typeof vi.fn>,
    modelProviders: Parameters<typeof useProviderSetupFlow>[1],
    baseUrl: string,
    modelIds: string,
    rawModelProviders?: Parameters<typeof useProviderSetupFlow>[2],
  ) => {
    const { result } = renderHook(() =>
      useProviderSetupFlow(submit, modelProviders, rawModelProviders),
    );
    act(() => result.current.start(customProvider));
    act(() => result.current.changeBaseUrl(baseUrl));
    act(() => result.current.submitBaseUrl());
    act(() => result.current.submitApiKey('sk-secret-test'));
    act(() => result.current.changeModelIds(modelIds));
    act(() => result.current.submitModelIds());
    act(() => result.current.submitAdvancedConfig());
    expect(result.current.state.step).toBe('review');
    return result;
  };

  it('shows the credential refusal on review instead of throwing in render', () => {
    // Two saved models on one endpoint can carry different credential
    // references (an older 6-char generated key next to a 12-char one, or
    // distinct explicit envKeys). buildInstallPlan refuses to reconnect them
    // under a single key; the preview runs during render, so the refusal has
    // to be surfaced there rather than escape to the root error boundary.
    const baseUrl = LOCAL_BASE_URL;
    const saved = (keyA: string, keyB: string) => ({
      openai: [
        { id: 'a', baseUrl, envKey: keyA },
        { id: 'b', baseUrl, envKey: keyB },
      ],
    });
    const split = reviewCustomReconnect(
      vi.fn(),
      saved(
        'QWEN_CUSTOM_API_KEY_OPENAI_GATEWAY_ABC123',
        'QWEN_CUSTOM_API_KEY_OPENAI_GATEWAY_ABC123DEF456',
      ),
      baseUrl,
      'a, b',
    );
    expect(split.current.state.previewJson).toBe('');
    expect(split.current.state.previewError).toContain(
      'different credential references',
    );

    // Control: a shared credential reference previews normally.
    const shared = reviewCustomReconnect(
      vi.fn(),
      saved(
        'QWEN_CUSTOM_API_KEY_OPENAI_GATEWAY_ABC123',
        'QWEN_CUSTOM_API_KEY_OPENAI_GATEWAY_ABC123',
      ),
      baseUrl,
      'a, b',
    );
    expect(shared.current.state.previewError).toBe('');
    expect(
      JSON.parse(shared.current.state.previewJson).modelProviders.openai,
    ).toHaveLength(2);
  });

  it('masks preserved custom header values in the preview but not the plan', () => {
    // Merged settings are env-resolved, so a saved `${TOKEN}` header reaches
    // the hook as the real secret. The review screen masks the API key; it
    // must not print that header value next to it.
    const baseUrl = LOCAL_BASE_URL;
    const models = [
      {
        id: 'gpt-5',
        baseUrl,
        envKey: 'K',
        generationConfig: {
          customHeaders: { Authorization: 'Bearer sk-live-secret' },
        },
      },
    ];
    const submit = vi.fn().mockResolvedValue(undefined);
    const result = reviewCustomReconnect(
      submit,
      { openai: models },
      baseUrl,
      'gpt-5',
    );
    const previewJson = result.current.state.previewJson;
    expect(previewJson).toContain('Authorization');
    expect(previewJson).not.toContain('sk-live-secret');
    expect(
      JSON.parse(previewJson).modelProviders.openai[0].generationConfig,
    ).toEqual({ customHeaders: { Authorization: '***' } });

    act(() => result.current.submit());
    const [provider, inputs] = submit.mock.calls[0]!;
    const plan = buildInstallPlan(provider, inputs, models);
    expect(plan.modelProviders![0]!.models[0]!.generationConfig).toEqual({
      customHeaders: { Authorization: 'Bearer sk-live-secret' },
    });
  });

  it('renders preserved `${VAR}` references as written instead of the resolved secret', () => {
    // Loading resolves every string in the tree, so a reference saved in any
    // preserved field — not only `customHeaders` — reaches the hook as the
    // live value, while the writer restores the placeholder before persisting.
    // The review screen claims to show what will be saved, so it renders the
    // same placeholder form; a literal header value stays masked.
    const baseUrl = LOCAL_BASE_URL;
    const raw = [
      {
        id: 'gpt-5',
        baseUrl,
        envKey: 'K',
        generationConfig: {
          customHeaders: {
            Authorization: 'Bearer ${GATEWAY_TOKEN}',
            'X-Static': 'literal-token',
          },
          extra_body: { api_key: '${GATEWAY_KEY}' },
        },
      },
    ];
    const resolved = [
      {
        ...raw[0]!,
        generationConfig: {
          customHeaders: {
            Authorization: 'Bearer sk-live-token',
            'X-Static': 'literal-token',
          },
          extra_body: { api_key: 'sk-live-extra-body' },
        },
      },
    ];
    const submit = vi.fn().mockResolvedValue(undefined);
    const result = reviewCustomReconnect(
      submit,
      { openai: resolved },
      baseUrl,
      'gpt-5',
      { openai: raw },
    );
    expect(result.current.state.previewError).toBe('');
    const previewJson = result.current.state.previewJson;
    expect(previewJson).not.toContain('sk-live-token');
    expect(previewJson).not.toContain('sk-live-extra-body');
    expect(
      JSON.parse(previewJson).modelProviders.openai[0].generationConfig,
    ).toMatchObject({
      customHeaders: {
        Authorization: 'Bearer ${GATEWAY_TOKEN}',
        'X-Static': '***',
      },
      extra_body: { api_key: '${GATEWAY_KEY}' },
    });

    // The plan still carries the resolved values the runtime needs.
    act(() => result.current.submit());
    const [provider, inputs] = submit.mock.calls[0]!;
    const plan = buildInstallPlan(provider, inputs, resolved);
    expect(plan.modelProviders![0]!.models[0]!.generationConfig).toMatchObject(
      resolved[0]!.generationConfig,
    );
  });
});
