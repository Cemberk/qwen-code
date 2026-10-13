/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  AuthType,
  getProviderModels,
  MODEL_GENERATION_CONFIG_FIELDS,
  OPENAI_ENV_MAPPING,
  type ContentGeneratorConfig,
  type ContentGeneratorConfigSources,
  normalizeReasoningEffort,
  REASONING_EFFORT_TIERS,
  resolveModelConfig,
  type ModelConfigSourcesInput,
  type ProviderModelConfig,
  stripRuntimeSnapshotPrefix,
} from '@qwen-code/qwen-code-core';
import type { Settings } from '../config/settings.js';
import { sanitizeProviderBaseUrl } from './model-option-utils.js';

/** Env var names that hold the model selection. */
const MODEL_ENV_VARS: readonly string[] = OPENAI_ENV_MAPPING.model;

function getIgnoredTopLevelGenerationConfigFields(
  settingsGenerationConfig: Partial<ContentGeneratorConfig> | undefined,
  modelProvider: ProviderModelConfig | undefined,
): string[] {
  if (!settingsGenerationConfig || !modelProvider) {
    return [];
  }

  const providerGenerationConfig = modelProvider.generationConfig ?? {};
  return MODEL_GENERATION_CONFIG_FIELDS.filter(
    (field) =>
      Object.hasOwn(settingsGenerationConfig, field) &&
      !Object.hasOwn(providerGenerationConfig, field),
  );
}

function buildIgnoredTopLevelGenerationConfigWarning(
  providerId: string,
  modelProvider: ProviderModelConfig,
  ignoredFields: string[],
): string | undefined {
  if (ignoredFields.length === 0) {
    return undefined;
  }

  const fieldList = ignoredFields
    .map((field) => `model.generationConfig.${field}`)
    .join(', ');
  const isSingular = ignoredFields.length === 1;
  const verb = isSingular ? 'is' : 'are';
  const fieldReference = isSingular ? 'this field' : 'these fields';
  const pronoun = isSingular ? 'it' : 'them';

  return `Warning: ${fieldList} ${verb} ignored for provider model "${modelProvider.id}" from modelProviders.${providerId}. Move ${fieldReference} to modelProviders.${providerId}[].generationConfig for that model if you want ${pronoun} to apply.`;
}

export interface CliGenerationConfigInputs {
  argv: {
    model?: string | undefined;
    openaiApiKey?: string | undefined;
    openaiBaseUrl?: string | undefined;
    openaiLogging?: boolean | undefined;
    openaiLoggingDir?: string | undefined;
  };
  settings: Settings;
  selectedAuthType: AuthType | undefined;
  /**
   * Injectable env for testability. Defaults to process.env at callsites.
   */
  env?: Record<string, string | undefined>;
}

export interface ResolvedCliGenerationConfig {
  /** The selected auth type (only 'openai' is supported). */
  authType: AuthType | undefined;
  /** The resolved model id (may be empty string if not resolvable at CLI layer) */
  model: string;
  /** API key for OpenAI-compatible auth */
  apiKey: string;
  /** Base URL for OpenAI-compatible auth */
  baseUrl: string;
  /** The full generation config to pass to core Config */
  generationConfig: Partial<ContentGeneratorConfig>;
  /** Exact selected modelProviders baseUrl; null selects an implicit route. */
  registryBaseUrl?: string | null;
  /** Source attribution for each resolved field */
  sources: ContentGeneratorConfigSources;
  /** Warnings generated during resolution */
  warnings: string[];
}

/**
 * Infer the auth type when none is selected: a complete OpenAI-compatible
 * environment (API key, model and base URL) selects the local server.
 */
export function getAuthTypeFromEnv(
  env: Record<string, string | undefined> = process.env,
): AuthType | undefined {
  if (
    env['OPENAI_API_KEY'] &&
    (env['OPENAI_MODEL'] || env['QWEN_MODEL']) &&
    env['OPENAI_BASE_URL']
  ) {
    return AuthType.USE_OPENAI;
  }
  return undefined;
}

/**
 * Unified resolver for CLI generation config.
 *
 * Model precedence:
 * - argv.model > settings.model.name > OPENAI_MODEL / QWEN_MODEL
 *
 * When model is resolved from argv or settings, all model env vars are stripped
 * from the env passed to core's resolveModelConfig to prevent incorrect overrides.
 * When model is resolved from an env var, only that env var is kept in the
 * filtered env so core can access the provider metadata.
 */
