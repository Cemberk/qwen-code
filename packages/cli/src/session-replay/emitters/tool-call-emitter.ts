/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import type { SessionEmitterContext, ResolvedToolMetadata } from '../types.js';
import { hasFullSessionContext } from '../types.js';
import type {
  ToolCallContent,
  ToolCallLocation,
  ToolKind,
} from '@agentclientprotocol/sdk';
import {
  formatVisionBridgeNoticeDisplay,
  isVisionBridgeNoticeDisplay,
  ToolNames,
  Kind,
} from '@qwen-code/qwen-code-core';
import { sanitizeTerminalText } from '../../ui/utils/textUtils.js';

const KIND_MAP: Record<Kind, ToolKind> = {
  [Kind.Read]: 'read',
  [Kind.Edit]: 'edit',
  [Kind.Delete]: 'delete',
  [Kind.Move]: 'move',
  [Kind.Search]: 'search',
  [Kind.Execute]: 'execute',
  [Kind.Think]: 'think',
  [Kind.Fetch]: 'fetch',
  // ACP defines no 'agent' ToolKind (verified through @agentclientprotocol/sdk
  // 0.25.1), so the internal Kind.Agent maps to 'other' to stay protocol-valid.
  [Kind.Agent]: 'other',
  [Kind.Other]: 'other',
};

/**
 * Resolves the title, locations and ACP kind of a replayed tool call for
 * HistoryReplayer (used by `/export`).
 */
export class ToolCallEmitter {
  constructor(private readonly ctx: SessionEmitterContext) {}

  /**
   * Checks if a tool name is the ExitPlanModeTool.
   */
  isExitPlanModeTool(toolName: string): boolean {
    return toolName === ToolNames.EXIT_PLAN_MODE;
  }

  /**
   * Checks if a tool name is the EnterPlanModeTool.
   */
  isEnterPlanModeTool(toolName: string): boolean {
    return toolName === ToolNames.ENTER_PLAN_MODE;
  }

  /**
   * Resolves tool metadata from the registry.
   * Falls back to defaults if tool not found or build fails.
   *
   * @param toolName - Name of the tool
   * @param args - Tool call arguments (used to build invocation)
   */
  resolveToolMetadata(
    toolName: string,
    args?: Record<string, unknown>,
  ): ResolvedToolMetadata {
    if (!hasFullSessionContext(this.ctx)) {
      const description =
        typeof args?.['description'] === 'string'
          ? args['description'].trim()
          : '';
      return {
        title: description ? `${toolName}: ${description}` : toolName,
        locations: [],
        kind: 'other',
      };
    }
    const toolRegistry = this.ctx.config.getToolRegistry();
    const tool = toolRegistry.getTool(toolName);

    let title = tool?.displayName ?? toolName;
    let locations: ToolCallLocation[] = [];
    let kind: ToolKind = 'other';

    if (tool && args) {
      try {
        const invocation = tool.build(args);
        title = `${title}: ${invocation.getDescription()}`;
        // Map locations to ensure line is null instead of undefined (for ACP consistency)
        locations = invocation.toolLocations().map((loc) => ({
          path: loc.path,
          line: loc.line ?? null,
        }));
        // Pass tool name to handle special cases like exit_plan_mode -> switch_mode
        kind = this.mapToolKind(tool.kind, toolName);
      } catch {
        // Fallback: use the description arg directly if available
        if (typeof args['description'] === 'string') {
          title = `${title}: ${args['description']}`;
        }
        if (tool.kind) {
          kind = this.mapToolKind(tool.kind, toolName);
        }
      }
    }

    return { title, locations, kind };
  }

  /**
   * Maps core Tool Kind enum to ACP ToolKind string literals.
   *
   * @param kind - The core Kind enum value
   * @param toolName - Optional tool name to handle special cases like exit_plan_mode
   */
  mapToolKind(kind: Kind, toolName?: string): ToolKind {
    // Special case: enter/exit_plan_mode use 'switch_mode' kind per ACP spec
    if (
      toolName &&
      (this.isExitPlanModeTool(toolName) || this.isEnterPlanModeTool(toolName))
    ) {
      return 'switch_mode';
    }
    return KIND_MAP[kind] ?? 'other';
  }
}

export function buildToolResultContentPrefix(
  resultDisplay: unknown,
): ToolCallContent[] {
  if (!isVisionBridgeNoticeDisplay(resultDisplay)) return [];
  return [
    {
      type: 'content',
      content: {
        type: 'text',
        text: sanitizeTerminalText(
          formatVisionBridgeNoticeDisplay(resultDisplay),
        ),
      },
    },
  ];
}
