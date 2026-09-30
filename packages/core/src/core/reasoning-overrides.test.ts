/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */
import { describe, expect, it, vi } from 'vitest';
import {
  AuthType,
  type ContentGeneratorConfig,
  type ContentGenerator,
} from './contentGenerator.js';
import { BaseLlmClient } from './baseLlmClient.js';
import { LlmClient, SendMessageType } from './client.js';
import { buildAgentContentGeneratorConfig } from '../models/content-generator-config.js';
import { Config } from '../config/config.js';
import {
  captureReasoningSnapshot,
  getEffectiveReasoning,
  resolveReasoningCapabilities,
  validateReasoningCapabilities,
  resolveReasoningForModel,
} from './reasoning-overrides.js';
import type { AvailableModel } from '../models/types.js';

const route: ContentGeneratorConfig = {
  model: 'alias',
  authType: AuthType.USE_OPENAI,
  baseUrl: 'http://127.0.0.1:11434/v1',
};
const declaration = {
  profile: 'openai-effort' as const,
  efforts: ['low', 'medium', 'high'] as const,
  defaultEffort: 'medium' as const,
};
const model = (
  id = 'alias',
  defaultEffort: 'low' | 'medium' | 'high' = 'medium',
): AvailableModel => ({
  id,
  label: id,
  authType: AuthType.USE_OPENAI,
  baseUrl: route.baseUrl,
  registryBaseUrl: route.baseUrl,
  capabilities: { reasoning: { ...declaration, defaultEffort } },
});

function snapshotConfig(
  rows: AvailableModel[],
  marker: string | null = route.baseUrl!,
) {
  const generation = {
    ...route,
    apiKey: 'dummy',
    reasoningRouteBaseUrl: marker,
    reasoningSnapshot: captureReasoningSnapshot(rows),
  };
  const config = Object.create(Config.prototype) as Config;
  Object.assign(config, {
    reasoningSnapshot: generation.reasoningSnapshot,
    getAllConfiguredModels: () => rows,
    getContentGeneratorConfig: () => generation,
    getModel: () => route.model,
    getFastModel: () => undefined,
    getModelsConfig: () => ({
      getResolvedModel: (_auth: string, id: string) => ({
        ...rows.find((row) => row.id === id),
        generationConfig: {},
      }),
    }),
    notifyModelChangeListeners: vi.fn(),
    debugLogger: { error: vi.fn() },
  });
  return { config, generation };
}

