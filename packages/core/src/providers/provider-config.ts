/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { AuthType } from '../core/contentGenerator.js';
import { assertLocalBaseUrl } from '../utils/local-base-url.js';
import type {
  ProviderConfig,
  ProviderInstallPlan,
  ProviderModelConfig,
  ProviderSetupInputs,
} from './types.js';

// ---------------------------------------------------------------------------
// Build model configs from a ProviderConfig + user inputs
// ---------------------------------------------------------------------------

function buildAdvancedGenerationConfig(
  advCfg: ProviderSetupInputs['advancedConfig'] | undefined,
): ProviderModelConfig['generationConfig'] | undefined {
  const cfg: ProviderModelConfig['generationConfig'] = {};
  let hasAny = false;
  if (advCfg?.enableThinking) {
    cfg.extra_body = { enable_thinking: true };
    hasAny = true;
  }
  if (advCfg?.multimodal && Object.values(advCfg.multimodal).some(Boolean)) {
    cfg.modalities = advCfg.multimodal;
    hasAny = true;
  }
  if (advCfg?.contextWindowSize && advCfg.contextWindowSize > 0) {
    cfg.contextWindowSize = advCfg.contextWindowSize;
    hasAny = true;
  }
  if (advCfg?.maxTokens && advCfg.maxTokens > 0) {
    cfg.samplingParams = { max_tokens: advCfg.maxTokens };
    hasAny = true;
  }
  return hasAny ? cfg : undefined;
}

/**
 * Merge a freshly built model with the entry already saved for the same
 * id + baseUrl, so a reconnect keeps the user's hand-tuned settings.
 */
function mergeWithExisting(
  model: ProviderModelConfig,
  existing: ProviderModelConfig,
  advanced: ProviderSetupInputs['advancedConfig'],
): ProviderModelConfig {
  const preservedGeneration = { ...existing.generationConfig };
  if (advanced) {
    if (advanced.replaceExisting) {
      delete preservedGeneration.contextWindowSize;
      if (preservedGeneration.samplingParams) {
        preservedGeneration.samplingParams = {
          ...preservedGeneration.samplingParams,
        };
        delete preservedGeneration.samplingParams.max_tokens;
        if (!Object.keys(preservedGeneration.samplingParams).length)
          delete preservedGeneration.samplingParams;
      }
    }
    if (advanced.replaceExisting || advanced.multimodal !== undefined)
      delete preservedGeneration.modalities;
    if (
      (advanced.replaceExisting || advanced.enableThinking !== undefined) &&
      preservedGeneration.extra_body
    ) {
      preservedGeneration.extra_body = { ...preservedGeneration.extra_body };
      delete preservedGeneration.extra_body['enable_thinking'];
      if (!Object.keys(preservedGeneration.extra_body).length)
        delete preservedGeneration.extra_body;
    }
  }
  const generationConfig =
    Object.keys(preservedGeneration).length || model.generationConfig
      ? {
          ...preservedGeneration,
          ...model.generationConfig,
          ...(preservedGeneration.extra_body ||
          model.generationConfig?.extra_body
            ? {
                extra_body: {
                  ...preservedGeneration.extra_body,
                  ...model.generationConfig?.extra_body,
                },
              }
            : {}),
          ...(preservedGeneration.contextWindowSize !== undefined &&
          advanced?.contextWindowSize === undefined
            ? { contextWindowSize: preservedGeneration.contextWindowSize }
            : {}),
          ...(preservedGeneration.samplingParams ||
          model.generationConfig?.samplingParams
            ? {
                samplingParams: {
                  ...preservedGeneration.samplingParams,
                  ...model.generationConfig?.samplingParams,
                },
              }
            : {}),
          ...(preservedGeneration.customHeaders ||
          model.generationConfig?.customHeaders
            ? {
                customHeaders: {
                  ...preservedGeneration.customHeaders,
                  ...model.generationConfig?.customHeaders,
                },
              }
            : {}),
        }
      : undefined;
  return {
    ...existing,
    ...model,
    name: existing.name ?? model.name,
    generationConfig,
    ...(existing.envKey ? { envKey: existing.envKey } : {}),
  };
}

// ---------------------------------------------------------------------------
// Build ProviderInstallPlan from config + inputs
// ---------------------------------------------------------------------------

/**
 * Build the settings changes for connecting `inputs.modelIds` on the local
 * server at `inputs.baseUrl`. Throws when the base URL is missing or is not a
 * loopback URL, or when no model is given.
 */
export function buildInstallPlan(
  config: ProviderConfig,
  inputs: ProviderSetupInputs,
  existingModels: readonly ProviderModelConfig[] = [],
): ProviderInstallPlan {
  const baseUrl = assertLocalBaseUrl(inputs.baseUrl);
  const protocol = config.protocol;
  let envKey = config.envKey(protocol, baseUrl);
  let models: ProviderModelConfig[] = inputs.modelIds.map((id) => {
    const genConfig = buildAdvancedGenerationConfig(inputs.advancedConfig);
    return {
      id,
      name: id,
      baseUrl,
      envKey,
      ...(genConfig ? { generationConfig: genConfig } : {}),
    };
  });
  if (models.length === 0) {
    throw new Error(
      `No models configured for provider "${config.id}". Check the model list.`,
    );
  }

  models = models.map((model) => {
    const existing = existingModels.find(
      (entry) => entry.id === model.id && entry.baseUrl === model.baseUrl,
    );
    return existing
      ? mergeWithExisting(model, existing, inputs.advancedConfig)
      : model;
  });

  const keys = new Set(models.map((model) => model.envKey));
  if (keys.size > 1 && inputs.apiKey) {
    throw new Error(
      'Reconnect models with different credential references separately to preserve their independent API keys.',
    );
  }
  if (models[0]?.envKey) envKey = models[0].envKey;

  const firstModel = models[0]!;
  return {
    providerId: config.id,
    authType: protocol,
    env: { [envKey]: inputs.apiKey },
    modelSelection: {
      modelId: firstModel.id,
      ...(firstModel.baseUrl ? { baseUrl: firstModel.baseUrl } : {}),
    },
    modelProviders: [{ authType: protocol, models }],
  };
}

function isProviderModelConfig(value: unknown): value is ProviderModelConfig {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as { id?: unknown }).id === 'string'
  );
}

/** The saved model entries; never mutate or persist the returned list. */
export function getProviderModels(
  modelProviders: Record<string, unknown> | undefined,
): ProviderModelConfig[] {
  const raw = modelProviders?.[AuthType.USE_OPENAI];
  return Array.isArray(raw) ? raw.filter(isProviderModelConfig) : [];
}

/**
 * Find the model entries a user has already saved for `config`. Used to
 * pre-fill the auth wizard / connect form with existing model IDs.
 */
export function findExistingProviderModels(
  config: ProviderConfig,
  modelProviders: Record<string, unknown> | undefined,
):
  | { protocol: ProviderConfig['protocol']; models: ProviderModelConfig[] }
  | undefined {
  const models = getProviderModels(modelProviders).filter(config.ownsModel);
  return models.length ? { protocol: config.protocol, models } : undefined;
}

// ---------------------------------------------------------------------------
// Match a provider by model credentials (baseUrl + envKey)
// ---------------------------------------------------------------------------

export function providerMatchesCredentials(
  config: ProviderConfig,
  baseUrl: string | undefined,
  envKey: string | undefined,
): boolean {
  if (!baseUrl) return false;
  return config.envKey(config.protocol, baseUrl) === envKey;
}
