/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import {
  AUTONOMOUS_SENTINEL_CRON,
  AUTONOMOUS_SENTINEL_DYNAMIC,
  LOOP_SENTINEL_CRON,
  LOOP_SENTINEL_DYNAMIC,
  detectAutonomousSentinel,
  detectLoopSentinel,
} from './loop-tick-resolver.js';

describe('detectLoopSentinel', () => {
  it('recognizes the cron and dynamic sentinels exactly (after trim)', () => {
    expect(detectLoopSentinel(LOOP_SENTINEL_CRON)).toBe('cron');
    expect(detectLoopSentinel(LOOP_SENTINEL_DYNAMIC)).toBe('dynamic');
    expect(detectLoopSentinel(`  ${LOOP_SENTINEL_DYNAMIC}\n`)).toBe('dynamic');
  });

  it('returns null for non-sentinel prompts', () => {
    expect(detectLoopSentinel('/loop check the deploy')).toBeNull();
    expect(detectLoopSentinel('<<loop.md>> and more')).toBeNull();
    expect(detectLoopSentinel('')).toBeNull();
  });
});

describe('detectAutonomousSentinel', () => {
  it('recognizes the autonomous sentinels exactly (after trim)', () => {
    expect(detectAutonomousSentinel(AUTONOMOUS_SENTINEL_CRON)).toBe('cron');
    expect(detectAutonomousSentinel(AUTONOMOUS_SENTINEL_DYNAMIC)).toBe(
      'dynamic',
    );
    expect(detectAutonomousSentinel(`  ${AUTONOMOUS_SENTINEL_DYNAMIC}\n`)).toBe(
      'dynamic',
    );
  });

  it('returns null for non-autonomous prompts (incl. loop.md sentinels)', () => {
    expect(detectAutonomousSentinel(LOOP_SENTINEL_DYNAMIC)).toBeNull();
    expect(detectAutonomousSentinel('<<autonomous-loop>> and more')).toBeNull();
    expect(detectAutonomousSentinel('')).toBeNull();
  });
});
