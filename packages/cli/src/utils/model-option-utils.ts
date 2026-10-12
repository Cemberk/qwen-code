/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { Config } from '@qwen-code/qwen-code-core/config/config.js';
import { AuthType } from '@qwen-code/qwen-code-core/utils/auth-type.js';
import { z } from 'zod';

export function sanitizeProviderBaseUrl(baseUrl: string): string {
  const scheme = baseUrl.match(/^[A-Za-z][A-Za-z\d+.-]*:\/\//);
  if (!scheme) {
    return baseUrl;
  }

  const authorityStart = scheme[0].length;
  const stripAt = (at: number) =>
    `${baseUrl.slice(0, authorityStart)}${baseUrl.slice(at + 1)}`;
  const authorityEnd = findAuthorityEnd(baseUrl, authorityStart);
  const authorityAt = baseUrl
    .slice(authorityStart, authorityEnd)
    .lastIndexOf('@');
  const authorityAtIndex =
    authorityAt === -1 ? -1 : authorityStart + authorityAt;

  try {
    const parsed = new URL(baseUrl);
    if (parsed.username || parsed.password) {
      return authorityAtIndex >= authorityStart
        ? stripAt(authorityAtIndex)
        : baseUrl;
    }
    return baseUrl;
  } catch {
    if (authorityAtIndex >= authorityStart) {
      return stripAt(authorityAtIndex);
    }

    const fallbackAt = findUnescapedUserInfoFallbackAt(
      baseUrl,
      authorityStart,
      authorityEnd,
    );
    return fallbackAt === -1 ? baseUrl : stripAt(fallbackAt);
  }
}

function findUnescapedUserInfoFallbackAt(
  baseUrl: string,
  authorityStart: number,
  authorityEnd: number,
): number {
  const at = baseUrl.lastIndexOf('@');
  if (at < authorityStart || authorityEnd >= at) {
    return -1;
  }

  const colon = baseUrl.indexOf(':', authorityStart);
  if (colon === -1 || colon > authorityEnd) {
    return -1;
  }

  const portCandidate = baseUrl.slice(colon + 1, authorityEnd);
  return /^\d+$/.test(portCandidate) ? -1 : at;
}

function findAuthorityEnd(baseUrl: string, authorityStart: number): number {
  const slash = baseUrl.indexOf('/', authorityStart);
  const query = baseUrl.indexOf('?', authorityStart);
  const hash = baseUrl.indexOf('#', authorityStart);
  let end = baseUrl.length;
  if (slash !== -1) end = Math.min(end, slash);
  if (query !== -1) end = Math.min(end, query);
  if (hash !== -1) end = Math.min(end, hash);
  return end;
}

/**
 * Parses a model option string (as typed after `/model`) into
 * `{ modelId, authType? }`.
 *
 * Supports the following formats:
 * - `${modelId}(${authType})` - Standard registry model (e.g., "gpt-4(USE_OPENAI)")
 * - `${snapshotId}(${authType})` - Runtime model snapshot (e.g., "$runtime|USE_OPENAI|gpt-4(USE_OPENAI)")
 *   where snapshotId is in format `$runtime|${authType}|${modelId}`
 * - Plain model ID - Returns as-is with no authType
 *
 * If the string ends with `(...)` and `...` is a valid `AuthType`, returns both;
 * otherwise returns the trimmed input as `modelId` only.
 */
export function parseModelOption(input: string): {
  modelId: string;
  authType?: AuthType;
} {
  const trimmed = input.trim();
  const closeIdx = trimmed.lastIndexOf(')');
  const openIdx = trimmed.lastIndexOf('(');
  if (openIdx >= 0 && closeIdx === trimmed.length - 1 && openIdx < closeIdx) {
    const maybeModelId = trimmed.slice(0, openIdx);
    const maybeAuthType = trimmed.slice(openIdx + 1, closeIdx);
    const parsedAuthType = z.nativeEnum(AuthType).safeParse(maybeAuthType);
    if (parsedAuthType.success) {
      return { modelId: maybeModelId, authType: parsedAuthType.data };
    }
  }
  return { modelId: trimmed };
}

/**
 * Whether a bare `modelId` resolves to the SAME provider identity as the active
 * content generator — same auth type, base URL, and credential env key.
 *
 * A per-turn inline `modelOverride` reuses the active provider's endpoint and
 * credentials and only swaps the model id; it cannot rebuild baseUrl/envKey for
 * a different provider. Any consumer that applies a `submit_prompt` result's
 * `modelOverride` must gate on this so an override naming a same-id model owned
 * by a different provider (or a different auth type) is never silently sent to
 * the active endpoint/account — even if a future (or untrusted) slash command
 * produces the override instead of the validated `/model` command. `modelId` is
 * the bare id without any `(authType)` suffix.
 */
export function isInlineModelOverrideAllowed(
  config: Config,
  modelId: string,
): boolean {
  const contentGeneratorConfig = config.getContentGeneratorConfig();
  const authType = contentGeneratorConfig?.authType;
  if (!authType) {
    return false;
  }
  const activeBaseUrl = contentGeneratorConfig.baseUrl;
  const activeEnvKey = contentGeneratorConfig.apiKeyEnvKey;
  return config
    .getAvailableModelsForAuthType(authType)
    .filter((m) => !m.fastOnly)
    .some(
      (m) =>
        m.id === modelId &&
        (m.baseUrl ?? undefined) === (activeBaseUrl ?? undefined) &&
        (m.envKey ?? undefined) === (activeEnvKey ?? undefined),
    );
}
