/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Drift detector for `buildAuthPreflightCell`'s env-key map.
 *
 * `AUTH_PREFLIGHT_ENV_KEYS` in `acpAgent.ts` is a hand-maintained mirror of
 * `OPENAI_ENV_MAPPING.apiKey` in `core/src/models/constants.ts`. An auth type
 * missing from the map silently reports `status: 'unknown'` in preflight, so
 * this test walks the public `AuthType` enum and asserts every value is keyed.
 *
 * Lives in its own file so it can `import` the real `AuthType` enum without
 * fighting the heavy `vi.mock('@qwen-code/qwen-code-core', ...)` block in
 * `acpAgent.test.ts`.
 */
import { describe, expect, it } from 'vitest';
import { AuthType, OPENAI_ENV_MAPPING } from '@qwen-code/qwen-code-core';
import { AUTH_PREFLIGHT_ENV_KEYS } from './acpAgent.js';

describe('AUTH_PREFLIGHT_ENV_KEYS drift detection', () => {
  it('keys every public AuthType value', () => {
    const keyed = new Set(Object.keys(AUTH_PREFLIGHT_ENV_KEYS));
    const uncovered = (Object.values(AuthType) as string[]).filter(
      (authType) => !keyed.has(authType),
    );

    // Failure here means a new AuthType value landed in core without an
    // entry in AUTH_PREFLIGHT_ENV_KEYS (packages/cli/src/acp-integration/acpAgent.ts).
    expect(uncovered).toEqual([]);
  });

  it('mirrors the core OpenAI-compatible API key env vars', () => {
    expect(AUTH_PREFLIGHT_ENV_KEYS[AuthType.USE_OPENAI]).toEqual(
      OPENAI_ENV_MAPPING.apiKey,
    );
  });

  it('keys only the local OpenAI-compatible auth type', () => {
    expect(Object.keys(AUTH_PREFLIGHT_ENV_KEYS)).toEqual([AuthType.USE_OPENAI]);
  });

  it('every keyed entry has at least one env var candidate', () => {
    const empty = Object.entries(AUTH_PREFLIGHT_ENV_KEYS).filter(
      ([, vars]) => vars.length === 0,
    );
    expect(empty).toEqual([]);
  });
});
