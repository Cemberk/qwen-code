/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * ModelConfigResolver - Unified resolver for model-related configuration.
 *
 * This module consolidates all model configuration resolution logic,
 * eliminating duplicate code between CLI and Core layers.
 *
 * Configuration priority (highest to lowest):
 * 1. modelProvider - Explicit selection from ModelProviders config
 * 2. CLI arguments - Command line flags (--model, --openaiApiKey, etc.)
 * 3. Environment variables - OPENAI_API_KEY, OPENAI_MODEL, etc.
 * 4. Settings - User/workspace settings file
 *
 * There are no built-in defaults for the model id or base URL.
 */

import type {
  AuthType,
  ContentGeneratorConfig,
} from '../core/contentGenerator.js';
import { defaultModalities } from '../core/modalityDefaults.js';
import { knownTokenLimit } from '../core/tokenLimits.js';
import {
  resolveField,
  resolveOptionalField,
  layer,
  envLayer,
  cliSource,
  settingsSource,
  modelProvidersSource,
  defaultSource,
  computedSource,
  type ConfigSources,
  type ConfigLayer,
} from '../utils/configResolver.js';
import {
  OPENAI_ENV_MAPPING,
  MODEL_GENERATION_CONFIG_FIELDS,
} from './constants.js';
import type { ModelConfig as ModelProviderConfig } from './types.js';
export {
  validateModelConfig,
  type ModelConfigValidationResult,
} from '../core/contentGenerator.js';

/**
 * CLI-provided configuration values
 */
export interface ModelConfigCliInput {
  model?: string;
  apiKey?: string;
  baseUrl?: string;
}

/**
 * Settings-provided configuration values
 */
export interface ModelConfigSettingsInput {
  /** Model name from settings.model.name */
  model?: string;
  /** API key from settings.security.auth.apiKey */
  apiKey?: string;
  /** Base URL from settings.security.auth.baseUrl */
  baseUrl?: string;
  /** Generation config from settings.model.generationConfig */
  generationConfig?: Partial<ContentGeneratorConfig>;
}

/**
 * All input sources for model configuration resolution
 */
export interface ModelConfigSourcesInput {
  /** Authentication type */
  authType?: AuthType;

  /** CLI arguments (highest priority for user-provided values) */
  cli?: ModelConfigCliInput;

  /** Settings file configuration */
  settings?: ModelConfigSettingsInput;

  /** Environment variables (injected for testability) */
  env: Record<string, string | undefined>;

  /** Model from ModelProviders (explicit selection, highest priority) */
  modelProvider?: ModelProviderConfig;
}

/**
 * Result of model configuration resolution
 */
export interface ModelConfigResolutionResult {
  /** The fully resolved configuration */
  config: ContentGeneratorConfig;
  /** Source attribution for each field */
  sources: ConfigSources;
  /** Warnings generated during resolution */
  warnings: string[];
}

/**
 * Applies QWEN_CODE_API_TIMEOUT_MS env override if modelProvider has not set a timeout.
 * Precedence: modelProvider > env > settings > default
 * Mutates generationConfig and sources in-place.
 */
function applyTimeoutEnvOverride(
  env: Record<string, string | undefined>,
  generationConfig: Partial<ContentGeneratorConfig>,
  sources: ConfigSources,
  modelProvider?: ModelProviderConfig,
): void {
  if (modelProvider?.generationConfig?.timeout !== undefined) return;

  const raw = env['QWEN_CODE_API_TIMEOUT_MS'];
  if (raw === undefined) return;

  const trimmed = raw.trim();
  // Accept a non-negative integer; `0` disables the request timeout downstream
  // (see resolveRequestTimeout). Malformed values are ignored (keep default).
  if (!/^\d+$/.test(trimmed)) return;
  const parsed = Number(trimmed);
  if (!Number.isSafeInteger(parsed)) return;
  generationConfig.timeout = parsed;
  sources['timeout'] = {
    kind: 'env',
    envKey: 'QWEN_CODE_API_TIMEOUT_MS',
  };
}

/**
 * Resolve model configuration from all input sources.
 *
 * This is the single entry point for model configuration resolution.
 * It replaces the duplicate logic in:
 * - packages/cli/src/utils/modelProviderUtils.ts (resolveCliGenerationConfig)
 * - packages/core/src/core/contentGenerator.ts (resolveContentGeneratorConfigWithSources)
 *
 * @param input - All configuration sources
 * @returns Resolved configuration with source tracking
 */
