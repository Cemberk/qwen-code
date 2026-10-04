/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import { HOOK_EVENT_DISPLAY } from './hook-event-display.js';
import { HookEventName } from './types.js';

const allEvents = Object.values(HookEventName);

describe('HOOK_EVENT_DISPLAY', () => {
  it('classifies every hook event and nothing else', () => {
    expect(allEvents).toHaveLength(22);
    expect(Object.keys(HOOK_EVENT_DISPLAY).sort()).toEqual(
      [...allEvents].sort(),
    );
  });

  it('cannot be changed by a consumer', () => {
    const entry = HOOK_EVENT_DISPLAY[HookEventName.MessageDisplay];
    expect(Object.isFrozen(HOOK_EVENT_DISPLAY)).toBe(true);
    expect(Object.isFrozen(entry)).toBe(true);
  });
});
