/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { SettingScope, type LoadedSettings } from './settings.js';

export function hasOwnModelProviders(settingsObj: unknown): boolean {
  if (!settingsObj || typeof settingsObj !== 'object') {
    return false;
  }
  const obj = settingsObj as Record<string, unknown>;
  // Treat an explicitly configured empty object (modelProviders: {}) as "owned"
  // by this scope, which is important when mergeStrategy is REPLACE.
  return Object.prototype.hasOwnProperty.call(obj, 'modelProviders');
}

/**
 * Returns which writable scope owns the effective modelProviders
 * configuration. Workspace settings never do: `modelProviders` and `model` are
 * workspace-restricted (see WORKSPACE_RESTRICTED_ROOT_SETTINGS).
 */
export function getModelProvidersOwnerScope(
  settings: LoadedSettings,
): SettingScope | undefined {
  return hasOwnModelProviders(settings.user.settings)
    ? SettingScope.User
    : undefined;
}

/**
 * Choose the settings scope to persist a model selection: the scope that
 * contains the effective modelProviders config, otherwise User.
 */
export function getPersistScopeForModelSelection(
  settings: LoadedSettings,
): SettingScope {
  return getModelProvidersOwnerScope(settings) ?? SettingScope.User;
}
