/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  McpClientManager,
  type McpClientManagerOptions,
} from './mcp-client-manager.js';
import { McpClient, populateMcpServerCommand } from './mcp-client.js';
import type { ToolRegistry } from './tool-registry.js';
import { MCPServerConfig, type Config } from '../config/config.js';
import type { PromptRegistry } from '../prompts/prompt-registry.js';
import type { WorkspaceContext } from '../utils/workspaceContext.js';
import { connectionIdOf } from './mcp-pool-key.js';
import { listDescendantPids, sigtermPids } from './pid-descendants.js';
import { expectWithinLatencyBudget } from '../test-utils/latency-budget.js';

vi.mock('./mcp-client.js', async () => {
  const originalModule = await vi.importActual('./mcp-client.js');
  return {
    ...originalModule,
    McpClient: vi.fn(),
    // Return the input servers unchanged (identity function)
    populateMcpServerCommand: vi.fn((servers) => servers),
  };
});

vi.mock('./pid-descendants.js', () => ({
  listDescendantPids: vi.fn().mockResolvedValue([]),
  sigtermPids: vi.fn().mockReturnValue(0),
}));

/**
 * F2 (#4175 commit 6 review fix — wenshao R9 / PR A): test factory
 * for `McpClientManager`. Pre-fix the 80 construction sites in this
 * file each repeated a 7-positional call with 4 `undefined` sentinels
 * to reach the trailing `pool` arg. With the options-object ctor +
 * this factory, each site names only the fields it overrides; default
 * `mockConfig` + `{} as ToolRegistry` cover the no-arg case.
 */
function mkManager(
  overrides: {
    config?: Config;
    toolRegistry?: ToolRegistry;
    options?: McpClientManagerOptions;
  } = {},
): McpClientManager {
  const config =
    overrides.config ??
    ({
      isTrustedFolder: () => true,
      getMcpServers: () => ({}),
      getMcpServerCommand: () => undefined,
      getTargetDir: () => '/session/worktree',
      getResourceRegistry: () => ({ removeResourcesByServer: vi.fn() }),
      getPromptRegistry: () => ({ removePromptsByServer: vi.fn() }),
      getWorkspaceContext: () => ({}),
      getDebugMode: () => false,
      getSessionId: () => 'sid-1',
      isMcpServerDisabled: () => false,
    } as unknown as Config);
  const toolRegistry =
    overrides.toolRegistry ??
    ({
      removeMcpToolsByServer: vi.fn(),
    } as unknown as ToolRegistry);
  return new McpClientManager(config, toolRegistry, overrides.options ?? {});
}

