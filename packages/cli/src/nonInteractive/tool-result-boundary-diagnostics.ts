/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  observeToolResultBoundary,
  type ToolResultBoundaryArtifact,
  type ToolResultBoundaryValue,
} from '@qwen-code/qwen-code-core';
import type { CLIMessage, ToolResultBlock } from './types.js';

interface ProjectedToolResult {
  mutated: boolean;
  artifact: ToolResultBoundaryArtifact;
  sessionId: string;
}

const projectedHeadlessMessages = new WeakMap<object, ProjectedToolResult>();

export function observeHeadlessToolResultProjection(
  message: CLIMessage,
  inputContent: string,
  outputContent: string,
  toolCallId: string,
  artifact: ToolResultBoundaryArtifact,
): void {
  try {
    const mutated = inputContent !== outputContent;
    const inputEligible = observeToolResultBoundary({
      stage: 'headless_projection_input',
      sessionId: message.session_id,
      toolCallId,
      mutated,
      artifacts: [artifact],
      values: [{ representation: 'headless_content', value: inputContent }],
    });
    const outputEligible = observeToolResultBoundary({
      stage: 'headless_projection_output',
      sessionId: message.session_id,
      toolCallId,
      mutated,
      artifacts: [artifact],
      values: [{ representation: 'headless_content', value: outputContent }],
    });
    if (inputEligible || outputEligible) {
      projectedHeadlessMessages.set(message, {
        mutated,
        artifact,
        sessionId: message.session_id,
      });
    }
  } catch {
    // Diagnostics must not affect projection or delivery.
  }
}

export function observeHeadlessToolResultWire(
  message: CLIMessage,
  frame: string,
): void {
  try {
    if (!projectedHeadlessMessages.has(message)) return;
    const projection = projectedHeadlessMessages.get(message)!;
    const toolResults = headlessToolResults(message);
    const values = toolResults.flatMap(toolResultValues);
    observeToolResultBoundary({
      stage: 'headless_wire',
      sessionId: message.session_id,
      toolCallId:
        toolResults.length === 1 &&
        typeof toolResults[0].tool_use_id === 'string'
          ? toolResults[0].tool_use_id
          : undefined,
      ...(toolResults.length > 1
        ? {
            toolCallIds: toolResults.map(
              (toolResult) => toolResult.tool_use_id,
            ),
          }
        : {}),
      wireUtf8Bytes: Buffer.byteLength(frame, 'utf8'),
      mutated: projection.mutated,
      artifacts: [projection.artifact],
      values,
    });
    projectedHeadlessMessages.delete(message);
  } catch {
    // Diagnostics must not affect the writer.
  }
}

export function observeHeadlessJsonToolResultWire(
  messages: readonly CLIMessage[],
  frame: string,
): void {
  try {
    const observedMessages = messages.filter((message) =>
      projectedHeadlessMessages.has(message),
    );
    if (observedMessages.length === 0) return;
    const toolResults = observedMessages.flatMap(headlessToolResults);
    const values = toolResults.flatMap(toolResultValues);
    observeToolResultBoundary({
      stage: 'headless_wire',
      sessionId:
        new Set(observedMessages.map((message) => message.session_id)).size ===
        1
          ? observedMessages[0].session_id
          : undefined,
      toolCallId:
        toolResults.length === 1 ? toolResults[0].tool_use_id : undefined,
      ...(toolResults.length > 1
        ? {
            toolCallIds: toolResults.map(
              (toolResult) => toolResult.tool_use_id,
            ),
          }
        : {}),
      wireUtf8Bytes: Buffer.byteLength(frame, 'utf8'),
      mutated: observedMessages.some(
        (message) => projectedHeadlessMessages.get(message)?.mutated === true,
      ),
      artifacts: observedMessages.map(
        (message) => projectedHeadlessMessages.get(message)!.artifact,
      ),
      values,
    });
    for (const message of observedMessages) {
      projectedHeadlessMessages.delete(message);
    }
  } catch {
    // Diagnostics must not affect the writer.
  }
}

function headlessToolResults(message: CLIMessage): ToolResultBlock[] {
  if (message.type !== 'user' || !Array.isArray(message.message.content)) {
    return [];
  }
  return message.message.content.flatMap((block) =>
    block.type === 'tool_result' ? [block] : [],
  );
}

function toolResultValues(
  toolResult: ToolResultBlock,
): ToolResultBoundaryValue[] {
  return typeof toolResult.content === 'string'
    ? [{ representation: 'headless_content', value: toolResult.content }]
    : [];
}
