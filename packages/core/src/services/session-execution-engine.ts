/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

export type SessionExecutionEngine = 'legacy' | 'managed';
export const SESSION_EXECUTION_ENGINE_META_KEY = 'qwen.session.executionEngine';

export class SessionExecutionEngineError extends Error {
  readonly errorKind = 'session_execution_engine_unavailable';

  constructor(sessionId: string, reason: string) {
    super(`Session execution engine for ${sessionId}: ${reason}.`);
    this.name = 'SessionExecutionEngineError';
  }
}
