/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  Client,
  type GetPromptResult,
  type JSONRPCMessage,
  type Prompt,
  type ReadResourceResult,
  type Resource,
  type Transport,
} from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import {
  GetPromptResultSchema,
  ListPromptsResultSchema,
  ListResourcesResultSchema,
  ListToolsResultSchema,
  ReadResourceResultSchema,
} from '@modelcontextprotocol/core';
import { parse } from 'shell-quote';
import type { Config, MCPServerConfig } from '../config/config.js';
import { isSdkMcpServerConfig } from '../config/config.js';
import { validateAgentPluginStdioRuntimePaths } from '../extension/agent-plugins-v1/mcp.js';
import { mcpToTool } from './mcp-callable-tool.js';
import { DiscoveredMCPTool } from './mcp-tool.js';
import type { McpToolAnnotations } from './mcp-tool.js';
import { SdkControlClientTransport } from './sdk-control-client-transport.js';
import {
  MCPServerStatus,
  recordMCPServerLastError,
  updateMCPServerStatus,
} from './mcp-status.js';
export {
  addMCPStatusChangeListener,
  getAllMCPServerStatuses,
  getMCPServerLastError,
  getMCPServerStatus,
  MCPServerStatus,
  recordMCPServerLastError,
  removeMCPServerStatus,
  removeMCPStatusChangeListener,
  updateMCPServerStatus,
} from './mcp-status.js';

import type { FunctionDeclaration } from '@google/genai';
import { existsSync } from 'node:fs';
import { basename } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { PromptRegistry } from '../prompts/prompt-registry.js';
import type { ResourceRegistry } from '../resources/resource-registry.js';
import { getErrorMessage } from '../utils/errors.js';
import { createDebugLogger } from '../utils/debugLogger.js';
import { discoveryTimeoutFor } from './mcp-discovery-timeout.js';
import { retryWithBackoff } from './mcp-retry.js';
import { normalizePathEnvForWindows } from '../utils/windowsPath.js';
import { sanitizeChildEnv } from '../utils/sanitize-child-env.js';
import type {
  Unsubscribe,
  WorkspaceContext,
} from '../utils/workspaceContext.js';
import type { ToolRegistry } from './tool-registry.js';

/**
 * Callback type for sending MCP messages to SDK servers via control plane
 */
export type SendSdkMcpMessage = (
  serverName: string,
  message: JSONRPCMessage,
) => Promise<JSONRPCMessage>;

export const MCP_DEFAULT_TIMEOUT_MSEC = 10 * 60 * 1000; // default to 10 minutes
// Auto-negotiation `server/discover` otherwise inherits connect()'s
// timeout (10 minutes here, 60s SDK default). Silent legacy stdio
// servers never answer that probe; cap it so fallback fits inside
// the discovery window.
export const MCP_VERSION_NEGOTIATION_PROBE_TIMEOUT_MS = 5_000;
/** Reserve a full handshake window after a silent stdio discovery probe. */
export const MCP_VERSION_NEGOTIATION_FALLBACK_HEADROOM_MS =
  MCP_VERSION_NEGOTIATION_PROBE_TIMEOUT_MS;
export const MCP_APPS_EXTENSION_ID = 'io.modelcontextprotocol/ui';
export const MCP_APP_RESOURCE_MIME_TYPE = 'text/html;profile=mcp-app';

const debugLogger = createDebugLogger('MCP');

const invocationContextTransports = new WeakSet<Transport>();
const invocationContextClients = new WeakSet<Client>();

function bindInvocationContextPolicy(
  client: Client,
  transport: Transport,
): void {
  invocationContextClients.delete(client);
  if (invocationContextTransports.has(transport)) {
    invocationContextClients.add(client);
  }
}

export type DiscoveredMCPPrompt = Prompt & {
  serverName: string;
  invoke: (params: Record<string, unknown>) => Promise<GetPromptResult>;
};

/**
 * A resource advertised by an MCP server (`resources/list`), tagged with
 * the originating server so the read path (`readMcpResource`) and the
 * `/mcp` view can address it by `(serverName, uri)`. Unlike prompts,
 * resources carry no bound `invoke` closure — they are read on demand by
 * URI via `ToolRegistry.readMcpResource`.
 */
export type DiscoveredMCPResource = Resource & {
  serverName: string;
};

export type McpVersionNegotiation =
  | { mode: 'legacy' }
  | { mode: 'auto'; probe: { timeoutMs: number } };

/**
 * External stdio clients negotiate automatically only when explicitly opted
 * in. Internal and default stdio transports stay on legacy.
 */
export function mcpVersionNegotiationFor(
  cfg: MCPServerConfig,
): McpVersionNegotiation {
  if (
    cfg.versionNegotiation !== 'auto' ||
    isSdkMcpServerConfig(cfg) ||
    !cfg.command
  ) {
    return { mode: 'legacy' };
  }
  const discoveryTimeoutMs = discoveryTimeoutFor(cfg);
  const probeTimeoutMs = Math.min(
    MCP_VERSION_NEGOTIATION_PROBE_TIMEOUT_MS,
    discoveryTimeoutMs - MCP_VERSION_NEGOTIATION_FALLBACK_HEADROOM_MS,
  );
  if (probeTimeoutMs <= 0) {
    return { mode: 'legacy' };
  }
  return {
    mode: 'auto',
    probe: { timeoutMs: probeTimeoutMs },
  };
}

export function createMcpClient(name: string, cfg: MCPServerConfig): Client {
  return new Client(
    { name, version: '0.0.1' },
    {
      versionNegotiation: mcpVersionNegotiationFor(cfg),
      // Keep listing until the server ends pagination. The SDK still stops on
      // repeated cursors, while its default 64-page cap turns larger valid
      // catalogs into a discovery failure that this module reports as empty.
      listMaxPages: 0,
      capabilities: {
        extensions: {
          [MCP_APPS_EXTENSION_ID]: {
            mimeTypes: [MCP_APP_RESOURCE_MIME_TYPE],
          },
        },
      },
    },
  );
}

