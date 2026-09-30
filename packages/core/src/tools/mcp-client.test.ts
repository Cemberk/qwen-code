/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import * as GenAiLib from '@google/genai';
import * as ClientLib from '@modelcontextprotocol/client';
import * as SdkClientStdioLib from '@modelcontextprotocol/client/stdio';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MCPServerConfig, type Config } from '../config/config.js';
import type { PromptRegistry } from '../prompts/prompt-registry.js';
import type { ResourceRegistry } from '../resources/resource-registry.js';
import type { WorkspaceContext } from '../utils/workspaceContext.js';
import {
  INVOCATION_CONTEXT_META_KEY,
  runWithInvocationContext,
  type InvocationContextV1,
} from '../utils/invocation-context.js';
import {
  addMCPStatusChangeListener,
  connectAndDiscover,
  createTransport,
  discoverPrompts,
  discoverResources,
  getAllMCPServerStatuses,
  getMCPServerLastError,
  getMCPServerStatus,
  isEnabled,
  listMcpPrompts,
  listMcpResources,
  MCPServerStatus,
  McpClient,
  discoverTools,
  populateMcpServerCommand,
  removeMCPServerStatus,
  removeMCPStatusChangeListener,
  updateMCPServerStatus,
} from './mcp-client.js';
import type { ToolRegistry } from './tool-registry.js';

const mockExistsSync = vi.hoisted(() => vi.fn(() => true));
const mockDebugLogger = vi.hoisted(() => ({
  debug: vi.fn(),
  error: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
}));
const ORIGINAL_ENV = process.env;
const TEST_MCP_TOOL_IDLE_TIMEOUT_MS = 300000;

vi.mock('node:fs', () => ({
  existsSync: mockExistsSync,
}));
vi.mock('@modelcontextprotocol/client/stdio');
vi.mock('@modelcontextprotocol/client', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('@modelcontextprotocol/client')>();
  return { ...actual, Client: vi.fn() };
});
vi.mock('@google/genai');
vi.mock('../utils/debugLogger.js', () => ({
  createDebugLogger: vi.fn(() => mockDebugLogger),
}));

/**
 * Minimal Config stub for the non-pool `discover()` path, which now reads
 * `cliConfig.getResourceRegistry()` to register discovered resources. The
 * returned registry just needs to accept `registerResource` without
 * throwing — these tests assert on the constructor-injected tool/prompt
 * registries, not the resource one.
 */
function cfgWithResources(): Config {
  return {
    getMcpToolIdleTimeoutMs: () => TEST_MCP_TOOL_IDLE_TIMEOUT_MS,
    getResourceRegistry: () => ({
      registerResource: vi.fn(),
      removeResourcesByServer: vi.fn(),
    }),
  } as unknown as Config;
}

function mockAppOnlyMcpServer(): void {
  const methodNotFound = Object.assign(new Error('Method not found'), {
    code: -32601,
  });
  vi.mocked(ClientLib.Client).mockReturnValue({
    connect: vi.fn(),
    registerCapabilities: vi.fn(),
    setRequestHandler: vi.fn(),
    getServerCapabilities: vi.fn().mockReturnValue({ tools: {} }),
    request: vi.fn().mockRejectedValue(methodNotFound),
    listTools: vi.fn().mockResolvedValue({
      tools: [
        {
          name: 'internal_refresh',
          _meta: { ui: { visibility: ['app'] } },
        },
      ],
    }),
    getInstructions: vi.fn(),
    close: vi.fn(),
  } as unknown as ClientLib.Client);
  vi.spyOn(SdkClientStdioLib, 'StdioClientTransport').mockReturnValue(
    {} as SdkClientStdioLib.StdioClientTransport,
  );
  vi.mocked(GenAiLib.mcpToTool).mockReturnValue({
    tool: () =>
      Promise.resolve({
        functionDeclarations: [{ name: 'internal_refresh' }],
      }),
  } as unknown as GenAiLib.CallableTool);
}

