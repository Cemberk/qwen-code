/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { Config } from '../config/config.js';
import type { ContentGeneratorConfig } from './contentGenerator.js';
import type {
  AvailableModel,
  ModelReasoningCapabilities,
} from '../models/types.js';
import { normalize } from './tokenLimits.js';
import {
  clampReasoningEffort,
  getGptReasoningCapabilities,
  parseModelReasoningCapabilities,
  REASONING_EFFORT_TIERS,
  type ReasoningEffort,
} from './reasoning-effort.js';

/**
 * Request-body shapes a model's reasoning switch can take on an
 * OpenAI-compatible server:
 * - `openai-effort`: top-level `reasoning_effort`
 * - `openai-reasoning`: a `reasoning` object
 * - `deepseek-openai`: `thinking: { type }` plus `reasoning_effort`
 * - `qwen-chat-template`: `chat_template_kwargs.enable_thinking`
 */
export const REASONING_PROFILES = [
  'openai-effort',
  'openai-reasoning',
  'deepseek-openai',
  'qwen-chat-template',
] as const;
export type ReasoningProfile = (typeof REASONING_PROFILES)[number];
export type ModelReasoningOverride = {
  profile?: ReasoningProfile;
  efforts?: readonly ReasoningEffort[];
  defaultEffort?: ReasoningEffort;
  thinking?: true;
  toggleOnly?: boolean;
  canDisable?: false;
  disableField?: ModelReasoningCapabilities['disableField'];
};
export type ResolvedReasoning = ModelReasoningCapabilities & {
  profile?: ReasoningProfile;
  defaultEnabled?: boolean;
};
export type ReasoningSnapshot = ReadonlyArray<
  Readonly<
    Pick<AvailableModel, 'id' | 'authType' | 'baseUrl' | 'registryBaseUrl'> & {
      reasoning: ModelReasoningOverride | undefined;
    }
  >
>;
type Route = Pick<
  ContentGeneratorConfig,
  'model' | 'authType' | 'baseUrl' | 'thinkingMandatory'
>;

function invalidReasoning(route: Route): never {
  throw new Error(
    `Model "${route.model}" capabilities.reasoning: invalid profile, efforts or defaultEffort`,
  );
}

export function validateReasoningDeclaration(
  route: Route,
  declaration: unknown,
): ModelReasoningOverride | undefined {
  if (declaration === undefined) return undefined;
  if (
    !declaration ||
    typeof declaration !== 'object' ||
    Array.isArray(declaration)
  )
    return invalidReasoning(route);
  const input = declaration as ModelReasoningOverride;
  if (
    input.profile === undefined &&
    ('thinking' in input || 'disableField' in input)
  )
    return parseModelReasoningCapabilities(input);
  if (
    !Object.keys(input).length ||
    Object.keys(input).some(
      (key) =>
        ![
          'profile',
          'efforts',
          'defaultEffort',
          'thinking',
          'toggleOnly',
          'canDisable',
          'disableField',
        ].includes(key),
    )
  )
    return invalidReasoning(route);
  if (
    (input.profile !== undefined &&
      !REASONING_PROFILES.includes(input.profile)) ||
    (input.thinking !== undefined && input.thinking !== true) ||
    (input.toggleOnly !== undefined && typeof input.toggleOnly !== 'boolean') ||
    (input.canDisable !== undefined && input.canDisable !== false)
  )
    return invalidReasoning(route);
  if (
    input.efforts !== undefined &&
    (!Array.isArray(input.efforts) ||
      !input.efforts.length ||
      input.efforts.some((tier) => !REASONING_EFFORT_TIERS.includes(tier)) ||
      new Set(input.efforts).size !== input.efforts.length)
  )
    return invalidReasoning(route);
  if (
    input.defaultEffort !== undefined &&
    (!REASONING_EFFORT_TIERS.includes(input.defaultEffort) ||
      (input.efforts && !input.efforts.includes(input.defaultEffort)))
  )
    return invalidReasoning(route);
  return input;
}

export function resolveReasoningCapabilities(
  route: Route,
  declaration: unknown,
): ResolvedReasoning | undefined {
  try {
    return validateReasoningCapabilities(route, declaration);
  } catch {
    return undefined;
  }
}

