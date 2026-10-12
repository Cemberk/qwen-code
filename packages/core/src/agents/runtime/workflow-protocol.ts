/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Wire format between a workflow run and the host process that executes its
 * script in QuickJS: length-prefixed UTF-8 JSON frames over stdin/stdout.
 * Only data crosses — never a function or an object reference — so nothing
 * the script builds can be handed to, or invoked by, the parent process.
 */

/** Filename QuickJS attributes the compiled workflow body to. */
export const WORKFLOW_SCRIPT_FILENAME = 'workflow.js';

/**
 * Wrap a stripped script body in the async IIFE the guest actually executes.
 *
 * `'use strict'` shares its line with the arrow deliberately. The wrapper
 * already shifts every body line number by one, and putting the directive on
 * its own line would shift them by two — so the directive costs nothing in
 * error legibility. Strict mode matters here because the body is
 * model-authored: in sloppy mode an undeclared assignment silently creates a
 * property on the global instead of throwing, which turns a typo into state
 * that outlives the statement that made it.
 */
export function wrapWorkflowBody(strippedSource: string): string {
  return `(async () => {'use strict';\n${strippedSource}\n})()`;
}

/** Largest frame either side writes or accepts. */
export const WORKFLOW_MAX_FRAME_BYTES = 64 * 1024 * 1024;

export interface WorkflowStartMessage {
  type: 'start';
  /** The compilable script body (meta masked, line terminators normalized). */
  source: string;
  /** JSON text of the `args` global, or null for `undefined`. */
  args: string | null;
  /** Whether a `workflow()` implementation is wired (top level only). */
  workflow: boolean;
  /** `budget.total`, plus the live snapshot; null when no budget is wired. */
  budget: WorkflowBudgetSnapshot | null;
  maxLogLines: number;
  syncTimeoutMs: number;
}

export interface WorkflowBudgetSnapshot {
  total: number | null;
  spent: number;
  /** `null` stands for Infinity, which JSON cannot carry. */
  remaining: number | null;
}

export interface WorkflowSettleMessage {
  type: 'settle';
  id: number;
  ok: boolean;
  /** JSON value of a fulfilled request; absent for `undefined`. */
  value?: unknown;
  error?: WorkflowErrorData;
  budget?: WorkflowBudgetSnapshot;
}

export interface WorkflowErrorData {
  message: string;
  name?: string;
  /** Run-level failure (budget, agent cap, policy): rejects a whole batch. */
  runFailure?: boolean;
  /** Teardown of a cancelled or timed-out run. */
  abort?: boolean;
}

export type WorkflowParentMessage =
  | WorkflowStartMessage
  | WorkflowSettleMessage
  | { type: 'abort' }
  | { type: 'flush' };

export function encodeWorkflowFrame(body: string): Buffer {
  const bytes = Buffer.from(body, 'utf8');
  if (bytes.byteLength > WORKFLOW_MAX_FRAME_BYTES) {
    throw new Error('Workflow host message exceeds the size limit.');
  }
  const frame = Buffer.allocUnsafe(bytes.byteLength + 4);
  frame.writeUInt32BE(bytes.byteLength, 0);
  bytes.copy(frame, 4);
  return frame;
}

/** Splits a byte stream into frame bodies. Bytes are copied only once a whole frame is buffered. */
export class WorkflowFrameDecoder {
  private buffer = Buffer.alloc(0);
  private queued: Buffer[] = [];
  private queuedBytes = 0;
  private needed = 4;

  push(chunk: Buffer): string[] {
    this.queued.push(chunk);
    this.queuedBytes += chunk.byteLength;
    const bodies: string[] = [];
    while (this.buffer.byteLength + this.queuedBytes >= this.needed) {
      if (this.queued.length > 0) {
        this.buffer = Buffer.concat([this.buffer, ...this.queued]);
        this.queued = [];
        this.queuedBytes = 0;
      }
      const length = this.buffer.readUInt32BE(0);
      if (length > WORKFLOW_MAX_FRAME_BYTES) {
        throw new Error('Workflow host message exceeds the size limit.');
      }
      if (this.buffer.byteLength < length + 4) {
        this.needed = length + 4;
        break;
      }
      bodies.push(this.buffer.toString('utf8', 4, length + 4));
      this.buffer = this.buffer.subarray(length + 4);
      this.needed = 4;
    }
    return bodies;
  }
}
