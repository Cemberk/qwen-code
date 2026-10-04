/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import type { LoopMode } from './autonomous-loop.js';

export {
  AUTONOMOUS_SENTINEL_CRON,
  AUTONOMOUS_SENTINEL_DYNAMIC,
  AutonomousLoopTickResolver,
  detectAutonomousSentinel,
} from './autonomous-loop.js';
export type { LoopMode } from './autonomous-loop.js';

export const LOOP_SENTINEL_CRON = '<<loop.md>>';
export const LOOP_SENTINEL_DYNAMIC = '<<loop.md-dynamic>>';

/** Detect whether a scheduled prompt is a loop.md sentinel, and which mode. */
export function detectLoopSentinel(prompt: string): LoopMode | null {
  const trimmed = prompt.trim();
  if (trimmed === LOOP_SENTINEL_DYNAMIC) {
    return 'dynamic';
  }
  if (trimmed === LOOP_SENTINEL_CRON) {
    return 'cron';
  }
  return null;
}