export function getMcpAppResourceUri(tool: {
  _meta?: Record<string, unknown>;
}): string | undefined {
  const ui = tool._meta?.['ui'];
  const nested =
    typeof ui === 'object' && ui !== null && !Array.isArray(ui)
      ? (ui as Record<string, unknown>)['resourceUri']
      : undefined;
  const value = nested ?? tool._meta?.['ui/resourceUri'];
  return typeof value === 'string' && value.startsWith('ui://')
    ? value
    : undefined;
}

function getMcpAppVisibility(tool: {
  _meta?: Record<string, unknown>;
}): readonly string[] | undefined {
  const ui = tool._meta?.['ui'];
  if (typeof ui !== 'object' || ui === null || Array.isArray(ui))
    return undefined;
  const visibility = (ui as Record<string, unknown>)['visibility'];
  if (visibility === undefined) return undefined;
  return Array.isArray(visibility)
    ? visibility.filter((value): value is string => typeof value === 'string')
    : [];
}

/** SEP-1865: omit tools whose visibility does not include `"model"`. */
export function isMcpToolVisibleToModel(tool: {
  _meta?: Record<string, unknown>;
}): boolean {
  const visibility = getMcpAppVisibility(tool);
  return visibility === undefined || visibility.includes('model');
}

/**
 * Enum representing the overall MCP discovery state
 */
export enum MCPDiscoveryState {
  /** Discovery has not started yet */
  NOT_STARTED = 'not_started',
  /** Discovery is currently in progress */
  IN_PROGRESS = 'in_progress',
  /** Discovery has completed (with or without errors) */
  COMPLETED = 'completed',
}

/**
 * A client for a single MCP server.
 *
 * This class is responsible for connecting to, discovering tools from, and
 * managing the state of a single MCP server.
 */
export class McpClient {
  private client: Client;
  private transport: Transport | undefined;
  private status: MCPServerStatus = MCPServerStatus.DISCONNECTED;
  private isDisconnecting = false;
  /**
   * captures the most recent error
   * delivered to the SDK Client's `onerror` callback. The pool entry's
   *  silent-drop block (the DISCONNECTED-on-active branch inside
   * `PoolEntry.statusChangeListener`) reads this via
   * `getLastTransportError()` to thread the upstream cause (EPIPE,
   * server crash) into the `'failed'` event's `lastError`
   * string instead of emitting only the synthetic
   * `'transport disconnected (silent transport drop)'` marker. Reset
   * at the top of `connect()` so a successful reconnect clears stale
   * state. No reset on `disconnect()` — McpClient instances are GC'd
   * at pool entry teardown; field staleness has no observable
   * consumer post-disconnect.
   */
  private lastTransportError?: Error;
  private instructions: string | undefined;

  constructor(
    private readonly serverName: string,
    private readonly serverConfig: MCPServerConfig,
    private readonly toolRegistry: ToolRegistry,
    private readonly promptRegistry: PromptRegistry,
    private readonly workspaceContext: WorkspaceContext,
    private readonly debugMode: boolean,
    private readonly sendSdkMcpMessage?: SendSdkMcpMessage,
  ) {
    this.client = createMcpClient(
      `qwen-cli-mcp-client-${this.serverName}`,
      this.serverConfig,
    );
  }

  /**
   * Connects to the MCP server.
   */
  async connect(): Promise<void> {
    this.isDisconnecting = false;
    invocationContextClients.delete(this.client);
    // clear stale upstream error from
    // any prior connect/disconnect cycle. The silent-drop reader
    // is otherwise satisfied by `undefined` and falls back to the
    // synthetic marker — but a stale error from a previous incarnation
    // would mis-attribute a fresh transport drop to an old cause.
    this.lastTransportError = undefined;
    this.updateStatus(MCPServerStatus.CONNECTING);
    try {
      this.transport = await this.createTransport();

      this.client.onerror = (error) => {
        if (this.isDisconnecting) {
          return;
        }
        // capture the upstream error
        // BEFORE the synchronous `updateStatus(DISCONNECTED)` cascades
        // to PoolEntry's statusChangeListener. The listener's
        // silent-drop block reads `lastTransportError` inline; setting
        // it ahead of `updateStatus` guarantees the field is populated
        // by the time the listener fires.
        this.lastTransportError = error;
        debugLogger.error(
          `MCP ERROR (${this.serverName}): ${getErrorMessage(error)}`,
        );
        this.updateStatus(MCPServerStatus.DISCONNECTED);
      };

      this.client.registerCapabilities({
        roots: {},
      });

      this.client.setRequestHandler('roots/list', async () => {
        const roots = [];
        for (const dir of this.workspaceContext.getDirectories()) {
          roots.push({
            uri: pathToFileURL(dir).toString(),
            name: basename(dir),
          });
        }
        return {
          roots,
        };
      });

      await this.client.connect(this.transport, {
        timeout: this.serverConfig.timeout,
      });
      this.instructions = this.client.getInstructions();
      bindInvocationContextPolicy(this.client, this.transport);

      this.updateStatus(MCPServerStatus.CONNECTED);
    } catch (error) {
      this.instructions = undefined;
      this.updateStatus(MCPServerStatus.DISCONNECTED);
      // Preserve the cause: the manager's discovery catch swallows this
      // error (best-effort discovery), leaving the status registry's enum as
      // the only other witness. Recording it lets status consumers (e.g.
      // `qwen mcp reconnect`) tell the user WHY the connection failed
      // instead of a bare "status: disconnected" (issue #9944).
      // Same guard as `updateStatus()`: a late rejection from a doomed
      // in-flight connect (server disabled/removed mid-connect) must not
      // resurrect a cause entry that `removeMCPServerStatus` already dropped.
      if (!this.isDisconnecting) {
        recordMCPServerLastError(this.serverName, getErrorMessage(error));
      }
      throw error;
    }
  }