export function validateReasoningCapabilities(
  route: Route,
  declaration: unknown,
): ResolvedReasoning | undefined {
  const input = validateReasoningDeclaration(route, declaration);
  if (!input) return undefined;
  if (input.profile === undefined && 'thinking' in input)
    return parseModelReasoningCapabilities(input);
  const model = normalize(route.model);
  const gpt = getGptReasoningCapabilities(route.model);
  if (!gpt && !input.profile) return invalidReasoning(route);
  const profile =
    input.profile ??
    (model.startsWith('qwen') ? 'qwen-chat-template' : 'openai-effort');
  const toggleOnly = profile === 'qwen-chat-template';
  const disableField = toggleOnly
    ? 'enable_thinking'
    : profile === 'openai-effort'
      ? 'reasoning_effort'
      : 'thinking';
  const efforts = input.efforts ?? gpt?.efforts;
  const defaultEffort =
    input.defaultEffort ??
    (gpt?.defaultEffort && efforts
      ? clampReasoningEffort(gpt.defaultEffort, efforts)
      : undefined);
  if (
    (toggleOnly &&
      (input.efforts !== undefined || input.defaultEffort !== undefined)) ||
    (!toggleOnly && (!efforts || !defaultEffort))
  )
    return invalidReasoning(route);
  const result = {
    ...input,
    thinking: true,
    profile,
    toggleOnly,
    disableField,
    ...(toggleOnly ? {} : { efforts, defaultEffort }),
    ...(route.thinkingMandatory || gpt?.thinkingMandatory
      ? { canDisable: false }
      : {}),
  };
  const parsed = parseModelReasoningCapabilities(result);
  if (!parsed) return invalidReasoning(route);
  return {
    ...parsed,
    profile,
    ...(gpt && input.defaultEffort === undefined
      ? { defaultEnabled: gpt.defaultEnabled }
      : {}),
  };
}

export function captureReasoningSnapshot(
  models: readonly AvailableModel[],
): ReasoningSnapshot {
  return Object.freeze(
    models.map((model) =>
      Object.freeze({
        id: model.id,
        authType: model.authType,
        baseUrl: model.baseUrl,
        registryBaseUrl: model.registryBaseUrl,
        reasoning:
          model.capabilities?.reasoning &&
          typeof model.capabilities.reasoning === 'object'
            ? Object.freeze({
                ...structuredClone(model.capabilities.reasoning),
                ...('efforts' in model.capabilities.reasoning &&
                Array.isArray(model.capabilities.reasoning.efforts)
                  ? {
                      efforts: Object.freeze([
                        ...model.capabilities.reasoning.efforts,
                      ]),
                    }
                  : {}),
              })
            : model.capabilities?.reasoning,
      }),
    ),
  );
}

export function resolveReasoningForModel(
  config: Pick<Config, 'getResolvedModelConfig'> | undefined,
  generation: ContentGeneratorConfig,
  model = generation.model,
  strict = false,
): ResolvedReasoning | undefined {
  let declaration: unknown;
  if (generation.reasoningSnapshot) {
    const rows = generation.reasoningSnapshot.filter(
      (row) => row.authType === generation.authType && row.id === model,
    );
    const row =
      generation.reasoningRouteBaseUrl === null && model === generation.model
        ? rows.find((row) => row.registryBaseUrl === undefined)
        : typeof generation.reasoningRouteBaseUrl === 'string' &&
            model === generation.model
          ? rows.find(
              (row) => row.registryBaseUrl === generation.reasoningRouteBaseUrl,
            )
          : (rows.find((row) => row.registryBaseUrl === generation.baseUrl) ??
            rows.find(
              (row) =>
                row.registryBaseUrl === undefined &&
                row.baseUrl === generation.baseUrl,
            ));
    declaration = row?.reasoning;
  } else {
    declaration = generation.authType
      ? config?.getResolvedModelConfig?.(
          generation.authType,
          model,
          generation.baseUrl,
        )?.capabilities?.reasoning
      : undefined;
  }
  return (
    strict ? validateReasoningCapabilities : resolveReasoningCapabilities
  )(
    {
      ...generation,
      model,
      thinkingMandatory:
        model === generation.model ? generation.thinkingMandatory : undefined,
    },
    declaration,
  );
}

export function getEffectiveReasoning(
  generation: Pick<ContentGeneratorConfig, 'reasoning'>,
  resolved?: ResolvedReasoning,
): ContentGeneratorConfig['reasoning'] {
  if (!resolved) return generation.reasoning;
  if (generation.reasoning === false && resolved.canDisable !== false)
    return false;
  const selected = generation.reasoning || undefined;
  if (
    !selected &&
    resolved.defaultEnabled === false &&
    resolved.canDisable !== false
  )
    return false;
  if (resolved.toggleOnly)
    return selected ?? (resolved.profile ? {} : undefined);
  const effort = selected?.effort ?? resolved.defaultEffort;
  return effort
    ? {
        ...selected,
        effort:
          resolved.profile && REASONING_EFFORT_TIERS.includes(effort)
            ? clampReasoningEffort(effort, resolved.efforts)
            : effort,
      }
    : selected;
}
