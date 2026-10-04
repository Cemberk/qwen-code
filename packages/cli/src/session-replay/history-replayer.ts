/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import type { ChatRecord } from '@qwen-code/qwen-code-core';
import {
  createTranscriptReplayMachine,
  type TranscriptReplayPresentationAdapter,
} from './transcript-replay.js';
import type { SessionEmitterContext } from './types.js';
import {
  buildToolResultContentPrefix,
  ToolCallEmitter,
} from './emitters/tool-call-emitter.js';
import { writeStderrLineSafe } from '../utils/stdioHelpers.js';

/**
 * Replays a saved session's records as session updates (used by `/export`).
 *
 * Uses the unified emitters to ensure consistency with normal flow.
 * This ensures that replayed history looks identical to how it would
 * have appeared during the original session.
 */
export class HistoryReplayer {
  private readonly toolCallEmitter: ToolCallEmitter;

  constructor(private readonly ctx: SessionEmitterContext) {
    this.toolCallEmitter = new ToolCallEmitter(ctx);
  }

  async replay(records: ChatRecord[]): Promise<void> {
    const machine = createTranscriptReplayMachine({
      presentation: this.presentationAdapter(),
      onDiagnostic: (diagnostic) => {
        if (
          diagnostic.code === 'malformed_part' &&
          diagnostic.path ===
            'systemPayload.outputHistoryItems.goalStatus.condition'
        ) {
          writeStderrLineSafe(`qwen: ${diagnostic.message}`);
        }
      },
    });
    let replayError: unknown;
    try {
      for (const record of records) {
        for (const emission of machine.project(record)) {
          this.setActiveRecordId(
            emission.sourceRecordId,
            emission.sourceTimestamp,
          );
          await this.ctx.sendUpdate(emission.update);
        }
      }
    } catch (error) {
      replayError = error;
    }

    let danglingError: unknown;
    for (const emission of machine.finalize()) {
      this.setActiveRecordId(emission.sourceRecordId, emission.sourceTimestamp);
      try {
        await this.ctx.sendUpdate(emission.update);
      } catch (error) {
        danglingError ??= error;
      }
    }
    this.setActiveRecordId(null);

    if (replayError && danglingError) {
      throw new AggregateError(
        [replayError, danglingError],
        'Replay and dangling-cleanup both failed',
      );
    }
    if (replayError) throw replayError;
    if (danglingError) throw danglingError;
  }

  private presentationAdapter(): TranscriptReplayPresentationAdapter {
    return {
      resolveToolMetadata: (toolName, args) =>
        this.toolCallEmitter.resolveToolMetadata(toolName, { ...args }),
      buildToolResultContentPrefix,
    };
  }

  private setActiveRecordId(recordId: string | null, timestamp?: string): void {
    this.ctx.setActiveRecordId?.(recordId, timestamp);
  }
}