describe('mcp-client', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    process.env = ORIGINAL_ENV;
  });

  describe('McpClient', () => {
    it.each([
      {
        description: 'an unrelated transport error',
        error: () => new Error('ECONNRESET'),
      },
    ])('still disconnects for $description', async ({ error }) => {
      const mockedClient = {
        connect: vi.fn(),
        registerCapabilities: vi.fn(),
        setRequestHandler: vi.fn(),
        getInstructions: vi.fn(),
        onerror: undefined as ((error: Error) => void) | undefined,
      };
      vi.mocked(ClientLib.Client).mockReturnValue(
        mockedClient as unknown as ClientLib.Client,
      );
      vi.spyOn(SdkClientStdioLib, 'StdioClientTransport').mockReturnValue(
        {} as SdkClientStdioLib.StdioClientTransport,
      );

      const serverName = 'unrelated-transport-error-server';
      const client = new McpClient(
        serverName,
        { command: 'test-command' },
        {} as ToolRegistry,
        {} as PromptRegistry,
        {
          getDirectories: vi.fn().mockReturnValue([]),
        } as unknown as WorkspaceContext,
        false,
      );
      await client.connect();

      mockedClient.onerror?.(error());

      expect(client.getStatus()).toBe(MCPServerStatus.DISCONNECTED);
      expect(getMCPServerStatus(serverName)).toBe(MCPServerStatus.DISCONNECTED);
      removeMCPServerStatus(serverName);
    });

    it('should discover tools', async () => {
      const mockedClient = {
        connect: vi.fn(),
        discover: vi.fn(),
        disconnect: vi.fn(),
        getStatus: vi.fn(),
        registerCapabilities: vi.fn(),
        setRequestHandler: vi.fn(),
        getInstructions: vi.fn(),
      };
      vi.mocked(ClientLib.Client).mockReturnValue(
        mockedClient as unknown as ClientLib.Client,
      );
      vi.spyOn(SdkClientStdioLib, 'StdioClientTransport').mockReturnValue(
        {} as SdkClientStdioLib.StdioClientTransport,
      );
      const mockedMcpToTool = vi.mocked(GenAiLib.mcpToTool).mockReturnValue({
        tool: () => ({
          functionDeclarations: [
            {
              name: 'testFunction',
            },
          ],
        }),
      } as unknown as GenAiLib.CallableTool);
      const mockedToolRegistry = {
        registerTool: vi.fn(),
      } as unknown as ToolRegistry;
      const client = new McpClient(
        'test-server',
        {
          command: 'test-command',
        },
        mockedToolRegistry,
        {} as PromptRegistry,
        {} as WorkspaceContext,
        false,
      );
      await client.connect();
      await client.discover(cfgWithResources());
      expect(mockedMcpToTool).toHaveBeenCalledOnce();
    });

    it('stores server instructions returned during initialization', async () => {
      const mockedClient = {
        connect: vi.fn(),
        registerCapabilities: vi.fn(),
        setRequestHandler: vi.fn(),
        getInstructions: vi.fn().mockReturnValue('Use concise replies.'),
      };
      vi.mocked(ClientLib.Client).mockReturnValue(
        mockedClient as unknown as ClientLib.Client,
      );
      vi.spyOn(SdkClientStdioLib, 'StdioClientTransport').mockReturnValue(
        {} as SdkClientStdioLib.StdioClientTransport,
      );

      const client = new McpClient(
        'test-server',
        {
          command: 'test-command',
        },
        { registerTool: vi.fn() } as unknown as ToolRegistry,
        {} as PromptRegistry,
        {
          getDirectories: vi.fn().mockReturnValue([]),
        } as unknown as WorkspaceContext,
        false,
      );

      await client.connect();

      expect(client.getInstructions()).toBe('Use concise replies.');
    });

    it('readResource does not gate on the resources capability (lenient read)', async () => {
      // Regression guard for the discover/read parity bug: a server that
      // answers resources/read but under-declares the `resources` capability
      // must still be readable (matching the lenient `listMcpResources`).
      const mockedClient = {
        connect: vi.fn(),
        registerCapabilities: vi.fn(),
        setRequestHandler: vi.fn(),
        getServerCapabilities: vi.fn().mockReturnValue({}), // not declared
        request: vi.fn().mockResolvedValue({
          contents: [{ uri: 'res://doc', text: 'BODY' }],
        }),
        getInstructions: vi.fn(),
      };
      vi.mocked(ClientLib.Client).mockReturnValue(
        mockedClient as unknown as ClientLib.Client,
      );
      vi.spyOn(SdkClientStdioLib, 'StdioClientTransport').mockReturnValue(
        {} as SdkClientStdioLib.StdioClientTransport,
      );
      const client = new McpClient(
        'srv',
        { command: 'test-command' },
        {} as ToolRegistry,
        {} as PromptRegistry,
        {} as WorkspaceContext,
        false,
      );
      await client.connect();

      const result = await client.readResource('res://doc');
      expect(mockedClient.request).toHaveBeenCalledWith(
        { method: 'resources/read', params: { uri: 'res://doc' } },
        expect.anything(),
        undefined,
      );
      expect((result.contents[0] as { text: string }).text).toBe('BODY');
    });

    it('readResource uses the cache-aware helper for modern sessions', async () => {
      const mockedClient = {
        connect: vi.fn(),
        registerCapabilities: vi.fn(),
        setRequestHandler: vi.fn(),
        getProtocolEra: vi.fn().mockReturnValue('modern'),
        getServerCapabilities: vi.fn().mockReturnValue({ resources: {} }),
        readResource: vi.fn().mockResolvedValue({
          contents: [{ uri: 'res://doc', text: 'BODY' }],
        }),
        getInstructions: vi.fn(),
      };
      vi.mocked(ClientLib.Client).mockReturnValue(
        mockedClient as unknown as ClientLib.Client,
      );
      vi.spyOn(SdkClientStdioLib, 'StdioClientTransport').mockReturnValue(
        {} as SdkClientStdioLib.StdioClientTransport,
      );
      const client = new McpClient(
        'srv',
        { command: 'test-command' },
        {} as ToolRegistry,
        {} as PromptRegistry,
        {} as WorkspaceContext,
        false,
      );
      await client.connect();

      const result = await client.readResource('res://doc');
      expect(mockedClient.readResource).toHaveBeenCalledWith(
        { uri: 'res://doc' },
        undefined,
      );
      expect((result.contents[0] as { text: string }).text).toBe('BODY');
    });

    it('readResource falls back to a raw request when a modern server omits resources', async () => {
      const mockedClient = {
        connect: vi.fn(),
        registerCapabilities: vi.fn(),
        setRequestHandler: vi.fn(),
        getProtocolEra: vi.fn().mockReturnValue('modern'),
        getServerCapabilities: vi.fn().mockReturnValue({}),
        readResource: vi.fn().mockResolvedValue({
          contents: [{ uri: 'res://doc', text: 'TYPED' }],
        }),
        request: vi.fn().mockResolvedValue({
          contents: [{ uri: 'res://doc', text: 'BODY' }],
        }),
        getInstructions: vi.fn(),
      };
      vi.mocked(ClientLib.Client).mockReturnValue(
        mockedClient as unknown as ClientLib.Client,
      );
      vi.spyOn(SdkClientStdioLib, 'StdioClientTransport').mockReturnValue(
        {} as SdkClientStdioLib.StdioClientTransport,
      );
      const client = new McpClient(
        'srv',
        { command: 'test-command' },
        {} as ToolRegistry,
        {} as PromptRegistry,
        {} as WorkspaceContext,
        false,
      );
      await client.connect();

      const result = await client.readResource('res://doc');
      expect(mockedClient.readResource).not.toHaveBeenCalled();
      expect(mockedClient.request).toHaveBeenCalledWith(
        { method: 'resources/read', params: { uri: 'res://doc' } },
        expect.anything(),
        undefined,
      );
      expect((result.contents[0] as { text: string }).text).toBe('BODY');
    });

    it('should not skip tools even if a parameter is missing a type', async () => {
      const mockedClient = {
        connect: vi.fn(),
        discover: vi.fn(),
        disconnect: vi.fn(),
        getStatus: vi.fn(),
        registerCapabilities: vi.fn(),
        setRequestHandler: vi.fn(),
        tool: vi.fn(),
        getInstructions: vi.fn(),
      };
      vi.mocked(ClientLib.Client).mockReturnValue(
        mockedClient as unknown as ClientLib.Client,
      );
      vi.spyOn(SdkClientStdioLib, 'StdioClientTransport').mockReturnValue(
        {} as SdkClientStdioLib.StdioClientTransport,
      );
      vi.mocked(GenAiLib.mcpToTool).mockReturnValue({
        tool: () =>
          Promise.resolve({
            functionDeclarations: [
              {
                name: 'validTool',
                parametersJsonSchema: {
                  type: 'object',
                  properties: {
                    param1: { type: 'string' },
                  },
                },
              },
              {
                name: 'invalidTool',
                parametersJsonSchema: {
                  type: 'object',
                  properties: {
                    param1: { description: 'a param with no type' },
                  },
                },
              },
            ],
          }),
      } as unknown as GenAiLib.CallableTool);
      const mockedToolRegistry = {
        registerTool: vi.fn(),
      } as unknown as ToolRegistry;
      const client = new McpClient(
        'test-server',
        {
          command: 'test-command',
        },
        mockedToolRegistry,
        {} as PromptRegistry,
        {} as WorkspaceContext,
        false,
      );
      await client.connect();
      await client.discover(cfgWithResources());
      expect(mockedToolRegistry.registerTool).toHaveBeenCalledTimes(2);
    });

    it('should handle errors when discovering prompts', async () => {
      const mockedClient = {
        connect: vi.fn(),
        discover: vi.fn(),
        disconnect: vi.fn(),
        getStatus: vi.fn(),
        registerCapabilities: vi.fn(),
        setRequestHandler: vi.fn(),
        getServerCapabilities: vi.fn().mockReturnValue({ prompts: {} }),
        request: vi.fn().mockRejectedValue(new Error('Test error')),
        getInstructions: vi.fn(),
      };
      vi.mocked(ClientLib.Client).mockReturnValue(
        mockedClient as unknown as ClientLib.Client,
      );
      vi.spyOn(SdkClientStdioLib, 'StdioClientTransport').mockReturnValue(
        {} as SdkClientStdioLib.StdioClientTransport,
      );
      vi.mocked(GenAiLib.mcpToTool).mockReturnValue({
        tool: () => Promise.resolve({ functionDeclarations: [] }),
      } as unknown as GenAiLib.CallableTool);
      const client = new McpClient(
        'test-server',
        {
          command: 'test-command',
        },
        {} as ToolRegistry,
        {} as PromptRegistry,
        {} as WorkspaceContext,
        false,
      );
      await client.connect();
      await expect(client.discover(cfgWithResources())).rejects.toThrow(
        'No prompts, tools, or resources found on the server.',
      );
    });

    it('flips status to DISCONNECTED when discover() throws', async () => {
      // `Config.getFailedMcpServerNames()` filters by
      // `status !== CONNECTED`, so a server that connects successfully
      // but whose `discover()` then crashes (e.g. tools/list rejects, or
      // the "no prompts or tools found" guard fires) must be marked
      // DISCONNECTED before the error propagates. Without this, the
      // server stays CONNECTED in the global registry, the non-interactive
      // failure banner silently omits it, and the Footer's MCP health
      // pill keeps counting it as healthy.
      const mockedClient = {
        connect: vi.fn(),
        discover: vi.fn(),
        disconnect: vi.fn(),
        getStatus: vi.fn(),
        registerCapabilities: vi.fn(),
        setRequestHandler: vi.fn(),
        getServerCapabilities: vi.fn().mockReturnValue({ prompts: {} }),
        request: vi.fn().mockRejectedValue(new Error('tools/list crashed')),
        close: vi.fn(),
        getInstructions: vi.fn(),
      };
      vi.mocked(ClientLib.Client).mockReturnValue(
        mockedClient as unknown as ClientLib.Client,
      );
      vi.spyOn(SdkClientStdioLib, 'StdioClientTransport').mockReturnValue(
        {} as SdkClientStdioLib.StdioClientTransport,
      );
      vi.mocked(GenAiLib.mcpToTool).mockReturnValue({
        tool: () => Promise.resolve({ functionDeclarations: [] }),
      } as unknown as GenAiLib.CallableTool);
      const serverName = `discover-error-${Date.now()}`;
      const client = new McpClient(
        serverName,
        {
          command: 'test-command',
        },
        {} as ToolRegistry,
        {} as PromptRegistry,
        {} as WorkspaceContext,
        false,
      );
      await client.connect();
      // Sanity: connect succeeded so the status is CONNECTED before the
      // discover failure we're about to assert against.
      expect(client.getStatus()).toBe(MCPServerStatus.CONNECTED);

      await expect(client.discover(cfgWithResources())).rejects.toThrow();

      expect(client.getStatus()).toBe(MCPServerStatus.DISCONNECTED);
      expect(getMCPServerStatus(serverName)).toBe(MCPServerStatus.DISCONNECTED);
    });

    it('discoverAndReturn returns tools and prompts WITHOUT registering them', async () => {
      // F2 (#4175) pool path: a single shared McpClient produces this
      // snapshot once; per-session SessionMcpView instances each register
      // a filtered copy. The bare method must therefore NOT touch any
      // registry — otherwise sharing a snapshot across sessions would
      // double-register or cross-contaminate.
      const mockedClient = {
        connect: vi.fn(),
        registerCapabilities: vi.fn(),
        setRequestHandler: vi.fn(),
        getServerCapabilities: vi.fn().mockReturnValue({ prompts: {} }),
        request: vi.fn().mockResolvedValue({
          prompts: [{ name: 'pure-prompt', description: 'p' }],
        }),
        listTools: vi.fn().mockResolvedValue({ tools: [] }),
        getInstructions: vi.fn(),
      };
      vi.mocked(ClientLib.Client).mockReturnValue(
        mockedClient as unknown as ClientLib.Client,
      );
      vi.spyOn(SdkClientStdioLib, 'StdioClientTransport').mockReturnValue(
        {} as SdkClientStdioLib.StdioClientTransport,
      );
      vi.mocked(GenAiLib.mcpToTool).mockReturnValue({
        tool: () =>
          Promise.resolve({
            functionDeclarations: [{ name: 'pure-tool' }],
          }),
      } as unknown as GenAiLib.CallableTool);
      const toolRegistry = {
        registerTool: vi.fn(),
      } as unknown as ToolRegistry;
      const promptRegistry = {
        registerPrompt: vi.fn(),
      } as unknown as PromptRegistry;
      const client = new McpClient(
        'pure-server',
        { command: 'test-command' },
        toolRegistry,
        promptRegistry,
        {} as WorkspaceContext,
        false,
      );
      await client.connect();

      const snapshot = await client.discoverAndReturn(cfgWithResources());

      expect(snapshot.tools).toHaveLength(1);
      expect(snapshot.tools[0].serverToolName).toBe('pure-tool');
      expect(snapshot.prompts).toHaveLength(1);
      expect(snapshot.prompts[0].name).toBe('pure-prompt');
      expect(snapshot.prompts[0].serverName).toBe('pure-server');
      expect(typeof snapshot.prompts[0].invoke).toBe('function');
      // The critical assertion: registries untouched.
      expect(toolRegistry.registerTool).not.toHaveBeenCalled();
      expect(promptRegistry.registerPrompt).not.toHaveBeenCalled();
    });

    it('marks discovered tools alwaysLoad when the MCP server config requests it', async () => {
      const mockedClient = {
        listTools: vi.fn().mockResolvedValue({ tools: [] }),
      } as unknown as ClientLib.Client;
      vi.mocked(GenAiLib.mcpToTool).mockReturnValue({
        tool: () =>
          Promise.resolve({
            functionDeclarations: [{ name: 'chrome_tool' }],
          }),
      } as unknown as GenAiLib.CallableTool);

      const tools = await discoverTools(
        'chrome-devtools',
        {
          command: 'test-command',
          alwaysLoadTools: true,
        },
        mockedClient,
        cfgWithResources(),
      );

      expect(tools).toHaveLength(1);
      expect(tools[0].alwaysLoad).toBe(true);
    });

    it('preserves App-only tools for the separate App registry', async () => {
      const mockedClient = {
        listTools: vi.fn().mockResolvedValue({
          tools: [
            {
              name: 'show_dashboard',
              _meta: {
                ui: {
                  resourceUri: 'ui://demo/dash',
                  visibility: ['model'],
                },
              },
            },
            {
              name: 'internal_refresh',
              _meta: {
                ui: {
                  resourceUri: 'ui://demo/refresh',
                  visibility: ['app'],
                },
              },
            },
          ],
        }),
      } as unknown as ClientLib.Client;
      vi.mocked(GenAiLib.mcpToTool).mockReturnValue({
        tool: () =>
          Promise.resolve({
            functionDeclarations: [
              { name: 'show_dashboard' },
              { name: 'internal_refresh' },
            ],
          }),
      } as unknown as GenAiLib.CallableTool);

      const tools = await discoverTools(
        'apps',
        { command: 'test-command' },
        mockedClient,
        cfgWithResources(),
        { applyConfigFilters: false },
      );

      expect(tools.map((tool) => tool.serverToolName)).toEqual([
        'show_dashboard',
        'internal_refresh',
      ]);
      expect(tools[0].isAppVisible).toBe(false);
      expect(tools[1].isModelVisible).toBe(false);
      expect(tools[1].appVisibility).toEqual(['app']);
    });

    it.each(
      [[], ['unknown'], null, 'app', [42]].map((visibility) => ({
        visibility,
      })),
    )('rejects unsupported visibility $visibility', async ({ visibility }) => {
      const client = {
        listTools: vi.fn().mockResolvedValue({
          tools: [{ name: 'private', _meta: { ui: { visibility } } }],
        }),
      } as unknown as ClientLib.Client;
      vi.mocked(GenAiLib.mcpToTool).mockReturnValue({
        tool: async () => ({ functionDeclarations: [{ name: 'private' }] }),
      } as unknown as GenAiLib.CallableTool);
      expect(
        await discoverTools(
          'apps',
          { command: 'test' },
          client,
          cfgWithResources(),
        ),
      ).toEqual([]);
    });

    it('attaches listing-level app resource UI onto discovered tools', async () => {
      const mockedClient = {
        connect: vi.fn(),
        registerCapabilities: vi.fn(),
        setRequestHandler: vi.fn(),
        getProtocolEra: vi.fn().mockReturnValue('modern'),
        getServerCapabilities: vi.fn().mockReturnValue({
          tools: {},
          resources: {},
        }),
        listTools: vi.fn().mockResolvedValue({
          tools: [
            {
              name: 'show_dashboard',
              _meta: { ui: { resourceUri: 'ui://demo/dash' } },
            },
          ],
        }),
        listResources: vi.fn().mockResolvedValue({
          resources: [
            {
              uri: 'ui://demo/dash',
              name: 'dash',
              _meta: {
                ui: {
                  csp: { connectDomains: ['https://api.example.com'] },
                  permissions: { clipboardWrite: {} },
                },
              },
            },
          ],
        }),
        listPrompts: vi.fn().mockResolvedValue({ prompts: [] }),
        request: vi.fn().mockResolvedValue({ prompts: [] }),
        getInstructions: vi.fn(),
      };
      vi.mocked(ClientLib.Client).mockReturnValue(
        mockedClient as unknown as ClientLib.Client,
      );
      vi.spyOn(SdkClientStdioLib, 'StdioClientTransport').mockReturnValue(
        {} as SdkClientStdioLib.StdioClientTransport,
      );
      vi.mocked(GenAiLib.mcpToTool).mockReturnValue({
        tool: () =>
          Promise.resolve({
            functionDeclarations: [{ name: 'show_dashboard' }],
          }),
      } as unknown as GenAiLib.CallableTool);

      const client = new McpClient(
        'apps',
        {
          command: 'test-command',
          appResourceMaxBytes: 2_097_152,
          appResourceTimeoutMs: 30_000,
        },
        { registerTool: vi.fn() } as unknown as ToolRegistry,
        { registerPrompt: vi.fn() } as unknown as PromptRegistry,
        {} as WorkspaceContext,
        false,
      );
      await client.connect();
      const snapshot = await client.discoverAndReturn(cfgWithResources(), {
        applyConfigFilters: false,
      });

      expect(snapshot.tools[0]?.appResourceLimits).toEqual({
        appResourceMaxBytes: 2_097_152,
        appResourceTimeoutMs: 30_000,
      });
      expect(snapshot.tools[0]?.appResourceUri).toBe('ui://demo/dash');
      expect(snapshot.tools[0]?.appResourceUi).toEqual({
        csp: { connectDomains: ['https://api.example.com'] },
        permissions: { clipboardWrite: {} },
      });
    });

    it('lists tools via request when a modern server omits the tools capability', async () => {
      const mockedClient = {
        getProtocolEra: vi.fn().mockReturnValue('modern'),
        getServerCapabilities: vi.fn().mockReturnValue({}),
        listTools: vi.fn().mockResolvedValue({ tools: [] }),
        request: vi.fn().mockResolvedValue({
          tools: [{ name: 'echo' }],
        }),
      } as unknown as ClientLib.Client;
      vi.mocked(GenAiLib.mcpToTool).mockReturnValue({
        tool: () =>
          Promise.resolve({
            functionDeclarations: [{ name: 'echo' }],
          }),
      } as unknown as GenAiLib.CallableTool);

      const tools = await discoverTools(
        'under-declared',
        { command: 'test-command' },
        mockedClient,
        cfgWithResources(),
        { applyConfigFilters: false },
      );

      expect(vi.mocked(mockedClient.request)).toHaveBeenCalledWith(
        { method: 'tools/list', params: {} },
        expect.anything(),
      );
      expect(vi.mocked(mockedClient.listTools)).not.toHaveBeenCalled();
      expect(tools.map((tool) => tool.serverToolName)).toEqual(['echo']);
    });

    it('allows invocation context only for a client bound to a created stdio transport', async () => {
      const callTool = vi.fn().mockResolvedValue({
        content: [{ type: 'text', text: 'ok' }],
      });
      const mockedClient = {
        connect: vi.fn(),
        registerCapabilities: vi.fn(),
        setRequestHandler: vi.fn(),
        getServerCapabilities: vi.fn().mockReturnValue({}),
        listTools: vi.fn().mockResolvedValue({ tools: [] }),
        getInstructions: vi.fn(),
        callTool,
      };
      vi.mocked(ClientLib.Client).mockReturnValue(
        mockedClient as unknown as ClientLib.Client,
      );
      vi.spyOn(SdkClientStdioLib, 'StdioClientTransport').mockReturnValue(
        {} as SdkClientStdioLib.StdioClientTransport,
      );
      vi.mocked(GenAiLib.mcpToTool).mockReturnValue({
        tool: () =>
          Promise.resolve({
            functionDeclarations: [{ name: 'local-tool' }],
          }),
      } as unknown as GenAiLib.CallableTool);
      const client = new McpClient(
        'local-server',
        { command: 'test-command' },
        {} as ToolRegistry,
        {} as PromptRegistry,
        {} as WorkspaceContext,
        false,
      );
      await client.connect();
      const { tools } = await client.discoverAndReturn(cfgWithResources());
      const context: InvocationContextV1 = {
        version: 1,
        sessionId: 'session-1',
        promptId: 'prompt-1',
      };

      await runWithInvocationContext(context, () =>
        tools[0].build({ param: 'test' }).execute(new AbortController().signal),
      );

      expect(callTool.mock.calls[0][0]._meta).toEqual({
        [INVOCATION_CONTEXT_META_KEY]: context,
      });
    });

    it('does not trust a stdio-shaped config without an internally bound client', async () => {
      const callTool = vi.fn().mockResolvedValue({
        content: [{ type: 'text', text: 'ok' }],
      });
      const arbitraryClient = {
        listTools: vi.fn().mockResolvedValue({ tools: [] }),
        callTool,
      } as unknown as ClientLib.Client;
      vi.mocked(GenAiLib.mcpToTool).mockReturnValue({
        tool: () =>
          Promise.resolve({
            functionDeclarations: [{ name: 'unbound-tool' }],
          }),
      } as unknown as GenAiLib.CallableTool);
      const [unboundTool] = await discoverTools(
        'unbound-server',
        { command: 'looks-like-stdio' },
        arbitraryClient,
        cfgWithResources(),
      );
      const context: InvocationContextV1 = {
        version: 1,
        sessionId: 'session-1',
        promptId: 'prompt-1',
      };

      await runWithInvocationContext(context, () =>
        unboundTool
          .build({ param: 'test' })
          .execute(new AbortController().signal),
      );

      expect(Object.hasOwn(callTool.mock.calls[0][0], '_meta')).toBe(false);
    });

    it('discoverAndReturn with { applyConfigFilters: false } ignores config filters and trust for shared pool snapshots', async () => {
      const mockedClient = {
        connect: vi.fn(),
        registerCapabilities: vi.fn(),
        setRequestHandler: vi.fn(),
        getServerCapabilities: vi.fn().mockReturnValue({}),
        listTools: vi.fn().mockResolvedValue({ tools: [] }),
        getInstructions: vi.fn(),
      };
      vi.mocked(ClientLib.Client).mockReturnValue(
        mockedClient as unknown as ClientLib.Client,
      );
      vi.spyOn(SdkClientStdioLib, 'StdioClientTransport').mockReturnValue(
        {} as SdkClientStdioLib.StdioClientTransport,
      );
      vi.mocked(GenAiLib.mcpToTool).mockReturnValue({
        tool: () =>
          Promise.resolve({
            functionDeclarations: [
              { name: 'allowed' },
              { name: 'filtered_out' },
            ],
          }),
      } as unknown as GenAiLib.CallableTool);
      const toolRegistry = {
        registerTool: vi.fn(),
      } as unknown as ToolRegistry;
      const client = new McpClient(
        'pure-filter-server',
        new MCPServerConfig(
          'test-command',
          undefined,
          undefined,
          undefined,
          undefined,
          true,
          undefined,
          ['allowed'],
          ['filtered_out'],
        ),
        toolRegistry,
        {} as PromptRegistry,
        {} as WorkspaceContext,
        false,
      );
      await client.connect();

      // R23 T1: pool callers explicitly opt out of filters via the
      // `applyConfigFilters: false` opts argument. Default
      // `discoverAndReturn(cliConfig)` (no opts) applies filters,
      // matching the legacy `discover()` semantics expected by
      // non-pool consumers.
      const snapshot = await client.discoverAndReturn(cfgWithResources(), {
        applyConfigFilters: false,
      });

      expect(snapshot.tools.map((tool) => tool.serverToolName)).toEqual([
        'allowed',
        'filtered_out',
      ]);
      expect(snapshot.tools.every((tool) => tool.trust === undefined)).toBe(
        true,
      );
      expect(toolRegistry.registerTool).not.toHaveBeenCalled();
    });

    it('discoverAndReturn (default) applies config filters and trust — legacy non-pool callers (R23 T1)', async () => {
      // R23 T1 regression: pre-fix `discoverAndReturn` hardcoded
      // `{ applyConfigFilters: false }`, so legacy `discover()`
      // (which delegates here) silently lost filtering and trust.
      // Operators with `trust: true` saw unexpected permission
      // prompts, and `excludeTools` was ignored.
      const mockedClient = {
        connect: vi.fn(),
        registerCapabilities: vi.fn(),
        setRequestHandler: vi.fn(),
        getServerCapabilities: vi.fn().mockReturnValue({}),
        listTools: vi.fn().mockResolvedValue({ tools: [] }),
        getInstructions: vi.fn(),
      };
      vi.mocked(ClientLib.Client).mockReturnValue(
        mockedClient as unknown as ClientLib.Client,
      );
      vi.spyOn(SdkClientStdioLib, 'StdioClientTransport').mockReturnValue(
        {} as SdkClientStdioLib.StdioClientTransport,
      );
      vi.mocked(GenAiLib.mcpToTool).mockReturnValue({
        tool: () =>
          Promise.resolve({
            functionDeclarations: [
              { name: 'allowed' },
              { name: 'filtered_out' },
            ],
          }),
      } as unknown as GenAiLib.CallableTool);
      const toolRegistry = {
        registerTool: vi.fn(),
      } as unknown as ToolRegistry;
      const client = new McpClient(
        'legacy-filter-server',
        new MCPServerConfig(
          'test-command',
          undefined,
          undefined,
          undefined,
          undefined,
          true,
          undefined,
          ['allowed'],
          ['filtered_out'],
        ),
        toolRegistry,
        {} as PromptRegistry,
        {} as WorkspaceContext,
        false,
      );
      await client.connect();

      // No opts → default applyConfigFilters=true → filters applied.
      const snapshot = await client.discoverAndReturn(cfgWithResources());

      // `excludeTools: ['filtered_out']` excludes the second tool;
      // `includeTools: ['allowed']` keeps the first.
      expect(snapshot.tools.map((tool) => tool.serverToolName)).toEqual([
        'allowed',
      ]);
      // `trust: true` config → tools carry trust=true (pre-fix this
      // was always undefined because discoverAndReturn forced
      // applyConfigFilters=false).
      expect(snapshot.tools[0].trust).toBe(true);
    });

    it('discoverAndReturn throws "No prompts or tools found" when both empty', async () => {
      // Preserves the discover() pre-F2 invariant — the wrapping
      // McpClientManager / pool entry uses this signal to mark the
      // entry as failed (vs "server up, just empty").
      const mockedClient = {
        connect: vi.fn(),
        registerCapabilities: vi.fn(),
        setRequestHandler: vi.fn(),
        getServerCapabilities: vi.fn().mockReturnValue({ prompts: {} }),
        request: vi.fn().mockResolvedValue({ prompts: [] }),
        listTools: vi.fn().mockResolvedValue({ tools: [] }),
        getInstructions: vi.fn(),
      };
      vi.mocked(ClientLib.Client).mockReturnValue(
        mockedClient as unknown as ClientLib.Client,
      );
      vi.spyOn(SdkClientStdioLib, 'StdioClientTransport').mockReturnValue(
        {} as SdkClientStdioLib.StdioClientTransport,
      );
      vi.mocked(GenAiLib.mcpToTool).mockReturnValue({
        tool: () => Promise.resolve({ functionDeclarations: [] }),
      } as unknown as GenAiLib.CallableTool);
      // Forward defense (per code-reviewer P2.4): also assert registries
      // were NOT touched even on the throw path. Catches a future
      // refactor in commits 2-6 that accidentally registers a partial
      // batch before the "no prompts or tools" guard fires.
      const toolRegistry = {
        registerTool: vi.fn(),
      } as unknown as ToolRegistry;
      const promptRegistry = {
        registerPrompt: vi.fn(),
      } as unknown as PromptRegistry;
      const client = new McpClient(
        'empty-server',
        { command: 'test-command' },
        toolRegistry,
        promptRegistry,
        {} as WorkspaceContext,
        false,
      );
      await client.connect();
      await expect(
        client.discoverAndReturn(cfgWithResources()),
      ).rejects.toThrow('No prompts, tools, or resources found on the server.');
      // Status flipped to DISCONNECTED (same as discover() path).
      expect(client.getStatus()).toBe(MCPServerStatus.DISCONNECTED);
      // Registries strictly untouched even on throw — pure method invariant.
      expect(toolRegistry.registerTool).not.toHaveBeenCalled();
      expect(promptRegistry.registerPrompt).not.toHaveBeenCalled();
    });

    it('discoverAndReturn records the discovery failure cause in the status registry (issue #9944)', async () => {
      // Same carrier as connect()'s catch: a server whose connect()
      // succeeds but discovery fails (up-but-empty) reaches
      // discoverAndReturn()'s catch, which the manager swallows for
      // best-effort discovery. `qwen mcp reconnect` relies on
      // `getMCPServerLastError` to print the cause — the status enum alone
      // only says DISCONNECTED.
      const mockedClient = {
        connect: vi.fn(),
        registerCapabilities: vi.fn(),
        setRequestHandler: vi.fn(),
        getServerCapabilities: vi.fn().mockReturnValue({ prompts: {} }),
        request: vi.fn().mockResolvedValue({ prompts: [] }),
        listTools: vi.fn().mockResolvedValue({ tools: [] }),
        getInstructions: vi.fn(),
      };
      vi.mocked(ClientLib.Client).mockReturnValue(
        mockedClient as unknown as ClientLib.Client,
      );
      vi.spyOn(SdkClientStdioLib, 'StdioClientTransport').mockReturnValue(
        {} as SdkClientStdioLib.StdioClientTransport,
      );
      vi.mocked(GenAiLib.mcpToTool).mockReturnValue({
        tool: () => Promise.resolve({ functionDeclarations: [] }),
      } as unknown as GenAiLib.CallableTool);

      const client = new McpClient(
        'discovery-cause-server',
        { command: 'test-command' },
        { registerTool: vi.fn() } as unknown as ToolRegistry,
        { registerPrompt: vi.fn() } as unknown as PromptRegistry,
        {} as WorkspaceContext,
        false,
      );
      await client.connect();
      await expect(
        client.discoverAndReturn(cfgWithResources()),
      ).rejects.toThrow('No prompts, tools, or resources found on the server.');

      expect(getMCPServerLastError('discovery-cause-server')).toBe(
        'No prompts, tools, or resources found on the server.',
      );

      removeMCPServerStatus('discovery-cause-server');
    });

    it('keeps a server with only app-visible tools connected', async () => {
      mockAppOnlyMcpServer();
      const client = new McpClient(
        'app-only-server',
        { command: 'test-command' },
        {} as ToolRegistry,
        {} as PromptRegistry,
        {} as WorkspaceContext,
        false,
      );
      await client.connect();

      const snapshot = await client.discoverAndReturn(cfgWithResources());

      expect(snapshot.tools).toHaveLength(1);
      expect(snapshot.tools[0].serverToolName).toBe('internal_refresh');
      expect(snapshot.tools[0].isModelVisible).toBe(false);
      expect(snapshot.tools[0].isAppVisible).toBe(true);
      expect(snapshot.prompts).toEqual([]);
      expect(snapshot.resources).toEqual([]);
      expect(client.getStatus()).toBe(MCPServerStatus.CONNECTED);
    });

    it('keeps standalone discovery connected for app-visible-only tools', async () => {
      mockAppOnlyMcpServer();
      const serverName = `app-only-standalone-${Date.now()}`;
      const toolRegistry = {
        registerTool: vi.fn(),
      } as unknown as ToolRegistry;

      await connectAndDiscover(
        serverName,
        { command: 'test-command' },
        toolRegistry,
        { registerPrompt: vi.fn() } as unknown as PromptRegistry,
        false,
        {
          getDirectories: vi.fn().mockReturnValue([]),
          onDirectoriesChanged: vi.fn().mockReturnValue(vi.fn()),
        } as unknown as WorkspaceContext,
        cfgWithResources(),
      );

      expect(getMCPServerStatus(serverName)).toBe(MCPServerStatus.CONNECTED);
      expect(toolRegistry.registerTool).toHaveBeenCalledWith(
        expect.objectContaining({
          serverToolName: 'internal_refresh',
          appVisibility: ['app'],
        }),
      );
    });

    it('discoverAndReturn throws when called before connect()', async () => {
      const client = new McpClient(
        'unconnected-server',
        { command: 'test-command' },
        {} as ToolRegistry,
        {} as PromptRegistry,
        {} as WorkspaceContext,
        false,
      );
      // Status starts DISCONNECTED; discoverAndReturn must reject without
      // hitting the network.
      await expect(
        client.discoverAndReturn(cfgWithResources()),
      ).rejects.toThrow('Client is not connected.');
    });

    it('discover() delegates to discoverAndReturn and registers both tools and prompts', async () => {
      // Backward-compat sanity: the historical discover() entry point
      // still produces side effects in BOTH registries. Previously
      // prompt registration was a side effect inside discoverPrompts;
      // post-F2-1 it is an explicit step in discover() after
      // discoverAndReturn returns.
      const mockedClient = {
        connect: vi.fn(),
        registerCapabilities: vi.fn(),
        setRequestHandler: vi.fn(),
        getServerCapabilities: vi.fn().mockReturnValue({ prompts: {} }),
        request: vi.fn().mockResolvedValue({
          prompts: [{ name: 'p1' }, { name: 'p2' }],
        }),
        listTools: vi.fn().mockResolvedValue({ tools: [] }),
        getInstructions: vi.fn(),
      };
      vi.mocked(ClientLib.Client).mockReturnValue(
        mockedClient as unknown as ClientLib.Client,
      );
      vi.spyOn(SdkClientStdioLib, 'StdioClientTransport').mockReturnValue(
        {} as SdkClientStdioLib.StdioClientTransport,
      );
      vi.mocked(GenAiLib.mcpToTool).mockReturnValue({
        tool: () =>
          Promise.resolve({
            functionDeclarations: [{ name: 't1' }],
          }),
      } as unknown as GenAiLib.CallableTool);
      const toolRegistry = {
        registerTool: vi.fn(),
      } as unknown as ToolRegistry;
      const promptRegistry = {
        registerPrompt: vi.fn(),
      } as unknown as PromptRegistry;
      const client = new McpClient(
        'compat-server',
        { command: 'test-command' },
        toolRegistry,
        promptRegistry,
        {} as WorkspaceContext,
        false,
      );
      await client.connect();
      await client.discover(cfgWithResources());
      expect(toolRegistry.registerTool).toHaveBeenCalledTimes(1);
      expect(promptRegistry.registerPrompt).toHaveBeenCalledTimes(2);
    });

    it('discover() registers discovered resources into the Config ResourceRegistry', async () => {
      const registerResource = vi.fn();
      const removeResourcesByServer = vi.fn();
      const cfg = {
        getMcpToolIdleTimeoutMs: () => TEST_MCP_TOOL_IDLE_TIMEOUT_MS,
        getResourceRegistry: () => ({
          registerResource,
          removeResourcesByServer,
        }),
      } as unknown as Config;
      const mockedClient = {
        connect: vi.fn(),
        registerCapabilities: vi.fn(),
        setRequestHandler: vi.fn(),
        getServerCapabilities: vi.fn().mockReturnValue({ resources: {} }),
        request: vi
          .fn()
          .mockImplementation((req: { method?: string }) =>
            req.method === 'resources/list'
              ? Promise.resolve({ resources: [{ uri: 'res://a', name: 'a' }] })
              : Promise.resolve({ prompts: [] }),
          ),
        getInstructions: vi.fn(),
      };
      vi.mocked(ClientLib.Client).mockReturnValue(
        mockedClient as unknown as ClientLib.Client,
      );
      vi.spyOn(SdkClientStdioLib, 'StdioClientTransport').mockReturnValue(
        {} as SdkClientStdioLib.StdioClientTransport,
      );
      vi.mocked(GenAiLib.mcpToTool).mockReturnValue({
        tool: () => Promise.resolve({ functionDeclarations: [] }),
      } as unknown as GenAiLib.CallableTool);
      const client = new McpClient(
        'srv',
        { command: 'test-command' },
        { registerTool: vi.fn() } as unknown as ToolRegistry,
        { registerPrompt: vi.fn() } as unknown as PromptRegistry,
        {} as WorkspaceContext,
        false,
      );
      await client.connect();
      await client.discover(cfg);
      // Clear-then-register so re-discovery (reconnect) is idempotent and a
      // dropped resource doesn't linger.
      expect(removeResourcesByServer).toHaveBeenCalledWith('srv');
      expect(registerResource).toHaveBeenCalledWith(
        expect.objectContaining({ uri: 'res://a', serverName: 'srv' }),
      );
    });

    it('discover() does NOT clear resources when the list returns empty (transient-failure guard)', async () => {
      // listMcpResources swallows a transient resources/list failure to [].
      // With tools present (discovery still succeeds), an empty resource list
      // must NOT wipe the registry.
      const registerResource = vi.fn();
      const removeResourcesByServer = vi.fn();
      const cfg = {
        getMcpToolIdleTimeoutMs: () => TEST_MCP_TOOL_IDLE_TIMEOUT_MS,
        getResourceRegistry: () => ({
          registerResource,
          removeResourcesByServer,
        }),
      } as unknown as Config;
      const mockedClient = {
        connect: vi.fn(),
        registerCapabilities: vi.fn(),
        setRequestHandler: vi.fn(),
        getServerCapabilities: vi.fn().mockReturnValue({ resources: {} }),
        request: vi.fn().mockResolvedValue({ resources: [], prompts: [] }),
        getInstructions: vi.fn(),
      };
      vi.mocked(ClientLib.Client).mockReturnValue(
        mockedClient as unknown as ClientLib.Client,
      );
      vi.spyOn(SdkClientStdioLib, 'StdioClientTransport').mockReturnValue(
        {} as SdkClientStdioLib.StdioClientTransport,
      );
      // A tool exists so discovery does not fail with "no prompts/tools/resources".
      vi.mocked(GenAiLib.mcpToTool).mockReturnValue({
        tool: () => Promise.resolve({ functionDeclarations: [{ name: 't1' }] }),
      } as unknown as GenAiLib.CallableTool);
      const client = new McpClient(
        'srv',
        { command: 'test-command' },
        { registerTool: vi.fn() } as unknown as ToolRegistry,
        { registerPrompt: vi.fn() } as unknown as PromptRegistry,
        {} as WorkspaceContext,
        false,
      );
      await client.connect();
      await client.discover(cfg);
      expect(removeResourcesByServer).not.toHaveBeenCalled();
      expect(registerResource).not.toHaveBeenCalled();
    });

    it('discoverAndReturn connects a resource-only server (does not throw)', async () => {
      // The failed-discovery guard now counts resources: a server exposing
      // only resources (no tools/prompts) is a successful discovery.
      const mockedClient = {
        connect: vi.fn(),
        registerCapabilities: vi.fn(),
        setRequestHandler: vi.fn(),
        getServerCapabilities: vi.fn().mockReturnValue({ resources: {} }),
        request: vi
          .fn()
          .mockImplementation((req: { method?: string }) =>
            req.method === 'resources/list'
              ? Promise.resolve({ resources: [{ uri: 'res://a', name: 'a' }] })
              : Promise.resolve({ prompts: [] }),
          ),
        listTools: vi.fn().mockResolvedValue({ tools: [] }),
        getInstructions: vi.fn(),
      };
      vi.mocked(ClientLib.Client).mockReturnValue(
        mockedClient as unknown as ClientLib.Client,
      );
      vi.spyOn(SdkClientStdioLib, 'StdioClientTransport').mockReturnValue(
        {} as SdkClientStdioLib.StdioClientTransport,
      );
      vi.mocked(GenAiLib.mcpToTool).mockReturnValue({
        tool: () => Promise.resolve({ functionDeclarations: [] }),
      } as unknown as GenAiLib.CallableTool);
      const client = new McpClient(
        'srv',
        { command: 'test-command' },
        {} as ToolRegistry,
        {} as PromptRegistry,
        {} as WorkspaceContext,
        false,
      );
      await client.connect();
      const snap = await client.discoverAndReturn(cfgWithResources());
      expect(snap.resources).toHaveLength(1);
      expect(snap.tools).toHaveLength(0);
      expect(snap.prompts).toHaveLength(0);
    });
  });

  describe('listMcpPrompts (F2 pure helper)', () => {
    it('returns enriched DiscoveredMCPPrompt[] with serverName + bound invoke', async () => {
      const mockClient = {
        getServerCapabilities: vi.fn().mockReturnValue({ prompts: {} }),
        request: vi.fn().mockResolvedValue({
          prompts: [
            { name: 'greet', description: 'Greet a user' },
            { name: 'farewell' },
          ],
        }),
      } as unknown as ClientLib.Client;

      const result = await listMcpPrompts('my-server', mockClient);
      expect(result).toHaveLength(2);
      expect(result[0].serverName).toBe('my-server');
      expect(result[0].name).toBe('greet');
      expect(typeof result[0].invoke).toBe('function');
      expect(result[1].name).toBe('farewell');
    });

    it('attempts prompts/list even when the prompts capability is undeclared (lenient)', async () => {
      // Regression guard: the v2 typed helper returns [] WITHOUT a request
      // when `capabilities.prompts` is absent. Modern under-declared servers
      // must still hit the wire.
      const mockClient = {
        getProtocolEra: vi.fn().mockReturnValue('modern'),
        getServerCapabilities: vi.fn().mockReturnValue({}),
        listPrompts: vi.fn().mockResolvedValue({ prompts: [] }),
        request: vi
          .fn()
          .mockRejectedValue(new Error('MCP error -32601: Method not found')),
      } as unknown as ClientLib.Client;
      const result = await listMcpPrompts('no-prompts', mockClient);
      expect(result).toEqual([]);
      expect(vi.mocked(mockClient.request)).toHaveBeenCalledTimes(1);
      expect(vi.mocked(mockClient.listPrompts)).not.toHaveBeenCalled();
    });

    it('lists prompts from a server that omits the prompts capability but still answers', async () => {
      const mockClient = {
        getProtocolEra: vi.fn().mockReturnValue('modern'),
        getServerCapabilities: vi.fn().mockReturnValue({}),
        listPrompts: vi.fn().mockResolvedValue({ prompts: [] }),
        request: vi.fn().mockResolvedValue({
          prompts: [{ name: 'greet' }],
        }),
      } as unknown as ClientLib.Client;
      const result = await listMcpPrompts('under-declared', mockClient);
      expect(result).toHaveLength(1);
      expect(result[0].name).toBe('greet');
      expect(result[0].serverName).toBe('under-declared');
      expect(vi.mocked(mockClient.listPrompts)).not.toHaveBeenCalled();
    });

    it('uses the typed helper when a modern server declares prompts', async () => {
      const mockClient = {
        getProtocolEra: vi.fn().mockReturnValue('modern'),
        getServerCapabilities: vi.fn().mockReturnValue({ prompts: {} }),
        listPrompts: vi.fn().mockResolvedValue({
          prompts: [{ name: 'greet' }],
        }),
        request: vi.fn(),
      } as unknown as ClientLib.Client;
      const result = await listMcpPrompts('modern', mockClient);
      expect(result).toHaveLength(1);
      expect(result[0].name).toBe('greet');
      expect(vi.mocked(mockClient.listPrompts)).toHaveBeenCalledTimes(1);
      expect(vi.mocked(mockClient.request)).not.toHaveBeenCalled();
    });

    it('returns [] on protocol error (server up but list call rejects)', async () => {
      const mockClient = {
        getServerCapabilities: vi.fn().mockReturnValue({ prompts: {} }),
        request: vi.fn().mockRejectedValue(new Error('boom')),
      } as unknown as ClientLib.Client;
      const result = await listMcpPrompts('flaky', mockClient);
      expect(result).toEqual([]);
    });

    it('retries on transient ECONNRESET and succeeds on second attempt', async () => {
      const mockClient = {
        getServerCapabilities: vi.fn().mockReturnValue({ prompts: {} }),
        request: vi
          .fn()
          .mockRejectedValueOnce(new Error('read ECONNRESET'))
          .mockResolvedValueOnce({
            prompts: [{ name: 'greet', description: 'Greet' }],
          }),
      } as unknown as ClientLib.Client;
      const result = await listMcpPrompts('retry-prompts', mockClient);
      expect(result).toHaveLength(1);
      expect(result[0].name).toBe('greet');
      expect(vi.mocked(mockClient.request)).toHaveBeenCalledTimes(2);
    });

    it('exhausts retries on persistent transient errors and returns []', async () => {
      const mockClient = {
        getServerCapabilities: vi.fn().mockReturnValue({ prompts: {} }),
        request: vi.fn().mockRejectedValue(new Error('read ECONNRESET')),
      } as unknown as ClientLib.Client;
      const result = await listMcpPrompts('always-failing', mockClient);
      expect(result).toEqual([]);
      // 1 initial + 2 retries = 3 total calls
      expect(vi.mocked(mockClient.request)).toHaveBeenCalledTimes(3);
    });
  });

  describe('listMcpResources', () => {
    it('returns enriched DiscoveredMCPResource[] with serverName', async () => {
      const mockClient = {
        getServerCapabilities: vi.fn().mockReturnValue({ resources: {} }),
        request: vi.fn().mockResolvedValue({
          resources: [
            { uri: 'file:///a.txt', name: 'a' },
            { uri: 'file:///b.txt', name: 'b', mimeType: 'text/plain' },
          ],
        }),
      } as unknown as ClientLib.Client;

      const result = await listMcpResources('my-server', mockClient);
      expect(result).toHaveLength(2);
      expect(result[0].serverName).toBe('my-server');
      expect(result[0].uri).toBe('file:///a.txt');
      expect(result[1].mimeType).toBe('text/plain');
      // Resources carry no bound invoke (unlike prompts).
      expect((result[0] as Record<string, unknown>)['invoke']).toBeUndefined();
    });

    it('attempts resources/list even when the resources capability is undeclared (lenient)', async () => {
      const mockClient = {
        getProtocolEra: vi.fn().mockReturnValue('modern'),
        getServerCapabilities: vi.fn().mockReturnValue({}),
        listResources: vi.fn().mockResolvedValue({ resources: [] }),
        request: vi
          .fn()
          .mockRejectedValue(new Error('MCP error -32601: Method not found')),
      } as unknown as ClientLib.Client;
      const result = await listMcpResources('no-resources', mockClient);
      expect(result).toEqual([]);
      expect(vi.mocked(mockClient.request)).toHaveBeenCalledTimes(1);
      expect(vi.mocked(mockClient.listResources)).not.toHaveBeenCalled();
    });

    it('uses the typed helper when a modern server declares resources', async () => {
      const mockClient = {
        getProtocolEra: vi.fn().mockReturnValue('modern'),
        getServerCapabilities: vi.fn().mockReturnValue({ resources: {} }),
        listResources: vi.fn().mockResolvedValue({
          resources: [{ uri: 'file:///a.txt', name: 'a' }],
        }),
        request: vi.fn(),
      } as unknown as ClientLib.Client;
      const result = await listMcpResources('modern', mockClient);
      expect(result).toHaveLength(1);
      expect(result[0].uri).toBe('file:///a.txt');
      expect(vi.mocked(mockClient.listResources)).toHaveBeenCalledTimes(1);
      expect(vi.mocked(mockClient.request)).not.toHaveBeenCalled();
    });

    it('returns [] on protocol error (server up but list call rejects)', async () => {
      const mockClient = {
        getServerCapabilities: vi.fn().mockReturnValue({ resources: {} }),
        request: vi.fn().mockRejectedValue(new Error('boom')),
      } as unknown as ClientLib.Client;
      const result = await listMcpResources('flaky', mockClient);
      expect(result).toEqual([]);
    });

    it('treats JSON-RPC code -32601 as method-absent even when the message differs (no error logged)', async () => {
      // A spec-compliant server signals an unimplemented method by the
      // numeric code; the message text is not guaranteed (it may be
      // localized or worded "Method not implemented"). It must not be
      // logged as an error.
      const err = Object.assign(new Error('Método no implementado'), {
        code: -32601,
      });
      const mockClient = {
        getServerCapabilities: vi.fn().mockReturnValue({}),
        request: vi.fn().mockRejectedValue(err),
      } as unknown as ClientLib.Client;
      const result = await listMcpResources('localized', mockClient);
      expect(result).toEqual([]);
      expect(mockDebugLogger.error).not.toHaveBeenCalled();
    });

    it('logs genuinely unexpected errors (not method-absent)', async () => {
      const mockClient = {
        getServerCapabilities: vi.fn().mockReturnValue({ resources: {} }),
        request: vi.fn().mockRejectedValue(new Error('connection reset')),
      } as unknown as ClientLib.Client;
      const result = await listMcpResources('broken', mockClient);
      expect(result).toEqual([]);
      expect(mockDebugLogger.error).toHaveBeenCalled();
    });

    it('swallows the exact "Method not found" message even without a code', async () => {
      const mockClient = {
        getServerCapabilities: vi.fn().mockReturnValue({ resources: {} }),
        request: vi.fn().mockRejectedValue(new Error('Method not found')),
      } as unknown as ClientLib.Client;
      const result = await listMcpResources('no-method', mockClient);
      expect(result).toEqual([]);
      expect(mockDebugLogger.error).not.toHaveBeenCalled();
    });

    it('does NOT swallow an unrelated error that merely contains "method not found" (case-sensitive)', async () => {
      // Regression guard for the message-substring narrowing: the old broad
      // /method not found/i would have hidden this genuine failure.
      const mockClient = {
        getServerCapabilities: vi.fn().mockReturnValue({ resources: {} }),
        request: vi
          .fn()
          .mockRejectedValue(
            new Error('Error in method not found handler: null pointer'),
          ),
      } as unknown as ClientLib.Client;
      const result = await listMcpResources('weird', mockClient);
      expect(result).toEqual([]);
      expect(mockDebugLogger.error).toHaveBeenCalled();
    });

    it('retries on transient ECONNRESET and succeeds on second attempt', async () => {
      const mockClient = {
        getServerCapabilities: vi.fn().mockReturnValue({ resources: {} }),
        request: vi
          .fn()
          .mockRejectedValueOnce(new Error('read ECONNRESET'))
          .mockResolvedValueOnce({
            resources: [{ uri: 'file:///a.txt', name: 'a' }],
          }),
      } as unknown as ClientLib.Client;
      const result = await listMcpResources('retry-server', mockClient);
      expect(result).toHaveLength(1);
      expect(result[0].name).toBe('a');
      expect(vi.mocked(mockClient.request)).toHaveBeenCalledTimes(2);
    });

    it('exhausts retries on persistent transient errors and returns []', async () => {
      const mockClient = {
        getServerCapabilities: vi.fn().mockReturnValue({ resources: {} }),
        request: vi.fn().mockRejectedValue(new Error('read ECONNRESET')),
      } as unknown as ClientLib.Client;
      const result = await listMcpResources('always-failing', mockClient);
      expect(result).toEqual([]);
      // 1 initial + 2 retries = 3 total calls
      expect(vi.mocked(mockClient.request)).toHaveBeenCalledTimes(3);
    });
  });

  describe('discoverResources wrapper', () => {
    it('registers discovered resources into the supplied ResourceRegistry', async () => {
      const mockClient = {
        getServerCapabilities: vi.fn().mockReturnValue({ resources: {} }),
        request: vi.fn().mockResolvedValue({
          resources: [{ uri: 'file:///x.txt', name: 'x' }],
        }),
      } as unknown as ClientLib.Client;
      const resourceRegistry = {
        registerResource: vi.fn(),
      } as unknown as ResourceRegistry;
      const out = await discoverResources(
        'wrapper-server',
        mockClient,
        resourceRegistry,
      );
      expect(resourceRegistry.registerResource).toHaveBeenCalledTimes(1);
      expect(out).toHaveLength(1);
      expect(out[0].uri).toBe('file:///x.txt');
      expect(out[0].serverName).toBe('wrapper-server');
    });
  });

  describe('discoverPrompts wrapper (backward compat after F2-1 split)', () => {
    it('still registers prompts into the supplied PromptRegistry', async () => {
      const mockClient = {
        getServerCapabilities: vi.fn().mockReturnValue({ prompts: {} }),
        request: vi.fn().mockResolvedValue({
          prompts: [{ name: 'register-me' }],
        }),
      } as unknown as ClientLib.Client;
      const promptRegistry = {
        registerPrompt: vi.fn(),
      } as unknown as PromptRegistry;
      const out = await discoverPrompts(
        'wrapper-server',
        mockClient,
        promptRegistry,
      );
      expect(promptRegistry.registerPrompt).toHaveBeenCalledTimes(1);
      expect(out).toHaveLength(1);
      expect(out[0].name).toBe('register-me');
      // Historical contract: return type strips serverName/invoke.
      expect((out[0] as Record<string, unknown>)['serverName']).toBeUndefined();
      expect((out[0] as Record<string, unknown>)['invoke']).toBeUndefined();
    });
  });

  describe('appendMcpServerCommand', () => {
    it('should do nothing if no MCP servers or command are configured', () => {
      const out = populateMcpServerCommand({}, undefined);
      expect(out).toEqual({});
    });

    it('should discover tools via mcpServerCommand', () => {
      const commandString = 'command --arg1 value1';
      const cwd = '/session/worktree';
      const out = populateMcpServerCommand({}, commandString, cwd);
      expect(out).toEqual({
        mcp: {
          command: 'command',
          args: ['--arg1', 'value1'],
          cwd,
        },
      });
    });

    it('should handle error if mcpServerCommand parsing fails', () => {
      expect(() => populateMcpServerCommand({}, 'derp && herp')).toThrowError();
    });

    it('stamps cwd onto implicit stdio servers', () => {
      const cwd = '/session/worktree';
      const out = populateMcpServerCommand(
        {
          implicit: { command: 'node', args: ['server.js'] },
          explicit: { command: 'node', cwd: '/explicit' },
          sdk: { type: 'sdk', command: 'placeholder' },
        },
        undefined,
        cwd,
      );
      expect(out['implicit']).toEqual({
        command: 'node',
        args: ['server.js'],
        cwd,
      });
      expect(out['explicit']?.cwd).toBe('/explicit');
      expect(out['sdk']?.cwd).toBeUndefined();
    });

    it('does not stamp cwd when cwd is undefined', () => {
      const servers = { local: { command: 'node', args: [] } };
      const out = populateMcpServerCommand(servers, undefined);
      expect(out['local']?.cwd).toBeUndefined();
    });

    it('does not mutate the input map', () => {
      const servers = { local: { command: 'node', args: [] } };
      const out = populateMcpServerCommand(servers, 'cmd --flag', '/wd');
      expect(servers).toEqual({ local: { command: 'node', args: [] } });
      expect(out['mcp']).toBeDefined();
      expect(out['local']?.cwd).toBe('/wd');
    });
  });

  describe('createTransport', () => {
    it('should connect via command', async () => {
      const mockedTransport = vi
        .spyOn(SdkClientStdioLib, 'StdioClientTransport')
        .mockReturnValue({} as SdkClientStdioLib.StdioClientTransport);

      await createTransport(
        'test-server',
        {
          command: 'test-command',
          args: ['--foo', 'bar'],
          env: { FOO: 'bar' },
          cwd: 'test/cwd',
        },
        false,
      );

      expect(mockedTransport).toHaveBeenCalledWith({
        command: 'test-command',
        args: ['--foo', 'bar'],
        cwd: 'test/cwd',
        // Use objectContaining because normalizePathEnvForWindows deduplicates
        // PATH entries on Windows, so the env won't be an exact spread match.
        env: expect.objectContaining({ FOO: 'bar' }),
        stderr: 'pipe',
      });
    });

    it('strips Qwen-internal daemon secrets from the stdio child env (#6601)', async () => {
      process.env = {
        ...ORIGINAL_ENV,
        QWEN_SERVER_TOKEN: 'serve-secret',
        QWEN_DAEMON_TOKEN: 'daemon-secret',
        GH_TOKEN: 'gh-abc',
      };
      const mockedTransport = vi
        .spyOn(SdkClientStdioLib, 'StdioClientTransport')
        .mockReturnValue({} as SdkClientStdioLib.StdioClientTransport);

      await createTransport('test-server', { command: 'test-command' }, false);

      const transportEnv = mockedTransport.mock.calls[0]?.[0]?.env ?? {};
      // Internal daemon secrets must never reach an agent-launched stdio server.
      expect(transportEnv['QWEN_SERVER_TOKEN']).toBeUndefined();
      expect(transportEnv['QWEN_DAEMON_TOKEN']).toBeUndefined();
      // Third-party credentials the server may legitimately need are preserved.
      expect(transportEnv['GH_TOKEN']).toBe('gh-abc');
    });

    it('leaves a user-provided PYTHONHOME untouched (#11718)', async () => {
      process.env = {
        ...ORIGINAL_ENV,
        PYTHONHOME: '/home/user/py313',
      };
      const mockedTransport = vi
        .spyOn(SdkClientStdioLib, 'StdioClientTransport')
        .mockReturnValue({} as SdkClientStdioLib.StdioClientTransport);

      await createTransport('test-server', { command: 'test-command' }, false);

      const transportEnv = mockedTransport.mock.calls[0]?.[0]?.env ?? {};
      expect(transportEnv['PYTHONHOME']).toBe('/home/user/py313');
    });

    it('should normalize PATH-like env keys on Windows for stdio transport', async () => {
      vi.spyOn(process, 'platform', 'get').mockReturnValue('win32');
      process.env = {
        ...ORIGINAL_ENV,
        PATH: 'C:\\Windows\\System32;C:\\Shared\\Tools',
        Path: 'C:\\Users\\tester\\bin;C:\\Shared\\Tools',
      };
      const mockedTransport = vi
        .spyOn(SdkClientStdioLib, 'StdioClientTransport')
        .mockReturnValue({} as SdkClientStdioLib.StdioClientTransport);

      await createTransport(
        'test-server',
        {
          command: 'test-command',
          env: { FOO: 'bar' },
        },
        false,
      );

      expect(mockedTransport).toHaveBeenCalledWith({
        command: 'test-command',
        args: [],
        cwd: undefined,
        env: expect.objectContaining({
          PATH: 'C:\\Windows\\System32;C:\\Shared\\Tools;C:\\Users\\tester\\bin',
          FOO: 'bar',
        }),
        stderr: 'pipe',
      });
      const transportOptions = mockedTransport.mock.calls[0]?.[0];
      expect(transportOptions?.env?.['Path']).toBeUndefined();
    });

    it('should let server config PATH override parent PATH on Windows', async () => {
      vi.spyOn(process, 'platform', 'get').mockReturnValue('win32');
      process.env = {
        ...ORIGINAL_ENV,
        PATH: 'C:\\Windows\\System32;C:\\Shared\\Tools',
        Path: 'C:\\Users\\tester\\bin;C:\\Shared\\Tools',
      };
      const mockedTransport = vi
        .spyOn(SdkClientStdioLib, 'StdioClientTransport')
        .mockReturnValue({} as SdkClientStdioLib.StdioClientTransport);

      await createTransport(
        'test-server',
        {
          command: 'test-command',
          env: { PATH: 'C:\\ServerToolchain\\bin' },
        },
        false,
      );

      const transportOptions = mockedTransport.mock.calls[0]?.[0];
      // Server-provided PATH should fully replace the parent PATH, not merge
      expect(transportOptions?.env?.['PATH']).toBe('C:\\ServerToolchain\\bin');
      expect(transportOptions?.env?.['Path']).toBeUndefined();
    });

    it('should connect via command without cwd', async () => {
      const mockedTransport = vi
        .spyOn(SdkClientStdioLib, 'StdioClientTransport')
        .mockReturnValue({} as SdkClientStdioLib.StdioClientTransport);

      await createTransport(
        'test-server',
        {
          command: 'test-command',
          args: ['--foo', 'bar'],
        },
        false,
      );

      expect(mockedTransport).toHaveBeenCalledWith({
        command: 'test-command',
        args: ['--foo', 'bar'],
        cwd: undefined,
        env: expect.any(Object),
        stderr: 'pipe',
      });
    });

    it('should throw if cwd does not exist', async () => {
      mockExistsSync.mockReturnValueOnce(false);

      await expect(
        createTransport(
          'test-server',
          {
            command: 'test-command',
            cwd: '/nonexistent/path',
          },
          false,
        ),
      ).rejects.toThrow(
        "MCP server 'test-server': configured cwd does not exist: /nonexistent/path",
      );
    });
  });
  describe('isEnabled', () => {
    const funcDecl = { name: 'myTool' };
    const serverName = 'myServer';

    it('should return true if no include or exclude lists are provided', () => {
      const mcpServerConfig = {};
      expect(isEnabled(funcDecl, serverName, mcpServerConfig)).toBe(true);
    });

    it('should return false if the tool is in the exclude list', () => {
      const mcpServerConfig = { excludeTools: ['myTool'] };
      expect(isEnabled(funcDecl, serverName, mcpServerConfig)).toBe(false);
    });

    it('should return true if the tool is in the include list', () => {
      const mcpServerConfig = { includeTools: ['myTool'] };
      expect(isEnabled(funcDecl, serverName, mcpServerConfig)).toBe(true);
    });

    it('should return true if the tool is in the include list with parentheses', () => {
      const mcpServerConfig = { includeTools: ['myTool()'] };
      expect(isEnabled(funcDecl, serverName, mcpServerConfig)).toBe(true);
    });

    it('should return false if the include list exists but does not contain the tool', () => {
      const mcpServerConfig = { includeTools: ['anotherTool'] };
      expect(isEnabled(funcDecl, serverName, mcpServerConfig)).toBe(false);
    });

    it('should return false if the tool is in both the include and exclude lists', () => {
      const mcpServerConfig = {
        includeTools: ['myTool'],
        excludeTools: ['myTool'],
      };
      expect(isEnabled(funcDecl, serverName, mcpServerConfig)).toBe(false);
    });

    it('should return false if the function declaration has no name', () => {
      const namelessFuncDecl = {};
      const mcpServerConfig = {};
      expect(isEnabled(namelessFuncDecl, serverName, mcpServerConfig)).toBe(
        false,
      );
    });
  });

  describe('removeMCPServerStatus', () => {
    afterEach(() => {
      // Clean up any state left in the module-level registry between tests.
      for (const name of getAllMCPServerStatuses().keys()) {
        removeMCPServerStatus(name);
      }
    });

    it('removes the entry from the global status map', () => {
      updateMCPServerStatus('srv-a', MCPServerStatus.DISCONNECTED);
      expect(getAllMCPServerStatuses().has('srv-a')).toBe(true);

      removeMCPServerStatus('srv-a');

      expect(getAllMCPServerStatuses().has('srv-a')).toBe(false);
      // getMCPServerStatus falls back to DISCONNECTED for unknown servers,
      // but the snapshot map should no longer include the entry.
      expect(getMCPServerStatus('srv-a')).toBe(MCPServerStatus.DISCONNECTED);
    });

    it('notifies listeners with undefined to signal removal', () => {
      const events: Array<[string, MCPServerStatus | undefined]> = [];
      const listener = (name: string, status: MCPServerStatus | undefined) => {
        events.push([name, status]);
      };
      addMCPStatusChangeListener(listener);

      updateMCPServerStatus('srv-b', MCPServerStatus.CONNECTED);
      removeMCPServerStatus('srv-b');

      removeMCPStatusChangeListener(listener);

      expect(events).toEqual([
        ['srv-b', MCPServerStatus.CONNECTED],
        ['srv-b', undefined],
      ]);
    });

    it('is a no-op (no listener fired) when the server is not tracked', () => {
      const listener = vi.fn();
      addMCPStatusChangeListener(listener);

      removeMCPServerStatus('never-registered');

      removeMCPStatusChangeListener(listener);
      expect(listener).not.toHaveBeenCalled();
    });

    it('a stale status update from an in-flight connect cannot resurrect a removed server', async () => {
      // Race scenario from PR review: `disableMcpServer` removes the entry,
      // but `McpClient.connect()`'s catch block could still fire afterwards
      // and call `updateStatus(DISCONNECTED)`. The `isDisconnecting` guard
      // inside `McpClient.updateStatus` must prevent that resurrection.
      const mockedClient = {
        connect: vi.fn().mockRejectedValue(new Error('connect failed')),
        registerCapabilities: vi.fn(),
        setRequestHandler: vi.fn(),
        close: vi.fn(),
        getInstructions: vi.fn(),
      };
      vi.mocked(ClientLib.Client).mockReturnValue(
        mockedClient as unknown as ClientLib.Client,
      );
      vi.spyOn(SdkClientStdioLib, 'StdioClientTransport').mockReturnValue({
        close: vi.fn(),
      } as unknown as SdkClientStdioLib.StdioClientTransport);

      const client = new McpClient(
        'racy-server',
        { command: 'test-command' },
        {} as ToolRegistry,
        {} as PromptRegistry,
        {} as WorkspaceContext,
        false,
      );

      // Kick off connect() but don't await it; it will reject and run its
      // catch block which calls updateStatus(DISCONNECTED).
      const connectPromise = client.connect();

      // Simulate the disable path running before connect's catch fires.
      await client.disconnect();
      removeMCPServerStatus('racy-server');

      // Now let the rejected connect propagate.
      await expect(connectPromise).rejects.toThrow('connect failed');

      // The entry must remain absent — no resurrection.
      expect(getAllMCPServerStatuses().has('racy-server')).toBe(false);
      // Same invariant for the failure-cause map: the status write is
      // suppressed by the `isDisconnecting` guard, and the lastError record
      // in connect()'s catch must be gated the same way — otherwise the
      // doomed in-flight connect resurrects an orphan cause entry that
      // `removeMCPServerStatus` already dropped (persisting until process
      // exit and misattributing to a later re-added incarnation).
      expect(getMCPServerLastError('racy-server')).toBeUndefined();
    });

    it('disconnect() propagates DISCONNECTED to the global registry', async () => {
      // Regression: a previous version set `isDisconnecting = true` BEFORE
      // calling `updateStatus(DISCONNECTED)`, and `updateStatus`'s guard
      // (designed to block stale `connect()` catch updates) silently
      // swallowed the write. The global registry stayed CONNECTED forever,
      // so `Config.getFailedMcpServerNames()` (which filters
      // `status !== CONNECTED`) omitted timeout-disconnected servers from
      // the non-interactive failure banner and the Footer's MCP health
      // pill kept counting them as healthy.
      const mockedClient = {
        connect: vi.fn(),
        registerCapabilities: vi.fn(),
        setRequestHandler: vi.fn(),
        close: vi.fn(),
        getInstructions: vi.fn(),
      };
      vi.mocked(ClientLib.Client).mockReturnValue(
        mockedClient as unknown as ClientLib.Client,
      );
      const mockedTransport = { close: vi.fn().mockResolvedValue(undefined) };
      vi.spyOn(SdkClientStdioLib, 'StdioClientTransport').mockReturnValue(
        mockedTransport as unknown as SdkClientStdioLib.StdioClientTransport,
      );

      const client = new McpClient(
        'healthy-server',
        { command: 'test-command' },
        {} as ToolRegistry,
        {} as PromptRegistry,
        { getDirectories: () => [] } as unknown as WorkspaceContext,
        false,
      );

      await client.connect();
      // After connect, the registry should show CONNECTED.
      expect(getMCPServerStatus('healthy-server')).toBe(
        MCPServerStatus.CONNECTED,
      );

      await client.disconnect();
      // After an intentional disconnect, the global registry MUST reflect
      // DISCONNECTED — otherwise downstream code (failure banner, health
      // pill) treats the server as still healthy.
      expect(getMCPServerStatus('healthy-server')).toBe(
        MCPServerStatus.DISCONNECTED,
      );

      // Cleanup the registry entry so this test doesn't leak.
      removeMCPServerStatus('healthy-server');
    });

    it('records the connect failure cause in the status registry (issue #9944)', async () => {
      // Discovery is best-effort and swallows connect errors (the manager's
      // catch logs them via debugLogger only), so the status enum alone
      // cannot tell a consumer WHY a server is not CONNECTED. connect() must
      // record the cause so `qwen mcp reconnect` can print it.
      const mockedClient = {
        connect: vi
          .fn()
          .mockRejectedValue(new Error('connect ECONNREFUSED 127.0.0.1:3939')),
        registerCapabilities: vi.fn(),
        setRequestHandler: vi.fn(),
        close: vi.fn(),
        getInstructions: vi.fn(),
      };
      vi.mocked(ClientLib.Client).mockReturnValue(
        mockedClient as unknown as ClientLib.Client,
      );
      vi.spyOn(SdkClientStdioLib, 'StdioClientTransport').mockReturnValue({
        close: vi.fn().mockResolvedValue(undefined),
      } as unknown as SdkClientStdioLib.StdioClientTransport);

      const client = new McpClient(
        'cause-recording-server',
        { command: 'test-command' },
        {} as ToolRegistry,
        {} as PromptRegistry,
        { getDirectories: () => [] } as unknown as WorkspaceContext,
        false,
      );

      await expect(client.connect()).rejects.toThrow(
        'connect ECONNREFUSED 127.0.0.1:3939',
      );
      expect(getMCPServerLastError('cause-recording-server')).toBe(
        'connect ECONNREFUSED 127.0.0.1:3939',
      );

      // A recovered connection clears the stale cause.
      mockedClient.connect.mockResolvedValue(undefined);
      await client.connect();
      expect(getMCPServerLastError('cause-recording-server')).toBeUndefined();

      removeMCPServerStatus('cause-recording-server');
    });
  });
});
