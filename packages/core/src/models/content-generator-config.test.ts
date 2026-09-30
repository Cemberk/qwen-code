/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  buildAgentContentGeneratorConfig,
  createRuntimeContentGeneratorView,
} from './content-generator-config.js';
import { createContentGenerator } from '../core/contentGenerator.js';
import type { ContentGeneratorConfig } from '../core/contentGenerator.js';
import type { Config } from '../config/config.js';
import type { ResolvedModelConfig } from './types.js';
import { ModelsConfig } from './modelsConfig.js';
import { getLocalBaseUrlError } from '../utils/local-base-url.js';

vi.mock('../core/contentGenerator.js', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('../core/contentGenerator.js')>();
  return {
    ...actual,
    createContentGenerator: vi.fn(),
  };
});

const PARENT_URL = 'http://127.0.0.1:11434/v1';
const SECOND_URL = 'http://localhost:1234/v1';
const REGISTRY_URL = 'http://127.0.0.1:8080/v1';

function createMockConfig(
  parentConfig: ContentGeneratorConfig,
  resolvedModel?: ResolvedModelConfig,
) {
  return {
    getContentGeneratorConfig: () => parentConfig,
    getModelsConfig: () => ({
      getResolvedModel: vi.fn().mockReturnValue(resolvedModel),
    }),
  } as unknown as Config;
}