  /**
   * Discovers tools and prompts from the MCP server.
   *
   * On error, the client's status is flipped to DISCONNECTED before the
   * error is re-thrown. Without this, a server that connects successfully
   * but then crashes (or returns no tools, or whose `tools/list` call
   * rejects) would remain `CONNECTED` in the global status registry, and
   * `Config.getFailedMcpServerNames()` — which filters by
   * `status !== CONNECTED` — would silently omit it from the
   * non-interactive failure banner. The caller (manager) still catches
   * and logs; we just need the status registry to reflect reality.
   */
  async discover(cliConfig: Config): Promise<void> {
    // legacy
    // `discover()` path (used by non-pool sessions and any direct
    // McpClient consumers) MUST apply config filters at discovery
    // time — pre-PR `this.discoverTools(cliConfig)` defaulted
    // `applyConfigFilters` to `true`, so `trust: true` server config
    // → tool's trust set; `includeTools`/`excludeTools` filtered out
    // disallowed tools. The refactor routed `discover()` through
    // `discoverAndReturn` which used to hardcode
    // `{ applyConfigFilters: false }` (matching pool semantics where
    // `SessionMcpView.applyTools` is the authoritative filter), but
    // that broke the legacy path: trust silently became `undefined`
    // (operators saw unexpected permission prompts) and include/
    // exclude filters were ignored. Now `discoverAndReturn` defaults
    // to applying filters; pool callers explicitly opt out.
    const { tools, prompts, resources } =
      await this.discoverAndReturn(cliConfig);
    for (const tool of tools) {
      this.toolRegistry.registerTool(tool);
    }
    for (const prompt of prompts) {
      this.promptRegistry.registerPrompt(prompt);
    }
    // Resources are registered via the Config-owned `ResourceRegistry`
    // rather than a constructor-injected field. `this.promptRegistry` is
    // already `cliConfig.getPromptRegistry()` on this non-pool path, so
    // this is the same single global registry — fetching it here avoids
    // threading a 4th registry through all ~20 `new McpClient(...)` sites.
    //
    // Clear-then-register makes re-discovery (health-monitor reconnect,
    // incremental settings-change discovery) idempotent: a resource the
    // server dropped between discoveries must not linger in the registry.
    // Mirrors `SessionMcpView.applyResources`' remove-then-register on the
    // pool path.
    //
    // Guard on `resources.length > 0`: `listMcpResources` swallows ALL errors
    // (including transient network failures / timeouts) and returns [], so an
    // unconditional clear would silently purge a server's resources whenever a
    // `resources/list` call transiently fails while tools/prompts succeed. We
    // only replace the set when we actually got one back. (Trade-off: a server
    // that legitimately drops to zero resources keeps the stale set until a
    // non-empty discovery — far less harmful than wiping good resources.)
    const resourceRegistry = cliConfig.getResourceRegistry();
    if (resources.length > 0) {
      resourceRegistry.removeResourcesByServer(this.serverName);
      for (const resource of resources) {
        resourceRegistry.registerResource(resource);
      }
    }
  }

  /**
   * Pure discovery — returns tools and prompts WITHOUT registering them.
   *
   * pool path: a single shared `McpClient` produces this
   * snapshot once; per-session `SessionMcpView` instances each
   * register a filtered/decorated copy into their own registries.
   *
   * Behavior mirrors `discover()` for error handling: status flips to
   * DISCONNECTED on any failure (so the global status registry +
   * `getFailedMcpServerNames()` reflect reality), then re-throws.
   *
   * Returns the same combined "no prompts or tools" error that `discover()`
   * raised previously, so callers that distinguish "server up but empty" from
   * "server down" still get the right signal.
   *
   * @param opts.applyConfigFilters Whether to apply `includeTools` /
   *   `excludeTools` filtering and set the `trust` field on returned
   *   tools at discovery time. Defaults to `true` (legacy `discover()`
   *   semantics). Pool callers pass `false` because per-session
   *   `SessionMcpView.applyTools` is the authoritative filter
   *   (otherwise pool-mode trust + filtering would apply twice
   *   inconsistently across sessions).
   */
  async discoverAndReturn(
    cliConfig: Config,
    opts?: { applyConfigFilters?: boolean },
  ): Promise<{
    tools: DiscoveredMCPTool[];
    prompts: DiscoveredMCPPrompt[];
    resources: DiscoveredMCPResource[];
  }> {
    if (this.status !== MCPServerStatus.CONNECTED) {
      throw new Error('Client is not connected.');
    }

    try {
      // Prompts, resources, and tools are independent reads with no data
      // dependency; run them concurrently (the SDK client multiplexes
      // requests by JSON-RPC id) to save round-trips per server at startup.
      // Each helper retries transient errors internally, then swallows
      // permanent errors and returns [], so Promise.all never rejects here.
      const [prompts, resources, toolDiscovery] = await Promise.all([
        listMcpPrompts(this.serverName, this.client),
        listMcpResources(this.serverName, this.client),
        discoverToolsWithMetadata(
          this.serverName,
          this.serverConfig,
          this.client,
          cliConfig,
          { applyConfigFilters: opts?.applyConfigFilters ?? true },
        ),
      ]);
      const tools = applyListingAppResourceUi(toolDiscovery.tools, resources);

      if (
        prompts.length === 0 &&
        tools.length === 0 &&
        resources.length === 0 &&
        !toolDiscovery.hadVisibilityFilteredTools
      ) {
        throw new Error('No prompts, tools, or resources found on the server.');
      }

      return { tools, prompts, resources };
    } catch (error) {
      this.updateStatus(MCPServerStatus.DISCONNECTED);
      // Same carrier as `connect()`'s catch: the manager swallows this error
      // for best-effort discovery; keep the cause retrievable for status
      // consumers (issue #9944). Gated like the status write so a server
      // removed mid-discovery doesn't get an orphan cause entry resurrected.
      if (!this.isDisconnecting) {
        recordMCPServerLastError(this.serverName, getErrorMessage(error));
      }
      throw error;
    }
  }

  /**
   * Disconnects from the MCP server.
   *
   * The intentional DISCONNECTED status update must reach the global
   * registry — `getFailedMcpServerNames()` filters on `status !== CONNECTED`
   * and the Footer's MCP health pill subscribes to the registry. Going
   * through `updateStatus()` would have it swallowed by the
   * `isDisconnecting` guard whose only purpose is to suppress LATE writes
   * from a stale `connect()` catch. We therefore write the local field and
   * the global registry directly, then flip `isDisconnecting = true` to
   * shut down propagation from any in-flight `connect()` / `discover()`
   * whose catch will fire after the transport has been torn down.
   */
  async disconnect(): Promise<void> {
    // Set the local status BEFORE flipping `isDisconnecting`. A concurrent
    // `discover()` reading `this.status` would otherwise see the stale
    // CONNECTED value and try to register tools that we're about to drop.
    this.status = MCPServerStatus.DISCONNECTED;
    updateMCPServerStatus(this.serverName, MCPServerStatus.DISCONNECTED);
    this.isDisconnecting = true;
    if (this.transport) {
      await this.transport.close();
    }
    this.client.close();
    this.instructions = undefined;
  }

