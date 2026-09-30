/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type {
  AuthType,
  ContentGeneratorConfig,
  InputModalities,
} from '../core/contentGenerator.js';
import type { ConfigSources } from '../utils/configResolver.js';
import type { ModelReasoningOverride } from '../core/reasoning-overrides.js';
import type { ReasoningEffort } from '../core/reasoning-effort.js';

export type ModelReasoningCapabilities = (
  | { toggleOnly: true }
  | {
      toggleOnly?: false;
      efforts: readonly ReasoningEffort[];
      defaultEffort?: ReasoningEffort;
    }
) & {
  thinking: true;
  canDisable?: false;
  disableField: 'enable_thinking' | 'reasoning_effort' | 'thinking';
};

/**
 * Model capabilities configuration
 */
export interface ModelCapabilities {
  /** Supports image/vision inputs */
  vision?: boolean;
  /** Can run the normal agent tool loop, not only transcription requests. */
  agent?: boolean;
  /** Declarative reasoning controls and wire behavior for this model route. */
  reasoning?: ModelReasoningCapabilities | ModelReasoningOverride;
}

/**
 * Model-scoped generation configuration.
 *
 * Keep this consistent with {@link ContentGeneratorConfig} so modelProviders can
 * feed directly into content generator resolution without shape conversion.
 */
export type ModelGenerationConfig = Pick<
  ContentGeneratorConfig,
  | 'samplingParams'
  | 'timeout'
  | 'streamIdleTimeoutMs'
  | 'maxRetries'
  | 'retryInitialDelayMs'
  | 'retryMaxDelayMs'
  | 'retryErrorCodes'
  | 'enableCacheControl'
  | 'schemaCompliance'
  | 'reasoning'
  | 'customHeaders'
  | 'extra_body'
  | 'thinkingMandatory'
  | 'contextWindowSize'
  | 'modalities'
  | 'splitToolMedia'
  | 'toolResultContentFormat'
>;

/**
 * Model configuration for a single model within an authType
 */
export interface ModelConfig {
  /** Model ID served by the local server (e.g., "qwen3-coder:30b") */
  id: string;
  /** Display name (defaults to id) */
  name?: string;
  /** Model description */
  description?: string;
  /** Environment variable name to read API key from (e.g., "OPENAI_API_KEY") */
  envKey?: string;
  /**
   * Base URL of the local OpenAI-compatible server serving this model.
   * Required; the host must be 127.0.0.1, ::1 or localhost.
   */
  baseUrl?: string;
  /** Explicit model capabilities used for safe feature routing. */
  capabilities?: ModelCapabilities;
  /** Generation configuration (sampling parameters) */
  generationConfig?: ModelGenerationConfig;
  /** When true, this model only appears in the fast model selector, not the main model list */
  fastOnly?: boolean;
  /** When true, this model only appears in the vision model selector, not the main model list */
  visionOnly?: boolean;
}

/**
 * Model providers configuration. The only supported key is the protocol id
 * `openai` (a local OpenAI-compatible server).
 */
export type ModelProvidersConfig = {
  [providerId: string]: ModelConfig[];
};

/**
 * Resolved model config with all defaults applied
 */
export interface ResolvedModelConfig extends ModelConfig {
  /** AuthType this model belongs to (always present from map key) */
  authType: AuthType;
  /** Display name (always present, defaults to id) */
  name: string;
  /** Environment variable name to read API key from (optional, provider-specific) */
  envKey?: string;
  /** API base URL (always present; validated as a loopback URL) */
  baseUrl: string;
  /** Exact optional baseUrl used in the registry key, before defaults. */
  registryBaseUrl?: string;
  /** Generation config (always present, merged with defaults) */
  generationConfig: ModelGenerationConfig;
  /** Capabilities (always present, defaults to {}) */
  capabilities: ModelCapabilities;
}

/**
 * Model info for UI display
 */
export interface AvailableModel {
  id: string;
  label: string;
  description?: string;
  capabilities?: ModelCapabilities;
  authType: AuthType;
  isVision?: boolean;
  contextWindowSize?: number;
  modalities?: InputModalities;
  baseUrl?: string;
  /** Exact optional baseUrl used in the model registry key, before defaults. */
  registryBaseUrl?: string;
  envKey?: string;

  /** When true, this model only appears in the fast model selector */
  fastOnly?: boolean;
  /** When true, this model only appears in the vision model selector */
  visionOnly?: boolean;

  /** Whether this is a runtime model (not from modelProviders) */
  isRuntimeModel?: boolean;

  /** Runtime model snapshot ID (if isRuntimeModel is true) */
  runtimeSnapshotId?: string;
}

/**
 * Metadata for model switch operations
 */
export interface ModelSwitchMetadata {
  /** Reason for the switch */
  reason?: string;
  /** Additional context */
  context?: string;
}

/**
 * Runtime model snapshot - captures complete model configuration from non-modelProviders sources
 */
export interface RuntimeModelSnapshot {
  /** Snapshot unique identifier */
  id: string;

  /** Associated AuthType */
  authType: AuthType;

  /** Model ID */
  modelId: string;

  /** API Key (may come from env/cli/manual input) */
  apiKey?: string;

  /** Base URL (may come from env/cli/settings/credentials) */
  baseUrl?: string;

  /** Environment variable name (if apiKey comes from env) */
  apiKeyEnvKey?: string;

  /** Generation config (sampling parameters, etc.) */
  generationConfig?: ModelGenerationConfig;

  /** Configuration source tracking */
  sources: ConfigSources;

  /** Snapshot creation timestamp */
  createdAt: number;
}
