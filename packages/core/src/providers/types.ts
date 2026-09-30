/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { AuthType, InputModalities } from '../core/contentGenerator.js';
import type {
  ModelCapabilities,
  ModelConfig,
  ModelProvidersConfig,
} from '../models/types.js';

// Re-export for convenience
export type ProviderModelConfig = ModelConfig;

// ---------------------------------------------------------------------------
// Provider Config — declarative provider definition
// ---------------------------------------------------------------------------

export type ProviderId = string;

/** A model served by the local server, as reported by model discovery. */
export interface ModelSpec {
  id: string;
  capabilities?: ModelCapabilities;
  contextWindowSize?: number;
  modalities?: InputModalities;
  description?: string;
}

export interface ProviderConfig {
  id: string;
  label: string;
  description: string;

  /** The protocol the provider speaks. */
  protocol: AuthType;

  /** Generates the environment variable key holding the API key. */
  envKey: (protocol: AuthType, baseUrl: string) => string;

  /** Load the served models from `{baseUrl}/models`. */
  supportsModelDiscovery?: boolean;

  /** Show advanced config step (thinking, modalities). */
  showAdvancedConfig?: boolean;

  /** API key input placeholder. */
  apiKeyPlaceholder?: string;

  /** Identifies models belonging to this provider. */
  ownsModel: (model: ProviderModelConfig) => boolean;
}

// ---------------------------------------------------------------------------
// Provider Setup Inputs — collected from user during setup wizard
// ---------------------------------------------------------------------------

export interface ProviderSetupInputs {
  /** Base URL of the local server; must be a loopback URL. */
  baseUrl: string;
  apiKey: string;
  modelIds: string[];
  advancedConfig?: {
    /** Replace all advanced form controls; omitted fields otherwise stay unchanged. */
    replaceExisting?: boolean;
    enableThinking?: boolean;
    multimodal?: InputModalities;
    contextWindowSize?: number;
    maxTokens?: number;
  };
}

// ---------------------------------------------------------------------------
// Provider Install Plan — output of buildInstallPlan
// ---------------------------------------------------------------------------

export interface ProviderModelProvidersPatch {
  authType: AuthType;
  models: ProviderModelConfig[];
}

export interface ProviderInstallPlan {
  providerId: ProviderId;
  authType: AuthType;
  env?: Record<string, string>;
  modelSelection?: {
    modelId: string;
    baseUrl?: string;
  };
  modelProviders?: ProviderModelProvidersPatch[];
}

// ---------------------------------------------------------------------------
// Provider Settings Adapter — abstraction for settings read/write
// ---------------------------------------------------------------------------

export interface ProviderSettingsAdapter {
  /** Get a value by dotted key path (e.g. 'security.auth.selectedType'). */
  getValue(key: string): unknown;
  /**
   * Set a value by dotted key path.
   *
   * IMPORTANT: implementations MAY flush to disk on every call (the CLI's
   * LoadedSettings-backed adapter does — each setValue triggers a
   * saveSettings). Callers must therefore NOT assume the on-disk file is
   * untouched until `persist()`; if the process crashes mid-sequence, disk
   * can hold a partial write. `backup()`/`restore()` are the rollback path
   * for that, not deferred persistence. Don't insert new pre-persist steps
   * assuming atomicity.
   */
  setValue(key: string, value: unknown): void;
  /** Get the current model providers config. */
  getModelProviders(): ModelProvidersConfig;
  /** Scope-owned entries; omitted by unscoped adapters. */
  getModelProvidersForWrite?(): {
    modelProviders: ModelProvidersConfig;
  };
  /**
   * Flush changes to disk. NOTE: this may be a no-op for adapters whose
   * `setValue` already persists eagerly (see the warning on `setValue`).
   */
  persist(): void;
  /** Create a backup before making changes (for rollback on error). */
  backup?(): void;
  /** Restore from backup (on error). */
  restore?(): void;
  /** Clean up backup after successful operation. */
  cleanupBackup?(): void;
}
