/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { AuthType } from '../core/contentGenerator.js';
import { defaultModalities } from '../core/modalityDefaults.js';
import { tokenLimit } from '../core/tokenLimits.js';
import { getLocalBaseUrlError } from '../utils/local-base-url.js';
import {
  type ModelConfig,
  type ModelProvidersConfig,
  type ResolvedModelConfig,
  type AvailableModel,
} from './types.js';
import { createDebugLogger } from '../utils/debugLogger.js';

const debugLogger = createDebugLogger('MODEL_REGISTRY');

/**
 * Validate a `modelProviders` settings object. The only supported provider
 * key is `openai` (a local OpenAI-compatible server), and every model entry
 * must name a loopback base URL. Throws a descriptive error for anything
 * else; configs from removed providers are rejected, never re-routed.
 */
export function validateModelProvidersConfig(
  modelProviders?: ModelProvidersConfig,
): void {
  for (const [providerId, models] of Object.entries(modelProviders ?? {})) {
    if (providerId !== AuthType.USE_OPENAI) {
      throw new Error(
        `modelProviders.${providerId} is not supported: only a local ` +
          `OpenAI-compatible server is supported. Move its models under ` +
          `modelProviders.${AuthType.USE_OPENAI} with a loopback baseUrl ` +
          `(e.g. http://127.0.0.1:11434/v1).`,
      );
    }
    if (!Array.isArray(models)) continue;
    models.forEach((model, index) => {
      const label = `modelProviders.${providerId}[${index}]${
        model?.id ? ` (${model.id})` : ''
      }`;
      const wireApi = (model as { wireApi?: unknown } | undefined)?.wireApi;
      if (wireApi !== undefined && wireApi !== 'chat-completions') {
        throw new Error(
          `${label}: wireApi "${String(wireApi)}" is not supported; only ` +
            `the Chat Completions API is. Remove the wireApi field.`,
        );
      }
      const baseUrlError = getLocalBaseUrlError(
        model?.baseUrl,
        `${label}.baseUrl`,
      );
      if (baseUrlError) {
        throw new Error(baseUrlError);
      }
    });
  }
}

function shouldUseCanonicalModalities(modelId: string): boolean {
  return /^minimax-m3/i.test(modelId.trim().toLowerCase());
}

/**
 * Build a composite registry key from model id and optional baseUrl.
 * Two models with the same id but different baseUrls are distinct entries.
 * When baseUrl is omitted/empty the key is just the id (backward compatible).
 */
export function modelRegistryKey(id: string, baseUrl?: string): string {
  return baseUrl ? `${id}\0${baseUrl}` : id;
}

/**
 * Central registry for the configured models of the local model server.
 */
export class ModelRegistry {
  private models: Map<string, ResolvedModelConfig>;

  /** Raw providers config this registry was last built from. */
  private modelProvidersConfig?: ModelProvidersConfig;

  constructor(modelProvidersConfig?: ModelProvidersConfig) {
    validateModelProvidersConfig(modelProvidersConfig);
    this.models = new Map();
    this.modelProvidersConfig = modelProvidersConfig;
    this.registerModels(modelProvidersConfig?.[AuthType.USE_OPENAI]);
  }

  /**
   * Register the configured models.
   * Uniqueness is determined by the composite key (id + baseUrl).
   * Two models with the same id but different baseUrls are treated as distinct.
   * If multiple models share both id and baseUrl, the first one takes precedence.
   */
  private registerModels(models: ModelConfig[] | undefined): void {
    if (models === undefined) return;
    // Defensive: runtime data from settings.json can violate the static type —
    // e.g. a hand-edited file, or one still in the reverted #5089 V5 shape
    // ({ protocol, models }) that the CLI v5->v4 migration has not yet
    // rewritten. Skip such entries with a clear warning instead of throwing an
    // opaque "models is not iterable" from the loop below.
    if (!Array.isArray(models)) {
      debugLogger.warn(
        `modelProviders.${AuthType.USE_OPENAI} is not an array; skipping. ` +
          `Expected ModelConfig[]; legacy { protocol, models } entries are ` +
          `normally rewritten by the v5->v4 settings migration.`,
      );
      return;
    }

    for (const config of models) {
      const key = modelRegistryKey(config.id, config.baseUrl);
      if (this.models.has(key)) {
        debugLogger.warn(
          `Duplicate model id "${config.id}"${config.baseUrl ? ` with baseUrl "${config.baseUrl}"` : ''}. Using the first registered config.`,
        );
        continue;
      }
      this.models.set(key, this.resolveModelConfig(config));
    }
  }

