/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type {
  ResolvedTelemetrySettings,
  TelemetrySettings,
} from '../config/config.js';
import { FatalConfigError } from '../utils/errors.js';
import {
  DEFAULT_SENSITIVE_SPAN_ATTRIBUTE_MAX_LENGTH,
  SENSITIVE_SPAN_ATTRIBUTE_MAX_LENGTH_LIMIT,
  isValidSensitiveSpanAttributeMaxLength,
} from './index.js';
import type { ResourceAttributeWarnings } from './resource-attributes.js';
import {
  coerceStringResourceAttributes,
  parseOtelResourceAttributes,
  stripReservedResourceAttributes,
} from './resource-attributes.js';

/**
 * Parse a boolean environment flag. Accepts 'true'/'1' as true.
 */
export function parseBooleanEnvFlag(
  value: string | undefined,
): boolean | undefined {
  if (value === undefined) return undefined;
  return value === 'true' || value === '1';
}

/**
 * @throws FatalConfigError when the env var is set but invalid; telemetry
 * config fails closed instead of silently falling back.
 */
function parseSensitiveSpanAttributeMaxLengthEnvValue(
  envName: string,
  value: string | undefined,
): number | undefined {
  if (value === undefined) return undefined;

  const trimmed = value.trim();
  const parsed = Number(trimmed);
  if (
    !/^\d+$/.test(trimmed) ||
    !isValidSensitiveSpanAttributeMaxLength(parsed)
  ) {
    throw new FatalConfigError(
      `Invalid ${envName}: must be a positive integer no greater than ${SENSITIVE_SPAN_ATTRIBUTE_MAX_LENGTH_LIMIT}, got '${value}'`,
    );
  }

  return parsed;
}

function parseSensitiveSpanAttributeMaxLengthSetting(
  settingName: string,
  value: unknown,
): number | undefined {
  if (value === undefined) return undefined;
  if (
    typeof value !== 'number' ||
    !isValidSensitiveSpanAttributeMaxLength(value)
  ) {
    throw new FatalConfigError(
      `Invalid ${settingName}: must be a positive integer no greater than ${SENSITIVE_SPAN_ATTRIBUTE_MAX_LENGTH_LIMIT}, got ${String(
        value,
      )}`,
    );
  }
  return value;
}

function parseTelemetryUserId(
  source: string,
  value: unknown,
): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string') {
    throw new FatalConfigError(
      `Invalid ${source}: must be a string, got ${typeof value}`,
    );
  }
  return value.trim() || undefined;
}

export interface TelemetryArgOverrides {
  telemetry?: boolean;
  telemetryLogPrompts?: boolean;
  telemetryOutfile?: string;
}

/**
 * Build TelemetrySettings by resolving from argv (highest), env, then settings.
 */
export async function resolveTelemetrySettings(options: {
  argv?: TelemetryArgOverrides;
  env?: Record<string, string | undefined>;
  settings?: TelemetrySettings;
}): Promise<ResolvedTelemetrySettings> {
  const argv = options.argv ?? {};
  const env = options.env ?? {};
  const settings = options.settings ?? {};

  const enabled =
    argv.telemetry ??
    parseBooleanEnvFlag(env['QWEN_TELEMETRY_ENABLED']) ??
    settings.enabled;

  const logPrompts =
    argv.telemetryLogPrompts ??
    parseBooleanEnvFlag(env['QWEN_TELEMETRY_LOG_PROMPTS']) ??
    settings.logPrompts;

  const userId =
    parseTelemetryUserId(
      'QWEN_TELEMETRY_USER_ID',
      env['QWEN_TELEMETRY_USER_ID'],
    ) ?? parseTelemetryUserId('telemetry.userId', settings.userId);

  const includeSensitiveSpanAttributes =
    parseBooleanEnvFlag(
      env['QWEN_TELEMETRY_INCLUDE_SENSITIVE_SPAN_ATTRIBUTES'],
    ) ??
    settings.includeSensitiveSpanAttributes ??
    false;

  const sensitiveSpanAttributeMaxLength =
    parseSensitiveSpanAttributeMaxLengthEnvValue(
      'QWEN_TELEMETRY_SENSITIVE_SPAN_ATTRIBUTE_MAX_LENGTH',
      env['QWEN_TELEMETRY_SENSITIVE_SPAN_ATTRIBUTE_MAX_LENGTH'],
    ) ??
    parseSensitiveSpanAttributeMaxLengthSetting(
      'telemetry.sensitiveSpanAttributeMaxLength',
      settings.sensitiveSpanAttributeMaxLength,
    ) ??
    DEFAULT_SENSITIVE_SPAN_ATTRIBUTE_MAX_LENGTH;

  const outfile =
    argv.telemetryOutfile ?? env['QWEN_TELEMETRY_OUTFILE'] ?? settings.outfile;

  // Resource attributes: merge OTEL_RESOURCE_ATTRIBUTES (lowest), then
  // settings.resourceAttributes (settings wins on key conflict). RESERVED
  // keys (`service.version`, `session.id`) are stripped from both sources
  // with a `diag.warn`. OTEL_SERVICE_NAME is a standard escape hatch that
  // overrides service.name from any other source. All drops/coercions are
  // accumulated into `resourceAttributeWarnings` so the SDK can emit a
  // one-time user-visible summary at telemetry init.
  const resourceAttributeWarnings: ResourceAttributeWarnings = [];
  const envResourceAttrs = stripReservedResourceAttributes(
    parseOtelResourceAttributes(
      env['OTEL_RESOURCE_ATTRIBUTES'],
      resourceAttributeWarnings,
    ),
    'OTEL_RESOURCE_ATTRIBUTES',
    resourceAttributeWarnings,
  );
  const settingsResourceAttrs = stripReservedResourceAttributes(
    coerceStringResourceAttributes(
      settings.resourceAttributes,
      resourceAttributeWarnings,
    ),
    'settings.telemetry.resourceAttributes',
    resourceAttributeWarnings,
  );
  const mergedResourceAttrs: Record<string, string> = {
    ...envResourceAttrs,
    ...settingsResourceAttrs,
  };
  // Trim OTEL_SERVICE_NAME so a whitespace-only value (`' '`, `'\t'`) is
  // treated as unset rather than producing a blank service name on Resource.
  const otelServiceName = env['OTEL_SERVICE_NAME']?.trim();
  if (otelServiceName) {
    mergedResourceAttrs['service.name'] = otelServiceName;
  }
  const resourceAttributes = Object.keys(mergedResourceAttrs).length
    ? mergedResourceAttrs
    : undefined;

  const metricsIncludeSessionId =
    parseBooleanEnvFlag(env['QWEN_TELEMETRY_METRICS_INCLUDE_SESSION_ID']) ??
    settings.metrics?.includeSessionId ??
    false;

  return {
    enabled,
    logPrompts,
    userId,
    includeSensitiveSpanAttributes,
    sensitiveSpanAttributeMaxLength,
    outfile,
    resourceAttributes,
    metrics: { includeSessionId: metricsIncludeSessionId },
    resourceAttributeWarnings: resourceAttributeWarnings.length
      ? resourceAttributeWarnings
      : undefined,
  };
}