describe('buildAgentContentGeneratorConfig', () => {
  const parentConfig: ContentGeneratorConfig = {
    model: 'parent-model',
    authType: 'openai' as ContentGeneratorConfig['authType'],
    apiKey: 'parent-key',
    apiKeyEnvKey: 'PARENT_KEY_ENV',
    baseUrl: PARENT_URL,
    samplingParams: { temperature: 0.7, top_p: 0.9 },
    reasoning: { effort: 'high' as const },
    timeout: 30000,
    streamIdleTimeoutMs: 300000,
    maxRetries: 3,
    contextWindowSize: 128000,
    extra_body: { custom: 'value' },
  };

  describe('endpoint-qualified advisor models', () => {
    afterEach(() => vi.unstubAllEnvs());

    function endpointConfig() {
      const models = new ModelsConfig({
        modelProvidersConfig: {
          openai: [
            {
              id: 'shared',
              baseUrl: PARENT_URL,
              envKey: 'PARENT_KEY_ENV',
            },
            {
              id: 'shared',
              baseUrl: SECOND_URL,
              envKey: 'SECOND_KEY',
            },
          ],
        },
      });
      return {
        getContentGeneratorConfig: () => ({
          ...parentConfig,
          model: 'shared',
          customHeaders: { Authorization: 'parent-secret' },
        }),
        getModelsConfig: () => models,
      } as unknown as Config;
    }

    it('uses the selected endpoint and its own credential with a bare model ID', () => {
      vi.stubEnv('SECOND_KEY', 'second-key');
      const result = buildAgentContentGeneratorConfig(
        endpointConfig(),
        'shared',
        {
          authType: 'openai',
          registryBaseUrl: SECOND_URL,
        },
      );
      expect(result).toMatchObject({
        model: 'shared',
        baseUrl: SECOND_URL,
        apiKey: 'second-key',
        apiKeyEnvKey: 'SECOND_KEY',
      });
      expect(result.customHeaders).toBeUndefined();
    });

    it('does not send parent credentials to an endpoint with a missing key', () => {
      vi.stubEnv('SECOND_KEY', undefined);
      const result = buildAgentContentGeneratorConfig(
        endpointConfig(),
        'shared',
        {
          authType: 'openai',
          registryBaseUrl: SECOND_URL,
        },
      );
      expect(result.apiKey).toBeUndefined();
      expect(result.customHeaders).toBeUndefined();
    });

    it('retains credentials and headers when the selected route matches the parent', () => {
      vi.stubEnv('PARENT_KEY_ENV', undefined);
      const result = buildAgentContentGeneratorConfig(
        endpointConfig(),
        'shared',
        {
          authType: 'openai',
          registryBaseUrl: PARENT_URL,
        },
      );
      expect(result.apiKey).toBe('parent-key');
      expect(result.customHeaders).toEqual({ Authorization: 'parent-secret' });
    });

    it.each([null, 'http://127.0.0.1:9999/v1', 'https://api.openai.com/v1'])(
      'rejects an endpoint that is not configured: %s',
      (registryBaseUrl) => {
        expect(() =>
          buildAgentContentGeneratorConfig(endpointConfig(), 'shared', {
            authType: 'openai',
            registryBaseUrl,
          }),
        ).toThrow('no longer configured');
      },
    );
  });

  describe('bare model ID, no registry match', () => {
    it('should override the model but keep parent generation config', () => {
      const config = createMockConfig(parentConfig);

      const result = buildAgentContentGeneratorConfig(config, 'custom-model', {
        authType: 'openai',
      });

      expect(result.model).toBe('custom-model');
      expect(result.authType).toBe('openai');
      expect(result.apiKey).toBe('parent-key');
      expect(result.baseUrl).toBe(PARENT_URL);
      expect(result.apiKeyEnvKey).toBe('PARENT_KEY_ENV');
      // Generation config inherited from parent
      expect(result.samplingParams).toEqual({ temperature: 0.7, top_p: 0.9 });
      expect(result.reasoning).toEqual({ effort: 'high' });
      expect(result.timeout).toBe(30000);
      expect(result.streamIdleTimeoutMs).toBe(300000);
      expect(result.maxRetries).toBe(3);
      expect(result.contextWindowSize).toBe(128000);
      expect(result.extra_body).toEqual({ custom: 'value' });
    });

    it('does not inherit mandatory thinking from another model', () => {
      const config = createMockConfig({
        ...parentConfig,
        thinkingMandatory: true,
      });

      const result = buildAgentContentGeneratorConfig(config, 'custom-model', {
        authType: 'openai',
      });

      expect(result.thinkingMandatory).toBeUndefined();
    });

    it('should use explicit auth overrides', () => {
      const config = createMockConfig(parentConfig);

      const result = buildAgentContentGeneratorConfig(config, 'custom-model', {
        authType: 'openai',
        apiKey: 'explicit-key',
        baseUrl: SECOND_URL,
      });

      expect(result.apiKey).toBe('explicit-key');
      expect(result.baseUrl).toBe(SECOND_URL);
    });
  });

  describe('side models stay on the local server', () => {
    afterEach(() => vi.unstubAllEnvs());

    function localOnlyConfig() {
      const models = new ModelsConfig({
        initialAuthType: 'openai' as ContentGeneratorConfig['authType'],
        modelProvidersConfig: {
          openai: [
            { id: 'parent-model', baseUrl: PARENT_URL, envKey: 'PARENT_KEY' },
          ],
        },
      });
      return {
        getContentGeneratorConfig: () => parentConfig,
        getModelsConfig: () => models,
      } as unknown as Config;
    }

    it.each(['claude-sonnet-4', 'anthropic:claude-3', 'gpt-4o', 'gemini-pro'])(
      'resolves the unconfigured side model %s to the parent loopback baseUrl',
      (modelId) => {
        const result = buildAgentContentGeneratorConfig(
          localOnlyConfig(),
          modelId,
          { authType: 'openai' },
        );

        expect(result.model).toBe(modelId);
        expect(result.authType).toBe('openai');
        expect(result.baseUrl).toBe(PARENT_URL);
        expect(getLocalBaseUrlError(result.baseUrl)).toBeNull();
        expect(result.apiKey).toBe('parent-key');
      },
    );

    it('does not pick up ANTHROPIC_* or GEMINI_* env credentials', () => {
      vi.stubEnv('ANTHROPIC_API_KEY', 'env-anthropic-key');
      vi.stubEnv('ANTHROPIC_BASE_URL', 'https://api.anthropic.com');
      vi.stubEnv('ANTHROPIC_MODEL', 'claude-sonnet-4');
      vi.stubEnv('GEMINI_API_KEY', 'env-gemini-key');
      vi.stubEnv('GOOGLE_API_KEY', 'env-google-key');

      for (const modelId of ['claude-sonnet-4', 'gemini-pro', undefined]) {
        const result = buildAgentContentGeneratorConfig(
          localOnlyConfig(),
          modelId,
          { authType: 'openai' },
        );

        expect(result.apiKey).toBe('parent-key');
        expect(result.apiKeyEnvKey).toBe('PARENT_KEY_ENV');
        expect(result.baseUrl).toBe(PARENT_URL);
      }
    });
  });

  describe('with registry-resolved model', () => {
    const resolvedModel: ResolvedModelConfig = {
      id: 'registry-model-id',
      name: 'Registry Model',
      authType: 'openai' as ResolvedModelConfig['authType'],
      baseUrl: REGISTRY_URL,
      envKey: 'REGISTRY_API_KEY',
      generationConfig: {
        samplingParams: { temperature: 0.5 },
        streamIdleTimeoutMs: 600000,
        contextWindowSize: 200000,
        reasoning: { effort: 'medium' as const },
      },
      capabilities: {},
    };

    beforeEach(() => {
      vi.stubEnv('REGISTRY_API_KEY', 'registry-key-from-env');
    });

    afterEach(() => {
      vi.unstubAllEnvs();
    });

    it('should apply registry generation config over the inherited parent config', () => {
      const config = createMockConfig(parentConfig, resolvedModel);

      const result = buildAgentContentGeneratorConfig(
        config,
        'registry-model-id',
        { authType: 'openai' },
      );

      expect(result.model).toBe('registry-model-id');
      expect(result.authType).toBe('openai');
      expect(result.baseUrl).toBe(REGISTRY_URL);
      expect(result.apiKey).toBe('registry-key-from-env');
      expect(result.apiKeyEnvKey).toBe('REGISTRY_API_KEY');
      // Registry generation config applied
      expect(result.samplingParams).toEqual({ temperature: 0.5 });
      expect(result.streamIdleTimeoutMs).toBe(600000);
      expect(result.contextWindowSize).toBe(200000);
      expect(result.reasoning).toEqual({ effort: 'medium' });
      // Fields the registry does not set are inherited from the parent
      expect(result.timeout).toBe(30000);
      expect(result.extra_body).toEqual({ custom: 'value' });
    });

    it('should preserve a zero stream idle timeout from the registry', () => {
      const config = createMockConfig(parentConfig, {
        ...resolvedModel,
        generationConfig: {
          ...resolvedModel.generationConfig,
          streamIdleTimeoutMs: 0,
        },
      });

      const result = buildAgentContentGeneratorConfig(
        config,
        'registry-model-id',
        { authType: 'openai' },
      );

      expect(result.streamIdleTimeoutMs).toBe(0);
    });

    it('should prefer explicit auth overrides over registry values', () => {
      const config = createMockConfig(parentConfig, resolvedModel);

      const result = buildAgentContentGeneratorConfig(
        config,
        'registry-model-id',
        {
          authType: 'openai',
          apiKey: 'explicit-key',
          baseUrl: SECOND_URL,
        },
      );

      expect(result.apiKey).toBe('explicit-key');
      expect(result.baseUrl).toBe(SECOND_URL);
    });

    it('should use explicit baseUrl when looking up a registry model', () => {
      const getResolvedModel = vi.fn().mockReturnValue(resolvedModel);
      const config = {
        getContentGeneratorConfig: () => parentConfig,
        getModelsConfig: () => ({ getResolvedModel }),
      } as unknown as Config;

      buildAgentContentGeneratorConfig(config, 'registry-model-id', {
        authType: 'openai',
        baseUrl: REGISTRY_URL,
      });

      expect(getResolvedModel).toHaveBeenCalledWith(
        'openai',
        'registry-model-id',
        REGISTRY_URL,
      );
    });

    it('does not inherit mandatory thinking from another model', () => {
      const config = createMockConfig(
        { ...parentConfig, thinkingMandatory: true },
        resolvedModel,
      );

      const result = buildAgentContentGeneratorConfig(
        config,
        'registry-model-id',
        { authType: 'openai' },
      );

      expect(result.thinkingMandatory).toBeUndefined();
    });
  });

  // A workflow `agent({ effort })` gets its tier through this builder. It has
  // to land on the agent's copy by the rule `/effort` uses, and never on the
  // session config that copy was spread from.
  describe('per-agent reasoning effort', () => {
    // An explicit tier is authoritative on the copy: an inherited budget would
    // outrank it on the wire, so the copy drops it. The parent keeps both.
    it('writes the tier onto an inherited copy, drops the inherited budget, and leaves the parent alone', () => {
      const parent: ContentGeneratorConfig = {
        ...parentConfig,
        reasoning: { effort: 'high', budget_tokens: 4096 },
      };
      const config = createMockConfig(parent);

      const result = buildAgentContentGeneratorConfig(
        config,
        undefined,
        { authType: 'openai' },
        { reasoningEffort: 'low' },
      );

      expect(result.model).toBe('parent-model');
      expect(result.apiKey).toBe('parent-key');
      expect(result.reasoning).toEqual({ effort: 'low' });
      expect(parent.reasoning).toEqual({ effort: 'high', budget_tokens: 4096 });
    });

    it('leaves thinking off when the parent turned it off', () => {
      const config = createMockConfig({ ...parentConfig, reasoning: false });

      const result = buildAgentContentGeneratorConfig(
        config,
        undefined,
        { authType: 'openai' },
        { reasoningEffort: 'max' },
      );

      expect(result.reasoning).toBe(false);
    });

    it('changes nothing when no effort is requested', () => {
      const config = createMockConfig(parentConfig);

      const result = buildAgentContentGeneratorConfig(
        config,
        undefined,
        { authType: 'openai' },
        {},
      );

      expect(result.reasoning).toEqual({ effort: 'high' });
    });

    // Limited to what `/effort` offers the agent's model: an unoffered tier
    // becomes the next stronger offered one (else the strongest), and a model
    // that offers none keeps the tier the agent inherited.
    it('clamps to the tiers the model declares', () => {
      const config = createMockConfig(parentConfig, {
        capabilities: {
          reasoning: {
            profile: 'openai-effort',
            defaultEffort: 'high',
            efforts: ['low', 'medium', 'high'],
          },
        },
      } as unknown as ResolvedModelConfig);

      const above = buildAgentContentGeneratorConfig(
        config,
        undefined,
        { authType: 'openai' },
        { reasoningEffort: 'max' },
      );
      const offered = buildAgentContentGeneratorConfig(
        config,
        undefined,
        { authType: 'openai' },
        { reasoningEffort: 'low' },
      );

      expect(above.reasoning).toEqual({ effort: 'high' });
      expect(offered.reasoning).toEqual({ effort: 'low' });
    });

    it('keeps the inherited tier for a model that offers none', () => {
      const config = createMockConfig(parentConfig, {
        capabilities: {
          reasoning: {
            thinking: true,
            disableField: 'enable_thinking',
            toggleOnly: true,
          },
        },
      } as unknown as ResolvedModelConfig);

      const result = buildAgentContentGeneratorConfig(
        config,
        undefined,
        { authType: 'openai' },
        { reasoningEffort: 'low' },
      );

      expect(result.reasoning).toEqual({ effort: 'high' });
    });

    it('drops a thinking budget the agent model registry provides', () => {
      const registryModel = {
        id: 'registry-model',
        authType: 'openai',
        name: 'registry-model',
        baseUrl: REGISTRY_URL,
        generationConfig: { reasoning: { budget_tokens: 32000 } },
        capabilities: {},
      } as unknown as ResolvedModelConfig;
      const config = createMockConfig(parentConfig, registryModel);

      const result = buildAgentContentGeneratorConfig(
        config,
        'registry-model',
        { authType: 'openai' },
        { reasoningEffort: 'low' },
      );

      expect(result.model).toBe('registry-model');
      expect(result.reasoning).toEqual({ effort: 'low' });
    });

    it('never re-enables thinking the session turned off, even for another model', () => {
      const config = createMockConfig({ ...parentConfig, reasoning: false });

      const result = buildAgentContentGeneratorConfig(
        config,
        'other-model',
        { authType: 'openai' },
        { reasoningEffort: 'max' },
      );

      expect(result.reasoning).toBe(false);
    });

    // Registry stubs that answer only for the arguments they are given, so a
    // lookup keyed on the wrong model or an exact-only base URL shows up.
    const DECLARED_TIERS = {
      thinking: true,
      disableField: 'reasoning_effort',
      efforts: ['low', 'medium', 'high'],
    };
    function configWithRegistry(
      parent: ContentGeneratorConfig,
      entry: { authType: string; model: string; baseUrl: string },
    ): Config {
      const getResolvedModel = vi.fn(
        (authType: string, model: string, baseUrl?: string) =>
          authType === entry.authType &&
          model === entry.model &&
          (baseUrl === undefined || baseUrl === entry.baseUrl)
            ? ({
                id: entry.model,
                authType: entry.authType,
                name: entry.model,
                baseUrl: entry.baseUrl,
                generationConfig: {},
                capabilities: { reasoning: DECLARED_TIERS },
              } as unknown as ResolvedModelConfig)
            : undefined,
      );
      return {
        getContentGeneratorConfig: () => parent,
        getModelsConfig: () => ({ getResolvedModel }),
      } as unknown as Config;
    }

    it("clamps against the agent's own model, not the session's", () => {
      const config = configWithRegistry(parentConfig, {
        authType: 'openai',
        model: 'agent-model',
        baseUrl: REGISTRY_URL,
      });

      const result = buildAgentContentGeneratorConfig(
        config,
        'agent-model',
        { authType: 'openai' },
        { reasoningEffort: 'max' },
      );

      expect(result.model).toBe('agent-model');
      expect(result.reasoning).toEqual({ effort: 'high' });
    });

    it('finds the declared tiers behind a different base URL', () => {
      const config = configWithRegistry(
        { ...parentConfig, baseUrl: SECOND_URL },
        {
          authType: 'openai',
          model: 'parent-model',
          baseUrl: PARENT_URL,
        },
      );

      const result = buildAgentContentGeneratorConfig(
        config,
        undefined,
        { authType: 'openai' },
        { reasoningEffort: 'max' },
      );

      expect(result.reasoning).toEqual({ effort: 'high' });
    });

    it("falls back to the provider's built-in tiers when the registry declares none", () => {
      const config = createMockConfig({ ...parentConfig, model: 'gpt-5' });

      const result = buildAgentContentGeneratorConfig(
        config,
        undefined,
        { authType: 'openai' },
        { reasoningEffort: 'max' },
      );

      expect(result.reasoning).toEqual({ effort: 'high' });
    });

    it('carries the effort through createRuntimeContentGeneratorView', async () => {
      const config = createMockConfig(parentConfig);
      vi.mocked(createContentGenerator).mockResolvedValue(
        {} as Awaited<ReturnType<typeof createContentGenerator>>,
      );

      const view = await createRuntimeContentGeneratorView(
        config,
        config,
        undefined,
        { authType: 'openai' },
        { reasoningEffort: 'medium' },
      );

      expect(view.contentGeneratorConfig.reasoning).toEqual({
        effort: 'medium',
      });
      expect(createContentGenerator).toHaveBeenCalledWith(
        expect.objectContaining({ reasoning: { effort: 'medium' } }),
        config,
      );
    });
  });

  describe('edge cases', () => {
    it('should fall back to parent model when modelId is undefined', () => {
      const config = createMockConfig(parentConfig);

      const result = buildAgentContentGeneratorConfig(config, undefined, {
        authType: 'openai',
      });

      expect(result.model).toBe('parent-model');
    });

    it('should keep userAgent from parent', () => {
      const config = createMockConfig({
        ...parentConfig,
        userAgent: 'custom-agent/1.0',
      });

      const result = buildAgentContentGeneratorConfig(config, 'other-model', {
        authType: 'openai',
      });

      expect(result.userAgent).toBe('custom-agent/1.0');
    });
  });
});