  /**
   * Get all configured models.
   * This is used by /model command to show the selectable models.
   */
  getModelsForAuthType(_authType: AuthType): AvailableModel[] {
    return Array.from(this.models.values()).map((model) => ({
      id: model.id,
      label: model.name,
      description: model.description,
      capabilities: model.capabilities,
      authType: model.authType,
      isVision: model.capabilities?.vision ?? false,
      contextWindowSize:
        model.generationConfig.contextWindowSize ?? tokenLimit(model.id),
      // `modalities` is auto-filled in `resolveModelConfig`, so it is
      // always defined on `ResolvedModelConfig` — no fallback needed here.
      modalities: model.generationConfig.modalities,
      baseUrl: model.baseUrl,
      ...(model.registryBaseUrl !== undefined
        ? { registryBaseUrl: model.registryBaseUrl }
        : {}),
      envKey: model.envKey,
      fastOnly: model.fastOnly,
      visionOnly: model.visionOnly,
    }));
  }

  /**
   * Get model configuration by modelId.
   * When baseUrl is provided, looks up the exact composite key.
   * When baseUrl is omitted, returns the first entry with that model id.
   */
  getModel(
    _authType: AuthType,
    modelId: string,
    baseUrl?: string | null,
  ): ResolvedModelConfig | undefined {
    if (baseUrl !== undefined) {
      // Every entry names its baseUrl, so the implicit route (null) is empty.
      return baseUrl === null
        ? undefined
        : this.models.get(modelRegistryKey(modelId, baseUrl));
    }

    for (const model of this.models.values()) {
      if (model.id === modelId) return model;
    }
    return undefined;
  }

  /**
   * Check if a model exists.
   * When baseUrl is provided, checks the exact endpoint.
   * When baseUrl is omitted, checks plain id and scans by model id.
   */
  hasModel(authType: AuthType, modelId: string, baseUrl?: string): boolean {
    return this.getModel(authType, modelId, baseUrl) !== undefined;
  }

  /**
   * Get the default model: the first configured model.
   */
  getDefaultModelForAuthType(
    _authType: AuthType,
  ): ResolvedModelConfig | undefined {
    return this.models.values().next().value;
  }

  /**
   * Resolve model config by applying defaults
   */
  private resolveModelConfig(config: ModelConfig): ResolvedModelConfig {
    this.validateModelConfig(config);

    const generationConfig = { ...(config.generationConfig ?? {}) };
    // Auto-fill modalities from the model name when the provider didn't set
    // them explicitly. Without this, downstream consumers that read straight
    // from the registry (e.g. sub-agents via getResolvedModel) would inherit
    // the parent session's modalities instead of the agent's own.
    if (
      generationConfig.modalities === undefined ||
      shouldUseCanonicalModalities(config.id)
    ) {
      generationConfig.modalities = defaultModalities(config.id);
    }

    return {
      ...config,
      authType: AuthType.USE_OPENAI,
      name: config.name || config.id,
      // validateModelProvidersConfig guarantees a loopback baseUrl.
      baseUrl: config.baseUrl!,
      registryBaseUrl: config.baseUrl,
      generationConfig,
      capabilities: config.capabilities || {},
    };
  }

  /**
   * Validate model configuration
   */
  private validateModelConfig(config: ModelConfig): void {
    if (!config.id) {
      throw new Error(
        `Model config in modelProviders.${AuthType.USE_OPENAI} missing required field: id`,
      );
    }
    if (config.fastOnly && config.visionOnly) {
      debugLogger.warn(
        `Model "${config.id}" has both fastOnly and visionOnly set. It will be unreachable in at least one model selector.`,
      );
    }
  }

  /**
   * Reload models from updated configuration.
   */
  reloadModels(modelProvidersConfig?: ModelProvidersConfig): void {
    const reloaded = new ModelRegistry(modelProvidersConfig);
    this.models = reloaded.models;
    this.modelProvidersConfig = reloaded.modelProvidersConfig;
  }

  /** The raw providers config this registry was last built from. */
  getModelProvidersConfig(): ModelProvidersConfig | undefined {
    return this.modelProvidersConfig;
  }
}
