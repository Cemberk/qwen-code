/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect } from 'vitest';
import { parseBooleanEnvFlag, resolveTelemetrySettings } from './config.js';
import { SENSITIVE_SPAN_ATTRIBUTE_MAX_LENGTH_LIMIT } from './index.js';

describe('telemetry/config helpers', () => {
  describe('parseBooleanEnvFlag', () => {
    it('returns undefined for undefined', () => {
      expect(parseBooleanEnvFlag(undefined)).toBeUndefined();
    });

    it('parses true values', () => {
      expect(parseBooleanEnvFlag('true')).toBe(true);
      expect(parseBooleanEnvFlag('1')).toBe(true);
    });

    it('parses false/other values as false', () => {
      expect(parseBooleanEnvFlag('false')).toBe(false);
      expect(parseBooleanEnvFlag('0')).toBe(false);
      expect(parseBooleanEnvFlag('TRUE')).toBe(false);
      expect(parseBooleanEnvFlag('random')).toBe(false);
      expect(parseBooleanEnvFlag('')).toBe(false);
    });
  });

  describe('resolveTelemetrySettings', () => {
    it('falls back to settings when no argv/env provided', async () => {
      const settings = {
        enabled: false,
        logPrompts: false,
        userId: 'settings-user',
        includeSensitiveSpanAttributes: true,
        sensitiveSpanAttributeMaxLength: 1234,
        outfile: 'settings.log',
      };
      const resolved = await resolveTelemetrySettings({ settings });
      expect(resolved).toEqual({
        ...settings,
        resourceAttributes: undefined,
        metrics: { includeSessionId: false },
        resourceAttributeWarnings: undefined,
      });
    });

    it('uses env over settings and argv over env', async () => {
      const settings = {
        enabled: false,
        logPrompts: false,
        userId: 'settings-user',
        includeSensitiveSpanAttributes: false,
        sensitiveSpanAttributeMaxLength: 1234,
        outfile: 'settings.log',
      };
      const env = {
        QWEN_TELEMETRY_ENABLED: '1',
        QWEN_TELEMETRY_LOG_PROMPTS: 'true',
        QWEN_TELEMETRY_USER_ID: 'env-user',
        QWEN_TELEMETRY_INCLUDE_SENSITIVE_SPAN_ATTRIBUTES: 'true',
        QWEN_TELEMETRY_SENSITIVE_SPAN_ATTRIBUTE_MAX_LENGTH: '2048',
        QWEN_TELEMETRY_OUTFILE: 'env.log',
      } as Record<string, string>;
      const argv = {
        telemetry: false,
        telemetryLogPrompts: false,
        telemetryOutfile: 'argv.log',
      };

      const resolvedEnv = await resolveTelemetrySettings({ env, settings });
      expect(resolvedEnv).toEqual({
        enabled: true,
        logPrompts: true,
        userId: 'env-user',
        includeSensitiveSpanAttributes: true,
        sensitiveSpanAttributeMaxLength: 2048,
        outfile: 'env.log',
        resourceAttributes: undefined,
        metrics: { includeSessionId: false },
        resourceAttributeWarnings: undefined,
      });

      const resolvedArgv = await resolveTelemetrySettings({
        argv,
        env,
        settings,
      });
      expect(resolvedArgv).toEqual({
        enabled: false,
        logPrompts: false,
        userId: 'env-user',
        includeSensitiveSpanAttributes: true,
        sensitiveSpanAttributeMaxLength: 2048,
        outfile: 'argv.log',
        resourceAttributes: undefined,
        metrics: { includeSessionId: false },
        resourceAttributeWarnings: undefined,
      });
    });

    it('defaults includeSensitiveSpanAttributes to false', async () => {
      const resolved = await resolveTelemetrySettings({});

      expect(resolved.includeSensitiveSpanAttributes).toBe(false);
    });

    it('resolves and normalizes the telemetry user ID', async () => {
      const resolvedFromSettings = await resolveTelemetrySettings({
        settings: { userId: '  user α  beta  ' },
      });
      expect(resolvedFromSettings.userId).toBe('user α  beta');

      const resolvedFromEnv = await resolveTelemetrySettings({
        env: { QWEN_TELEMETRY_USER_ID: '  0  ' },
        settings: { userId: 'settings-user' },
      });
      expect(resolvedFromEnv.userId).toBe('0');
    });

    it('falls back to settings when the telemetry user ID env var is blank', async () => {
      const resolved = await resolveTelemetrySettings({
        env: { QWEN_TELEMETRY_USER_ID: '   ' },
        settings: { userId: ' settings-user ' },
      });

      expect(resolved.userId).toBe('settings-user');
    });

    it('omits the telemetry user ID when both sources are blank', async () => {
      const resolved = await resolveTelemetrySettings({
        env: { QWEN_TELEMETRY_USER_ID: '\t' },
        settings: { userId: ' ' },
      });

      expect(resolved.userId).toBeUndefined();
    });

    it('rejects a non-string telemetry user ID setting', async () => {
      await expect(
        resolveTelemetrySettings({
          settings: {
            // @ts-expect-error — runtime defensive path against bad JSON.
            userId: 42,
          },
        }),
      ).rejects.toThrow(/telemetry\.userId.*must be a string.*number/);
    });

    it('defaults sensitiveSpanAttributeMaxLength to 1MiB', async () => {
      const resolved = await resolveTelemetrySettings({});
      const resolvedMaxLength: number =
        resolved.sensitiveSpanAttributeMaxLength;

      expect(resolvedMaxLength).toBe(1024 * 1024);
    });

    it('parses includeSensitiveSpanAttributes from settings and env', async () => {
      const resolvedFromSettings = await resolveTelemetrySettings({
        settings: { includeSensitiveSpanAttributes: true },
      });
      expect(resolvedFromSettings.includeSensitiveSpanAttributes).toBe(true);

      const resolvedEnvTrue = await resolveTelemetrySettings({
        env: {
          QWEN_TELEMETRY_INCLUDE_SENSITIVE_SPAN_ATTRIBUTES: '1',
        },
        settings: { includeSensitiveSpanAttributes: false },
      });
      expect(resolvedEnvTrue.includeSensitiveSpanAttributes).toBe(true);

      const resolvedEnvFalse = await resolveTelemetrySettings({
        env: {
          QWEN_TELEMETRY_INCLUDE_SENSITIVE_SPAN_ATTRIBUTES: 'false',
        },
        settings: { includeSensitiveSpanAttributes: true },
      });
      expect(resolvedEnvFalse.includeSensitiveSpanAttributes).toBe(false);
    });

    it('parses sensitiveSpanAttributeMaxLength from settings and env', async () => {
      const resolvedFromSettings = await resolveTelemetrySettings({
        settings: { sensitiveSpanAttributeMaxLength: 65_536 },
      });
      expect(resolvedFromSettings.sensitiveSpanAttributeMaxLength).toBe(65_536);

      const resolvedFromEnv = await resolveTelemetrySettings({
        env: {
          QWEN_TELEMETRY_SENSITIVE_SPAN_ATTRIBUTE_MAX_LENGTH: '131072',
        },
        settings: { sensitiveSpanAttributeMaxLength: 65_536 },
      });
      expect(resolvedFromEnv.sensitiveSpanAttributeMaxLength).toBe(131_072);
    });

    it('accepts sensitiveSpanAttributeMaxLength at the configured maximum', async () => {
      const resolvedFromSettings = await resolveTelemetrySettings({
        settings: {
          sensitiveSpanAttributeMaxLength:
            SENSITIVE_SPAN_ATTRIBUTE_MAX_LENGTH_LIMIT,
        },
      });
      expect(resolvedFromSettings.sensitiveSpanAttributeMaxLength).toBe(
        SENSITIVE_SPAN_ATTRIBUTE_MAX_LENGTH_LIMIT,
      );

      const resolvedFromEnv = await resolveTelemetrySettings({
        env: {
          QWEN_TELEMETRY_SENSITIVE_SPAN_ATTRIBUTE_MAX_LENGTH: String(
            SENSITIVE_SPAN_ATTRIBUTE_MAX_LENGTH_LIMIT,
          ),
        },
      });
      expect(resolvedFromEnv.sensitiveSpanAttributeMaxLength).toBe(
        SENSITIVE_SPAN_ATTRIBUTE_MAX_LENGTH_LIMIT,
      );
    });

    it('rejects invalid sensitiveSpanAttributeMaxLength settings', async () => {
      await expect(
        resolveTelemetrySettings({
          settings: { sensitiveSpanAttributeMaxLength: 0 },
        }),
      ).rejects.toThrow(/sensitiveSpanAttributeMaxLength.*got 0/i);

      await expect(
        resolveTelemetrySettings({
          settings: {
            sensitiveSpanAttributeMaxLength: 1.5,
          },
        }),
      ).rejects.toThrow(/sensitiveSpanAttributeMaxLength.*got 1\.5/i);

      await expect(
        resolveTelemetrySettings({
          settings: {
            sensitiveSpanAttributeMaxLength: -1,
          },
        }),
      ).rejects.toThrow(/sensitiveSpanAttributeMaxLength.*got -1/i);

      await expect(
        resolveTelemetrySettings({
          settings: {
            sensitiveSpanAttributeMaxLength:
              SENSITIVE_SPAN_ATTRIBUTE_MAX_LENGTH_LIMIT + 1,
          },
        }),
      ).rejects.toThrow(/sensitiveSpanAttributeMaxLength.*104857600/i);

      await expect(
        resolveTelemetrySettings({
          settings: {
            sensitiveSpanAttributeMaxLength: Number.NaN,
          },
        }),
      ).rejects.toThrow(/sensitiveSpanAttributeMaxLength.*got NaN/i);
    });

    it.each([
      ['string', '1024'],
      ['boolean', true],
    ])(
      'rejects non-number sensitiveSpanAttributeMaxLength settings (%s)',
      async (_type, value) => {
        const settings = {
          sensitiveSpanAttributeMaxLength: value,
        } as unknown as Parameters<
          typeof resolveTelemetrySettings
        >[0]['settings'];

        await expect(resolveTelemetrySettings({ settings })).rejects.toThrow(
          /sensitiveSpanAttributeMaxLength/i,
        );
      },
    );

    it('rejects invalid sensitive span max length env values', async () => {
      await expect(
        resolveTelemetrySettings({
          env: {
            QWEN_TELEMETRY_SENSITIVE_SPAN_ATTRIBUTE_MAX_LENGTH: '',
          },
        }),
      ).rejects.toThrow(
        /QWEN_TELEMETRY_SENSITIVE_SPAN_ATTRIBUTE_MAX_LENGTH.*got ''/,
      );

      await expect(
        resolveTelemetrySettings({
          env: {
            QWEN_TELEMETRY_SENSITIVE_SPAN_ATTRIBUTE_MAX_LENGTH: '   ',
          },
        }),
      ).rejects.toThrow(
        /QWEN_TELEMETRY_SENSITIVE_SPAN_ATTRIBUTE_MAX_LENGTH.*got ' {3}'/,
      );

      await expect(
        resolveTelemetrySettings({
          env: {
            QWEN_TELEMETRY_SENSITIVE_SPAN_ATTRIBUTE_MAX_LENGTH: 'abc',
          },
        }),
      ).rejects.toThrow(
        /QWEN_TELEMETRY_SENSITIVE_SPAN_ATTRIBUTE_MAX_LENGTH.*got 'abc'/,
      );

      await expect(
        resolveTelemetrySettings({
          env: {
            QWEN_TELEMETRY_SENSITIVE_SPAN_ATTRIBUTE_MAX_LENGTH: '1e3',
          },
        }),
      ).rejects.toThrow(
        /QWEN_TELEMETRY_SENSITIVE_SPAN_ATTRIBUTE_MAX_LENGTH.*got '1e3'/,
      );

      await expect(
        resolveTelemetrySettings({
          env: {
            QWEN_TELEMETRY_SENSITIVE_SPAN_ATTRIBUTE_MAX_LENGTH: '0',
          },
        }),
      ).rejects.toThrow(
        /QWEN_TELEMETRY_SENSITIVE_SPAN_ATTRIBUTE_MAX_LENGTH.*got '0'/,
      );

      await expect(
        resolveTelemetrySettings({
          env: {
            QWEN_TELEMETRY_SENSITIVE_SPAN_ATTRIBUTE_MAX_LENGTH:
              '9007199254740992',
          },
        }),
      ).rejects.toThrow(
        /QWEN_TELEMETRY_SENSITIVE_SPAN_ATTRIBUTE_MAX_LENGTH.*got '9007199254740992'/,
      );

      await expect(
        resolveTelemetrySettings({
          env: {
            QWEN_TELEMETRY_SENSITIVE_SPAN_ATTRIBUTE_MAX_LENGTH: String(
              SENSITIVE_SPAN_ATTRIBUTE_MAX_LENGTH_LIMIT + 1,
            ),
          },
        }),
      ).rejects.toThrow(
        /QWEN_TELEMETRY_SENSITIVE_SPAN_ATTRIBUTE_MAX_LENGTH.*104857600/,
      );
    });
  });

  describe('resolveTelemetrySettings — resource attributes', () => {
    it('returns undefined resourceAttributes when nothing set', async () => {
      const resolved = await resolveTelemetrySettings({});
      expect(resolved.resourceAttributes).toBeUndefined();
    });

    it('parses OTEL_RESOURCE_ATTRIBUTES from env', async () => {
      const resolved = await resolveTelemetrySettings({
        env: { OTEL_RESOURCE_ATTRIBUTES: 'team=platform,env=prod' },
      });
      expect(resolved.resourceAttributes).toEqual({
        team: 'platform',
        env: 'prod',
      });
    });

    it('merges settings on top of env (settings wins)', async () => {
      const resolved = await resolveTelemetrySettings({
        env: { OTEL_RESOURCE_ATTRIBUTES: 'team=x,env=prod' },
        settings: { resourceAttributes: { team: 'y' } },
      });
      expect(resolved.resourceAttributes).toEqual({
        team: 'y',
        env: 'prod',
      });
    });

    it('reads service.name from OTEL_SERVICE_NAME alone', async () => {
      const resolved = await resolveTelemetrySettings({
        env: { OTEL_SERVICE_NAME: 'A' },
      });
      expect(resolved.resourceAttributes).toEqual({ 'service.name': 'A' });
    });

    it('reads service.name from OTEL_RESOURCE_ATTRIBUTES alone', async () => {
      const resolved = await resolveTelemetrySettings({
        env: { OTEL_RESOURCE_ATTRIBUTES: 'service.name=B' },
      });
      expect(resolved.resourceAttributes).toEqual({ 'service.name': 'B' });
    });

    it('drops user-provided session.id from env with warning', async () => {
      const resolved = await resolveTelemetrySettings({
        env: { OTEL_RESOURCE_ATTRIBUTES: 'session.id=spoofed,team=x' },
      });
      expect(resolved.resourceAttributes).toEqual({ team: 'x' });
    });

    it('drops user-provided session.id from settings with warning', async () => {
      const resolved = await resolveTelemetrySettings({
        settings: {
          resourceAttributes: { 'session.id': 'spoofed', team: 'x' },
        },
      });
      expect(resolved.resourceAttributes).toEqual({ team: 'x' });
    });

    it('trims whitespace-only OTEL_SERVICE_NAME (treats as unset)', async () => {
      const resolved = await resolveTelemetrySettings({
        env: { OTEL_SERVICE_NAME: '   ' },
      });
      // No user attrs → resourceAttributes stays undefined.
      expect(resolved.resourceAttributes).toBeUndefined();
    });

    it('exposes resourceAttributeWarnings when input has issues', async () => {
      const resolved = await resolveTelemetrySettings({
        env: {
          OTEL_RESOURCE_ATTRIBUTES: 'bogus,service.version=1,team=ok',
        },
        settings: {
          resourceAttributes: {
            '': 'empty-key',
            // @ts-expect-error — runtime defensive path against bad JSON.
            count: 42,
          },
        },
      });
      expect(resolved.resourceAttributeWarnings).toBeDefined();
      // Expect at least: malformed pair, reserved service.version, empty key, non-string value.
      expect(resolved.resourceAttributeWarnings!.length).toBeGreaterThanOrEqual(
        4,
      );
    });

    it('leaves resourceAttributeWarnings undefined when input is clean', async () => {
      const resolved = await resolveTelemetrySettings({
        env: { OTEL_RESOURCE_ATTRIBUTES: 'team=platform,env=prod' },
      });
      expect(resolved.resourceAttributeWarnings).toBeUndefined();
    });

    it('drops non-string settings values', async () => {
      const resolved = await resolveTelemetrySettings({
        settings: {
          resourceAttributes: {
            team: 'platform',
            // @ts-expect-error — runtime defensive path against bad JSON.
            count: 42,
          },
        },
      });
      expect(resolved.resourceAttributes).toEqual({ team: 'platform' });
    });

    it('OTEL_SERVICE_NAME wins over OTEL_RESOURCE_ATTRIBUTES.service.name', async () => {
      const resolved = await resolveTelemetrySettings({
        env: {
          OTEL_SERVICE_NAME: 'A',
          OTEL_RESOURCE_ATTRIBUTES: 'service.name=B',
        },
      });
      expect(resolved.resourceAttributes?.['service.name']).toBe('A');
    });

    it('OTEL_SERVICE_NAME wins over settings.resourceAttributes.service.name', async () => {
      const resolved = await resolveTelemetrySettings({
        env: { OTEL_SERVICE_NAME: 'A' },
        settings: { resourceAttributes: { 'service.name': 'C' } },
      });
      expect(resolved.resourceAttributes?.['service.name']).toBe('A');
    });

    it('settings.service.name wins over env.OTEL_RESOURCE_ATTRIBUTES.service.name when no OTEL_SERVICE_NAME', async () => {
      const resolved = await resolveTelemetrySettings({
        env: { OTEL_RESOURCE_ATTRIBUTES: 'service.name=B' },
        settings: { resourceAttributes: { 'service.name': 'C' } },
      });
      expect(resolved.resourceAttributes?.['service.name']).toBe('C');
    });

    it('strips service.version from env source', async () => {
      const resolved = await resolveTelemetrySettings({
        env: { OTEL_RESOURCE_ATTRIBUTES: 'service.version=fake,team=x' },
      });
      expect(resolved.resourceAttributes).toEqual({ team: 'x' });
    });

    it('strips service.version from settings source', async () => {
      const resolved = await resolveTelemetrySettings({
        settings: {
          resourceAttributes: { 'service.version': 'fake', team: 'x' },
        },
      });
      expect(resolved.resourceAttributes).toEqual({ team: 'x' });
    });
  });

  describe('resolveTelemetrySettings — metrics.includeSessionId', () => {
    it('defaults to false', async () => {
      const resolved = await resolveTelemetrySettings({});
      expect(resolved.metrics?.includeSessionId).toBe(false);
    });

    it('reads from settings', async () => {
      const resolved = await resolveTelemetrySettings({
        settings: { metrics: { includeSessionId: true } },
      });
      expect(resolved.metrics?.includeSessionId).toBe(true);
    });

    it('reads from env (override settings)', async () => {
      const resolved = await resolveTelemetrySettings({
        env: { QWEN_TELEMETRY_METRICS_INCLUDE_SESSION_ID: 'true' },
        settings: { metrics: { includeSessionId: false } },
      });
      expect(resolved.metrics?.includeSessionId).toBe(true);
    });

    it('explicit env=false overrides settings=true', async () => {
      const resolved = await resolveTelemetrySettings({
        env: { QWEN_TELEMETRY_METRICS_INCLUDE_SESSION_ID: 'false' },
        settings: { metrics: { includeSessionId: true } },
      });
      expect(resolved.metrics?.includeSessionId).toBe(false);
    });
  });
});