export function resolveModelConfig(
  input: ModelConfigSourcesInput,
): ModelConfigResolutionResult {
  const { authType, cli, settings, env, modelProvider } = input;
  const warnings: string[] = [];
  const sources: ConfigSources = {};

  // If authType is not provided, do not read any env vars.
  const envMapping = authType
    ? OPENAI_ENV_MAPPING
    : { model: [], apiKey: [], baseUrl: [] };

  // Build layers for each field in priority order
  // Priority: modelProvider > cli > env > settings > default

  // ---- Model ----
  const modelLayers: Array<ConfigLayer<string>> = [];

  if (authType && modelProvider) {
    modelLayers.push(
      layer(
        modelProvider.id,
        modelProvidersSource(authType, modelProvider.id, 'model.id'),
      ),
    );
  }
  if (cli?.model) {
    modelLayers.push(layer(cli.model, cliSource('--model')));
  }
  for (const envKey of envMapping.model) {
    modelLayers.push(envLayer(env, envKey));
  }
  if (settings?.model) {
    modelLayers.push(layer(settings.model, settingsSource('model.name')));
  }

  const modelResult = resolveField(modelLayers, '', defaultSource(''));
  sources['model'] = modelResult.source;

  // ---- API Key ----
  const apiKeyLayers: Array<ConfigLayer<string>> = [];

  // For modelProvider, read from the specified envKey
  if (authType && modelProvider?.envKey) {
    const apiKeyFromEnv = env[modelProvider.envKey];
    if (apiKeyFromEnv) {
      apiKeyLayers.push(
        layer(apiKeyFromEnv, {
          kind: 'env',
          envKey: modelProvider.envKey,
          via: modelProvidersSource(authType, modelProvider.id, 'envKey'),
        }),
      );
    }
  }
  if (cli?.apiKey) {
    apiKeyLayers.push(layer(cli.apiKey, cliSource('--openaiApiKey')));
  }
  for (const envKey of envMapping.apiKey) {
    apiKeyLayers.push(envLayer(env, envKey));
  }
  if (settings?.apiKey) {
    apiKeyLayers.push(
      layer(settings.apiKey, settingsSource('security.auth.apiKey')),
    );
  }

  const apiKeyResult = resolveOptionalField(apiKeyLayers);
  if (apiKeyResult) {
    sources['apiKey'] = apiKeyResult.source;
  }

  // ---- Base URL ----
  const baseUrlLayers: Array<ConfigLayer<string>> = [];

  if (authType && modelProvider?.baseUrl) {
    baseUrlLayers.push(
      layer(
        modelProvider.baseUrl,
        modelProvidersSource(authType, modelProvider.id, 'baseUrl'),
      ),
    );
  }
  if (cli?.baseUrl) {
    baseUrlLayers.push(layer(cli.baseUrl, cliSource('--openaiBaseUrl')));
  }
  for (const envKey of envMapping.baseUrl) {
    baseUrlLayers.push(envLayer(env, envKey));
  }
  if (settings?.baseUrl) {
    baseUrlLayers.push(
      layer(settings.baseUrl, settingsSource('security.auth.baseUrl')),
    );
  }

  const baseUrlResult = resolveOptionalField(baseUrlLayers);
  if (baseUrlResult) {
    sources['baseUrl'] = baseUrlResult.source;
  }

  // ---- API Key Env Key (for error messages) ----
  let apiKeyEnvKey: string | undefined;
  if (authType && modelProvider?.envKey) {
    apiKeyEnvKey = modelProvider.envKey;
    sources['apiKeyEnvKey'] = {
      ...modelProvidersSource(authType, modelProvider.id, 'envKey'),
      envKey: modelProvider.envKey,
    };
  }

  // ---- Generation Config (from settings or modelProvider) ----
  const generationConfig = resolveGenerationConfig(
    settings?.generationConfig,
    modelProvider?.generationConfig,
    authType,
    modelProvider?.id ?? modelResult.value,
    sources,
  );

  // ---- Env override: QWEN_CODE_API_TIMEOUT_MS ----
  applyTimeoutEnvOverride(env, generationConfig, sources, modelProvider);

  // Build final config
  const config: ContentGeneratorConfig = {
    authType,
    model: modelResult.value || '',
    apiKey: apiKeyResult?.value,
    apiKeyEnvKey,
    baseUrl: baseUrlResult?.value,
    ...generationConfig,
  };

  // Add authType source
  sources['authType'] = computedSource('provided by caller');

  return { config, sources, warnings };
}

/**
 * Resolve generation config fields (samplingParams, timeout, etc.)
 */
function resolveGenerationConfig(
  settingsConfig: Partial<ContentGeneratorConfig> | undefined,
  modelProviderConfig: Partial<ContentGeneratorConfig> | undefined,
  authType: AuthType | undefined,
  modelId: string | undefined,
  sources: ConfigSources,
): Partial<ContentGeneratorConfig> {
  const result: Partial<ContentGeneratorConfig> = {};

  for (const field of MODEL_GENERATION_CONFIG_FIELDS) {
    // ModelProvider config takes priority over settings config
    if (authType && modelProviderConfig && field in modelProviderConfig) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (result as any)[field] = modelProviderConfig[field];
      sources[field] = modelProvidersSource(
        authType,
        modelId || '',
        `generationConfig.${field}`,
      );
    } else if (settingsConfig && field in settingsConfig) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (result as any)[field] = settingsConfig[field];
      sources[field] = settingsSource(`model.generationConfig.${field}`);
    }
  }

  // contextWindowSize fallback: auto-detect from model when neither
  // modelProvider nor settings supplied it. Only known models are stamped —
  // unknown models keep `undefined` so downstream `?? DEFAULT_TOKEN_LIMIT`
  // consumers apply the generic default without a misleading
  // 'auto-detected' source label.
  if (result.contextWindowSize === undefined && modelId) {
    const knownLimit = knownTokenLimit(modelId, 'input');
    if (knownLimit !== undefined) {
      result.contextWindowSize = knownLimit;
      sources['contextWindowSize'] = computedSource('auto-detected from model');
    }
  }

  // modalities fallback: auto-detect from model when neither modelProvider nor
  // settings supplied it. Mirrors modelRegistry.resolveModelConfig and
  // modelsConfig.applyResolvedModelDefaults so all paths agree on which models
  // are multimodal — without this, env-var-only setups silently drop @image
  // attachments for image-capable models (issue #4219).
  //
  // Invariant: defaultModalities() returns `{}` (text-only) for unknown
  // models, never `undefined`. After this fallback runs with a known modelId,
  // `result.modalities` is always defined. Downstream code must NOT branch
  // on `modalities === undefined` to mean "unresolved" — use the sources map
  // (kind === 'computed' vs 'modelProviders'/'settings') if that distinction
  // matters.
  if (result.modalities === undefined && modelId) {
    result.modalities = defaultModalities(modelId);
    sources['modalities'] = computedSource('auto-detected from model');
  }

  return result;
}