  /**
   * Returns the current status of the client.
   */
  getStatus(): MCPServerStatus {
    return this.status;
  }

  /**
   * The OS pid of the spawned MCP child process, if this is a stdio
   * transport and the child is currently alive. Returns `undefined`
   * for SDK transports and for stdio transports that have not yet
   * connected or have already exited.
   *
   * `PoolEntry.forceShutdown` reads this to enumerate
   * descendant pids (via `listDescendantPids`) before calling
   * `client.disconnect()`, so wrapper processes like
   * `npx @modelcontextprotocol/server-X` and `uvx ...` don't leak.
   */
  getTransportPid(): number | undefined {
    const t = this.transport as { pid?: number | null } | undefined;
    if (!t || typeof t.pid !== 'number' || t.pid <= 0) return undefined;
    return t.pid;
  }

  /**
   * expose the most recent SDK Client
   * `onerror` payload so PoolEntry's silent-drop block can thread
   * the upstream cause (EPIPE, server-side crash) into the
   * `'failed'` event's `lastError` string. Returns `undefined` if no
   * error has been observed since the last `connect()`. Caller falls
   * back to the synthetic marker on `undefined`. Population site: the
   * `client.onerror` arrow inside `connect()` (this file). Consumer:
   * the silent-drop block inside `PoolEntry.statusChangeListener`.
   */
  getLastTransportError(): Error | undefined {
    return this.lastTransportError;
  }

  getInstructions(): string | undefined {
    return this.instructions;
  }

  async readResource(
    uri: string,
    options?: { signal?: AbortSignal },
  ): Promise<ReadResourceResult> {
    if (this.status !== MCPServerStatus.CONNECTED) {
      throw new Error('Client is not connected.');
    }

    // No `getServerCapabilities()?.resources` precheck, to match the lenient
    // `listMcpResources` discovery path: a server that answers `resources/list`
    // but under-declares the `resources` capability would otherwise have its
    // resources discovered, listed in `/mcp`, and offered in `@server:`
    // completion, yet fail on read with a misleading "does not support
    // resources" error. The v2 typed helper skips the wire request when the
    // capability is omitted, so modern sessions use it only when `resources`
    // is declared; otherwise we issue the same raw request as the legacy path.
    if (canUseModernTypedHelper(this.client, 'resources')) {
      return this.client.readResource({ uri }, options);
    }
    return this.client.request(
      { method: 'resources/read', params: { uri } },
      ReadResourceResultSchema,
      options,
    );
  }

  private updateStatus(status: MCPServerStatus): void {
    this.status = status;
    // Once disconnect has begun, don't propagate further status changes to
    // the global registry. An in-flight `connect()` whose catch block fires
    // after `disableMcpServer` has already removed the entry would otherwise
    // silently resurrect the server and the Footer's MCP health pill would
    // continue to count it as offline.
    if (this.isDisconnecting) {
      return;
    }
    updateMCPServerStatus(this.serverName, status);
  }

  private async createTransport(): Promise<Transport> {
    return createTransport(
      this.serverName,
      this.serverConfig,
      this.debugMode,
      this.sendSdkMcpMessage,
    );
  }
}

/**
 * Track the overall MCP discovery state
 */
let mcpDiscoveryState: MCPDiscoveryState = MCPDiscoveryState.NOT_STARTED;

/**
 * Get the current MCP discovery state
 */
export function getMCPDiscoveryState(): MCPDiscoveryState {
  return mcpDiscoveryState;
}

/**
 * expose a setter so
 * `McpClientManager.discoverAllMcpToolsViaPool` can update the
 * module-global `mcpDiscoveryState`. Pre-fix the pool path only
 * updated the manager-local state, leaving the global at
 * `NOT_STARTED` while pool discovery was running or already
 * complete — `GET /workspace/mcp` and the MCP preflight cell read
 * the global and reported `not_started` for a workspace whose
 * discovery had finished. Per-session managers don't have the
 * concept of "ALL workspace discovery complete" anymore in pool
 * mode, so the pool path becomes the canonical writer when active.
 */
export function setMCPDiscoveryState(state: MCPDiscoveryState): void {
  mcpDiscoveryState = state;
}

/**
 * Discovers tools from all configured MCP servers and registers them with the tool registry.
 * It orchestrates the connection and discovery process for each server defined in the
 * configuration, as well as any server specified via a command-line argument.
 *
 * @param mcpServers A record of named MCP server configurations.
 * @param mcpServerCommand An optional command string for a dynamically specified MCP server.
 * @param toolRegistry The central registry where discovered tools will be registered.
 * @returns A promise that resolves when the discovery process has been attempted for all servers.
 */

export async function discoverMcpTools(
  mcpServers: Record<string, MCPServerConfig>,
  mcpServerCommand: string | undefined,
  toolRegistry: ToolRegistry,
  promptRegistry: PromptRegistry,
  debugMode: boolean,
  workspaceContext: WorkspaceContext,
  cliConfig: Config,
): Promise<void> {
  mcpDiscoveryState = MCPDiscoveryState.IN_PROGRESS;
  try {
    mcpServers = populateMcpServerCommand(
      mcpServers,
      mcpServerCommand,
      cliConfig.getTargetDir(),
    );

    const discoveryPromises = Object.entries(mcpServers).map(
      ([mcpServerName, mcpServerConfig]) =>
        connectAndDiscover(
          mcpServerName,
          mcpServerConfig,
          toolRegistry,
          promptRegistry,
          debugMode,
          workspaceContext,
          cliConfig,
        ),
    );
    await Promise.all(discoveryPromises);
  } finally {
    mcpDiscoveryState = MCPDiscoveryState.COMPLETED;
  }
}