export function resolveCliGenerationConfig(
  inputs: CliGenerationConfigInputs,
): ResolvedCliGenerationConfig {
  const { argv, settings, selectedAuthType } = inputs;
  const env = inputs.env ?? (process.env as Record<string, string | undefined>);

  // Resolve the target model based on strict precedence:
  // argv.model > settings.model.name > model env vars
  // Env vars are ONLY considered when neither argv.model nor settings.model.name is set.
  let resolvedModel: string | undefined;
  let sourceEnvVar: string | undefined;
  // Whether the model came from settings.model.name (vs argv/env). The persisted
  // settings.model.baseUrl disambiguator only applies to this case.
  let resolvedFromSettings = false;
  if (argv.model) {
    resolvedModel = argv.model;
  } else if (settings.model?.name) {
    // Self-heal configs already corrupted by older builds.
    resolvedModel = stripRuntimeSnapshotPrefix(settings.model.name);
    resolvedFromSettings = true;
  } else if (selectedAuthType) {
    for (const envVar of MODEL_ENV_VARS) {
      if (env[envVar]) {
        resolvedModel = env[envVar];
        sourceEnvVar = envVar;
        break;
      }
    }
  }
  // Nothing chose a model: use the first configured one, as the model
  // registry does.
  if (!resolvedModel && selectedAuthType) {
    resolvedModel = getProviderModels(settings.modelProviders)[0]?.id;
  }

  const authType = selectedAuthType;

  // Find a matching provider for the resolved model (for metadata: generationConfig, envKey, etc.)
  // When resolvedModel is from settings and matches a provider, modelProvider.id == settings.model.name,
  // so the resolver correctly uses the settings-selected model (no override occurs).
  // The old candidate-loop code that fell through to OPENAI_MODEL is gone.
  let modelProvider: ProviderModelConfig | undefined;
  let disambiguationWarning: string | undefined;
  if (resolvedModel && authType && settings.modelProviders) {
    const providers = getProviderModels(settings.modelProviders);
    if (providers.length > 0) {
      // When multiple providers share the same id, disambiguate by the
      // persisted settings.model.baseUrl (written by the model picker). This
      // only applies when the model itself came from settings.model.name.
      // Fall back to the first id match if the paired provider was edited or
      // removed (and for the legacy id-only case where no baseUrl was saved),
      // mirroring auth.ts:findModelConfig.
      //
      // Note: `settings` is already merged across user/workspace/system scopes.
      // Every writer of model.name (the picker, /model, provider install)
      // also writes model.baseUrl in the SAME scope — a real URL, or an empty
      // string tombstone when there is none. The tombstone matters because an
      // omitted key cannot override a stale model.baseUrl in a lower-priority
      // scope on merge, but '' (a present value) can. Empty string is treated
      // as "no disambiguator" here. The only remaining desync is a hand-edited
      // config that sets model.name in a higher scope with no baseUrl key at
      // all; the id-only fallback bounds the blast radius to a same-id provider.
      const persistedBaseUrl = settings.model?.baseUrl;
      if (resolvedFromSettings && persistedBaseUrl) {
        const exactMatch = providers.find(
          (p) => p.id === resolvedModel && p.baseUrl === persistedBaseUrl,
        );
        modelProvider =
          exactMatch ?? providers.find((p) => p.id === resolvedModel);
        // Surface the silent fallback: the paired provider was removed or its
        // baseUrl changed, so traffic now routes to a different same-id provider.
        if (!exactMatch && modelProvider) {
          const fallbackBaseUrl = sanitizeProviderBaseUrl(
            modelProvider.baseUrl ?? '',
          );
          disambiguationWarning =
            `Persisted model.baseUrl '${sanitizeProviderBaseUrl(persistedBaseUrl)}' no longer matches any provider ` +
            `for model '${resolvedModel}' (authType '${authType}'); using the first id match ` +
            `('${fallbackBaseUrl}'). Re-select the model to update it.`;
        }
      } else {
        modelProvider = providers.find((p) => p.id === resolvedModel);
      }
    }
  }

  // Filter env to prevent auth-specific model env vars from overriding higher-priority sources.
  // sourceEnvVar is only set when the model was actually resolved from an env var (lines 119-128),
  // so this is source-based filtering, not value-based. If model came from argv or settings,
  // sourceEnvVar is undefined and ALL model env vars are stripped.
  const filteredEnv = { ...env };
  if (sourceEnvVar) {
    // Keep only the env var that was actually used
    for (const envVar of MODEL_ENV_VARS) {
      if (envVar !== sourceEnvVar) {
        delete filteredEnv[envVar];
      }
    }
  } else {
    // Model was not resolved from env - strip ALL model env vars
    for (const envVar of MODEL_ENV_VARS) {
      delete filteredEnv[envVar];
    }
  }

  const configSources: ModelConfigSourcesInput = {
    authType,
    cli: {
      model: argv.model,
      apiKey: argv.openaiApiKey,
      baseUrl: argv.openaiBaseUrl,
    },
    settings: {
      model: settings.model?.name
        ? stripRuntimeSnapshotPrefix(settings.model.name)
        : undefined,
      apiKey: settings.security?.auth?.apiKey,
      baseUrl: settings.security?.auth?.baseUrl,
      generationConfig: settings.model?.generationConfig as
        | Partial<ContentGeneratorConfig>
        | undefined,
    },
    modelProvider,
    env: filteredEnv,
  };

  const resolved = resolveModelConfig(configSources);

  // Provider-backed models are synced again during Config.refreshAuth(), which
  // reapplies provider defaults after the initial resolver fallback.
  const ignoredGenerationConfigWarning =
    authType && modelProvider
      ? buildIgnoredTopLevelGenerationConfigWarning(
          authType,
          modelProvider,
          getIgnoredTopLevelGenerationConfigFields(
            settings.model?.generationConfig as
              | Partial<ContentGeneratorConfig>
              | undefined,
            modelProvider,
          ),
        )
      : undefined;

  // Resolve OpenAI logging config (CLI-specific, not part of core resolver)
  const enableOpenAILogging =
    (typeof argv.openaiLogging === 'undefined'
      ? settings.model?.enableOpenAILogging
      : argv.openaiLogging) ?? false;

  const openAILoggingDir =
    argv.openaiLoggingDir || settings.model?.openAILoggingDir;

  // Build the full generation config
  // Note: we merge the resolved config with logging settings
  const generationConfig: Partial<ContentGeneratorConfig> = {
    ...resolved.config,
    enableOpenAILogging,
    openAILoggingDir,
  };

  // Apply the global reasoning-effort preference (settings.model.reasoningEffort,
  // set via /effort) onto the unified reasoning config. Skip when thinking is
  // explicitly disabled (reasoning === false) so effort never silently
  // re-enables it; provider adapters clamp the tier to the active model.
  const rawReasoningEffort = settings.model?.reasoningEffort;
  const reasoningDisabled = rawReasoningEffort === 'none';
  const reasoningEffort = reasoningDisabled
    ? undefined
    : normalizeReasoningEffort(rawReasoningEffort);
  // A configured-but-unrecognized value (e.g. a "hihg" typo in settings.json)
  // normalizes to undefined and is silently skipped below. Surface it as a
  // warning so the user isn't left wondering why /effort had no effect.
  const invalidReasoningEffortWarning =
    rawReasoningEffort && !reasoningDisabled && !reasoningEffort
      ? `Ignoring invalid model.reasoningEffort "${rawReasoningEffort}"; expected one of: none, ${REASONING_EFFORT_TIERS.join(', ')}.`
      : undefined;
  if (reasoningDisabled && generationConfig.thinkingMandatory !== true) {
    generationConfig.reasoning = false;
  } else if (reasoningEffort && generationConfig.reasoning !== false) {
    generationConfig.reasoning = {
      ...(generationConfig.reasoning ?? {}),
      effort: reasoningEffort,
    };
  }

  return {
    authType,
    model: resolved.config.model || '',
    apiKey: resolved.config.apiKey || '',
    baseUrl: resolved.config.baseUrl || '',
    generationConfig,
    ...(modelProvider
      ? { registryBaseUrl: modelProvider.baseUrl ?? null }
      : {}),
    sources: resolved.sources,
    warnings: [
      ...resolved.warnings,
      ...(invalidReasoningEffortWarning ? [invalidReasoningEffortWarning] : []),
      ...(disambiguationWarning ? [disambiguationWarning] : []),
      ...(ignoredGenerationConfigWarning
        ? [ignoredGenerationConfigWarning]
        : []),
    ],
  };
}
