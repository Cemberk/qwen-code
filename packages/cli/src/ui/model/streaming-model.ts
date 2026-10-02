/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Framework-neutral agent-loop stream events and render-ready history items
 * shared by renderer bindings.
 *
 * This module must not import react / solid / ink / @opentui — the rule is
 * enforced by `scripts/check-tui-dep-direction.mjs` (wired into CI via
 * `npm run check:tui-dep-direction`).
 */

export type StreamEvent =
  | {
      type: 'user';
      text: string;
      /** Stable turn key (`sessionId########promptCount`) — file checkpoints
       * are keyed by it, so /rewind needs it on the user item. */
      promptId?: string;
      /** False when the echoed command was handled locally (never sent). */
      sentToModel?: boolean;
    }
  | { type: 'thinking'; delta: string }
  | { type: 'thinking-end' }
  | { type: 'text'; delta: string }
  | { type: 'tool-start'; id: string; tool: string; title: string }
  /** The whole output so far, not an increment — a tool card replaces its
   * output per event, unlike the incremental `text`/`thinking` above. */
  | { type: 'tool-output'; id: string; output: string }
  | { type: 'tool-end'; id: string; success: boolean; summary: string }
  | { type: 'task-start'; id: string; name: string; description: string }
  | { type: 'task-progress'; id: string; line: string }
  | { type: 'task-end'; id: string }
  | { type: 'done' };

export type HistoryItem =
  | {
      kind: 'user';
      id: string;
      text: string;
      promptId?: string;
      sentToModel?: boolean;
    }
  | { kind: 'thinking'; id: string; text: string; done: boolean }
  | { kind: 'assistant'; id: string; text: string; streaming: boolean }
  | {
      kind: 'tool';
      id: string;
      tool: string;
      title: string;
      output: string;
      done: boolean;
      success?: boolean;
      summary?: string;
    }
  | {
      kind: 'task';
      id: string;
      name: string;
      description: string;
      progress: string[];
    };
