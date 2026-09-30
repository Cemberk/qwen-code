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
  const callTool = vi.fn(async () => ({
    content: [{ type: 'text', text: 'ok' }],
  }));
  return {
    client: { listTools, callTool } as unknown as Client,
    listTools,
    callTool,
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

  it('calls only listed tools and wraps their results', async () => {
    const { client, callTool } = fakeClient([
      { tools: [{ name: 'a', inputSchema: {} }] },
    ]);

    const parts = await mcpToTool(client, { timeout: 5 }).callTool([
      { name: 'a', args: { x: 1 } },
      { name: 'unknown', args: {} },
    ]);

    expect(callTool).toHaveBeenCalledOnce();
    expect(callTool).toHaveBeenCalledWith(
      { name: 'a', arguments: { x: 1 } },
      { timeout: 5 },
    );
    expect(parts).toEqual([
      {
        functionResponse: {
          name: 'a',
          response: { content: [{ type: 'text', text: 'ok' }] },
        },
      },
    ]);
  });
});
