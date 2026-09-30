/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type { SettingsMigration } from '../types.js';

/**
 * V3 -> V4 migration (version bump only).
 *
 * V4 originally reshaped a setting that no longer exists; the step is kept
 * so V3 files still reach the current version.
 */
export class V3ToV4Migration implements SettingsMigration {
  readonly fromVersion = 3;
  readonly toVersion = 4;

  shouldMigrate(settings: unknown): boolean {
    if (typeof settings !== 'object' || settings === null) {
      return false;
    }
    return (settings as Record<string, unknown>)['$version'] === 3;
  }

  migrate(settings: unknown): { settings: unknown; warnings: string[] } {
    if (typeof settings !== 'object' || settings === null) {
      throw new Error('Settings must be an object');
    }

    const result = structuredClone(settings) as Record<string, unknown>;
    result['$version'] = 4;

    return { settings: result, warnings: [] };
  }
}

export const v3ToV4Migration = new V3ToV4Migration();