/** Visible for Testing */
export function populateMcpServerCommand(
  mcpServers: Record<string, MCPServerConfig>,
  mcpServerCommand: string | undefined,
  cwd?: string,
): Record<string, MCPServerConfig> {
  let result = mcpServers;
  if (mcpServerCommand) {
    const cmd = mcpServerCommand;
    const args = parse(cmd, process.env) as string[];
    if (args.some((arg) => typeof arg !== 'string')) {
      throw new Error('failed to parse mcpServerCommand: ' + cmd);
    }
    result = {
      ...result,
      mcp: {
        command: args[0],
        args: args.slice(1),
        cwd,
      },
    };
  }
  if (cwd === undefined) return result;
  // Stamp the session cwd onto implicit stdio servers so a worktree
  // relocation rebinds them (cwd is part of the pool fingerprint).
  return Object.fromEntries(
    Object.entries(result).map(([name, server]) => [
      name,
      server.command !== undefined &&
      server.type !== 'sdk' &&
      server.cwd === undefined
        ? { ...server, cwd }
        : server,
    ]),
  );
}

/**
 * Connects to an MCP server and discovers available tools, registering them with the tool registry.
 * This function handles the complete lifecycle of connecting to a server, discovering tools,
 * and cleaning up resources if no tools are found.
 *
 * @param mcpServerName The name identifier for this MCP server
 * @param mcpServerConfig Configuration object containing connection details
 * @param toolRegistry The registry to register discovered tools with
 * @param sendSdkMcpMessage Optional callback for SDK MCP servers to route messages via control plane.
 * @returns Promise that resolves when discovery is complete
 */
export async function connectAndDiscover(
  mcpServerName: string,
  mcpServerConfig: MCPServerConfig,
  toolRegistry: ToolRegistry,
  promptRegistry: PromptRegistry,
  debugMode: boolean,
  workspaceContext: WorkspaceContext,
  cliConfig: Config,
  sendSdkMcpMessage?: SendSdkMcpMessage,
): Promise<void> {
  updateMCPServerStatus(mcpServerName, MCPServerStatus.CONNECTING);

  let mcpClient: Client | undefined;
  try {
    mcpClient = await connectToMcpServer(
      mcpServerName,
      mcpServerConfig,
      debugMode,
      workspaceContext,
      sendSdkMcpMessage,
    );

    mcpClient.onerror = (error) => {
      debugLogger.error(`MCP ERROR (${mcpServerName}):`, error.toString());
      updateMCPServerStatus(mcpServerName, MCPServerStatus.DISCONNECTED);
    };

    // Attempt to discover prompts, resources, and tools
    const prompts = await discoverPrompts(
      mcpServerName,
      mcpClient,
      promptRegistry,
    );
    const resources = await discoverResources(
      mcpServerName,
      mcpClient,
      cliConfig.getResourceRegistry(),
    );
    const toolDiscovery = await discoverToolsWithMetadata(
      mcpServerName,
      mcpServerConfig,
      mcpClient,
      cliConfig,
    );
    const tools = applyListingAppResourceUi(toolDiscovery.tools, resources);

    // If we found no prompts, resources, or tools, it's a failed discovery
    if (
      prompts.length === 0 &&
      resources.length === 0 &&
      tools.length === 0 &&
      !toolDiscovery.hadVisibilityFilteredTools
    ) {
      throw new Error('No prompts, tools, or resources found on the server.');
    }

    // If we found anything, the server is connected
    updateMCPServerStatus(mcpServerName, MCPServerStatus.CONNECTED);

    // Register any discovered tools
    for (const tool of tools) {
      toolRegistry.registerTool(tool);
    }
  } catch (error) {
    if (mcpClient) {
      mcpClient.close();
    }
    debugLogger.error(
      `Error connecting to MCP server '${mcpServerName}': ${getErrorMessage(
        error,
      )}`,
    );
    updateMCPServerStatus(mcpServerName, MCPServerStatus.DISCONNECTED);
  }
}

/**
 * Applies resource listing UI metadata (`_meta.ui`) to matching discovered tools.
 * @param tools Discovered tools.
 * @param resources Resources whose `_meta.ui` decorates matching tools.
 * @returns The updated tool list.
 */
function applyListingAppResourceUi(
  tools: DiscoveredMCPTool[],
  resources: readonly DiscoveredMCPResource[],
): DiscoveredMCPTool[] {
  if (tools.length === 0 || resources.length === 0) return tools;
  const uiByUri = new Map<string, Record<string, unknown>>();
  for (const resource of resources) {
    const meta = resource._meta;
    if (!meta || typeof meta !== 'object' || Array.isArray(meta)) continue;
    const ui = meta['ui'];
    if (!ui || typeof ui !== 'object' || Array.isArray(ui)) continue;
    uiByUri.set(resource.uri, ui as Record<string, unknown>);
  }
  if (uiByUri.size === 0) return tools;
  return tools.map((tool) => {
    const listingUi = tool.appResourceUri
      ? uiByUri.get(tool.appResourceUri)
      : undefined;
    return listingUi ? tool.withAppResourceUi(listingUi) : tool;
  });
}

export async function discoverTools(
  mcpServerName: string,
  mcpServerConfig: MCPServerConfig,
  mcpClient: Client,
  cliConfig: Config,
  opts?: { applyConfigFilters?: boolean },
): Promise<DiscoveredMCPTool[]> {
  return (
    await discoverToolsWithMetadata(
      mcpServerName,
      mcpServerConfig,
      mcpClient,
      cliConfig,
      opts,
    )
  ).tools;
}

type ToolDiscoveryResult = {
  tools: DiscoveredMCPTool[];
  hadVisibilityFilteredTools: boolean;
};