describe('McpClientManager', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('removeServer (config-driven removal) drops the server prompts and resources (leak regression, sub-task 3)', async () => {
    const removePromptsByServer = vi.fn();
    const removeResourcesByServer = vi.fn();
    const removeMcpToolsByServer = vi.fn();
    const mockConfig = {
      isTrustedFolder: () => true,
      getMcpServers: () => ({}),
      getMcpServerCommand: () => undefined,
      getTargetDir: () => '/session/worktree',
      getPromptRegistry: () => ({ removePromptsByServer }),
      getResourceRegistry: () => ({ removeResourcesByServer }),
      getWorkspaceContext: () => ({}),
      getDebugMode: () => false,
      getSessionId: () => 'sid-1',
      isMcpServerDisabled: () => false,
    } as unknown as Config;
    const manager = mkManager({
      config: mockConfig,
      toolRegistry: { removeMcpToolsByServer } as unknown as ToolRegistry,
    });

    // `removeServer` is private; exercised here directly (the incremental
    // reconcile's removal branch calls it).
    await (
      manager as unknown as { removeServer(name: string): Promise<void> }
    ).removeServer('srv');

    expect(removeMcpToolsByServer).toHaveBeenCalledWith('srv');
    expect(removePromptsByServer).toHaveBeenCalledWith('srv');
    expect(removeResourcesByServer).toHaveBeenCalledWith('srv');
  });

  it('should discover tools from all servers', async () => {
    const mockedMcpClient = {
      connect: vi.fn(),
      discover: vi.fn(),
      disconnect: vi.fn(),
      getStatus: vi.fn(),
    };
    vi.mocked(McpClient).mockReturnValue(
      mockedMcpClient as unknown as McpClient,
    );
    const mockConfig = {
      isTrustedFolder: () => true,
      getMcpServers: () => ({ 'test-server': {} }),
      getMcpServerCommand: () => undefined,
      getTargetDir: () => '/session/worktree',
      getResourceRegistry: () => ({ removeResourcesByServer: vi.fn() }),
      getPromptRegistry: () => ({ removePromptsByServer: vi.fn() }),
      getWorkspaceContext: () => ({}),
      getDebugMode: () => false,
      isMcpServerDisabled: () => false,
    } as unknown as Config;
    const manager = mkManager({ config: mockConfig });
    await manager.discoverAllMcpTools(mockConfig);
    expect(mockedMcpClient.connect).toHaveBeenCalledOnce();
    expect(mockedMcpClient.discover).toHaveBeenCalledOnce();
  });

  it('returns instructions from connected clients', async () => {
    vi.mocked(McpClient).mockImplementation(
      (name: string) =>
        ({
          connect: vi.fn(),
          discover: vi.fn(),
          disconnect: vi.fn(),
          getStatus: vi.fn(),
          getInstructions: vi
            .fn()
            .mockReturnValue(
              name === 'with-instructions' ? 'Use concise replies.' : undefined,
            ),
        }) as unknown as McpClient,
    );
    const mockConfig = {
      isTrustedFolder: () => true,
      getMcpServers: () => ({
        'with-instructions': {},
        'without-instructions': {},
      }),
      getMcpServerCommand: () => undefined,
      getTargetDir: () => '/session/worktree',
      getResourceRegistry: () => ({ removeResourcesByServer: vi.fn() }),
      getPromptRegistry: () => ({ removePromptsByServer: vi.fn() }),
      getWorkspaceContext: () => ({}),
      getDebugMode: () => false,
      isMcpServerDisabled: () => false,
    } as unknown as Config;
    const manager = new McpClientManager(mockConfig, {} as ToolRegistry);

    await manager.discoverAllMcpTools(mockConfig);

    expect(manager.getServerInstructions()).toEqual(
      new Map([['with-instructions', 'Use concise replies.']]),
    );
  });

  it('should not discover tools if folder is not trusted', async () => {
    const mockedMcpClient = {
      connect: vi.fn(),
      discover: vi.fn(),
      disconnect: vi.fn(),
      getStatus: vi.fn(),
    };
    vi.mocked(McpClient).mockReturnValue(
      mockedMcpClient as unknown as McpClient,
    );
    const mockConfig = {
      isTrustedFolder: () => false,
      getMcpServers: () => ({ 'test-server': {} }),
      getMcpServerCommand: () => undefined,
      getTargetDir: () => '/session/worktree',
      getResourceRegistry: () => ({ removeResourcesByServer: vi.fn() }),
      getPromptRegistry: () => ({ removePromptsByServer: vi.fn() }),
      getWorkspaceContext: () => ({}),
      getDebugMode: () => false,
      isMcpServerDisabled: () => false,
    } as unknown as Config;
    const manager = mkManager({ config: mockConfig });
    await manager.discoverAllMcpTools(mockConfig);
    expect(mockedMcpClient.connect).not.toHaveBeenCalled();
    expect(mockedMcpClient.discover).not.toHaveBeenCalled();
  });

  it('should not discover a single server if folder is not trusted', async () => {
    const mockedMcpClient = {
      connect: vi.fn(),
      discover: vi.fn(),
      disconnect: vi.fn(),
      getStatus: vi.fn(),
    };
    vi.mocked(McpClient).mockReturnValue(
      mockedMcpClient as unknown as McpClient,
    );
    const mockConfig = {
      isTrustedFolder: () => false,
      getMcpServers: () => ({ 'test-server': {} }),
      getMcpServerCommand: () => undefined,
      getTargetDir: () => '/session/worktree',
      getResourceRegistry: () => ({ removeResourcesByServer: vi.fn() }),
      getPromptRegistry: () => ({ removePromptsByServer: vi.fn() }),
      getWorkspaceContext: () => ({}),
      getDebugMode: () => false,
      isMcpServerDisabled: () => false,
      isMcpServerPendingApproval: () => false,
    } as unknown as Config;
    const manager = new McpClientManager(mockConfig, {} as ToolRegistry);

    await manager.discoverMcpToolsForServer('test-server', mockConfig);

    expect(McpClient).not.toHaveBeenCalled();
    expect(mockedMcpClient.connect).not.toHaveBeenCalled();
    expect(mockedMcpClient.discover).not.toHaveBeenCalled();
  });

  it('should not connect a project server that is pending approval (#4615)', async () => {
    const mockedMcpClient = {
      connect: vi.fn(),
      discover: vi.fn(),
      disconnect: vi.fn(),
      getStatus: vi.fn(),
    };
    vi.mocked(McpClient).mockReturnValue(
      mockedMcpClient as unknown as McpClient,
    );
    const mockConfig = {
      isTrustedFolder: () => true,
      getMcpServers: () => ({ 'pending-server': { scope: 'project' } }),
      getMcpServerCommand: () => undefined,
      getTargetDir: () => '/session/worktree',
      getResourceRegistry: () => ({ removeResourcesByServer: vi.fn() }),
      getPromptRegistry: () => ({ removePromptsByServer: vi.fn() }),
      getWorkspaceContext: () => ({}),
      getDebugMode: () => false,
      isMcpServerDisabled: () => false,
      isMcpServerPendingApproval: (name: string) => name === 'pending-server',
    } as unknown as Config;
    const manager = new McpClientManager(mockConfig, {} as ToolRegistry);
    await manager.discoverAllMcpTools(mockConfig);
    // The gate runs before `new McpClient(...)` — no client is even constructed,
    // so no stdio spawn / transport / health check can occur.
    expect(McpClient).not.toHaveBeenCalled();
    expect(mockedMcpClient.connect).not.toHaveBeenCalled();
    expect(mockedMcpClient.discover).not.toHaveBeenCalled();
  });

  it('connects an approved project server (not pending)', async () => {
    const mockedMcpClient = {
      connect: vi.fn(),
      discover: vi.fn(),
      disconnect: vi.fn(),
      getStatus: vi.fn(),
    };
    vi.mocked(McpClient).mockReturnValue(
      mockedMcpClient as unknown as McpClient,
    );
    const mockConfig = {
      isTrustedFolder: () => true,
      getMcpServers: () => ({ 'approved-server': { scope: 'project' } }),
      getMcpServerCommand: () => undefined,
      getTargetDir: () => '/session/worktree',
      getResourceRegistry: () => ({ removeResourcesByServer: vi.fn() }),
      getPromptRegistry: () => ({ removePromptsByServer: vi.fn() }),
      getWorkspaceContext: () => ({}),
      getDebugMode: () => false,
      isMcpServerDisabled: () => false,
      isMcpServerPendingApproval: () => false,
    } as unknown as Config;
    const manager = new McpClientManager(mockConfig, {} as ToolRegistry);
    await manager.discoverAllMcpTools(mockConfig);
    expect(mockedMcpClient.connect).toHaveBeenCalledOnce();
    expect(mockedMcpClient.discover).toHaveBeenCalledOnce();
  });

  it('should disconnect all clients when stop is called', async () => {
    // Track disconnect calls across all instances
    const disconnectCalls: string[] = [];
    vi.mocked(McpClient).mockImplementation(
      (name: string) =>
        ({
          connect: vi.fn(),
          discover: vi.fn(),
          disconnect: vi.fn().mockImplementation(() => {
            disconnectCalls.push(name);
            return Promise.resolve();
          }),
          getStatus: vi.fn(),
        }) as unknown as McpClient,
    );
    const mockConfig = {
      isTrustedFolder: () => true,
      getMcpServers: () => ({ 'test-server': {}, 'another-server': {} }),
      getMcpServerCommand: () => undefined,
      getTargetDir: () => '/session/worktree',
      getPromptRegistry: () =>
        ({ removePromptsByServer: vi.fn() }) as unknown as PromptRegistry,
      getResourceRegistry: () => ({ removeResourcesByServer: vi.fn() }),
      getWorkspaceContext: () => ({}) as WorkspaceContext,
      getDebugMode: () => false,
      isMcpServerDisabled: () => false,
    } as unknown as Config;
    const manager = mkManager({ config: mockConfig });
    // First connect to create the clients
    await manager.discoverAllMcpTools({
      isTrustedFolder: () => true,
      isMcpServerDisabled: () => false,
    } as unknown as Config);

    // Clear the disconnect calls from initial stop() in discoverAllMcpTools
    disconnectCalls.length = 0;

    // Then stop
    await manager.stop();
    expect(disconnectCalls).toHaveLength(2);
    expect(disconnectCalls).toContain('test-server');
    expect(disconnectCalls).toContain('another-server');
  });

  it('should be idempotent - stop can be called multiple times safely', async () => {
    const mockedMcpClient = {
      connect: vi.fn(),
      discover: vi.fn(),
      disconnect: vi.fn().mockResolvedValue(undefined),
      getStatus: vi.fn(),
    };
    vi.mocked(McpClient).mockReturnValue(
      mockedMcpClient as unknown as McpClient,
    );
    const mockConfig = {
      isTrustedFolder: () => true,
      getMcpServers: () => ({ 'test-server': {} }),
      getMcpServerCommand: () => undefined,
      getTargetDir: () => '/session/worktree',
      getPromptRegistry: () =>
        ({ removePromptsByServer: vi.fn() }) as unknown as PromptRegistry,
      getResourceRegistry: () => ({ removeResourcesByServer: vi.fn() }),
      getWorkspaceContext: () => ({}) as WorkspaceContext,
      getDebugMode: () => false,
      isMcpServerDisabled: () => false,
    } as unknown as Config;
    const manager = mkManager({ config: mockConfig });
    await manager.discoverAllMcpTools({
      isTrustedFolder: () => true,
      isMcpServerDisabled: () => false,
    } as unknown as Config);

    // Call stop multiple times - should not throw
    await manager.stop();
    await manager.stop();
    await manager.stop();
  });

  it('should discover tools for a single server and track the client for stop', async () => {
    const mockedMcpClient = {
      connect: vi.fn(),
      discover: vi.fn(),
      disconnect: vi.fn().mockResolvedValue(undefined),
      getStatus: vi.fn(),
    };
    vi.mocked(McpClient).mockReturnValue(
      mockedMcpClient as unknown as McpClient,
    );

    const mockConfig = {
      isTrustedFolder: () => true,
      getMcpServers: () => ({ 'test-server': {} }),
      getMcpServerCommand: () => undefined,
      getTargetDir: () => '/session/worktree',
      getPromptRegistry: () =>
        ({ removePromptsByServer: vi.fn() }) as unknown as PromptRegistry,
      getResourceRegistry: () => ({ removeResourcesByServer: vi.fn() }),
      getWorkspaceContext: () => ({}) as WorkspaceContext,
      getDebugMode: () => false,
    } as unknown as Config;
    const manager = mkManager({ config: mockConfig });

    await manager.discoverMcpToolsForServer(
      'test-server',
      {} as unknown as Config,
    );

    expect(mockedMcpClient.connect).toHaveBeenCalledOnce();
    expect(mockedMcpClient.discover).toHaveBeenCalledOnce();

    await manager.stop();
    expect(mockedMcpClient.disconnect).toHaveBeenCalledOnce();
  });

  it('should replace an existing client when re-discovering a server', async () => {
    const firstClient = {
      connect: vi.fn(),
      discover: vi.fn(),
      disconnect: vi.fn().mockResolvedValue(undefined),
      getStatus: vi.fn(),
    };
    const secondClient = {
      connect: vi.fn(),
      discover: vi.fn(),
      disconnect: vi.fn().mockResolvedValue(undefined),
      getStatus: vi.fn(),
    };

    vi.mocked(McpClient)
      .mockReturnValueOnce(firstClient as unknown as McpClient)
      .mockReturnValueOnce(secondClient as unknown as McpClient);

    const mockConfig = {
      isTrustedFolder: () => true,
      getMcpServers: () => ({ 'test-server': {} }),
      getMcpServerCommand: () => undefined,
      getTargetDir: () => '/session/worktree',
      getPromptRegistry: () =>
        ({ removePromptsByServer: vi.fn() }) as unknown as PromptRegistry,
      getResourceRegistry: () => ({ removeResourcesByServer: vi.fn() }),
      getWorkspaceContext: () => ({}) as WorkspaceContext,
      getDebugMode: () => false,
    } as unknown as Config;
    const manager = mkManager({ config: mockConfig });

    await manager.discoverMcpToolsForServer(
      'test-server',
      {} as unknown as Config,
    );
    await manager.discoverMcpToolsForServer(
      'test-server',
      {} as unknown as Config,
    );

    expect(firstClient.disconnect).toHaveBeenCalledOnce();
    expect(secondClient.connect).toHaveBeenCalledOnce();
    expect(secondClient.discover).toHaveBeenCalledOnce();

    await manager.stop();
    expect(secondClient.disconnect).toHaveBeenCalledOnce();
  });

  it('should coalesce concurrent discovery for the same server', async () => {
    let resolveDisconnect!: () => void;
    const disconnectPromise = new Promise<void>((resolve) => {
      resolveDisconnect = resolve;
    });
    const firstClient = {
      connect: vi.fn().mockResolvedValue(undefined),
      discover: vi.fn().mockResolvedValue(undefined),
      disconnect: vi.fn(() => disconnectPromise),
      getStatus: vi.fn(),
    };
    const replacementClients: Array<{
      connect: ReturnType<typeof vi.fn>;
      discover: ReturnType<typeof vi.fn>;
      disconnect: ReturnType<typeof vi.fn>;
      getStatus: ReturnType<typeof vi.fn>;
    }> = [];

    vi.mocked(McpClient).mockImplementation(() => {
      if (vi.mocked(McpClient).mock.calls.length === 1) {
        return firstClient as unknown as McpClient;
      }

      const replacementClient = {
        connect: vi.fn().mockResolvedValue(undefined),
        discover: vi.fn().mockResolvedValue(undefined),
        disconnect: vi.fn().mockResolvedValue(undefined),
        getStatus: vi.fn(),
      };
      replacementClients.push(replacementClient);
      return replacementClient as unknown as McpClient;
    });

    const mockConfig = {
      isTrustedFolder: () => true,
      getMcpServers: () => ({ 'test-server': {} }),
      getMcpServerCommand: () => undefined,
      getTargetDir: () => '/session/worktree',
      getPromptRegistry: () =>
        ({ removePromptsByServer: vi.fn() }) as unknown as PromptRegistry,
      getResourceRegistry: () => ({ removeResourcesByServer: vi.fn() }),
      getWorkspaceContext: () => ({}) as WorkspaceContext,
      getDebugMode: () => false,
    } as unknown as Config;
    const manager = mkManager({ config: mockConfig });

    await manager.discoverMcpToolsForServer(
      'test-server',
      {} as unknown as Config,
    );

    const firstRediscovery = manager.discoverMcpToolsForServer(
      'test-server',
      {} as unknown as Config,
    );
    await Promise.resolve();

    const secondRediscovery = manager.discoverMcpToolsForServer(
      'test-server',
      {} as unknown as Config,
    );
    const disconnectCallsBeforeResolve =
      firstClient.disconnect.mock.calls.length;

    resolveDisconnect();
    await Promise.all([firstRediscovery, secondRediscovery]);

    expect(disconnectCallsBeforeResolve).toBe(1);
    expect(vi.mocked(McpClient)).toHaveBeenCalledTimes(2);
    expect(replacementClients).toHaveLength(1);
    expect(replacementClients[0].connect).toHaveBeenCalledOnce();
    expect(replacementClients[0].discover).toHaveBeenCalledOnce();

    // Verify map was cleaned up: a third call should do real work,
    // not get coalesced into a stale promise.
    await manager.discoverMcpToolsForServer(
      'test-server',
      {} as unknown as Config,
    );

    expect(vi.mocked(McpClient)).toHaveBeenCalledTimes(3);
    expect(replacementClients).toHaveLength(2);
    expect(replacementClients[1].connect).toHaveBeenCalledOnce();
    expect(replacementClients[1].discover).toHaveBeenCalledOnce();
  });

  it('should restore health checks after failed server rediscovery', async () => {
    vi.useFakeTimers();

    const firstClient = {
      connect: vi.fn().mockResolvedValue(undefined),
      discover: vi.fn().mockResolvedValue(undefined),
      disconnect: vi.fn().mockResolvedValue(undefined),
      getStatus: vi.fn(),
    };
    const failedClient = {
      connect: vi.fn().mockRejectedValue(new Error('transient failure')),
      discover: vi.fn(),
      disconnect: vi.fn().mockResolvedValue(undefined),
      getStatus: vi.fn(),
    };
    vi.mocked(McpClient)
      .mockReturnValueOnce(firstClient as unknown as McpClient)
      .mockReturnValueOnce(failedClient as unknown as McpClient);

    const mockConfig = {
      isTrustedFolder: () => true,
      getMcpServers: () => ({ 'test-server': {} }),
      getMcpServerCommand: () => undefined,
      getTargetDir: () => '/session/worktree',
      getPromptRegistry: () =>
        ({ removePromptsByServer: vi.fn() }) as unknown as PromptRegistry,
      getResourceRegistry: () => ({ removeResourcesByServer: vi.fn() }),
      getWorkspaceContext: () => ({}) as WorkspaceContext,
      getDebugMode: () => false,
    } as unknown as Config;
    const manager = mkManager({
      config: mockConfig,
      options: {
        healthConfig: {
          autoReconnect: true,
          checkIntervalMs: 10,
          maxConsecutiveFailures: 1,
          reconnectDelayMs: 10,
        },
      },
    });

    try {
      await manager.discoverMcpToolsForServer(
        'test-server',
        {} as unknown as Config,
      );
      expect(
        (
          manager as unknown as {
            healthCheckTimers: Map<string, NodeJS.Timeout>;
          }
        ).healthCheckTimers.has('test-server'),
      ).toBe(true);

      await manager.discoverMcpToolsForServer(
        'test-server',
        {} as unknown as Config,
      );

      expect(failedClient.connect).toHaveBeenCalledOnce();
      expect(
        (
          manager as unknown as {
            healthCheckTimers: Map<string, NodeJS.Timeout>;
          }
        ).healthCheckTimers.has('test-server'),
      ).toBe(true);
    } finally {
      await manager.stop();
      vi.useRealTimers();
    }
  });

  it('unrefs health-check timers so they never hold the event loop open (issue #9944)', async () => {
    // `qwen mcp reconnect` (and other short-lived Config consumers) call
    // `config.shutdown()` while an incremental discovery pass is still in
    // flight; that pass's `finally` block re-arms health checks AFTER
    // `stop()` cleared them. Pre-fix those intervals were ref'd, so the
    // process hung forever. Health monitoring is background bookkeeping —
    // the timer must be unref'd so it never keeps the loop alive on its own.
    // Real timers here: the assertion is about `hasRef()`, which fake timers
    // do not model faithfully.
    const client = {
      connect: vi.fn().mockResolvedValue(undefined),
      discover: vi.fn().mockResolvedValue(undefined),
      disconnect: vi.fn().mockResolvedValue(undefined),
      getStatus: vi.fn(),
    };
    vi.mocked(McpClient).mockReturnValue(client as unknown as McpClient);

    const mockConfig = {
      isTrustedFolder: () => true,
      getMcpServers: () => ({ 'test-server': {} }),
      getMcpServerCommand: () => undefined,
      getTargetDir: () => '/session/worktree',
      getPromptRegistry: () =>
        ({ removePromptsByServer: vi.fn() }) as unknown as PromptRegistry,
      getResourceRegistry: () => ({ removeResourcesByServer: vi.fn() }),
      getWorkspaceContext: () => ({}) as WorkspaceContext,
      getDebugMode: () => false,
    } as unknown as Config;
    const manager = mkManager({
      config: mockConfig,
      options: {
        healthConfig: {
          autoReconnect: true,
          // Long interval: we only inspect the armed timer, we never let it
          // fire.
          checkIntervalMs: 60_000,
          maxConsecutiveFailures: 3,
          reconnectDelayMs: 10,
        },
      },
    });

    try {
      await manager.discoverMcpToolsForServer(
        'test-server',
        {} as unknown as Config,
      );
      const timer = (
        manager as unknown as {
          healthCheckTimers: Map<string, NodeJS.Timeout>;
        }
      ).healthCheckTimers.get('test-server');
      expect(timer).toBeDefined();
      expect(timer?.hasRef()).toBe(false);
    } finally {
      await manager.stop();
    }
  });

  it('should clear in-flight discovery tracking when stopping', async () => {
    let resolveConnect!: () => void;
    const connectPromise = new Promise<void>((resolve) => {
      resolveConnect = resolve;
    });
    const mockedMcpClient = {
      connect: vi.fn(() => connectPromise),
      discover: vi.fn().mockResolvedValue(undefined),
      disconnect: vi.fn().mockResolvedValue(undefined),
      getStatus: vi.fn(),
    };
    vi.mocked(McpClient).mockReturnValue(
      mockedMcpClient as unknown as McpClient,
    );

    const mockConfig = {
      isTrustedFolder: () => true,
      getMcpServers: () => ({ 'test-server': {} }),
      getMcpServerCommand: () => undefined,
      getTargetDir: () => '/session/worktree',
      getPromptRegistry: () =>
        ({ removePromptsByServer: vi.fn() }) as unknown as PromptRegistry,
      getResourceRegistry: () => ({ removeResourcesByServer: vi.fn() }),
      getWorkspaceContext: () => ({}) as WorkspaceContext,
      getDebugMode: () => false,
    } as unknown as Config;
    const manager = mkManager({ config: mockConfig });

    const discovery = manager.discoverMcpToolsForServer(
      'test-server',
      {} as unknown as Config,
    );
    await Promise.resolve();

    expect(
      (
        manager as unknown as {
          serverDiscoveryPromises: Map<string, Promise<void>>;
        }
      ).serverDiscoveryPromises.has('test-server'),
    ).toBe(true);

    await manager.stop();

    expect(
      (
        manager as unknown as {
          serverDiscoveryPromises: Map<string, Promise<void>>;
        }
      ).serverDiscoveryPromises.has('test-server'),
    ).toBe(false);

    resolveConnect();
    await discovery;
  });

  it('should no-op when discovering an unknown server', async () => {
    const mockedMcpClient = {
      connect: vi.fn(),
      discover: vi.fn(),
      disconnect: vi.fn().mockResolvedValue(undefined),
      getStatus: vi.fn(),
    };
    vi.mocked(McpClient).mockReturnValue(
      mockedMcpClient as unknown as McpClient,
    );

    const mockConfig = {
      isTrustedFolder: () => true,
      getMcpServers: () => ({}),
      getMcpServerCommand: () => undefined,
      getTargetDir: () => '/session/worktree',
      getPromptRegistry: () =>
        ({ removePromptsByServer: vi.fn() }) as unknown as PromptRegistry,
      getResourceRegistry: () => ({ removeResourcesByServer: vi.fn() }),
      getWorkspaceContext: () => ({}) as WorkspaceContext,
      getDebugMode: () => false,
    } as unknown as Config;
    const manager = mkManager({ config: mockConfig });

    await manager.discoverMcpToolsForServer('unknown-server', {
      isTrustedFolder: () => true,
    } as unknown as Config);

    expect(vi.mocked(McpClient)).not.toHaveBeenCalled();
  });

  it('discoverAllMcpToolsIncremental enforces a per-server discoveryTimeoutMs', async () => {
    // A stdio server whose `connect` hangs forever. The 50ms per-server
    // timeout should fire and surface as a swallowed error, leaving the
    // manager in COMPLETED state instead of stuck.
    let neverResolve!: () => void;
    const hung = new Promise<void>((resolve) => {
      neverResolve = resolve;
    });
    const mockedMcpClient = {
      connect: vi.fn().mockReturnValue(hung),
      discover: vi.fn().mockResolvedValue(undefined),
      disconnect: vi.fn().mockResolvedValue(undefined),
      getStatus: vi.fn(),
    };
    vi.mocked(McpClient).mockReturnValue(
      mockedMcpClient as unknown as McpClient,
    );

    const mockConfig = {
      isTrustedFolder: () => true,
      getMcpServers: () => ({
        broken: { command: 'node', args: [], discoveryTimeoutMs: 50 },
      }),
      getMcpServerCommand: () => undefined,
      getTargetDir: () => '/session/worktree',
      getPromptRegistry: () =>
        ({ removePromptsByServer: vi.fn() }) as unknown as PromptRegistry,
      getResourceRegistry: () => ({ removeResourcesByServer: vi.fn() }),
      getWorkspaceContext: () => ({}) as WorkspaceContext,
      getDebugMode: () => false,
      isMcpServerDisabled: () => false,
    } as unknown as Config;
    const manager = mkManager({
      config: mockConfig,
      toolRegistry: {
        removeMcpToolsByServer: vi.fn(),
      } as unknown as ToolRegistry,
    });

    const t0 = Date.now();
    await manager.discoverAllMcpToolsIncremental(mockConfig);
    const elapsed = Date.now() - t0;

    expect(elapsed).toBeGreaterThanOrEqual(40);
    // Generous upper bound — the 50ms timeout should fire well within 2s
    // even on a heavily-loaded CI runner.
    expectWithinLatencyBudget(elapsed, 2000);
    // discoveryAllMcpToolsIncremental must always settle the state, even
    // when every server times out. Otherwise the cli's deferred-finalize
    // path would hang forever.
    expect(manager.getDiscoveryState()).toBe(
      (await import('./mcp-client.js')).MCPDiscoveryState.COMPLETED,
    );

    // Cleanup the stuck connect so test doesn't leak a pending promise.
    neverResolve();
  });

  it('discoverAllMcpToolsIncremental skips servers flagged as disabled', async () => {
    // PR-A regression guard: the new incremental path used to iterate
    // `Object.entries(servers)` without consulting `isMcpServerDisabled`,
    // so a server the user had explicitly disabled (e.g. via
    // `mcpServers.foo.disabled: true`) would still get connected and its
    // tools registered. Mirrors the existing protection in
    // `discoverAllMcpTools`.
    const mockedMcpClient = {
      connect: vi.fn().mockResolvedValue(undefined),
      discover: vi.fn().mockResolvedValue(undefined),
      disconnect: vi.fn().mockResolvedValue(undefined),
      getStatus: vi.fn(),
    };
    vi.mocked(McpClient).mockReturnValue(
      mockedMcpClient as unknown as McpClient,
    );
    const mockConfig = {
      isTrustedFolder: () => true,
      getMcpServers: () => ({
        enabled: { command: 'node', args: [] },
        disabled: { command: 'node', args: [] },
      }),
      getMcpServerCommand: () => undefined,
      getTargetDir: () => '/session/worktree',
      getPromptRegistry: () =>
        ({ removePromptsByServer: vi.fn() }) as unknown as PromptRegistry,
      getResourceRegistry: () => ({ removeResourcesByServer: vi.fn() }),
      getWorkspaceContext: () => ({}) as WorkspaceContext,
      getDebugMode: () => false,
      isMcpServerDisabled: (name: string) => name === 'disabled',
    } as unknown as Config;
    const manager = mkManager({ config: mockConfig });

    await manager.discoverAllMcpToolsIncremental(mockConfig);

    // Only the enabled server should have driven a discover; the disabled
    // one is skipped before any connect attempt.
    expect(mockedMcpClient.connect).toHaveBeenCalledTimes(1);
    expect(mockedMcpClient.discover).toHaveBeenCalledTimes(1);
  });

  it('discoverAllMcpToolsIncremental tears down enabled→disabled transitions', async () => {
    // Mid-session, the user disables a previously-connected server (e.g.
    // via `/mcp disable foo` or by editing settings). The incremental
    // path must tear down the existing client, drop its registered tools,
    // stop its health check, and remove its global status — otherwise
    // the Footer pill keeps counting it, its tools stay live in the
    // ToolRegistry, and the health-check loop keeps probing a server
    // the user has told us to ignore.
    const mockedMcpClient = {
      connect: vi.fn().mockResolvedValue(undefined),
      discover: vi.fn().mockResolvedValue(undefined),
      disconnect: vi.fn().mockResolvedValue(undefined),
      getStatus: vi.fn(),
    };
    vi.mocked(McpClient).mockReturnValue(
      mockedMcpClient as unknown as McpClient,
    );

    const removeMcpToolsByServer = vi.fn();
    const toolRegistryStub = {
      removeMcpToolsByServer,
    } as unknown as ToolRegistry;

    let disabled = false;
    const mockConfig = {
      isTrustedFolder: () => true,
      getMcpServers: () => ({ foo: { command: 'node', args: [] } }),
      getMcpServerCommand: () => undefined,
      getTargetDir: () => '/session/worktree',
      getPromptRegistry: () =>
        ({ removePromptsByServer: vi.fn() }) as unknown as PromptRegistry,
      getResourceRegistry: () => ({ removeResourcesByServer: vi.fn() }),
      getWorkspaceContext: () => ({}) as WorkspaceContext,
      getDebugMode: () => false,
      isMcpServerDisabled: (name: string) => name === 'foo' && disabled,
    } as unknown as Config;
    const manager = mkManager({
      config: mockConfig,
      toolRegistry: toolRegistryStub,
    });

    // First pass: server enabled, gets connected.
    await manager.discoverAllMcpToolsIncremental(mockConfig);
    expect(mockedMcpClient.connect).toHaveBeenCalledTimes(1);
    expect(mockedMcpClient.disconnect).not.toHaveBeenCalled();

    // Now disable mid-session and re-run incremental discovery.
    disabled = true;
    await manager.discoverAllMcpToolsIncremental(mockConfig);

    // The previously-connected client must be disconnected and its tools
    // dropped from the registry.
    expect(mockedMcpClient.disconnect).toHaveBeenCalledTimes(1);
    expect(removeMcpToolsByServer).toHaveBeenCalledWith('foo');
    // And no fresh connect was attempted (the disabled branch fires
    // before serversToUpdate is populated).
    expect(mockedMcpClient.connect).toHaveBeenCalledTimes(1);
  });

  it('discoverAllMcpToolsIncremental reconnects a still-connected server when its config fingerprint changes', async () => {
    // Single-session reconcile parity with the pool path's `desiredIds`
    // diff: editing a live server's config at runtime (here `args`) must
    // tear down the stale connection and reconnect with the new config —
    // otherwise the server keeps running on the old command/env/url.
    // Without fingerprint tracking, an already-connected server fell into
    // the no-op else branch and the edit was silently ignored.
    const { MCPServerStatus } = await import('./mcp-client.js');
    const mockedMcpClient = {
      connect: vi.fn().mockResolvedValue(undefined),
      discover: vi.fn().mockResolvedValue(undefined),
      disconnect: vi.fn().mockResolvedValue(undefined),
      getStatus: vi.fn().mockReturnValue(MCPServerStatus.CONNECTED),
    };
    vi.mocked(McpClient).mockReturnValue(
      mockedMcpClient as unknown as McpClient,
    );

    const removePromptsByServer = vi.fn();
    const removeResourcesByServer = vi.fn();
    const removeMcpToolsByServer = vi.fn();
    const toolRegistryStub = {
      removeMcpToolsByServer,
    } as unknown as ToolRegistry;
    let args: string[] = [];
    const mockConfig = {
      isTrustedFolder: () => true,
      getMcpServers: () => ({ foo: { command: 'node', args } }),
      getMcpServerCommand: () => undefined,
      getTargetDir: () => '/session/worktree',
      getPromptRegistry: () =>
        ({ removePromptsByServer }) as unknown as PromptRegistry,
      getResourceRegistry: () => ({ removeResourcesByServer }),
      getWorkspaceContext: () => ({}) as WorkspaceContext,
      getDebugMode: () => false,
      isMcpServerDisabled: () => false,
    } as unknown as Config;
    const manager = mkManager({
      config: mockConfig,
      toolRegistry: toolRegistryStub,
    });

    // First pass: connects and records the fingerprint of `args: []`.
    await manager.discoverAllMcpToolsIncremental(mockConfig);
    expect(mockedMcpClient.connect).toHaveBeenCalledTimes(1);
    expect(mockedMcpClient.disconnect).not.toHaveBeenCalled();

    // Re-running with an identical config must NOT churn the connection
    // (fingerprint unchanged → no-op).
    await manager.discoverAllMcpToolsIncremental(mockConfig);
    expect(mockedMcpClient.connect).toHaveBeenCalledTimes(1);
    expect(mockedMcpClient.disconnect).not.toHaveBeenCalled();

    // Now change the config in place. The fingerprint differs, so the
    // still-connected server is disconnected and reconnected.
    removeMcpToolsByServer.mockClear();
    removePromptsByServer.mockClear();
    removeResourcesByServer.mockClear();
    args = ['--flag'];
    await manager.discoverAllMcpToolsIncremental(mockConfig);
    expect(mockedMcpClient.disconnect).toHaveBeenCalledTimes(1);
    expect(mockedMcpClient.connect).toHaveBeenCalledTimes(2);
    // The OLD config's tools/prompts/resources MUST be purged before
    // rediscovery, so a changed server that drops/renames entries doesn't leave
    // stale ones registered against the now-closed client.
    expect(removeMcpToolsByServer).toHaveBeenCalledWith('foo');
    expect(removePromptsByServer).toHaveBeenCalledWith('foo');
    expect(removeResourcesByServer).toHaveBeenCalledWith('foo');
  });

  it('reconnects a still-connected server when only a discovery filter (includeTools) changes', async () => {
    // trust / includeTools / excludeTools are excluded from connectionIdOf
    // (transport identity), but they ARE applied during discover() and baked
    // into the registered tools. The single-session reconcile must therefore
    // reconnect when they change — otherwise the edit is silently ignored until
    // a manual reconnect/restart.
    const { MCPServerStatus } = await import('./mcp-client.js');
    const mockedMcpClient = {
      connect: vi.fn().mockResolvedValue(undefined),
      discover: vi.fn().mockResolvedValue(undefined),
      disconnect: vi.fn().mockResolvedValue(undefined),
      getStatus: vi.fn().mockReturnValue(MCPServerStatus.CONNECTED),
    };
    vi.mocked(McpClient).mockReturnValue(
      mockedMcpClient as unknown as McpClient,
    );

    let includeTools: string[] | undefined = undefined;
    const mockConfig = {
      isTrustedFolder: () => true,
      // command/args/env unchanged across passes → transport fingerprint stays
      // identical; only the per-session filter changes.
      getMcpServers: () => ({ foo: { command: 'node', includeTools } }),
      getMcpServerCommand: () => undefined,
      getTargetDir: () => '/session/worktree',
      getPromptRegistry: () =>
        ({ removePromptsByServer: vi.fn() }) as unknown as PromptRegistry,
      getResourceRegistry: () => ({ removeResourcesByServer: vi.fn() }),
      getWorkspaceContext: () => ({}) as WorkspaceContext,
      getDebugMode: () => false,
      isMcpServerDisabled: () => false,
    } as unknown as Config;
    const manager = mkManager({ config: mockConfig });

    await manager.discoverAllMcpToolsIncremental(mockConfig);
    expect(mockedMcpClient.connect).toHaveBeenCalledTimes(1);

    // Identical config → no churn.
    await manager.discoverAllMcpToolsIncremental(mockConfig);
    expect(mockedMcpClient.connect).toHaveBeenCalledTimes(1);
    expect(mockedMcpClient.disconnect).not.toHaveBeenCalled();

    // Change ONLY includeTools — connectionIdOf is unchanged, but the
    // discovery-aware key differs → reconnect so discover() re-applies it.
    includeTools = ['allowed_tool'];
    await manager.discoverAllMcpToolsIncremental(mockConfig);
    expect(mockedMcpClient.disconnect).toHaveBeenCalledTimes(1);
    expect(mockedMcpClient.connect).toHaveBeenCalledTimes(2);
  });

  it('normalizes duplicate filters but reconnects when alwaysLoadTools changes', async () => {
    const { MCPServerStatus } = await import('./mcp-client.js');
    const mockedMcpClient = {
      connect: vi.fn().mockResolvedValue(undefined),
      discover: vi.fn().mockResolvedValue(undefined),
      disconnect: vi.fn().mockResolvedValue(undefined),
      getStatus: vi.fn().mockReturnValue(MCPServerStatus.CONNECTED),
    };
    vi.mocked(McpClient).mockReturnValue(
      mockedMcpClient as unknown as McpClient,
    );

    let serverConfig = {
      command: 'node',
      includeTools: ['alpha(args)', 'alpha(args)', 'beta'],
      alwaysLoadTools: false,
    } as MCPServerConfig;
    const mockConfig = {
      isTrustedFolder: () => true,
      getMcpServers: () => ({ foo: serverConfig }),
      getMcpServerCommand: () => undefined,
      getTargetDir: () => '/session/worktree',
      getPromptRegistry: () =>
        ({ removePromptsByServer: vi.fn() }) as unknown as PromptRegistry,
      getResourceRegistry: () => ({ removeResourcesByServer: vi.fn() }),
      getWorkspaceContext: () => ({}) as WorkspaceContext,
      getDebugMode: () => false,
      isMcpServerDisabled: () => false,
    } as unknown as Config;
    const manager = mkManager({ config: mockConfig });

    await manager.discoverAllMcpToolsIncremental(mockConfig);
    serverConfig = {
      command: 'node',
      includeTools: ['beta', 'alpha'],
      alwaysLoadTools: false,
    } as MCPServerConfig;
    await manager.discoverAllMcpToolsIncremental(mockConfig);
    expect(mockedMcpClient.disconnect).not.toHaveBeenCalled();

    serverConfig = { ...serverConfig, alwaysLoadTools: true };
    await manager.discoverAllMcpToolsIncremental(mockConfig);
    expect(mockedMcpClient.disconnect).toHaveBeenCalledTimes(1);
    expect(mockedMcpClient.connect).toHaveBeenCalledTimes(2);
  });

  it('reconnects legacy discovery when includeTools changes from absent to empty', async () => {
    const { MCPServerStatus } = await import('./mcp-client.js');
    const mockedMcpClient = {
      connect: vi.fn().mockResolvedValue(undefined),
      discover: vi.fn().mockResolvedValue(undefined),
      disconnect: vi.fn().mockResolvedValue(undefined),
      getStatus: vi.fn().mockReturnValue(MCPServerStatus.CONNECTED),
    };
    vi.mocked(McpClient).mockReturnValue(
      mockedMcpClient as unknown as McpClient,
    );

    const settings: { includeTools?: string[] } = {};
    const mockConfig = {
      isTrustedFolder: () => true,
      getMcpServers: () => ({
        foo: {
          command: 'node',
          includeTools: settings.includeTools,
        } as MCPServerConfig,
      }),
      getMcpServerCommand: () => undefined,
      getTargetDir: () => '/session/worktree',
      getPromptRegistry: () =>
        ({ removePromptsByServer: vi.fn() }) as unknown as PromptRegistry,
      getResourceRegistry: () => ({ removeResourcesByServer: vi.fn() }),
      getWorkspaceContext: () => ({}) as WorkspaceContext,
      getDebugMode: () => false,
      isMcpServerDisabled: () => false,
    } as unknown as Config;
    const manager = mkManager({ config: mockConfig });

    await manager.discoverAllMcpToolsIncremental(mockConfig);
    settings.includeTools = [];
    await manager.discoverAllMcpToolsIncremental(mockConfig);

    expect(mockedMcpClient.disconnect).toHaveBeenCalledTimes(1);
    expect(mockedMcpClient.connect).toHaveBeenCalledTimes(2);
  });

  it('reconnects a server first connected via the bulk path when its config later changes', async () => {
    // Regression: the bulk `discoverAllMcpTools` path (reached via legacy
    // blocking boot + extension reload) used to connect WITHOUT recording a
    // fingerprint. A subsequent `discoverAllMcpToolsIncremental` then saw an
    // `undefined` fingerprint on the still-connected server, short-circuited
    // the reconcile guard, and silently dropped the edit — the server kept
    // running stale config. Both connect paths must record the fingerprint so
    // the invariant the guard relies on actually holds.
    const { MCPServerStatus } = await import('./mcp-client.js');
    const mockedMcpClient = {
      connect: vi.fn().mockResolvedValue(undefined),
      discover: vi.fn().mockResolvedValue(undefined),
      disconnect: vi.fn().mockResolvedValue(undefined),
      getStatus: vi.fn().mockReturnValue(MCPServerStatus.CONNECTED),
    };
    vi.mocked(McpClient).mockReturnValue(
      mockedMcpClient as unknown as McpClient,
    );

    const removePromptsByServer = vi.fn();
    const removeResourcesByServer = vi.fn();
    const removeMcpToolsByServer = vi.fn();
    const toolRegistryStub = {
      removeMcpToolsByServer,
    } as unknown as ToolRegistry;
    let args: string[] = [];
    const mockConfig = {
      isTrustedFolder: () => true,
      getMcpServers: () => ({ foo: { command: 'node', args } }),
      getMcpServerCommand: () => undefined,
      getTargetDir: () => '/session/worktree',
      getPromptRegistry: () =>
        ({ removePromptsByServer }) as unknown as PromptRegistry,
      getResourceRegistry: () => ({ removeResourcesByServer }),
      getWorkspaceContext: () => ({}) as WorkspaceContext,
      getDebugMode: () => false,
      isMcpServerDisabled: () => false,
    } as unknown as Config;
    const manager = mkManager({
      config: mockConfig,
      toolRegistry: toolRegistryStub,
    });

    // First connect via the BULK path (not the incremental path) — this is the
    // path that previously left the fingerprint unset.
    await manager.discoverAllMcpTools(mockConfig);
    expect(mockedMcpClient.connect).toHaveBeenCalledTimes(1);
    expect(mockedMcpClient.disconnect).not.toHaveBeenCalled();

    // Now edit the config in place and run the incremental reconcile. With the
    // fingerprint recorded by the bulk path, the change is detected and the
    // server is torn down + reconnected with the new config; without the fix
    // the edit would be silently ignored (connect stays at 1).
    args = ['--flag'];
    await manager.discoverAllMcpToolsIncremental(mockConfig);
    expect(mockedMcpClient.disconnect).toHaveBeenCalledTimes(1);
    expect(mockedMcpClient.connect).toHaveBeenCalledTimes(2);
    expect(removeMcpToolsByServer).toHaveBeenCalledWith('foo');
    expect(removePromptsByServer).toHaveBeenCalledWith('foo');
    expect(removeResourcesByServer).toHaveBeenCalledWith('foo');
  });

  it('discoverAllMcpToolsIncremental records `failed` outcome for swallowed connect errors', async () => {
    // `discoverMcpToolsForServerInternal` catches connect/discover errors
    // without re-throwing (best-effort semantics — one broken server
    // shouldn't bring down the others). Before this fix, the try block in
    // `discoverAllMcpToolsIncremental` therefore resolved even for failed
    // servers, and we'd record `mcp_server_ready:<name>` with
    // `outcome: 'ready'`. Now we consult the actual server status (set
    // to DISCONNECTED by McpClient.connect's catch) and emit `failed`
    // instead — otherwise the startup profile claims success for every
    // auth error / crashed server.
    const events: Array<{ name: string; attrs?: Record<string, unknown> }> = [];
    const startupEventSink = await import('../utils/startupEventSink.js');
    startupEventSink.setStartupEventSink((name, attrs) => {
      events.push({ name, attrs });
    });

    const mockedMcpClient = {
      connect: vi.fn().mockRejectedValue(new Error('auth failed')),
      discover: vi.fn().mockResolvedValue(undefined),
      disconnect: vi.fn().mockResolvedValue(undefined),
      getStatus: vi.fn(),
    };
    vi.mocked(McpClient).mockReturnValue(
      mockedMcpClient as unknown as McpClient,
    );

    const mockConfig = {
      isTrustedFolder: () => true,
      getMcpServers: () => ({ 'broken-auth': { command: 'node', args: [] } }),
      getMcpServerCommand: () => undefined,
      getTargetDir: () => '/session/worktree',
      getPromptRegistry: () =>
        ({ removePromptsByServer: vi.fn() }) as unknown as PromptRegistry,
      getResourceRegistry: () => ({ removeResourcesByServer: vi.fn() }),
      getWorkspaceContext: () => ({}) as WorkspaceContext,
      getDebugMode: () => false,
      isMcpServerDisabled: () => false,
    } as unknown as Config;
    const manager = mkManager({ config: mockConfig });
    await manager.discoverAllMcpToolsIncremental(mockConfig);

    // Cleanup the global sink so it doesn't leak into other tests.
    startupEventSink.setStartupEventSink(null);

    const readyEvents = events.filter(
      (e) => e.name === 'mcp_server_ready:broken-auth',
    );
    expect(readyEvents).toHaveLength(1);
    expect(readyEvents[0].attrs?.['outcome']).toBe('failed');
    // And no `mcp_first_tool_registered` was emitted — that metric is
    // user-facing ("first MCP server became usable") so a failed server
    // must not pollute it.
    const firstToolEvents = events.filter(
      (e) => e.name === 'mcp_first_tool_registered',
    );
    expect(firstToolEvents).toHaveLength(0);
  });

  it('discoveryTimeoutMs is clamped to a minimum and maximum', async () => {
    // A 0 or negative override would cause the timeout to fire on the
    // very next macrotask, racing the connect() handshake. Combined with
    // the lack of disconnect-on-timeout this used to be a silent tool
    // registration vector. The clamp puts the floor at 100ms.
    const calls: number[] = [];
    const realSetTimeout = globalThis.setTimeout;
    const spy = vi.spyOn(globalThis, 'setTimeout').mockImplementation(((
      cb: () => void,
      ms?: number,
    ) => {
      if (typeof ms === 'number') calls.push(ms);
      return realSetTimeout(cb, ms ?? 0);
    }) as unknown as typeof setTimeout);

    const mockedMcpClient = {
      connect: vi.fn().mockResolvedValue(undefined),
      discover: vi.fn().mockResolvedValue(undefined),
      disconnect: vi.fn().mockResolvedValue(undefined),
      getStatus: vi.fn(),
    };
    vi.mocked(McpClient).mockReturnValue(
      mockedMcpClient as unknown as McpClient,
    );
    const mockConfig = {
      isTrustedFolder: () => true,
      getMcpServers: () => ({
        zero: { command: 'node', args: [], discoveryTimeoutMs: 0 },
        negative: { command: 'node', args: [], discoveryTimeoutMs: -5 },
        huge: { command: 'node', args: [], discoveryTimeoutMs: 10_000_000 },
      }),
      getMcpServerCommand: () => undefined,
      getTargetDir: () => '/session/worktree',
      getPromptRegistry: () =>
        ({ removePromptsByServer: vi.fn() }) as unknown as PromptRegistry,
      getResourceRegistry: () => ({ removeResourcesByServer: vi.fn() }),
      getWorkspaceContext: () => ({}) as WorkspaceContext,
      getDebugMode: () => false,
      isMcpServerDisabled: () => false,
    } as unknown as Config;
    const manager = mkManager({
      config: mockConfig,
      toolRegistry: {
        removeMcpToolsByServer: vi.fn(),
      } as unknown as ToolRegistry,
    });
    await manager.discoverAllMcpToolsIncremental(mockConfig);
    spy.mockRestore();

    // Among the values setTimeout was called with, look only at the ones
    // our discoveryTimeoutFor would have produced: 100 (clamped floor)
    // and 300_000 (clamped ceiling). Other timers (test infra, vitest)
    // may be in `calls` but never both 100 AND 300000 by coincidence.
    expect(calls).toContain(100);
    expect(calls).toContain(300_000);
    expect(calls).not.toContain(0);
    expect(calls).not.toContain(-5);
    expect(calls).not.toContain(10_000_000);
  });

  describe('discovery timeout process cleanup', () => {
    function makeTimedOutClient(rootPid?: number) {
      return {
        connect: vi.fn(() => new Promise<void>(() => {})),
        discover: vi.fn().mockResolvedValue(undefined),
        disconnect: vi.fn().mockResolvedValue(undefined),
        getStatus: vi.fn(),
        getTransportPid: vi.fn(() => rootPid),
      };
    }

    async function runTimedOutDiscovery(
      mockedMcpClient: ReturnType<typeof makeTimedOutClient>,
      serverConfig: MCPServerConfig,
    ): Promise<void> {
      vi.mocked(McpClient).mockReturnValue(
        mockedMcpClient as unknown as McpClient,
      );
      const config = {
        isTrustedFolder: () => true,
        getMcpServers: () => ({ slow: serverConfig }),
        getMcpServerCommand: () => undefined,
        getTargetDir: () => '/session/worktree',
        getPromptRegistry: () =>
          ({ removePromptsByServer: vi.fn() }) as unknown as PromptRegistry,
        getResourceRegistry: () => ({ removeResourcesByServer: vi.fn() }),
        getWorkspaceContext: () => ({}) as WorkspaceContext,
        getDebugMode: () => false,
        isMcpServerDisabled: () => false,
      } as unknown as Config;
      const manager = mkManager({ config });

      await manager.discoverAllMcpToolsIncremental(config);
    }

    it('signals stdio wrapper descendants before disconnecting after timeout', async () => {
      const events: string[] = [];
      const mockedMcpClient = makeTimedOutClient(101);
      mockedMcpClient.disconnect.mockImplementationOnce(async () => {
        events.push('disconnect');
      });
      vi.mocked(listDescendantPids).mockClear();
      vi.mocked(sigtermPids).mockClear();
      vi.mocked(listDescendantPids).mockResolvedValueOnce([201, 301]);
      vi.mocked(sigtermPids).mockImplementationOnce(() => {
        events.push('signal');
        return 2;
      });

      await runTimedOutDiscovery(mockedMcpClient, {
        command: 'node',
        args: [],
        discoveryTimeoutMs: 100,
      });

      expect(listDescendantPids).toHaveBeenCalledWith(101);
      expect(sigtermPids).toHaveBeenCalledWith([201, 301]);
      expect(events).toEqual(['signal', 'disconnect']);
    });

    it('skips signaling when a stdio transport has no descendants', async () => {
      const mockedMcpClient = makeTimedOutClient(101);
      vi.mocked(listDescendantPids).mockClear();
      vi.mocked(sigtermPids).mockClear();

      await runTimedOutDiscovery(mockedMcpClient, {
        command: 'node',
        args: [],
        discoveryTimeoutMs: 100,
      });

      expect(listDescendantPids).toHaveBeenCalledWith(101);
      expect(sigtermPids).not.toHaveBeenCalled();
      expect(mockedMcpClient.disconnect).toHaveBeenCalledOnce();
    });

    it('still disconnects when descendant enumeration fails', async () => {
      const mockedMcpClient = makeTimedOutClient(101);
      vi.mocked(listDescendantPids).mockClear();
      vi.mocked(sigtermPids).mockClear();
      vi.mocked(listDescendantPids).mockRejectedValueOnce(
        new Error('process table unavailable'),
      );

      await runTimedOutDiscovery(mockedMcpClient, {
        command: 'node',
        args: [],
        discoveryTimeoutMs: 100,
      });

      expect(listDescendantPids).toHaveBeenCalledWith(101);
      expect(sigtermPids).not.toHaveBeenCalled();
      expect(mockedMcpClient.disconnect).toHaveBeenCalledOnce();
    });
  });

  it('runWithDiscoveryTimeout disconnects the client AND drops registered tools on timeout', async () => {
    // Before this fix, the inner `discoverMcpToolsForServer` kept running
    // after the timeout rejected the outer promise. If `client.discover()`
    // eventually succeeded it would register the late-arriving server's
    // tools into the live toolRegistry (a remote-exploitable silent
    // registration).
    //
    // Disconnecting the client on timeout aborts the handshake, but a
    // fire-and-forget `void disconnect()` doesn't help when `discover()`
    // already pumped tools into the registry synchronously — the
    // transport close lands a tick later. We therefore (a) await the
    // disconnect and (b) call `removeMcpToolsByServer()` to drop any
    // tools that slipped through the race window.
    let resolveConnect!: () => void;
    const hungConnect = new Promise<void>((res) => {
      resolveConnect = res;
    });
    const mockedMcpClient = {
      connect: vi.fn().mockReturnValue(hungConnect),
      discover: vi.fn().mockResolvedValue(undefined),
      disconnect: vi.fn().mockResolvedValue(undefined),
      getStatus: vi.fn(),
    };
    vi.mocked(McpClient).mockReturnValue(
      mockedMcpClient as unknown as McpClient,
    );

    const mockConfig = {
      isTrustedFolder: () => true,
      getMcpServers: () => ({
        slow: { command: 'node', args: [], discoveryTimeoutMs: 100 },
      }),
      getMcpServerCommand: () => undefined,
      getTargetDir: () => '/session/worktree',
      getPromptRegistry: () =>
        ({ removePromptsByServer: vi.fn() }) as unknown as PromptRegistry,
      getResourceRegistry: () => ({ removeResourcesByServer: vi.fn() }),
      getWorkspaceContext: () => ({}) as WorkspaceContext,
      getDebugMode: () => false,
      isMcpServerDisabled: () => false,
    } as unknown as Config;
    const removeMcpToolsByServer = vi.fn();
    const manager = mkManager({
      config: mockConfig,
      toolRegistry: { removeMcpToolsByServer } as unknown as ToolRegistry,
    });

    await manager.discoverAllMcpToolsIncremental(mockConfig);

    // The timeout must have triggered the disconnect — that's what
    // aborts the connect() handshake so no tools land.
    expect(mockedMcpClient.disconnect).toHaveBeenCalled();
    // And any tools that registered during the disconnect race window
    // must have been removed from the registry.
    expect(removeMcpToolsByServer).toHaveBeenCalledWith('slow');

    // Cleanup the hung promise to avoid leaking it across tests.
    resolveConnect();
  });

  it('runWithDiscoveryTimeout drops the client + stops health-check so the auto-reconnect loop cannot resurrect an intentionally timed-out server', async () => {
    // Round-7 regression: before this fix, the timeout handler removed
    // tools but left the client in `this.clients` and didn't stop its
    // health-check timer. `discoverMcpToolsForServerInternal`'s `finally`
    // block would then `startHealthCheck`, which (with `autoReconnect`)
    // detects `status !== CONNECTED`, increments the failure counter for
    // ~maxConsecutiveFailures intervals, and calls `reconnectServer()` →
    // `discoverMcpToolsForServer()` directly — bypassing
    // `runWithDiscoveryTimeout` entirely. The intentionally slow server
    // would silently come back.
    let resolveConnect!: () => void;
    const hungConnect = new Promise<void>((res) => {
      resolveConnect = res;
    });
    const mockedMcpClient = {
      connect: vi.fn().mockReturnValue(hungConnect),
      discover: vi.fn().mockResolvedValue(undefined),
      disconnect: vi.fn().mockResolvedValue(undefined),
      getStatus: vi.fn(),
    };
    vi.mocked(McpClient).mockReturnValue(
      mockedMcpClient as unknown as McpClient,
    );

    const mockConfig = {
      isTrustedFolder: () => true,
      getMcpServers: () => ({
        slow: { command: 'node', args: [], discoveryTimeoutMs: 100 },
      }),
      getMcpServerCommand: () => undefined,
      getTargetDir: () => '/session/worktree',
      getPromptRegistry: () =>
        ({ removePromptsByServer: vi.fn() }) as unknown as PromptRegistry,
      getResourceRegistry: () => ({ removeResourcesByServer: vi.fn() }),
      getWorkspaceContext: () => ({}) as WorkspaceContext,
      getDebugMode: () => false,
      isMcpServerDisabled: () => false,
    } as unknown as Config;
    const manager = mkManager({
      config: mockConfig,
      toolRegistry: {
        removeMcpToolsByServer: vi.fn(),
      } as unknown as ToolRegistry,
    });

    await manager.discoverAllMcpToolsIncremental(mockConfig);

    // The client entry must be gone — otherwise `performHealthCheck`
    // would observe it (and the disconnected status) every checkInterval.
    expect(
      (manager as unknown as { clients: Map<string, unknown> }).clients.has(
        'slow',
      ),
    ).toBe(false);
    // And no health-check timer must remain for this server.
    expect(
      (
        manager as unknown as {
          healthCheckTimers: Map<string, NodeJS.Timeout>;
        }
      ).healthCheckTimers.has('slow'),
    ).toBe(false);

    // Cleanup the hung promise to avoid leaking it across tests.
    resolveConnect();
  });

  it('discoverAllMcpToolsIncremental emits the trailing mcp-client-update after COMPLETED', async () => {
    // Without the trailing emit, the cli's deferred-finalize subscriber
    // (which polls discoveryState on each `mcp-client-update`) would never
    // observe the terminal state. Regression-protect the emit ordering.
    const mockedMcpClient = {
      connect: vi.fn().mockResolvedValue(undefined),
      discover: vi.fn().mockResolvedValue(undefined),
      disconnect: vi.fn().mockResolvedValue(undefined),
      getStatus: vi.fn(),
    };
    vi.mocked(McpClient).mockReturnValue(
      mockedMcpClient as unknown as McpClient,
    );

    const mcpClientModule = await import('./mcp-client.js');
    const { MCPDiscoveryState } = mcpClientModule;
    const observedStatesAtEmit: Array<
      (typeof mcpClientModule.MCPDiscoveryState)[keyof typeof mcpClientModule.MCPDiscoveryState]
    > = [];
    const events = {
      emit: vi.fn((eventName: string) => {
        if (eventName === 'mcp-client-update') {
          observedStatesAtEmit.push(manager.getDiscoveryState());
        }
        return true;
      }),
    } as unknown as import('node:events').EventEmitter;

    const mockConfig = {
      isTrustedFolder: () => true,
      getMcpServers: () => ({ srv: { command: 'node', args: [] } }),
      getMcpServerCommand: () => undefined,
      getTargetDir: () => '/session/worktree',
      getPromptRegistry: () =>
        ({ removePromptsByServer: vi.fn() }) as unknown as PromptRegistry,
      getResourceRegistry: () => ({ removeResourcesByServer: vi.fn() }),
      getWorkspaceContext: () => ({}) as WorkspaceContext,
      getDebugMode: () => false,
      isMcpServerDisabled: () => false,
    } as unknown as Config;
    const manager = mkManager({
      config: mockConfig,
      options: { eventEmitter: events },
    });

    await manager.discoverAllMcpToolsIncremental(mockConfig);

    // Must include at least one COMPLETED-state emit at the tail.
    expect(observedStatesAtEmit.at(-1)).toBe(MCPDiscoveryState.COMPLETED);
    // And must have started with an IN_PROGRESS emit (so progress UI shows
    // the transition even when there are no servers to update).
    expect(observedStatesAtEmit[0]).toBe(MCPDiscoveryState.IN_PROGRESS);
  });
});

