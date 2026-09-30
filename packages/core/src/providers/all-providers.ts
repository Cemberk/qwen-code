/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 *
 * Provider registry — the local OpenAI-compatible server is the only
 * provider.
 */

import { providerMatchesCredentials } from './provider-config.js';
import type { ProviderConfig } from './types.js';
import { customProvider } from './presets/custom-provider.js';

export { customProvider };
export {
  CUSTOM_API_KEY_ENV_PREFIX,
  generateCustomEnvKey,
} from './presets/custom-provider.js';

/** All known providers, in display order. */
export const ALL_PROVIDERS: readonly ProviderConfig[] = [customProvider];

export function findProviderById(id: string): ProviderConfig | undefined {
  return ALL_PROVIDERS.find((p) => p.id === id);
}

/** Find a provider by model credentials (baseUrl + envKey). */
export function findProviderByCredentials(
  baseUrl: string | undefined,
  envKey: string | undefined,
): ProviderConfig | undefined {
  return ALL_PROVIDERS.find((p) =>
    providerMatchesCredentials(p, baseUrl, envKey),
  );
}