async function discoverToolsWithMetadata(
  mcpServerName: string,
  mcpServerConfig: MCPServerConfig,
  mcpClient: Client,
  cliConfig: Config,
  opts?: { applyConfigFilters?: boolean },
): Promise<ToolDiscoveryResult> {
  try {
    const listedTools: Array<
      Awaited<ReturnType<Client['listTools']>>['tools'][number]
    > = [];
    let didListTools = false;
    const listTools = async (params?: { cursor?: string }) => {
      // Clients without getProtocolEra (tests and the genai adapter) keep
      // the typed helper. Modern sessions use it only when `tools` is
      // declared; otherwise the v2 helper returns [] without a wire request.
      const result =
        typeof mcpClient.getProtocolEra !== 'function' ||
        canUseModernTypedHelper(mcpClient, 'tools')
          ? await mcpClient.listTools(params)
          : await mcpClient.request(
              { method: 'tools/list', params: params ?? {} },
              ListToolsResultSchema,
            );
      didListTools = true;
      listedTools.push(...result.tools);
      return result;
    };
    // Discovery only calls listTools(); execution stays on the v2 client.
    // Legacy listTools must remain lenient because some servers implement
    // tools/list without declaring the tools capability during initialization.
    const discoveryClient = { listTools } as unknown as Client;
    const mcpCallableTool = mcpToTool(discoveryClient, {
      timeout: mcpServerConfig.timeout ?? MCP_DEFAULT_TIMEOUT_MSEC,
    });
    const tool = await retryWithBackoff(
      () => mcpCallableTool.tool(),
      `${mcpServerName}/tools/list`,
    );

    if (!Array.isArray(tool.functionDeclarations)) {
      // This is a valid case for a prompt-only server
      return { tools: [], hadVisibilityFilteredTools: false };
    }

    // Fetch raw tool list from MCP client to get annotations (readOnlyHint, etc.)
    // that are not preserved by mcpToTool's functionDeclarations conversion.
    const annotationsMap = new Map<string, McpToolAnnotations>();
    const appResourceUriMap = new Map<string, string>();
    try {
      if (!didListTools) await listTools();
      for (const mcpTool of listedTools) {
        if (mcpTool.annotations) {
          annotationsMap.set(mcpTool.name, mcpTool.annotations);
        }
        const resourceUri = getMcpAppResourceUri(mcpTool);
        if (resourceUri) appResourceUriMap.set(mcpTool.name, resourceUri);
      }
    } catch {
      // If listTools fails, proceed without annotations — non-critical
      debugLogger.error(
        `Failed to fetch tool annotations from MCP server '${mcpServerName}'`,
      );
    }

    const mcpTimeout = mcpServerConfig.timeout ?? MCP_DEFAULT_TIMEOUT_MSEC;
    const applyConfigFilters = opts?.applyConfigFilters ?? true;
    const discoveredTools: DiscoveredMCPTool[] = [];
    let hadVisibilityFilteredTools = false;
    for (const funcDecl of tool.functionDeclarations) {
      try {
        if (!funcDecl.name) {
          // emit the
          // malformed-funcDecl warning inline rather than calling
          // `isEnabled` solely for its side effect. Pre-fix
          // `isEnabled(funcDecl, ...)` was invoked just to trigger
          // the warn log inside it (return value ignored), which
          // misuses isEnabled as a logging helper. The warning text
          // is the same as the one in isEnabled (line 1618-1620);
          // keeping it here keeps the call site readable and lets
          // isEnabled stay a pure predicate.
          debugLogger.warn(
            `Discovered a function declaration without a name from MCP server '${mcpServerName}'. Skipping.`,
          );
          continue;
        }

        if (
          applyConfigFilters &&
          !isEnabled(funcDecl, mcpServerName, mcpServerConfig)
        ) {
          continue;
        }

        const listed = listedTools.find(
          (mcpTool) => mcpTool.name === funcDecl.name,
        );
        const appVisibility = listed ? getMcpAppVisibility(listed) : undefined;
        if (listed && !isMcpToolVisibleToModel(listed)) {
          hadVisibilityFilteredTools = true;
          if (!appVisibility?.includes('app')) continue;
        }

        discoveredTools.push(
          new DiscoveredMCPTool(
            mcpCallableTool,
            mcpServerName,
            funcDecl.name!,
            funcDecl.description ?? '',
            funcDecl.parametersJsonSchema ?? { type: 'object', properties: {} },
            applyConfigFilters ? mcpServerConfig.trust : undefined,
            undefined,
            cliConfig,
            mcpClient, // raw MCP Client for direct callTool with progress
            mcpTimeout,
            cliConfig?.getMcpToolIdleTimeoutMs?.(),
            annotationsMap.get(funcDecl.name!),
            mcpServerConfig.alwaysLoadTools === true,
            invocationContextClients.has(mcpClient),
            appResourceUriMap.get(funcDecl.name!),
            undefined,
            {
              appResourceMaxBytes: mcpServerConfig.appResourceMaxBytes,
              appResourceTimeoutMs: mcpServerConfig.appResourceTimeoutMs,
              extensionName: mcpServerConfig.extensionName,
              scope: mcpServerConfig.scope,
            },
            appVisibility,
          ),
        );
      } catch (error) {
        debugLogger.error(
          `Error discovering tool: '${
            funcDecl.name
          }' from MCP server '${mcpServerName}': ${(error as Error).message}`,
        );
      }
    }
    return { tools: discoveredTools, hadVisibilityFilteredTools };
  } catch (error) {
    if (!isMethodNotFound(error)) {
      debugLogger.error(
        `Error discovering tools from ${mcpServerName}: ${getErrorMessage(
          error,
        )}`,
      );
    }
    return { tools: [], hadVisibilityFilteredTools: false };
  }
}

/**
 * True when an MCP request failed because the method is not implemented.
 * JSON-RPC guarantees the numeric code (`-32601`), so that is the primary,
 * precise check. The message fallback (for transports that drop the code)
 * keeps the original case-sensitive exact substring `'Method not found'` —
 * deliberately NOT a broad `/method not found/i`, which would also swallow
 * unrelated errors like "Error in method not found handler: ...".
 */
function isMethodNotFound(error: unknown): boolean {
  const code = (error as { code?: unknown } | null)?.code;
  if (code === -32601) return true;
  return error instanceof Error && error.message.includes('Method not found');
}

/**
 * v2 typed list/read helpers return empty (or skip the call) when the
 * server omitted that capability. Use them only when the capability is
 * declared; otherwise fall back to a raw request so under-declared
 * servers stay visible.
 */
function canUseModernTypedHelper(
  mcpClient: Client,
  capability: 'prompts' | 'resources' | 'tools',
): boolean {
  return (
    mcpClient.getProtocolEra?.() === 'modern' &&
    Boolean(mcpClient.getServerCapabilities?.()?.[capability])
  );
}

