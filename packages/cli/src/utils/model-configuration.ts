/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  parseModelReasoningCapabilities,
  REASONING_EFFORT_TIERS,
  getGptReasoningCapabilities,
  isReasoningEffortPlaceholder,
  reasoningEffortsForCapability,
  type Config,
  type ContentGeneratorConfig,
  type ReasoningEffort,
} from '@qwen-code/qwen-code-core';
import {
  resolveReasoningForModel,
  getEffectiveReasoning,
  type ReasoningProfile,
} from '@qwen-code/qwen-code-core/core/reasoning-overrides.js';

export type ModelReasoningConfiguration = (
  | {
      readonly thinking: true;
      readonly toggleOnly: true;
      readonly canDisable?: false;
    }
  | {
      readonly thinking: true;
      readonly toggleOnly?: false;
      readonly efforts: readonly ReasoningEffort[];
      readonly defaultEffort?: ReasoningEffort;
      readonly defaultEnabled?: boolean;
      readonly canDisable?: false;
    }
) & { readonly profile?: ReasoningProfile };

const MODEL_CONFIGURATIONS: Readonly<
  Record<string, { readonly reasoning?: ModelReasoningConfiguration }>
> = {
  'qwen3.5-plus': {
    reasoning: {
      thinking: true,
      toggleOnly: true,
    },
  },
  'qwen3.6-plus': {
    reasoning: {
      thinking: true,
      toggleOnly: true,
    },
  },
  'qwen3.6-flash': {
    reasoning: {
      thinking: true,
      toggleOnly: true,
    },
  },
  'qwen3.7-plus': {
    reasoning: {
      thinking: true,
      toggleOnly: true,
    },
  },
  'qwen3.7-max': {
    reasoning: {
      thinking: true,
      toggleOnly: true,
    },
  },
  'qwen3.8-max': {
    reasoning: {
      thinking: true,
      efforts: ['low', 'medium', 'xhigh'],
      defaultEffort: 'xhigh',
    },
  },
};

const REASONING_EFFORT_NONE = 'none';

export function getGptReasoningOverrideState(
  generation: ContentGeneratorConfig,
  configuredReasoning?: ModelReasoningConfiguration,
):
  | {
      enabled: boolean;
      effort?: ReasoningEffort;
      useDefaultEffort: boolean;
      blocksTierChange: true;
    }
  | undefined {
  const capabilities = getGptReasoningCapabilities(generation.model);
  const profile = configuredReasoning?.profile;
  if ((!capabilities && !profile) || generation.reasoning === false) {
    return undefined;
  }
  if (
    profile &&
    profile !== 'openai-effort' &&
    profile !== 'openai-reasoning'
  ) {
    return undefined;
  }
  const reasoning = getModelConfiguration(
    generation.model,
    configuredReasoning,
  )?.reasoning;
  const defaultEnabled =
    !reasoning || reasoning.toggleOnly || reasoning.defaultEnabled !== false;
  const efforts =
    reasoning && !reasoning.toggleOnly
      ? reasoning.efforts
      : (capabilities?.efforts ?? REASONING_EFFORT_TIERS);
  const raw = { ...generation.samplingParams, ...generation.extra_body };
  const flat = raw['reasoning_effort'];
  const nested = raw['reasoning'] as
    | { enabled?: boolean; effort?: unknown; max_tokens?: number }
    | false
    | null
    | undefined;
  const reasoningObject = profile === 'openai-reasoning';
  const removedFlatNone =
    (generation.thinkingMandatory === true ||
      reasoning?.canDisable === false ||
      capabilities?.thinkingMandatory) &&
    flat === REASONING_EFFORT_NONE;
  if (
    !reasoningObject &&
    !isReasoningEffortPlaceholder(flat) &&
    !removedFlatNone
  ) {
    const effort = efforts.find((tier) => tier === flat);
    return {
      enabled: flat !== REASONING_EFFORT_NONE,
      ...(effort ? { effort } : {}),
      useDefaultEffort: effort === undefined,
      blocksTierChange: true,
    };
  }
  if (nested === undefined) {
    const suppressedConfiguredTier = reasoningObject
      ? !parseModelReasoningCapabilities(configuredReasoning) &&
        !isReasoningEffortPlaceholder(
          generation.samplingParams?.['reasoning_effort'],
        ) &&
        !isReasoningEffortPlaceholder(flat)
      : removedFlatNone;
    const effort = removedFlatNone
      ? undefined
      : efforts.find((tier) => tier === flat);
    return suppressedConfiguredTier
      ? {
          enabled: removedFlatNone
            ? defaultEnabled
            : flat !== REASONING_EFFORT_NONE,
          ...(effort ? { effort } : {}),
          useDefaultEffort: effort === undefined,
          blocksTierChange: true,
        }
      : undefined;
  }
  if (!reasoningObject || nested === null) {
    return {
      enabled: defaultEnabled,
      useDefaultEffort: true,
      blocksTierChange: true,
    };
  }
  const effort =
    nested === false
      ? undefined
      : efforts.find((tier) => tier === nested.effort);
  const enabled =
    nested === false ||
    nested.enabled === false ||
    nested.effort === REASONING_EFFORT_NONE
      ? false
      : nested.enabled === true ||
          (typeof nested.effort === 'string' && nested.effort.length > 0) ||
          (nested.max_tokens ?? 0) > 0
        ? true
        : defaultEnabled;
  return {
    enabled,
    ...(effort ? { effort } : {}),
    useDefaultEffort: effort === undefined,
    blocksTierChange: true,
  };
}