describe('createRuntimeContentGeneratorView', () => {
  const parentConfig: ContentGeneratorConfig = {
    model: 'parent-model',
    authType: 'openai' as ContentGeneratorConfig['authType'],
    apiKey: 'parent-key',
    baseUrl: PARENT_URL,
  };

  beforeEach(() => {
    vi.mocked(createContentGenerator).mockReset();
  });

  it('should bind the new ContentGenerator to contentGeneratorOwner, not base', async () => {
    const baseConfig = createMockConfig(parentConfig);
    // Distinct instance — represents the per-agent override Config.
    const ownerConfig = createMockConfig(parentConfig);
    const fakeGenerator = { generateContentStream: vi.fn() };
    vi.mocked(createContentGenerator).mockResolvedValueOnce(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      fakeGenerator as any,
    );

    const view = await createRuntimeContentGeneratorView(
      baseConfig,
      ownerConfig,
      'custom-model',
      { authType: 'openai' },
    );

    expect(createContentGenerator).toHaveBeenCalledTimes(1);
    const [, ownerArg] = vi.mocked(createContentGenerator).mock.calls[0];
    expect(ownerArg).toBe(ownerConfig);
    expect(ownerArg).not.toBe(baseConfig);
    expect(view.contentGenerator).toBe(fakeGenerator);
    expect(view.contentGeneratorConfig.model).toBe('custom-model');
  });

  it.each([
    [
      'a cloud base URL override',
      { authType: 'openai', baseUrl: 'https://api.openai.com/v1' },
      'is not allowed',
    ],
    [
      'a removed auth type',
      { authType: 'anthropic' },
      "Auth type 'anthropic' is not supported",
    ],
  ])('refuses %s for a side model', async (_label, authOverrides, message) => {
    const actual = await vi.importActual<
      typeof import('../core/contentGenerator.js')
    >('../core/contentGenerator.js');
    vi.mocked(createContentGenerator).mockImplementationOnce(
      actual.createContentGenerator,
    );
    const config = createMockConfig(parentConfig);

    await expect(
      createRuntimeContentGeneratorView(
        config,
        config,
        'claude-sonnet-4',
        authOverrides,
      ),
    ).rejects.toThrow(message);
  });
});
