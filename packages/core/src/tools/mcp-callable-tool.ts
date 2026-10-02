/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { Client } from '@modelcontextprotocol/client';
import type { CallableTool, Tool } from '@google/genai';

type McpToolClient = Pick<Client, 'listTools'>;
type McpListedTool = Awaited<ReturnType<Client['listTools']>>['tools'][number];

const MAX_LISTED_TOOLS = 100;

// Adapted from @google/genai 2.6.0's `mcpToTool` / `McpCallableTool`
// (Copyright 2025 Google LLC, Apache-2.0) so the SDK stays type-only.
export function mcpToTool(client: McpToolClient): Pick<CallableTool, 'tool'> {
  let tools: McpListedTool[] = [];

  const initialize = async (): Promise<void> => {
    if (tools.length > 0) return;
    const listed: McpListedTool[] = [];
    const names = new Set<string>();
    let cursor: string | undefined;
    while (listed.length < MAX_LISTED_TOOLS) {
      const page = await client.listTools({ cursor });
      for (const tool of page.tools) {
        if (names.has(tool.name)) {
          throw new Error(
            `Duplicate function name ${tool.name} found in MCP tools. Please ensure function names are unique.`,
          );
        }
        names.add(tool.name);
        listed.push(tool);
      }
      if (!page.nextCursor) break;
      cursor = page.nextCursor;
    }
    tools = listed;
  };

  return {
    async tool(): Promise<Tool> {
      await initialize();
      return {
        functionDeclarations: tools.map((tool) => ({
          name: tool.name,
          description: tool.description,
          parametersJsonSchema: tool.inputSchema,
          ...(tool.outputSchema
            ? { responseJsonSchema: tool.outputSchema }
            : {}),
        })),
      };
    },
  };
}