export function getModelConfiguration(
  modelId: string | undefined,
  reasoning?: ModelReasoningConfiguration,
):
  | {
      readonly reasoning?: ModelReasoningConfiguration;
    }
  | undefined {
  const configured = parseModelReasoningCapabilities(reasoning);
  const gpt = getGptReasoningCapabilities(modelId);
  return configured
    ? {
        reasoning:
          !reasoning?.profile && gpt?.thinkingMandatory
            ? { ...configured, canDisable: false }
            : configured,
      }
    : gpt
      ? {
          reasoning: {
            thinking: true,
            efforts: gpt.efforts,
            defaultEffort: gpt.defaultEffort,
            defaultEnabled: gpt.defaultEnabled,
            ...(gpt.thinkingMandatory ? { canDisable: false } : {}),
          },
        }
      : modelId
        ? MODEL_CONFIGURATIONS[modelId]
        : undefined;
}

export function getConfiguredModelReasoning(
  config: Config,
  modelId = config.getModel?.(),
  fallbackToManifest = true,
): ModelReasoningConfiguration | undefined {
  if (!modelId || config.getActiveRuntimeModelSnapshot?.()) {
    return undefined;
  }
  const active = config.getContentGeneratorConfig?.();
  const generation = {
    ...active,
    model: active?.model ?? modelId,
    authType: active?.authType ?? config.getAuthType?.(),
    baseUrl:
      active?.baseUrl ?? config.getCurrentModelRegistryBaseUrl?.() ?? undefined,
  };
  const reasoning = resolveReasoningForModel(config, generation, modelId);
  return (
    reasoning ??
    (fallbackToManifest ? getModelConfiguration(modelId)?.reasoning : undefined)
  );
}

export function getReasoningEffortsForConfig(
  config: Config,
): readonly ReasoningEffort[] {
  const modelId = config.getModel?.();
  // One tier rule for `/effort` and a workflow agent's per-call effort: this
  // site keeps its own capability lookup and delegates only the rule.
  return reasoningEffortsForCapability(
    getConfiguredModelReasoning(config, modelId, false),
  );
}

export function getReasoningForDisplay(
  config: Config,
  generation: ContentGeneratorConfig,
) {
  const resolved = resolveReasoningForModel(config, generation);
  if (!resolved) return generation.reasoning;
  const override = getGptReasoningOverrideState(generation, resolved);
  if (override) return override.enabled ? { effort: override.effort } : false;
  return getEffectiveReasoning(generation, resolved);
}
