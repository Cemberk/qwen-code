/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  AuthType,
  getLocalBaseUrlError,
  getProviderModels,
  type Config,
  type ModelProvidersConfig,
  type ProviderModelConfig,
} from '@qwen-code/qwen-code-core';
import { loadEnvironment, loadSettings, type Settings } from './settings.js';
import { t } from '../i18n/index.js';

/** Environment variable read for the API key when no envKey is configured. */
const DEFAULT_API_KEY_ENV = 'OPENAI_API_KEY';

/**
 * Find model configuration from modelProviders by modelId.
 * When a baseUrl is given, prefers the exact id+baseUrl match (disambiguating
 * entries that share a model id) and falls back to the first id match if the
 * paired entry was edited/removed. When no baseUrl is given, returns the
 * first id match. Mirrors resolveCliGenerationConfig so pre-flight auth
 * validation checks the same entry that startup resolution selects.
 */
function findModelConfig(
  modelProviders: ModelProvidersConfig | undefined,
  modelId: string | undefined,
  baseUrl?: string,
): ProviderModelConfig | undefined {
  if (!modelId) {
    return undefined;
  }
  const models = getProviderModels(modelProviders);
  if (baseUrl) {
    return (
      models.find((m) => m.id === modelId && m.baseUrl === baseUrl) ??
      models.find((m) => m.id === modelId)
    );
  }
  return models.find((m) => m.id === modelId);
}

/**
 * Resolve the selected model id and its paired baseUrl for provider lookup.
 * Prefers the runtime-resolved generation config (which folds in CLI args, env
 * vars, settings, and the selected provider), falling back to the persisted
 * settings.model.{name,baseUrl} when no Config is available yet (pre-flight).
 */
function resolveSelectedModel(
  settings: Settings,
  config?: Config,
): { modelId: string | undefined; baseUrl: string | undefined } {
  const modelsConfig = config?.getModelsConfig();
  if (modelsConfig) {
    // A live Config is the source of truth: pair its model with its own
    // resolved baseUrl. Do NOT fall back to settings.model.baseUrl here — that
    // could pair the runtime-selected model with a stale persisted baseUrl from
    // a previous selection and validate a different duplicate-id entry.
    return {
      modelId: modelsConfig.getModel(),
      baseUrl: modelsConfig.getGenerationConfig()?.baseUrl,
    };
  }
  // Pre-flight (no Config yet): use the persisted selection as a paired unit.
  return {
    modelId: settings.model?.name,
    baseUrl: settings.model?.baseUrl,
  };
}

/**
 * The base URL startup resolution would use: the live Config's resolved value
 * when available, otherwise the selected modelProviders entry, then
 * OPENAI_BASE_URL, then settings.security.auth.baseUrl.
 */
function resolveBaseUrl(settings: Settings, config?: Config): string {
  const modelsConfig = config?.getModelsConfig();
  if (modelsConfig) {
    return modelsConfig.getGenerationConfig()?.baseUrl ?? '';
  }
  const { modelId, baseUrl } = resolveSelectedModel(settings, config);
  const modelConfig = findModelConfig(
    settings.modelProviders as ModelProvidersConfig | undefined,
    modelId,
    baseUrl,
  );
  return (
    modelConfig?.baseUrl ||
    process.env['OPENAI_BASE_URL'] ||
    settings.security?.auth?.baseUrl ||
    ''
  );
}

function hasEnvValue(settings: Settings, envKey: string | undefined): boolean {
  if (!envKey) {
    return false;
  }
  if (process.env[envKey]) {
    return true;
  }
  const settingsEnv = settings.env as Record<string, unknown> | undefined;
  const settingsEnvValue = settingsEnv?.[envKey];
  return (
    typeof settingsEnvValue === 'string' && settingsEnvValue.trim().length > 0
  );
}

/**
 * Check if an API key is available for the selected model.
 * Prioritizes the model's envKey from modelProviders over OPENAI_API_KEY.
 */
function hasApiKey(
  settings: Settings,
  config?: Config,
): {
  hasKey: boolean;
  checkedEnvKey: string;
  isExplicitEnvKey: boolean;
} {
  const { modelId, baseUrl } = resolveSelectedModel(settings, config);
  const modelConfig = findModelConfig(
    settings.modelProviders as ModelProvidersConfig | undefined,
    modelId,
    baseUrl,
  );

  // If a Config is available, prefer the API key already resolved into the
  // generation config. The unified resolver folds CLI flags (e.g.
  // --openai-api-key), env vars, settings.security.auth.apiKey, and
  // modelProvider envKey lookups into this single value, so it is the same
  // key that refreshAuth will actually use at runtime (issue #3171).
  const resolvedApiKey = config
    ?.getModelsConfig()
    .getGenerationConfig()?.apiKey;
  if (resolvedApiKey) {
    return {
      hasKey: true,
      checkedEnvKey: modelConfig?.envKey ?? DEFAULT_API_KEY_ENV,
      isExplicitEnvKey: !!modelConfig?.envKey,
    };
  }

  if (modelConfig?.envKey) {
    // Explicit envKey configured - only check this env var, no apiKey fallback
    return {
      hasKey: hasEnvValue(settings, modelConfig.envKey),
      checkedEnvKey: modelConfig.envKey,
      isExplicitEnvKey: true,
    };
  }

  return {
    hasKey:
      hasEnvValue(settings, DEFAULT_API_KEY_ENV) ||
      !!settings.security?.auth?.apiKey,
    checkedEnvKey: DEFAULT_API_KEY_ENV,
    isExplicitEnvKey: false,
  };
}

/**
 * Validate that the required credentials and configuration exist for the given
 * auth method. Only a local OpenAI-compatible server ('openai') is supported,
 * and its base URL must be a loopback URL.
 */
export function validateAuthMethod(
  authMethod: string,
  config?: Config,
): string | null {
  const settings = loadSettings(process.cwd(), false);
  loadEnvironment(settings.merged);

  if (authMethod !== AuthType.USE_OPENAI) {
    return t(
      'Auth type "{{authType}}" is not supported. Only a local OpenAI-compatible server is supported: run /auth, or set security.auth.selectedType to "openai".',
      { authType: authMethod },
    );
  }

  const baseUrlError = getLocalBaseUrlError(
    resolveBaseUrl(settings.merged, config),
  );
  if (baseUrlError) {
    return baseUrlError;
  }

  const { hasKey, checkedEnvKey, isExplicitEnvKey } = hasApiKey(
    settings.merged,
    config,
  );
  if (!hasKey) {
    const envKeyHint = `'${checkedEnvKey}'`;
    if (isExplicitEnvKey) {
      // Explicit envKey configured - only suggest setting the env var
      return t(
        'Missing API key for OpenAI-compatible auth. Set the {{envKeyHint}} environment variable.',
        { envKeyHint },
      );
    }
    // Default env key - can use either apiKey or env var
    return t(
      'Missing API key for OpenAI-compatible auth. Set settings.security.auth.apiKey, or set the {{envKeyHint}} environment variable.',
      { envKeyHint },
    );
  }
  return null;
}
