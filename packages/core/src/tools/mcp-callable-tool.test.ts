/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it, vi } from 'vitest';
import type { Client } from '@modelcontextprotocol/client';
import { mcpToTool } from './mcp-callable-tool.js';

function fakeClient(pages: Array<{ tools: unknown[]; nextCursor?: string }>) {
  const listTools = vi.fn(async ({ cursor }: { cursor?: string } = {}) => {
    const index = cursor ? Number(cursor) : 0;
    return pages[index];
  });
  return {
    client: { listTools } as unknown as Client,
    listTools,
  };
}

describe('mcpToTool', () => {
  it('lists every page and converts tools to function declarations', async () => {
    const { client, listTools } = fakeClient([
      {
        tools: [
          {
            name: 'a',
            description: 'A',
            inputSchema: { type: 'object' },
            outputSchema: { type: 'object', properties: {} },
          },
        ],
        nextCursor: '1',
      },
      { tools: [{ name: 'b', inputSchema: { type: 'object' } }] },
    ]);

    await expect(mcpToTool(client).tool()).resolves.toEqual({
      functionDeclarations: [
        {
          name: 'a',
          description: 'A',
          parametersJsonSchema: { type: 'object' },
          responseJsonSchema: { type: 'object', properties: {} },
        },
        {
          name: 'b',
          description: undefined,
          parametersJsonSchema: { type: 'object' },
        },
      ],
    });
    expect(listTools).toHaveBeenNthCalledWith(1, { cursor: undefined });
    expect(listTools).toHaveBeenNthCalledWith(2, { cursor: '1' });
  });

  it('rejects duplicate tool names', async () => {
    const { client } = fakeClient([
      {
        tools: [
          { name: 'a', inputSchema: {} },
          { name: 'a', inputSchema: {} },
        ],
      },
    ]);

    await expect(mcpToTool(client).tool()).rejects.toThrow(
      'Duplicate function name a found in MCP tools',
    );
  });
});
