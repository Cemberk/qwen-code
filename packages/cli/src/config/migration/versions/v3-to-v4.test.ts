/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect } from 'vitest';
import { V3ToV4Migration } from './v3-to-v4.js';

describe('V3ToV4Migration', () => {
  const migration = new V3ToV4Migration();

  describe('shouldMigrate', () => {
    it('returns true for V3 settings', () => {
      expect(migration.shouldMigrate({ $version: 3 })).toBe(true);
    });

    it('returns false for V4 and versionless settings', () => {
      expect(migration.shouldMigrate({ $version: 4 })).toBe(false);
      expect(migration.shouldMigrate({ general: {} })).toBe(false);
    });

    it('returns false for non-object input', () => {
      expect(migration.shouldMigrate(null)).toBe(false);
      expect(migration.shouldMigrate('x')).toBe(false);
      expect(migration.shouldMigrate(42)).toBe(false);
    });
  });

  describe('migrate', () => {
    it('bumps the version and keeps every other value', () => {
      const input = { $version: 3, general: { vimMode: true } };
      const { settings, warnings } = migration.migrate(input) as {
        settings: Record<string, unknown>;
        warnings: string[];
      };

      expect(settings).toEqual({ $version: 4, general: { vimMode: true } });
      expect(warnings).toEqual([]);
    });

    it('does not mutate the input settings object', () => {
      const input = { $version: 3, general: { vimMode: true } };
      migration.migrate(input);

      expect(input).toEqual({ $version: 3, general: { vimMode: true } });
    });

    it('throws for non-object input', () => {
      expect(() => migration.migrate(null)).toThrow();
      expect(() => migration.migrate('string')).toThrow();
    });
  });
});