// Issue #4175 PR 14: MCP client guardrails (counter + slot reservation +
// budget enforcement). Kept in its own describe so the existing test
// suite stays untouched and a future revert of PR 14 drops a single
// contiguous block.
describe('McpClientManager — PR 14 guardrails', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  /**
   * Mock factory: returns a fresh stub McpClient whose `getStatus()`
   * returns CONNECTED after `connect()` resolves. Mirrors the
   * `discoverAllMcpTools` happy path — counter sees the client as
   * live only when `getStatus === CONNECTED`, so without flipping
   * the mock status the accounting would always read zero.
   */
  function makeConnectedMcpClientMock() {
    // Real McpClient.getStatus is sync — start CONNECTED so accounting
    // sees it as live immediately after construction. `connect()` is a
    // no-op (we don't simulate handshake state machinery in unit
    // tests; the accounting cares only about the final status).
    const state = { status: undefined as unknown };
    return {
      connect: vi.fn().mockImplementation(async () => {
        const { MCPServerStatus } = await import('./mcp-client.js');
        state.status = MCPServerStatus.CONNECTED;
      }),
      discover: vi.fn().mockResolvedValue(undefined),
      disconnect: vi.fn().mockResolvedValue(undefined),
      getStatus: vi.fn(() => state.status),
      readResource: vi.fn().mockResolvedValue({ contents: [] }),
    };
  }

  function configWithServers(
    servers: Record<string, unknown>,
    overrides: Partial<Config> = {},
  ): Config {
    return {
      isTrustedFolder: () => true,
      getMcpServers: () => servers,
      getMcpServerCommand: () => undefined,
      getTargetDir: () => '/session/worktree',
      getPromptRegistry: () =>
        ({ removePromptsByServer: vi.fn() }) as unknown as PromptRegistry,
      getResourceRegistry: () => ({ removeResourcesByServer: vi.fn() }),
      getWorkspaceContext: () => ({}) as WorkspaceContext,
      getDebugMode: () => false,
      isMcpServerDisabled: () => false,
      ...overrides,
    } as unknown as Config;
  }

  it('mcpTransportOf maps each transport family correctly', async () => {
    const { mcpTransportOf } = await import('./mcp-client-manager.js');
    const cfg = (overrides: Record<string, unknown>) =>
      overrides as unknown as import('../config/config.js').MCPServerConfig;
    expect(mcpTransportOf(cfg({ command: 'node' }))).toBe('stdio');
    expect(mcpTransportOf(cfg({ httpUrl: 'http://x' }))).toBe('unknown');
    expect(mcpTransportOf(cfg({}))).toBe('unknown');
    // SDK detection short-circuits: even with a placeholder command,
    // an SDK-marked server reports `sdk` (not `stdio`).
    expect(mcpTransportOf(cfg({ type: 'sdk', command: 'node' }))).toBe('sdk');
  });

  // PR 14 fix (review #4247): regression tests for the four bypass /
  // ordering / staleness bugs the Codex + Copilot reviews caught.
  // Round 2 review fixes (PR #4247 wenshao Critical 2, Critical 3, Suggestion 4).
  it('reconnects a server first connected via a readResource lazy spawn when its config later changes', async () => {
    // Regression: the lazy-connect path in `readResource` used to connect
    // WITHOUT recording a fingerprint, so a server first brought up by a
    // resource read would fall into the reconcile guard's `undefined`
    // short-circuit and silently ignore a later in-place config edit.
    const { MCPServerStatus } = await import('./mcp-client.js');
    let status: unknown = MCPServerStatus.DISCONNECTED;
    const mockedMcpClient = {
      connect: vi.fn().mockImplementation(async () => {
        status = MCPServerStatus.CONNECTED;
      }),
      discover: vi.fn().mockResolvedValue(undefined),
      disconnect: vi.fn().mockResolvedValue(undefined),
      getStatus: vi.fn(() => status),
      readResource: vi.fn().mockResolvedValue({ contents: [] }),
    };
    vi.mocked(McpClient).mockReturnValue(
      mockedMcpClient as unknown as McpClient,
    );

    const removePromptsByServer = vi.fn();
    const removeResourcesByServer = vi.fn();
    const removeMcpToolsByServer = vi.fn();
    let args: string[] = [];
    const mockConfig = {
      isTrustedFolder: () => true,
      getMcpServers: () => ({ foo: { command: 'node', args } }),
      getMcpServerCommand: () => undefined,
      getTargetDir: () => '/session/worktree',
      getPromptRegistry: () =>
        ({ removePromptsByServer }) as unknown as PromptRegistry,
      getResourceRegistry: () => ({ removeResourcesByServer }),
      getWorkspaceContext: () => ({}) as WorkspaceContext,
      getDebugMode: () => false,
      isMcpServerDisabled: () => false,
    } as unknown as Config;
    const manager = mkManager({
      config: mockConfig,
      toolRegistry: { removeMcpToolsByServer } as unknown as ToolRegistry,
    });

    // First bring the server up via a lazy resource read (not discovery).
    await manager.readResource('foo', 'mcp://foo/doc');
    expect(mockedMcpClient.connect).toHaveBeenCalledTimes(1);
    expect(mockedMcpClient.disconnect).not.toHaveBeenCalled();

    // Edit the config in place + reconcile. The fingerprint recorded by the
    // lazy spawn lets the incremental pass detect the change and reconnect;
    // without the fix the edit would be silently dropped (connect stays 1).
    args = ['--flag'];
    await manager.discoverAllMcpToolsIncremental(mockConfig);
    expect(mockedMcpClient.disconnect).toHaveBeenCalledTimes(1);
    expect(mockedMcpClient.connect).toHaveBeenCalledTimes(2);
    expect(removeMcpToolsByServer).toHaveBeenCalledWith('foo');
    expect(removePromptsByServer).toHaveBeenCalledWith('foo');
    expect(removeResourcesByServer).toHaveBeenCalledWith('foo');
  });

  // Round 3 review fixes (PR #4247 wenshao second pass).
  it('readResource rejects disabled servers before checking budget (wenshao R3 #5)', async () => {
    vi.mocked(McpClient).mockImplementation(
      () => makeConnectedMcpClientMock() as unknown as McpClient,
    );
    // Pre-fix the lazy spawn path bypassed `isMcpServerDisabled`,
    // so a disabled server could be resurrected by a resource read.
    const config = configWithServers(
      {
        a: { command: 'node' },
      },
      {
        isMcpServerDisabled: ((name: string) =>
          name === 'a') as Config['isMcpServerDisabled'],
      },
    );
    const manager = mkManager({ config });
    await expect(manager.readResource('a', 'file:///x')).rejects.toThrow(
      /'a' is disabled/,
    );
  });

  // Round 4 review fixes (PR #4247 wenshao R3-R4 zombie leak in internal path).
  // R8 #4 (line 1221): the `freshReservations` Set distinguishes
  // fresh-reservation timeouts (release) from `'already_held'`
  // reconnect timeouts (keep slot). Verified by code inspection +
  // the R5 release-on-fresh test below; a dedicated already_held
  // timeout test requires either driving the health-monitor flow
  // end-to-end (which needs autoReconnect timer interleaving with
  // fake timers — interferes with the sibling R5 test in the same
  // file) or piercing the private `runWithDiscoveryTimeout`
  // helper. The invariant is small enough that the fresh-release
  // test below is sufficient regression coverage; an integration
  // test in a separate file can add the already_held variant
  // without the timer interleave problem.
  it('discoverMcpToolsForServerInternal rejects disabled servers (wenshao R7 #2 line 528)', async () => {
    // Reachable from /mcp reconnect and health
    // monitor reconnect. Pre-fix none of these paths checked the
    // disabled flag, so a disabled server could be resurrected.
    let createdCount = 0;
    vi.mocked(McpClient).mockImplementation(() => {
      createdCount += 1;
      return makeConnectedMcpClientMock() as unknown as McpClient;
    });
    const config = configWithServers(
      { a: { command: 'node' } },
      {
        isMcpServerDisabled: ((name: string) =>
          name === 'a') as Config['isMcpServerDisabled'],
      },
    );
    const manager = mkManager({ config });
    await manager.discoverMcpToolsForServer('a', config);
    expect(createdCount).toBe(0);
  });

  it('discoverMcpToolsForServerInternal rejects pending-approval servers', async () => {
    let createdCount = 0;
    vi.mocked(McpClient).mockImplementation(() => {
      createdCount += 1;
      return makeConnectedMcpClientMock() as unknown as McpClient;
    });
    const config = configWithServers(
      { a: { command: 'node' } },
      {
        isMcpServerPendingApproval: ((name: string) =>
          name === 'a') as Config['isMcpServerPendingApproval'],
      },
    );
    const manager = new McpClientManager(config, {} as ToolRegistry);

    await manager.discoverMcpToolsForServer('a', config);

    expect(createdCount).toBe(0);
  });

  it('readResource rejects existing-but-now-disabled servers (wenshao R7 #5 line 1342)', async () => {
    // Pre-fix: a server connected pre-disable and then operator-
    // disabled mid-session via settings reload would still serve
    // resource reads via its existing CONNECTED client until the
    // next incremental discovery pass called removeServer.
    vi.mocked(McpClient).mockImplementation(
      () => makeConnectedMcpClientMock() as unknown as McpClient,
    );
    let disabled = false;
    const config = configWithServers(
      { a: { command: 'node' } },
      {
        isMcpServerDisabled: ((name: string) =>
          name === 'a' && disabled) as Config['isMcpServerDisabled'],
      },
    );
    const manager = mkManager({ config });
    // First connect while NOT disabled.
    await manager.discoverAllMcpTools(config);
    // Now operator disables 'a' mid-session.
    disabled = true;
    // readResource on the EXISTING (still CONNECTED) client must
    // reject — pre-fix this would have proceeded to client.readResource.
    await expect(manager.readResource('a', 'file:///x')).rejects.toThrow(
      /'a' is disabled/,
    );
  });

  it('readResource rejects existing-but-now-pending servers', async () => {
    vi.mocked(McpClient).mockImplementation(
      () => makeConnectedMcpClientMock() as unknown as McpClient,
    );
    let pending = false;
    const config = configWithServers(
      { a: { command: 'node' } },
      {
        isMcpServerPendingApproval: ((name: string) =>
          name === 'a' && pending) as Config['isMcpServerPendingApproval'],
      },
    );
    const manager = new McpClientManager(config, {} as ToolRegistry);
    await manager.discoverAllMcpTools(config);

    pending = true;

    await expect(manager.readResource('a', 'file:///x')).rejects.toThrow(
      /'a' is pending approval/,
    );
  });

  it('readResource lazy spawn rejects pending-approval servers', async () => {
    let createdCount = 0;
    vi.mocked(McpClient).mockImplementation(() => {
      createdCount += 1;
      return makeConnectedMcpClientMock() as unknown as McpClient;
    });
    const config = configWithServers(
      { a: { command: 'node' } },
      {
        isMcpServerPendingApproval: ((name: string) =>
          name === 'a') as Config['isMcpServerPendingApproval'],
      },
    );
    const manager = new McpClientManager(config, {} as ToolRegistry);

    await expect(manager.readResource('a', 'file:///x')).rejects.toThrow(
      /'a' is pending approval/,
    );
    expect(createdCount).toBe(0);
  });

  it('discoverAllMcpTools disconnects on discover() failure (wenshao R8 #1 line 532)', async () => {
    // Bulk-path mirror of R7 #3 (per-server path). Pre-fix:
    // connect() success + discover() throw → catch deleted client
    // without disconnect() → stdio child / WebSocket / HTTP socket
    // leaked for the rest of the daemon's lifetime (stop() can't
    // see the entry it just removed from this.clients).
    let disconnectCalls = 0;
    vi.mocked(McpClient).mockImplementation(
      () =>
        ({
          connect: vi.fn().mockResolvedValue(undefined),
          discover: vi.fn().mockRejectedValue(new Error('discover failed')),
          disconnect: vi.fn().mockImplementation(() => {
            disconnectCalls += 1;
            return Promise.resolve();
          }),
          getStatus: vi.fn(),
        }) as unknown as McpClient,
    );
    const config = configWithServers({ a: { command: 'node' } });
    const manager = mkManager({
      config,
      options: { budgetConfig: { clientBudget: 1, budgetMode: 'enforce' } },
    });
    await manager.discoverAllMcpTools(config);
    // Transport closed before client reference dropped + slot released.
    expect(disconnectCalls).toBeGreaterThanOrEqual(1);
    expect(manager.getMcpClientAccounting().reservedSlots).toEqual([]);
  });

});

// Issue #4175 PR 14b: push events + hysteresis state machine. Kept in
// its own describe so a future revert of PR 14b drops a single
// contiguous block. Mirrors PR 14's testing style (mock `McpClient`,
// fluent `configWithServers` helper). Imports are dynamic to keep
// the spy on `McpClient` cleanly bound per test (vi.mocked module
// already mocked at file top).
// ────────────────────────────────────────────────────────────────────
// T2.8: addRuntimeMcpServer / removeRuntimeMcpServer
// ────────────────────────────────────────────────────────────────────