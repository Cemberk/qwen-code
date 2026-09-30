/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

export {
  type ModelCapabilities,
  type ModelGenerationConfig,
  type ModelConfig,
  type ModelProvidersConfig,
  type ResolvedModelConfig,
  type AvailableModel,
  type ModelSwitchMetadata,
  type RuntimeModelSnapshot,
} from './types.js';

export {
  ModelRegistry,
  modelRegistryKey,
  validateModelProvidersConfig,
} from './modelRegistry.js';

export {
  ModelsConfig,
  type ModelsConfigOptions,
  type OnModelChangeCallback,
} from './modelsConfig.js';

export {
  CREDENTIAL_FIELDS,
  MODEL_GENERATION_CONFIG_FIELDS,
  OPENAI_ENV_MAPPING,
  PROVIDER_SOURCED_FIELDS,
} from './constants.js';

// Model configuration resolver
export {
  resolveModelConfig,
  validateModelConfig,
  type ModelConfigSourcesInput,
  type ModelConfigCliInput,
  type ModelConfigSettingsInput,
  type ModelConfigResolutionResult,
  type ModelConfigValidationResult,
} from './modelConfigResolver.js';
