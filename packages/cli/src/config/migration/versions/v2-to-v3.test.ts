/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect } from 'vitest';
import { V2ToV3Migration } from './v2-to-v3.js';

describe('V2ToV3Migration', () => {
  const migration = new V2ToV3Migration();

  describe('shouldMigrate', () => {
    it('should return true for V2 settings with deprecated disable* keys', () => {
      const v2Settings = {
        $version: 2,
        context: { fileFiltering: { disableFuzzySearch: true } },
      };

      expect(migration.shouldMigrate(v2Settings)).toBe(true);
    });

    it('should return true for V2 settings with ui.accessibility.disableLoadingPhrases', () => {
      const v2Settings = {
        $version: 2,
        ui: { accessibility: { disableLoadingPhrases: false } },
      };

      expect(migration.shouldMigrate(v2Settings)).toBe(true);
    });

    it('should return false for V3 settings', () => {
      const v3Settings = {
        $version: 3,
        general: { vimMode: true },
      };

      expect(migration.shouldMigrate(v3Settings)).toBe(false);
    });

    it('should return false for V1 settings without version', () => {
      const v1Settings = {
        theme: 'dark',
        disableFuzzySearch: true,
      };

      expect(migration.shouldMigrate(v1Settings)).toBe(false);
    });

    it('should return true for V2 settings without deprecated keys', () => {
      const cleanV2Settings = {
        $version: 2,
        ui: { theme: 'dark' },
        general: { vimMode: true },
      };

      // V2 settings should always be migrated to V3 to update the version number
      expect(migration.shouldMigrate(cleanV2Settings)).toBe(true);
    });

    it('should return false for null input', () => {
      expect(migration.shouldMigrate(null)).toBe(false);
    });

    it('should return false for non-object input', () => {
      expect(migration.shouldMigrate('string')).toBe(false);
      expect(migration.shouldMigrate(123)).toBe(false);
    });
  });

  describe('migrate', () => {
    it('should migrate disableLoadingPhrases to enableLoadingPhrases', () => {
      const v2Settings = {
        $version: 2,
        ui: { accessibility: { disableLoadingPhrases: true } },
      };

      const { settings: result } = migration.migrate(v2Settings, 'user') as {
        settings: Record<string, unknown>;
        warnings: unknown[];
      };

      expect(result['$version']).toBe(3);
      expect(
        (result['ui'] as Record<string, unknown>)['accessibility'],
      ).toEqual({
        enableLoadingPhrases: false,
      });
    });

    it('should migrate disableFuzzySearch to enableFuzzySearch', () => {
      const v2Settings = {
        $version: 2,
        context: { fileFiltering: { disableFuzzySearch: false } },
      };

      const { settings: result } = migration.migrate(v2Settings, 'user') as {
        settings: Record<string, unknown>;
        warnings: unknown[];
      };

      expect(result['$version']).toBe(3);
      expect(
        (result['context'] as Record<string, unknown>)['fileFiltering'],
      ).toEqual({
        enableFuzzySearch: true,
      });
    });

    it('should migrate disableCacheControl to enableCacheControl', () => {
      const v2Settings = {
        $version: 2,
        model: { generationConfig: { disableCacheControl: true } },
      };

      const { settings: result } = migration.migrate(v2Settings, 'user') as {
        settings: Record<string, unknown>;
        warnings: unknown[];
      };

      expect(result['$version']).toBe(3);
      expect(
        (result['model'] as Record<string, unknown>)['generationConfig'],
      ).toEqual({
        enableCacheControl: false,
      });
    });

    it('should preserve other settings during migration', () => {
      const v2Settings = {
        $version: 2,
        ui: {
          theme: 'dark',
          accessibility: { disableLoadingPhrases: true },
        },
        model: {
          name: 'gemini',
        },
      };

      const { settings: result } = migration.migrate(v2Settings, 'user') as {
        settings: Record<string, unknown>;
        warnings: unknown[];
      };

      expect(result['$version']).toBe(3);
      expect((result['ui'] as Record<string, unknown>)['theme']).toBe('dark');
      expect((result['model'] as Record<string, unknown>)['name']).toBe(
        'gemini',
      );
      expect(
        (result['ui'] as Record<string, unknown>)['accessibility'],
      ).toEqual({
        enableLoadingPhrases: false,
      });
    });

    it('should not modify the input object', () => {
      const v2Settings = {
        $version: 2,
        context: { fileFiltering: { disableFuzzySearch: true } },
      };

      const result = migration.migrate(v2Settings, 'user');

      expect(v2Settings.context).toEqual({
        fileFiltering: { disableFuzzySearch: true },
      });
      expect(result).not.toBe(v2Settings);
    });

    it('should throw error for non-object input', () => {
      expect(() => migration.migrate(null, 'user')).toThrow(
        'Settings must be an object',
      );
      expect(() => migration.migrate('string', 'user')).toThrow(
        'Settings must be an object',
      );
    });

    it('should handle multiple deprecated keys in one migration', () => {
      const v2Settings = {
        $version: 2,
        ui: { accessibility: { disableLoadingPhrases: false } },
        context: { fileFiltering: { disableFuzzySearch: false } },
      };

      const { settings: result } = migration.migrate(v2Settings, 'user') as {
        settings: Record<string, unknown>;
        warnings: unknown[];
      };

      expect(result['$version']).toBe(3);
      expect(
        (result['ui'] as Record<string, unknown>)['accessibility'],
      ).toEqual({
        enableLoadingPhrases: true,
      });
      expect(
        (result['context'] as Record<string, unknown>)['fileFiltering'],
      ).toEqual({
        enableFuzzySearch: true,
      });
    });

    it('should coerce string "true" and remove deprecated key', () => {
      const v2Settings = {
        $version: 2,
        context: { fileFiltering: { disableFuzzySearch: 'true' } },
      };

      const { settings: result, warnings } = migration.migrate(
        v2Settings,
        'user',
      ) as {
        settings: Record<string, unknown>;
        warnings: string[];
      };

      expect(result['$version']).toBe(3);
      expect(
        (
          (result['context'] as Record<string, unknown>)[
            'fileFiltering'
          ] as Record<string, unknown>
        )['disableFuzzySearch'],
      ).toBeUndefined();
      expect(
        (
          (result['context'] as Record<string, unknown>)[
            'fileFiltering'
          ] as Record<string, unknown>
        )['enableFuzzySearch'],
      ).toBe(false);
      expect(warnings).toHaveLength(0);
    });

    it('should coerce string "false" and remove deprecated key', () => {
      const v2Settings = {
        $version: 2,
        context: { fileFiltering: { disableFuzzySearch: 'false' } },
      };

      const { settings: result, warnings } = migration.migrate(
        v2Settings,
        'user',
      ) as {
        settings: Record<string, unknown>;
        warnings: string[];
      };

      expect(result['$version']).toBe(3);
      expect(
        (
          (result['context'] as Record<string, unknown>)[
            'fileFiltering'
          ] as Record<string, unknown>
        )['disableFuzzySearch'],
      ).toBeUndefined();
      expect(
        (
          (result['context'] as Record<string, unknown>)[
            'fileFiltering'
          ] as Record<string, unknown>
        )['enableFuzzySearch'],
      ).toBe(true);
      expect(warnings).toHaveLength(0);
    });

    it('should coerce case-insensitive strings', () => {
      const v2Settings = {
        $version: 2,
        context: { fileFiltering: { disableFuzzySearch: 'TRUE' } },
      };

      const { settings: result, warnings } = migration.migrate(
        v2Settings,
        'user',
      ) as {
        settings: Record<string, unknown>;
        warnings: string[];
      };

      expect(result['$version']).toBe(3);
      expect(
        (
          (result['context'] as Record<string, unknown>)[
            'fileFiltering'
          ] as Record<string, unknown>
        )['disableFuzzySearch'],
      ).toBeUndefined();
      expect(
        (
          (result['context'] as Record<string, unknown>)[
            'fileFiltering'
          ] as Record<string, unknown>
        )['enableFuzzySearch'],
      ).toBe(false);
      expect(warnings).toHaveLength(0);
    });

    it('should remove number value and emit warning', () => {
      const v2Settings = {
        $version: 2,
        context: { fileFiltering: { disableFuzzySearch: 123 } },
      };

      const { settings: result, warnings } = migration.migrate(
        v2Settings,
        'user',
      ) as {
        settings: Record<string, unknown>;
        warnings: string[];
      };

      expect(result['$version']).toBe(3);
      expect(
        (
          (result['context'] as Record<string, unknown>)[
            'fileFiltering'
          ] as Record<string, unknown>
        )['disableFuzzySearch'],
      ).toBeUndefined();
      expect(
        (
          (result['context'] as Record<string, unknown>)[
            'fileFiltering'
          ] as Record<string, unknown>
        )['enableFuzzySearch'],
      ).toBeUndefined();
      expect(warnings).toHaveLength(1);
      expect(warnings[0]).toContain('context.fileFiltering.disableFuzzySearch');
    });

    it('should remove invalid string value and emit warning', () => {
      const v2Settings = {
        $version: 2,
        context: { fileFiltering: { disableFuzzySearch: 'invalid-string' } },
      };

      const { settings: result, warnings } = migration.migrate(
        v2Settings,
        'user',
      ) as {
        settings: Record<string, unknown>;
        warnings: string[];
      };

      expect(result['$version']).toBe(3);
      expect(
        (
          (result['context'] as Record<string, unknown>)[
            'fileFiltering'
          ] as Record<string, unknown>
        )['disableFuzzySearch'],
      ).toBeUndefined();
      expect(
        (
          (result['context'] as Record<string, unknown>)[
            'fileFiltering'
          ] as Record<string, unknown>
        )['enableFuzzySearch'],
      ).toBeUndefined();
      expect(warnings).toHaveLength(1);
      expect(warnings[0]).toContain('context.fileFiltering.disableFuzzySearch');
    });

    it('should coerce disableCacheControl string "true"', () => {
      const v2Settings = {
        $version: 2,
        model: { generationConfig: { disableCacheControl: 'true' } },
      };

      const { settings: result, warnings } = migration.migrate(
        v2Settings,
        'user',
      ) as {
        settings: Record<string, unknown>;
        warnings: string[];
      };

      expect(result['$version']).toBe(3);
      expect(
        (result['model'] as Record<string, unknown>)['generationConfig'],
      ).toEqual({
        enableCacheControl: false,
      });
      expect(warnings).toHaveLength(0);
    });

    it('should coerce disableCacheControl string "false"', () => {
      const v2Settings = {
        $version: 2,
        model: { generationConfig: { disableCacheControl: 'false' } },
      };

      const { settings: result, warnings } = migration.migrate(
        v2Settings,
        'user',
      ) as {
        settings: Record<string, unknown>;
        warnings: string[];
      };

      expect(result['$version']).toBe(3);
      expect(
        (result['model'] as Record<string, unknown>)['generationConfig'],
      ).toEqual({
        enableCacheControl: true,
      });
      expect(warnings).toHaveLength(0);
    });

    it('should remove disableCacheControl number value and emit warning', () => {
      const v2Settings = {
        $version: 2,
        model: { generationConfig: { disableCacheControl: 456 } },
      };

      const { settings: result, warnings } = migration.migrate(
        v2Settings,
        'user',
      ) as {
        settings: Record<string, unknown>;
        warnings: string[];
      };

      expect(result['$version']).toBe(3);
      expect(
        (result['model'] as Record<string, unknown>)['generationConfig'],
      ).toEqual({});
      expect(
        (
          (result['model'] as Record<string, unknown>)[
            'generationConfig'
          ] as Record<string, unknown>
        )['enableCacheControl'],
      ).toBeUndefined();
      expect(warnings).toHaveLength(1);
      expect(warnings[0]).toContain(
        'model.generationConfig.disableCacheControl',
      );
    });

    it('should remove object value for disable key and emit warning', () => {
      const v2Settings = {
        $version: 2,
        context: { fileFiltering: { disableFuzzySearch: { nested: 'value' } } },
      };

      const { settings: result, warnings } = migration.migrate(
        v2Settings,
        'user',
      ) as {
        settings: Record<string, unknown>;
        warnings: string[];
      };

      expect(result['$version']).toBe(3);
      expect(
        (
          (result['context'] as Record<string, unknown>)[
            'fileFiltering'
          ] as Record<string, unknown>
        )['disableFuzzySearch'],
      ).toBeUndefined();
      expect(
        (
          (result['context'] as Record<string, unknown>)[
            'fileFiltering'
          ] as Record<string, unknown>
        )['enableFuzzySearch'],
      ).toBeUndefined();
      expect(warnings).toHaveLength(1);
      expect(warnings[0]).toContain('context.fileFiltering.disableFuzzySearch');
    });

    it('should remove array value for disable key and emit warning', () => {
      const v2Settings = {
        $version: 2,
        context: { fileFiltering: { disableFuzzySearch: [1, 2, 3] } },
      };

      const { settings: result, warnings } = migration.migrate(
        v2Settings,
        'user',
      ) as {
        settings: Record<string, unknown>;
        warnings: string[];
      };

      expect(result['$version']).toBe(3);
      expect(
        (
          (result['context'] as Record<string, unknown>)[
            'fileFiltering'
          ] as Record<string, unknown>
        )['disableFuzzySearch'],
      ).toBeUndefined();
      expect(
        (
          (result['context'] as Record<string, unknown>)[
            'fileFiltering'
          ] as Record<string, unknown>
        )['enableFuzzySearch'],
      ).toBeUndefined();
      expect(warnings).toHaveLength(1);
      expect(warnings[0]).toContain('context.fileFiltering.disableFuzzySearch');
    });

    it('should remove null value for disable key and emit warning', () => {
      const v2Settings = {
        $version: 2,
        context: { fileFiltering: { disableFuzzySearch: null } },
      };

      const { settings: result, warnings } = migration.migrate(
        v2Settings,
        'user',
      ) as {
        settings: Record<string, unknown>;
        warnings: string[];
      };

      expect(result['$version']).toBe(3);
      expect(
        (
          (result['context'] as Record<string, unknown>)[
            'fileFiltering'
          ] as Record<string, unknown>
        )['disableFuzzySearch'],
      ).toBeUndefined();
      expect(
        (
          (result['context'] as Record<string, unknown>)[
            'fileFiltering'
          ] as Record<string, unknown>
        )['enableFuzzySearch'],
      ).toBeUndefined();
      expect(warnings).toHaveLength(1);
      expect(warnings[0]).toContain('context.fileFiltering.disableFuzzySearch');
    });
  });

  describe('version properties', () => {
    it('should have correct fromVersion', () => {
      expect(migration.fromVersion).toBe(2);
    });

    it('should have correct toVersion', () => {
      expect(migration.toVersion).toBe(3);
    });
  });
});