describe('reasoning declarations', () => {
  it('overrides a known default without persisting a user choice', () => {
    const resolved = resolveReasoningCapabilities(
      { ...route, model: 'gpt-5.2' },
      { efforts: ['low', 'medium', 'xhigh'], defaultEffort: 'medium' },
    );
    expect(resolved).toMatchObject({
      profile: 'openai-effort',
      efforts: ['low', 'medium', 'xhigh'],
      defaultEffort: 'medium',
    });
    expect(getEffectiveReasoning(route, resolved)).toEqual({
      effort: 'medium',
    });
    expect(route.reasoning).toBeUndefined();
    expect(
      getEffectiveReasoning({ reasoning: { effort: 'high' } }, resolved),
    ).toEqual({ effort: 'xhigh' });
    expect(getEffectiveReasoning({ reasoning: false }, resolved)).toBe(false);
  });

  it('inherits mandatory thinking while changing a known model format', () => {
    const capability = resolveReasoningCapabilities(
      { ...route, model: 'gpt-5' },
      declaration,
    );
    expect(capability?.canDisable).toBe(false);
    expect(getEffectiveReasoning({ reasoning: false }, capability)).toEqual({
      effort: 'medium',
    });
  });

  it('inherits default-off until an explicit default is supplied', () => {
    const known = { ...route, model: 'gpt-5.2' };
    const override = { efforts: ['low', 'medium', 'high'] };
    expect(
      getEffectiveReasoning({}, resolveReasoningCapabilities(known, override)),
    ).toBe(false);
    expect(
      getEffectiveReasoning(
        {},
        resolveReasoningCapabilities(known, {
          ...override,
          defaultEffort: 'medium',
        }),
      ),
    ).toEqual({ effort: 'medium' });
  });

  it('preserves undeclared and malformed legacy inputs', () => {
    expect(resolveReasoningCapabilities(route, undefined)).toBeUndefined();
    expect(
      resolveReasoningCapabilities(route, { thinking: true }),
    ).toBeUndefined();
    const reasoning = { effort: 'high' as const, budget_tokens: 5000 };
    expect(getEffectiveReasoning({ reasoning })).toBe(reasoning);
  });

  it.each([
    {},
    { defaultEffort: 'medium' },
    { ...declaration, profile: 'unknown' },
    { ...declaration, efforts: [] },
    { ...declaration, efforts: 'medium' },
    { ...declaration, defaultEffort: null },
    { ...declaration, efforts: ['low', 'low'] },
    { ...declaration, defaultEffort: 'max' },
    { profile: 'qwen-chat-template', defaultEffort: 'medium' },
  ])('rejects an invalid declaration %j', (value) => {
    expect(resolveReasoningCapabilities(route, value)).toBeUndefined();
    expect(() => validateReasoningCapabilities(route, value)).toThrow(
      'capabilities.reasoning',
    );
  });

  it('clamps an inherited default when replacing the tier set', () => {
    expect(
      resolveReasoningCapabilities(
        { ...route, model: 'gpt-5.5' },
        { efforts: ['low', 'high'] },
      ),
    ).toMatchObject({ defaultEffort: 'high' });
  });

  it.each([
    ['qwen-chat-template', 'enable_thinking', true],
    ['deepseek-openai', 'thinking', false],
  ] as const)(
    'maps the %s profile to its wire switch',
    (profile, disableField, toggleOnly) => {
      const declared =
        profile === 'qwen-chat-template'
          ? { profile }
          : { ...declaration, profile };
      expect(
        resolveReasoningCapabilities({ ...route, model: 'qwen3:8b' }, declared),
      ).toMatchObject({ profile, disableField, toggleOnly });
    },
  );
});

