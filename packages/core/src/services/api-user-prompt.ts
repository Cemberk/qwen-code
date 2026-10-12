/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { Content } from '@google/genai';
import { isSystemReminderContent } from '../core/environmentContext.js';
import { isClearedMediaPlaceholder } from './microcompaction/microcompact.js';

/**
 * Options for {@link isApiUserPrompt}.
 *
 * Rewind works by counting user prompts in the model history and cutting at
 * the n-th one.
 */
export interface ApiUserPromptOptions {
  /**
   * Exclude entries whose only text is a microcompaction media-clear
   * placeholder (`[Old inline media cleared: …]`).
   *
   * TUI rewind sets this: `/compress-fast` rewrites a media-only user entry's
   * inlineData parts into text placeholders, and a media-only entry never
   * produced a visible TUI user turn, so counting it desynchronizes the API
   * prompt count from the UI turn count and truncates one turn early.
   *
   * Matching is on the FULL generated placeholder shape, so a genuine prompt
   * that merely begins with the prefix keeps counting. A prompt whose entire
   * text equals a generated placeholder is indistinguishable from a cleared
   * entry once serialized, and this classifier drops it — a known, still-open
   * limitation, pinned as a loud rewind block by `historyMapping.test.ts`.
   * Disambiguating it durably needs a structural sentinel on cleared parts;
   * the prompt-identity anchoring tracked in #9437 is the intended fix.
   */
  excludeClearedMediaPlaceholders?: boolean;
}

/**
 * The single classifier for "this API history entry is a user prompt", shared
 * by every rewind surface.
 *
 * A user prompt is a `user` entry that is neither a tool result
 * (`functionResponse`) nor a structural `<system-reminder>` entry. A genuine
 * user turn that merely has a per-turn reminder prepended still has a
 * non-reminder prompt part, so it is NOT excluded.
 */
export function isApiUserPrompt(
  content: Content,
  options?: ApiUserPromptOptions,
): boolean {
  if (content.role !== 'user') return false;
  if (!content.parts || content.parts.length === 0) return false;

  if (content.parts.some((part) => 'functionResponse' in part)) return false;

  // Structural, not real user prompts: the startup prelude and the
  // mid-history MCP added-tool reminders. Counting them would shift the
  // truncation index and silently drop a real turn's context.
  if (isSystemReminderContent(content)) return false;

  return content.parts.some((part) => {
    if (!('text' in part) || !part.text) return false;
    return !(
      options?.excludeClearedMediaPlaceholders &&
      isClearedMediaPlaceholder(part.text)
    );
  });
}
