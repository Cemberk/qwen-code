/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import type { Config } from '@qwen-code/qwen-code-core';
import type {
  SessionUpdate,
  ToolCallLocation,
  ToolKind,
} from '@agentclientprotocol/sdk';

/**
 * Receives the session updates produced by history replay.
 * Implemented by the `/export` collector (ui/utils/export/collect.ts).
 */
export interface SessionUpdateSender {
  sendUpdate(update: SessionUpdate): Promise<void>;
}

export interface SessionEmitterContext extends SessionUpdateSender {
  readonly sessionId: string;
  /** History replay hook used to correlate emitted updates with disk records. */
  setActiveRecordId?: (id: string | null, timestamp?: string) => void;
}

/**
 * Session context that can resolve tool metadata from the runtime registry.
 */
export interface SessionContext extends SessionEmitterContext {
  readonly config: Config;
}

export function hasFullSessionContext(
  context: SessionEmitterContext,
): context is SessionContext {
  return 'config' in context;
}

/**
 * Resolved tool metadata from the registry.
 */
export interface ResolvedToolMetadata {
  title: string;
  locations: ToolCallLocation[];
  kind: ToolKind;
}