/**
 * Pure prompt listing. Asks the MCP server for its prompts and returns
 * enriched `DiscoveredMCPPrompt[]` (with `serverName` + bound `invoke`)
 * WITHOUT registering them anywhere. pool uses this so a single
 * shared transport can produce the snapshot once and let each session's
 * `SessionMcpView` register into its own registry.
 *
 * Returns `[]` on protocol errors or when the server has no prompts —
 * matches `discoverPrompts` swallow-and-continue behavior.
 *
 * We deliberately do NOT skip the wire request when
 * `getServerCapabilities()?.prompts` is absent. A non-trivial number of
 * real MCP servers implement `prompts/list` but under-declare (or omit)
 * the `prompts` capability in their `initialize` response; the v2 typed
 * helper returns `[]` without a request in that case. Modern sessions
 * therefore use the helper only when the capability is declared;
 * otherwise we issue the same raw `prompts/list` request as the legacy
 * path. A server that truly lacks prompts answers with JSON-RPC error code
 * `-32601`, which the catch below swallows silently.
 */
export async function listMcpPrompts(
  mcpServerName: string,
  mcpClient: Client,
): Promise<DiscoveredMCPPrompt[]> {
  try {
    const response = await retryWithBackoff(
      () =>
        canUseModernTypedHelper(mcpClient, 'prompts')
          ? mcpClient.listPrompts()
          : mcpClient.request(
              { method: 'prompts/list', params: {} },
              ListPromptsResultSchema,
            ),
      `${mcpServerName}/prompts/list`,
    );

    return response.prompts.map((prompt) => ({
      ...prompt,
      serverName: mcpServerName,
      invoke: (params: Record<string, unknown>) =>
        invokeMcpPrompt(mcpServerName, mcpClient, prompt.name, params),
    }));
  } catch (error) {
    // It's okay if this fails, not all servers will have prompts.
    // Don't log an error if the method is not found, which is a common case.
    if (!isMethodNotFound(error)) {
      debugLogger.error(
        `Error discovering prompts from ${mcpServerName}: ${getErrorMessage(
          error,
        )}`,
      );
    }
    return [];
  }
}

/**
 * Discovers prompts AND registers them into the supplied PromptRegistry.
 * Thin wrapper over `listMcpPrompts` that preserves the historical
 * `Promise<Prompt[]>` signature (used by `connectAndDiscover`, standalone
 * qwen, and existing tests). New code should prefer `listMcpPrompts`
 * for testability.
 *
 * @param mcpServerName The name of the MCP server.
 * @param mcpClient The active MCP client instance.
 * @param promptRegistry The registry to register discovered prompts into.
 */
export async function discoverPrompts(
  mcpServerName: string,
  mcpClient: Client,
  promptRegistry: PromptRegistry,
): Promise<Prompt[]> {
  const enriched = await listMcpPrompts(mcpServerName, mcpClient);
  for (const prompt of enriched) {
    promptRegistry.registerPrompt(prompt);
  }
  // Preserve historical return type: raw Prompt (without serverName/invoke).
  // Callers only ever inspected `length`, but the type contract is preserved.
  return enriched.map(({ serverName: _s, invoke: _i, ...rest }) => rest);
}

/**
 * Invokes a prompt on a connected MCP client.
 *
 * @param mcpServerName The name of the MCP server.
 * @param mcpClient The active MCP client instance.
 * @param promptName The name of the prompt to invoke.
 * @param promptParams The parameters to pass to the prompt.
 * @returns A promise that resolves to the result of the prompt invocation.
 */
export async function invokeMcpPrompt(
  mcpServerName: string,
  mcpClient: Client,
  promptName: string,
  promptParams: Record<string, unknown>,
): Promise<GetPromptResult> {
  try {
    const params = {
      name: promptName,
      arguments: promptParams as Record<string, string>,
    };
    const response =
      mcpClient.getProtocolEra?.() === 'modern'
        ? await mcpClient.getPrompt(params)
        : await mcpClient.request(
            { method: 'prompts/get', params },
            GetPromptResultSchema,
          );

    return response;
  } catch (error) {
    if (!isMethodNotFound(error)) {
      debugLogger.error(
        `Error invoking prompt '${promptName}' from ${mcpServerName} ${promptParams}: ${getErrorMessage(
          error,
        )}`,
      );
    }
    throw error;
  }
}

/**
 * Lists resources advertised by an MCP server (`resources/list`) WITHOUT
 * registering them anywhere — the pool uses this so a single shared
 * transport can produce the snapshot once and let each session register
 * into its own registry. Mirrors `listMcpPrompts`.
 *
 * As with prompts, we do NOT skip the wire request when
 * `getServerCapabilities()?.resources` is absent: some servers expose
 * resources but under-declare the capability. The v2 typed helper returns
 * `[]` without a request in that case, so modern sessions use it only
 * when `resources` is declared; otherwise we issue the same raw request
 * as the legacy path. A server with no resources answers `-32601 Method
 * not found`, swallowed below.
 *
 * When the capability is declared, the v2 helper also aggregates cursor
 * pagination. Legacy sessions preserve the existing first-page behavior.
 */
export async function listMcpResources(
  mcpServerName: string,
  mcpClient: Client,
): Promise<DiscoveredMCPResource[]> {
  try {
    const response = await retryWithBackoff(
      () =>
        canUseModernTypedHelper(mcpClient, 'resources')
          ? mcpClient.listResources()
          : mcpClient.request(
              { method: 'resources/list', params: {} },
              ListResourcesResultSchema,
            ),
      `${mcpServerName}/resources/list`,
    );

    return response.resources.map((resource) => ({
      ...resource,
      serverName: mcpServerName,
    }));
  } catch (error) {
    // It's okay if this fails; not all servers expose resources. Don't log
    // when the method is simply absent (the common case for tool-only
    // servers).
    if (!isMethodNotFound(error)) {
      debugLogger.error(
        `Error discovering resources from ${mcpServerName}: ${getErrorMessage(
          error,
        )}`,
      );
    }
    return [];
  }
}

/**
 * Discovers resources AND registers them into the supplied
 * `ResourceRegistry`. Thin wrapper over `listMcpResources`, mirroring
 * `discoverPrompts`.
 *
 * @param mcpServerName The name of the MCP server.
 * @param mcpClient The active MCP client instance.
 * @param resourceRegistry The registry to register discovered resources into.
 */