describe('prompt reasoning snapshots', () => {
  it('retains staged reasoning across unmatched route edits and tolerates malformed entries', () => {
    const { config, generation } = snapshotConfig([model()]);
    config.stageReasoningOverrides({ openai: [model('alias', 'high')] });
    config.stageReasoningOverrides({ openai: [null] } as unknown as Parameters<
      Config['stageReasoningOverrides']
    >[0]);
    config.applyReasoningOverrides();
    expect(resolveReasoningForModel(config, generation)).toMatchObject({
      defaultEffort: 'high',
    });
    config.stageReasoningOverrides({
      openai: [{ id: 'alias', baseUrl: route.baseUrl }],
    });
    config.applyReasoningOverrides();
    expect(resolveReasoningForModel(config, generation)).toBeUndefined();
  });

  it('refreshes cached side-model views only on adoption while existing views retain their table', async () => {
    const { config, generation } = snapshotConfig([
      model(),
      model('child', 'low'),
    ]);
    const client = new BaseLlmClient({} as ContentGenerator, config);
    Object.assign(config, { baseLlmClient: client });
    const first = await client.resolveForModel('child', { failClosed: true });
    config.stageReasoningOverrides({ openai: [model('child', 'high')] });
    config.applyReasoningOverrides();
    const second = await client.resolveForModel('child', { failClosed: true });
    expect(
      resolveReasoningForModel(config, first.contentGeneratorConfig),
    ).toMatchObject({ defaultEffort: 'low' });
    expect(second.contentGeneratorConfig.reasoningSnapshot).toBe(
      generation.reasoningSnapshot,
    );
    expect(
      resolveReasoningForModel(config, second.contentGeneratorConfig),
    ).toMatchObject({ defaultEffort: 'high' });
    expect(config.applyReasoningOverrides()).toBe(false);
    expect(
      (await client.resolveForModel('child', { failClosed: true }))
        .contentGenerator,
    ).toBe(second.contentGenerator);
  });

  it.each([
    [false, false, 'high'],
    [true, false, 'medium'],
    [false, true, 'medium'],
  ] as const)(
    'owns promotion only for a primary user prompt (concurrent=%s)',
    async (isConcurrentSideQuery, refused, expected) => {
      const { config, generation } = snapshotConfig([model()]);
      config.stageReasoningOverrides({ openai: [model('alias', 'high')] });
      const cutoff = new Error('post-admission cutoff');
      Object.assign(config, {
        assertCanStartTurn: () => {
          if (refused) throw cutoff;
        },
        getTelemetryIncludeSensitiveSpanAttributes: () => false,
      });
      const client = Object.create(LlmClient.prototype) as LlmClient;
      Object.assign(client, { config });
      const stream = client.sendMessageStream(
        'probe',
        new AbortController().signal,
        'probe',
        {
          type: SendMessageType.UserQuery,
          isConcurrentSideQuery,
          get goalSignal(): never {
            throw cutoff;
          },
        },
      );
      await expect(stream.next()).rejects.toBe(cutoff);
      expect(resolveReasoningForModel(config, generation)).toMatchObject({
        defaultEffort: expected,
      });
    },
  );

  it.each([undefined, route.baseUrl])(
    'preserves the inherited implicit route with endpoint %s',
    (baseUrl) => {
      const { config } = snapshotConfig(
        [
          { ...model('alias', 'low'), registryBaseUrl: undefined },
          model('alias', 'high'),
        ],
        null,
      );
      const child = buildAgentContentGeneratorConfig(config, undefined, {
        baseUrl,
        authType: AuthType.USE_OPENAI,
      });
      expect(child.reasoningRouteBaseUrl).toBeNull();
      expect(resolveReasoningForModel(config, child)).toMatchObject({
        defaultEffort: 'low',
      });
    },
  );

  it('degrades invalid initial declarations without losing healthy routes', () => {
    const invalid = model('invalid');
    invalid.capabilities = { reasoning: { ...declaration, efforts: ['low'] } };
    const config = Object.create(Config.prototype) as Config;
    Object.assign(config, { getAllConfiguredModels: () => [invalid, model()] });
    const generation = {
      ...route,
      reasoningSnapshot: config.getReasoningSnapshot(),
    };
    expect(
      resolveReasoningForModel(config, generation, 'invalid'),
    ).toBeUndefined();
    expect(resolveReasoningForModel(config, generation)).toMatchObject({
      defaultEffort: 'medium',
    });
  });

  it('is immutable, exact-route scoped, and never falls through to a changed registry', () => {
    const models = [
      model(),
      {
        ...model('alias', 'high'),
        baseUrl: 'http://127.0.0.1:1234/v1',
        registryBaseUrl: 'http://127.0.0.1:1234/v1',
      },
    ];
    const snapshot = captureReasoningSnapshot(models);
    expect(
      resolveReasoningForModel(
        undefined,
        {
          ...route,
          model: 'parent',
          thinkingMandatory: true,
          reasoningSnapshot: snapshot,
        },
        'alias',
      )?.canDisable,
    ).toBeUndefined();
    models[0]!.capabilities = {
      reasoning: { ...declaration, defaultEffort: 'low' },
    };
    const getResolvedModelConfig = vi.fn();
    const config = { getResolvedModelConfig };
    expect(
      resolveReasoningForModel(config, {
        ...route,
        reasoningSnapshot: snapshot,
      }),
    ).toMatchObject({ defaultEffort: 'medium' });
    expect(
      resolveReasoningForModel(config, {
        ...route,
        baseUrl: 'http://127.0.0.1:1234/v1',
        reasoningSnapshot: snapshot,
      }),
    ).toMatchObject({ defaultEffort: 'high' });
    expect(
      resolveReasoningForModel(config, {
        ...route,
        baseUrl: 'http://127.0.0.1:8000/v1',
        reasoningSnapshot: snapshot,
      }),
    ).toBeUndefined();
    expect(
      resolveReasoningForModel(
        config,
        { ...route, reasoningSnapshot: snapshot },
        'missing-child',
      ),
    ).toBeUndefined();
    expect(getResolvedModelConfig).not.toHaveBeenCalled();
    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(Object.isFrozen(snapshot[0]!.reasoning!.efforts)).toBe(true);
  });

  it('distinguishes implicit and explicit entries sharing the default endpoint', () => {
    const snapshot = captureReasoningSnapshot([
      { ...model('alias', 'low'), registryBaseUrl: undefined },
      model('alias', 'high'),
    ]);
    expect(
      resolveReasoningForModel(undefined, {
        ...route,
        reasoningSnapshot: snapshot,
        reasoningRouteBaseUrl: null,
      }),
    ).toMatchObject({ defaultEffort: 'low' });
    expect(
      resolveReasoningForModel(undefined, {
        ...route,
        reasoningSnapshot: snapshot,
        reasoningRouteBaseUrl: route.baseUrl,
      }),
    ).toMatchObject({ defaultEffort: 'high' });
  });

  it('adopts the latest table only at admission and retains a child table', () => {
    let models = [model(), model('child', 'low')];
    const generation = {
      ...route,
      reasoningSnapshot: captureReasoningSnapshot(models),
    };
    const child = { ...generation, model: 'child' };
    const config = Object.create(Config.prototype) as Config;
    Object.assign(config, {
      reasoningSnapshot: generation.reasoningSnapshot,
      getAllConfiguredModels: () => models,
      getContentGeneratorConfig: () => generation,
      notifyModelChangeListeners: vi.fn(),
      debugLogger: { error: vi.fn() },
    });
    models = [model('alias', 'low'), model('child', 'medium')];
    models = [model('alias', 'high'), model('child', 'high')];
    expect(resolveReasoningForModel(config, generation)).toMatchObject({
      defaultEffort: 'medium',
    });
    expect(config.applyReasoningOverrides()).toBe(true);
    expect(resolveReasoningForModel(config, generation)).toMatchObject({
      defaultEffort: 'high',
    });
    expect(resolveReasoningForModel(config, child)).toMatchObject({
      defaultEffort: 'low',
    });
  });
  it.each([false, true, 'unknown'])(
    'retains a valid observed update after invalid input (inactive implicit route: %s)',
    (inactive) => {
      const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});
      let models = [model('alias', 'low')];
      const generation = {
        ...route,
        reasoningSnapshot: captureReasoningSnapshot(models),
      };
      const config = Object.create(Config.prototype) as Config;
      Object.assign(config, {
        reasoningSnapshot: generation.reasoningSnapshot,
        getAllConfiguredModels: () => models,
        getContentGeneratorConfig: () => generation,
        modelsConfig: { reloadModelProvidersConfig: vi.fn() },
        notifyModelChangeListeners: vi.fn(),
        debugLogger: { error: vi.fn() },
      });
      models = [model('alias', 'high')];
      config.reloadModelProvidersConfig();
      if (inactive) {
        models.push({
          ...model('child'),
          registryBaseUrl: undefined,
          capabilities: {
            reasoning:
              inactive === 'unknown'
                ? { defaultEffort: 'medium' }
                : { efforts: ['low'], defaultEffort: 'high' },
          },
        });
      } else {
        models[0]!.capabilities = {
          reasoning: {
            ...declaration,
            efforts: ['low'],
            defaultEffort: 'high',
          },
        };
      }
      config.reloadModelProvidersConfig();
      expect(resolveReasoningForModel(config, generation)).toMatchObject({
        defaultEffort: 'low',
      });
      expect(config.applyReasoningOverrides()).toBe(true);
      expect(resolveReasoningForModel(config, generation)).toMatchObject({
        defaultEffort: 'high',
      });
      expect(
        config.getContentGeneratorConfig()?.reasoningSnapshot,
      ).toHaveLength(1);
      expect(warning).toHaveBeenCalledWith(
        expect.stringContaining('capabilities.reasoning'),
      );
      warning.mockRestore();
    },
  );
});
