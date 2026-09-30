/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { ModelConfig, ModelProvidersConfig } from '../models/types.js';

function preservePlaceholders(
  value: unknown,
  resolved: unknown,
  original: unknown,
): unknown {
  if (typeof original === 'string' && value === resolved) return original;
  if (
    Array.isArray(value) &&
    Array.isArray(resolved) &&
    Array.isArray(original)
  ) {
    return value.map((entry, index) =>
      preservePlaceholders(entry, resolved[index], original[index]),
    );
  }
  if (
    value &&
    resolved &&
    original &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    typeof resolved === 'object' &&
    !Array.isArray(resolved) &&
    typeof original === 'object' &&
    !Array.isArray(original)
  ) {
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [
        key,
        preservePlaceholders(
          entry,
          (resolved as Record<string, unknown>)[key],
          (original as Record<string, unknown>)[key],
        ),
      ]),
    );
  }
  return value;
}

/**
 * Map resolved model entries (env placeholders expanded) back onto the raw
 * settings entries so `${VAR}` placeholders survive a rewrite.
 */
export function preserveModelProviderPlaceholders(
  models: ModelConfig[],
  provider: string,
  resolvedProviders: ModelProvidersConfig,
  rawProviders: ModelProvidersConfig,
): ModelConfig[] {
  const resolvedEntries = resolvedProviders[provider];
  const pairs = Array.isArray(resolvedEntries)
    ? resolvedEntries.map((resolved, index) => ({
        resolved,
        raw: rawProviders[provider]?.[index] ?? resolved,
      }))
    : [];
  return models.map((model) => {
    const matches = pairs.filter(
      ({ resolved }) =>
        resolved.id === model.id && resolved.baseUrl === model.baseUrl,
    );
    if (
      matches.length > 1 &&
      matches.some(
        (pair) => JSON.stringify(pair.raw) !== JSON.stringify(pair.resolved),
      )
    ) {
      throw new Error(
        'Cannot preserve placeholders in an ambiguous model configuration. Remove duplicate model entries first.',
      );
    }
    const match = matches[0];
    return match
      ? (preservePlaceholders(model, match.resolved, match.raw) as ModelConfig)
      : model;
  });
}