export async function discoverResources(
  mcpServerName: string,
  mcpClient: Client,
  resourceRegistry: ResourceRegistry,
): Promise<DiscoveredMCPResource[]> {
  const resources = await listMcpResources(mcpServerName, mcpClient);
  for (const resource of resources) {
    resourceRegistry.registerResource(resource);
  }
  return resources;
}

/**
 * Creates and connects an MCP client to a server based on the provided configuration.
 * It determines the appropriate transport (stdio or SDK) and
 * establishes a connection. It also applies a patch to handle request timeouts.
 *
 * @param mcpServerName The name of the MCP server, used for logging and identification.
 * @param mcpServerConfig The configuration specifying how to connect to the server.
 * @param sendSdkMcpMessage Optional callback for SDK MCP servers to route messages via control plane.
 * @returns A promise that resolves to a connected MCP `Client` instance.
 * @throws An error if the connection fails or the configuration is invalid.
 */
export async function connectToMcpServer(
  mcpServerName: string,
  mcpServerConfig: MCPServerConfig,
  debugMode: boolean,
  workspaceContext: WorkspaceContext,
  sendSdkMcpMessage?: SendSdkMcpMessage,
): Promise<Client> {
  const mcpClient = createMcpClient('qwen-code-mcp-client', mcpServerConfig);

  mcpClient.registerCapabilities({
    roots: {
      listChanged: true,
    },
  });

  mcpClient.setRequestHandler('roots/list', async () => {
    const roots = [];
    for (const dir of workspaceContext.getDirectories()) {
      roots.push({
        uri: pathToFileURL(dir).toString(),
        name: basename(dir),
      });
    }
    return {
      roots,
    };
  });

  let unlistenDirectories: Unsubscribe | undefined =
    workspaceContext.onDirectoriesChanged(async () => {
      try {
        await mcpClient.notification({
          method: 'notifications/roots/list_changed',
        });
      } catch (_) {
        // If this fails, its almost certainly because the connection was closed
        // and we should just stop listening for future directory changes.
        unlistenDirectories?.();
        unlistenDirectories = undefined;
      }
    });

  // Attempt to pro-actively unsubscribe if the mcp client closes. This API is
  // very brittle though so we don't have any guarantees, hence the try/catch
  // above as well.
  //
  // Be a good steward and don't just bash over onclose.
  const oldOnClose = mcpClient.onclose;
  mcpClient.onclose = () => {
    oldOnClose?.();
    unlistenDirectories?.();
    unlistenDirectories = undefined;
  };

  try {
    const transport = await createTransport(
      mcpServerName,
      mcpServerConfig,
      debugMode,
      sendSdkMcpMessage,
    );
    try {
      await mcpClient.connect(transport, {
        timeout: mcpServerConfig.timeout ?? MCP_DEFAULT_TIMEOUT_MSEC,
      });
      bindInvocationContextPolicy(mcpClient, transport);
      return mcpClient;
    } catch (error) {
      unlistenDirectories?.();
      unlistenDirectories = undefined;
      await transport.close();
      throw error;
    }
  } catch (error) {
    unlistenDirectories?.();
    unlistenDirectories = undefined;
    // Create a concise error message
    const errorMessage = (error as Error).message || String(error);
    let conciseError = `Connection failed for '${mcpServerName}': ${errorMessage}`;

    if (process.env['SANDBOX']) {
      conciseError += ` (check sandbox availability)`;
    }

    throw new Error(conciseError);
  }
}

/** Visible for Testing */
export async function createTransport(
  mcpServerName: string,
  mcpServerConfig: MCPServerConfig,
  debugMode: boolean,
  sendSdkMcpMessage?: SendSdkMcpMessage,
): Promise<Transport> {
  if (isSdkMcpServerConfig(mcpServerConfig)) {
    if (!sendSdkMcpMessage) {
      throw new Error(
        `SDK MCP server '${mcpServerName}' requires sendSdkMcpMessage callback`,
      );
    }
    return new SdkControlClientTransport({
      serverName: mcpServerName,
      sendMcpMessage: sendSdkMcpMessage,
      debugMode,
    });
  }

  if (mcpServerConfig.command) {
    validateAgentPluginStdioRuntimePaths(mcpServerConfig);
    if (mcpServerConfig.cwd && !existsSync(mcpServerConfig.cwd)) {
      throw new Error(
        `MCP server '${mcpServerName}': configured cwd does not exist: ${mcpServerConfig.cwd}`,
      );
    }

    // Normalize process.env PATH first (merge PATH+Path → single PATH on
    // Windows), then apply server-specific overrides on top so that a server
    // config providing its own PATH fully replaces the parent value instead of
    // being merged with a stale case-variant.
    const inherited = normalizePathEnvForWindows(sanitizeChildEnv(process.env));
    const env = {
      ...inherited,
      ...(mcpServerConfig.env || {}),
    };

    const transport = new StdioClientTransport({
      command: mcpServerConfig.command,
      args: mcpServerConfig.args || [],
      env: env as Record<string, string>,
      cwd: mcpServerConfig.cwd,
      stderr: 'pipe',
    });
    invocationContextTransports.add(transport);
    if (debugMode) {
      transport.stderr!.on('data', (data) => {
        const stderrStr = data.toString().trim();
        debugLogger.debug(`MCP STDERR (${mcpServerName}):`, stderrStr);
      });
    }
    return transport;
  }

  throw new Error(`Invalid configuration: missing command (for stdio).`);
}

/** Visible for testing */
export function isEnabled(
  funcDecl: FunctionDeclaration,
  mcpServerName: string,
  mcpServerConfig: MCPServerConfig,
): boolean {
  if (!funcDecl.name) {
    debugLogger.warn(
      `Discovered a function declaration without a name from MCP server '${mcpServerName}'. Skipping.`,
    );
    return false;
  }
  const { includeTools, excludeTools } = mcpServerConfig;

  // excludeTools takes precedence over includeTools
  if (excludeTools && excludeTools.includes(funcDecl.name)) {
    return false;
  }

  return (
    !includeTools ||
    includeTools.some(
      (tool) => tool === funcDecl.name || tool.startsWith(`${funcDecl.name}(`),
    )
  );
}
