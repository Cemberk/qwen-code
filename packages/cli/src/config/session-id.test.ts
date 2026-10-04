/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import { isValidSessionId, normalizeSessionIdForLookup } from './session-id.js';

describe('normalizeSessionIdForLookup', () => {
  it('lowercases caller-visible UUIDs', () => {
    expect(
      normalizeSessionIdForLookup('550E8400-E29B-41D4-A716-446655440000'),
    ).toBe('550e8400-e29b-41d4-a716-446655440000');
  });

  it.each([
    '550e8400-e29b-41d4-a716-446655440000-agent-WorkerA',
    'legacy-session-ID',
  ])('leaves internal or legacy ID %s unchanged', (sessionId) => {
    expect(normalizeSessionIdForLookup(sessionId)).toBe(sessionId);
  });
});

describe('isValidSessionId', () => {
  it('keeps internal Arena agent session IDs valid', () => {
    expect(
      isValidSessionId('550e8400-e29b-41d4-a716-446655440000-agent-arena_1'),
    ).toBe(true);
  });
});
