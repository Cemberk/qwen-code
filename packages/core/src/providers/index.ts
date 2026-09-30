/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

// Types
export type {
  ModelSpec,
  ProviderId,
  ProviderConfig,
  ProviderInstallPlan,
  ProviderModelConfig,
  ProviderModelProvidersPatch,
  ProviderSettingsAdapter,
  ProviderSetupInputs,
} from './types.js';

// Provider config utilities
export {
  buildInstallPlan,
  findExistingProviderModels,
  getProviderModels,
  providerMatchesCredentials,
} from './provider-config.js';

export { discoverProviderModels } from './model-discovery.js';

// Provider registry
export {
  ALL_PROVIDERS,
  CUSTOM_API_KEY_ENV_PREFIX,
  customProvider,
  findProviderByCredentials,
  findProviderById,
  generateCustomEnvKey,
} from './all-providers.js';

// Install logic
export {
  applyProviderInstallPlan,
  ProviderInstallError,
  type ApplyProviderInstallPlanOptions,
  type ApplyProviderInstallPlanResult,
} from './install.js';

export { preserveModelProviderPlaceholders } from './model-config-serialization.js';
