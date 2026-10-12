/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type { Config, MCPServerConfig } from '../config/config.js';
import { isSdkMcpServerConfig } from '../config/config.js';
import type { ToolRegistry } from './tool-registry.js';
import {
  McpClient,
  MCPDiscoveryState,
  MCPServerStatus,
  getMCPServerStatus,
  populateMcpServerCommand,
  removeMCPServerStatus,
} from './mcp-client.js';
import type { SendSdkMcpMessage } from './mcp-client.js';
import { getErrorMessage } from '../utils/errors.js';
import { createDebugLogger } from '../utils/debugLogger.js';
import { recordStartupEvent } from '../utils/startupEventSink.js';
import type { EventEmitter } from 'node:events';
import { createHash } from 'node:crypto';
import type { ReadResourceResult } from '@modelcontextprotocol/client';
import { listDescendantPids, sigtermPids } from './pid-descendants.js';
import { mcpSessionMetadataKey } from './mcp-session-config.js';

import { warnOnUnmatchedEagerToolEntries } from '../permissions/eager-allowlist-coverage.js';

const debugLogger = createDebugLogger('MCP');

/**
 * Configuration for MCP health monitoring
 */
export interface MCPHealthMonitorConfig {
  /** Health check interval in milliseconds (default: 30000ms) */
  checkIntervalMs: number;
  /** Number of consecutive failures before marking as disconnected (default: 3) */
  maxConsecutiveFailures: number;
  /** Enable automatic reconnection (default: true) */
  autoReconnect: boolean;
  /** Delay before reconnection attempt in milliseconds (default: 5000ms) */
  reconnectDelayMs: number;
}

const DEFAULT_HEALTH_CONFIG: MCPHealthMonitorConfig = {
  checkIntervalMs: 30000, // 30 seconds
  maxConsecutiveFailures: 3,
  autoReconnect: true,
  reconnectDelayMs: 5000, // 5 seconds
};

/** Transport family per `MCPServerConfig`. `unknown` covers misconfigured entries. */
export type McpTransportKind = 'stdio' | 'sdk' | 'unknown';

/**
 * Map an `MCPServerConfig` to its transport family. Aligned with the
 * detection order in `mcp-client.ts:createTransport` (sdk → command).
 *
 * `sdk` is checked first because `SDK_MCP_SERVER_FIELDS` may coexist
 * with a placeholder `command` — without the sdk-first order, an
 * in-process SDK server would mis-report as `stdio`.
 */
export function mcpTransportOf(config: MCPServerConfig): McpTransportKind {
  if (isSdkMcpServerConfig(config)) return 'sdk';
  if (typeof config.command === 'string') return 'stdio';
  return 'unknown';
}

function sortedEntries(
  obj: Record<string, string> | undefined | null,
): Array<[string, string]> {
  if (!obj) return [];
  return Object.entries(obj).sort((a, b) =>
    a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0,
  );
}

/**
 * Transport identity of a server config, `${name}::${fp16hex}`. Hashes the
 * fields that shape the spawned transport and its discovered tools
 * (transport, command, args, cwd, env, timeout, version negotiation).
 * Per-session metadata (includeTools, excludeTools, trust, alwaysLoadTools,
 * description, extensionName, discoveryTimeoutMs) is excluded; see
 * `singleSessionConnectedKeyOf`.
 */
function connectionIdOf(serverName: string, cfg: MCPServerConfig): string {
  const canonical = {
    transport: mcpTransportOf(cfg),
    command: cfg.command ?? null,
    args: cfg.args ?? [],
    cwd: cfg.cwd ?? null,
    env: sortedEntries(cfg.env),
    timeout: cfg.timeout ?? null,
    automaticVersionNegotiation: cfg.versionNegotiation === 'auto',
  };
  const fingerprint = createHash('sha256')
    .update(JSON.stringify(canonical))
    .digest('hex')
    .slice(0, 16);
  return `${serverName}::${fingerprint}`;
}

export interface McpClientManagerOptions {
  eventEmitter?: EventEmitter;
  sendSdkMcpMessage?: SendSdkMcpMessage;
  healthConfig?: Partial<MCPHealthMonitorConfig>;
}

/**
 * Manages the lifecycle of multiple MCP clients, including local child processes.
 * This class is responsible for starting, stopping, and discovering tools from
 * a collection of MCP servers defined in the configuration.
 */
export class McpClientManager {
  private clients: Map<string, McpClient> = new Map();
  private readonly toolRegistry: ToolRegistry;
  private readonly cliConfig: Config;
  private discoveryState: MCPDiscoveryState = MCPDiscoveryState.NOT_STARTED;
  private readonly eventEmitter?: EventEmitter;
  private readonly sendSdkMcpMessage?: SendSdkMcpMessage;
  private healthConfig: MCPHealthMonitorConfig;
  private healthCheckTimers: Map<string, NodeJS.Timeout> = new Map();
  private consecutiveFailures: Map<string, number> = new Map();
  private isReconnecting: Map<string, boolean> = new Map();
  private serverDiscoveryPromises: Map<string, Promise<void>> = new Map();

  /**
   * Per connected server, the single-session "connected config key" of the
   * config it was last connected with — see {@link singleSessionConnectedKeyOf}.
   * Lets `discoverAllMcpToolsIncremental` detect an in-place config change to an
   * already-connected server and reconnect it, instead of leaving it on the
   * stale config. Unlike the transport-only `connectionIdOf`, this key also
   * covers the discovery-time metadata (trust / alwaysLoadTools / includeTools /
   * excludeTools) so editing those re-applies it. Set on successful connect;
   * cleared on every teardown path so a stale key can't mask a later change.
   */
  private readonly connectedConfigKeys = new Map<string, string>();

  constructor(
    config: Config,
    toolRegistry: ToolRegistry,
    options: McpClientManagerOptions = {},
  ) {
    this.cliConfig = config;
    this.toolRegistry = toolRegistry;
    this.eventEmitter = options.eventEmitter;
    this.sendSdkMcpMessage = options.sendSdkMcpMessage;
    this.healthConfig = { ...DEFAULT_HEALTH_CONFIG, ...options.healthConfig };
  }

  /**
   * Single source of truth for the effective server map: the configured
   * servers plus the `mcpServerCommand`-derived `mcp` server, each stamped
   * with the session target dir as its cwd. Every discovery entry point
   * resolves servers through here so the recipe cannot diverge.
   */
  private getEffectiveMcpServers(): Record<string, MCPServerConfig> {
    return populateMcpServerCommand(
      this.cliConfig.getMcpServers() || {},
      this.cliConfig.getMcpServerCommand(),
      this.cliConfig.getTargetDir(),
    );
  }

  /**
   * Initiates the tool discovery process for all configured MCP servers.
   * It connects to each server, discovers its available tools, and registers
   * them with the `ToolRegistry`.
   */
  async discoverAllMcpTools(cliConfig: Config): Promise<void> {
    if (cliConfig.isTrustedFolder?.() === false) {
      return;
    }
    await this.stop();

    const servers = this.getEffectiveMcpServers();

    this.discoveryState = MCPDiscoveryState.IN_PROGRESS;

    this.eventEmitter?.emit('mcp-client-update', this.clients);
    const discoveryPromises = Object.entries(servers).map(
      async ([name, config]) => {
        // Skip disabled servers
        if (cliConfig.isMcpServerDisabled(name)) {
          debugLogger.debug(`Skipping disabled MCP server: ${name}`);
          return;
        }

        // Skip project-scoped (`.mcp.json`) servers the user has not
        // approved (#4615). This MUST be before `new McpClient` /
        // `connect()` so an untrusted `.mcp.json` never spawns a process,
        // opens a transport, or runs a health check.
        if (cliConfig.isMcpServerPendingApproval?.(name)) {
          debugLogger.debug(`Skipping MCP server pending approval: ${name}`);
          return;
        }

        // For SDK MCP servers, pass the sendSdkMcpMessage callback
        const sdkCallback = isSdkMcpServerConfig(config)
          ? this.sendSdkMcpMessage
          : undefined;

        const client = new McpClient(
          name,
          config,
          this.toolRegistry,
          this.cliConfig.getPromptRegistry(),
          this.cliConfig.getWorkspaceContext(),
          this.cliConfig.getDebugMode(),
          sdkCallback,
        );
        this.clients.set(name, client);

        this.eventEmitter?.emit('mcp-client-update', this.clients);
        try {
          await client.connect();
          await client.discover(cliConfig);
          // Record the fingerprint of the config this client connected with
          // so a later `discoverAllMcpToolsIncremental` can detect an
          // in-place config change. The single-session reconcile guard
          // skips a still-connected server whose fingerprint is `undefined`,
          // so a bulk connect (this path is reached via legacy blocking boot
          // + extension reload) that omitted this would silently drop a
          // subsequent edit — same invariant the per-server path upholds.
          this.connectedConfigKeys.set(
            name,
            this.singleSessionConnectedKeyOf(name, config),
          );
          this.eventEmitter?.emit('mcp-client-update', this.clients);
        } catch (error) {
          // The client object held by `clients.delete(name)` only has its
          // tracking reference removed, not its underlying transport
          // closed. Leaving the orphan transport alive would leak the stdio
          // child for the rest of the process — `stop()` can't clean it
          // because we just removed it from the map. Errors intentionally
          // swallowed (we're already in a discovery-failure catch;
          // double-throwing would lose the original error context).
          try {
            await client.disconnect();
          } catch {
            // best-effort transport cleanup
          }
          this.clients.delete(name);
          this.eventEmitter?.emit('mcp-client-update', this.clients);
          // Log the error but don't let a single failed server stop the others
          debugLogger.error(
            `Error during discovery for server '${name}': ${getErrorMessage(
              error,
            )}`,
          );
        }
      },
    );

    await Promise.all(discoveryPromises);
    this.discoveryState = MCPDiscoveryState.COMPLETED;
    // The registry is settled, so `tools.eager` entries that name no
    // discovered tool can be reported without warning prematurely (#12435).
    warnOnUnmatchedEagerToolEntries(cliConfig);
  }

  /**
   * Connects to a single MCP server and discovers its tools/prompts.
   * The connected client is tracked so it can be closed by {@link stop}.
   *
   * This is primarily used for on-demand re-discovery flows.
   */
  async discoverMcpToolsForServer(
    serverName: string,
    cliConfig: Config,
  ): Promise<void> {
    const servers = this.getEffectiveMcpServers();
    const serverConfig = servers[serverName];
    if (!serverConfig) {
      return;
    }

    const inProgressDiscovery = this.serverDiscoveryPromises.get(serverName);
    if (inProgressDiscovery) {
      await inProgressDiscovery;
      return;
    }

    const discoveryPromise = this.discoverMcpToolsForServerInternal(
      serverName,
      cliConfig,
    );
    this.serverDiscoveryPromises.set(serverName, discoveryPromise);

    try {
      await discoveryPromise;
    } finally {
      if (this.serverDiscoveryPromises.get(serverName) === discoveryPromise) {
        this.serverDiscoveryPromises.delete(serverName);
      }
    }
  }

  private async discoverMcpToolsForServerInternal(
    serverName: string,
    cliConfig: Config,
  ): Promise<void> {
    const servers = this.getEffectiveMcpServers();
    const serverConfig = servers[serverName];
    if (!serverConfig) {
      return;
    }
    if (cliConfig.isTrustedFolder?.() === false) {
      debugLogger.debug(
        `Skipping MCP server in untrusted folder: ${serverName}`,
      );
      return;
    }
    // disabled gate.
    // `discoverMcpToolsForServerInternal` is reachable from
    // `/mcp reconnect` and the health monitor's
    // `reconnectServer`. Without this check those paths could
    // resurrect a server the operator has explicitly disabled,
    // registering tools the user told us to ignore. Mirrors the
    // disabled checks in `discoverAllMcpTools` +
    // `discoverAllMcpToolsIncremental` + `readResource`.
    //
    // Optional-chain on `isMcpServerDisabled` is defensive against
    // test fixtures that omit the method (the bulk paths already
    // assume it exists; this single-server path was the laggard).
    // Production `Config` always defines the method.
    if (this.cliConfig.isMcpServerDisabled?.(serverName)) {
      debugLogger.debug(`Skipping disabled MCP server: ${serverName}`);
      return;
    }

    // Pending-approval project servers (`.mcp.json`) are never connected on the
    // single-server path either (#4615). Optional-chain matches the defensive
    // style above for test fixtures that omit the method.
    if (this.cliConfig.isMcpServerPendingApproval?.(serverName)) {
      debugLogger.debug(`Skipping MCP server pending approval: ${serverName}`);
      return;
    }

    this.stopHealthCheck(serverName);

    // Ensure we don't leak an existing connection for this server.
    const existingClient = this.clients.get(serverName);
    if (existingClient) {
      try {
        await existingClient.disconnect();
      } catch (error) {
        debugLogger.error(
          `Error stopping client '${serverName}': ${getErrorMessage(error)}`,
        );
      } finally {
        this.clients.delete(serverName);
        // Purge the OLD config's tools/prompts before rediscovery. `discover()`
        // only adds/overwrites by name and never purges, and `disconnect()`
        // doesn't touch the registries — so when this path reconnects a server
        // whose config CHANGED (the incremental fingerprint-diff branch), any
        // tool the new config drops or renames would otherwise linger,
        // selectable by the model but bound to the now-closed client. Clearing
        // here also keeps the failure path clean (a rediscovery that throws
        // leaves no stale entries behind). Mirrors `removeServer`.
        // Same-config reconnects
        // (`/mcp reconnect`, health monitor) simply re-register the
        // identical set immediately after.
        this.purgeServerRegistries(serverName);
        this.eventEmitter?.emit('mcp-client-update', this.clients);
      }
    }

    // For SDK MCP servers, pass the sendSdkMcpMessage callback.
    const sdkCallback = isSdkMcpServerConfig(serverConfig)
      ? this.sendSdkMcpMessage
      : undefined;

    const client = new McpClient(
      serverName,
      serverConfig,
      this.toolRegistry,
      this.cliConfig.getPromptRegistry(),
      this.cliConfig.getWorkspaceContext(),
      this.cliConfig.getDebugMode(),
      sdkCallback,
    );

    this.clients.set(serverName, client);
    this.eventEmitter?.emit('mcp-client-update', this.clients);

    try {
      await client.connect();
      await client.discover(cliConfig);
      // Record the connected-config key of the config this client is now
      // connected with, so the incremental reconcile can detect a later
      // in-place config change and reconnect (see
      // singleSessionConnectedKeyOf).
      this.connectedConfigKeys.set(
        serverName,
        this.singleSessionConnectedKeyOf(serverName, serverConfig),
      );
    } catch (error) {
      // Log the error but don't throw: callers expect best-effort discovery.
      debugLogger.error(
        `Error during discovery for server '${serverName}': ${getErrorMessage(
          error,
        )}`,
      );
    } finally {
      this.startHealthCheck(serverName);
      this.eventEmitter?.emit('mcp-client-update', this.clients);
    }
  }

  /**
   * Stops all running local MCP servers and closes all client connections.
   * This is the cleanup method to be called on application exit.
   */
  async stop(): Promise<void> {
    // Stop all health checks first
    this.stopAllHealthChecks();

    const disconnectionPromises = Array.from(this.clients.entries()).map(
      async ([name, client]) => {
        try {
          await client.disconnect();
        } catch (error) {
          debugLogger.error(
            `Error stopping client '${name}': ${getErrorMessage(error)}`,
          );
        }
      },
    );

    await Promise.all(disconnectionPromises);
    this.clients.clear();
    this.connectedConfigKeys.clear();
    this.consecutiveFailures.clear();
    this.isReconnecting.clear();
    this.serverDiscoveryPromises.clear();
  }

  /**
   * Disconnects a specific MCP server.
   * @param serverName The name of the server to disconnect.
   */
  async disconnectServer(serverName: string): Promise<void> {
    // Stop health check for this server
    this.stopHealthCheck(serverName);

    const client = this.clients.get(serverName);
    if (client) {
      try {
        await client.disconnect();
      } catch (error) {
        debugLogger.error(
          `Error disconnecting client '${serverName}': ${getErrorMessage(error)}`,
        );
      } finally {
        this.clients.delete(serverName);
        this.connectedConfigKeys.delete(serverName);
        this.consecutiveFailures.delete(serverName);
        this.isReconnecting.delete(serverName);
        this.serverDiscoveryPromises.delete(serverName);
        this.eventEmitter?.emit('mcp-client-update', this.clients);
      }
    }
  }

  getDiscoveryState(): MCPDiscoveryState {
    return this.discoveryState;
  }

  getServerInstructions(): Map<string, string> {
    const instructions = new Map<string, string>();
    for (const [serverName, client] of this.clients) {
      const serverInstructions = client.getInstructions();
      if (serverInstructions) {
        instructions.set(serverName, serverInstructions);
      }
    }
    return instructions;
  }

  /**
   * Starts health monitoring for a specific server
   */
  private startHealthCheck(serverName: string): void {
    if (!this.healthConfig.autoReconnect) {
      return;
    }

    // Don't arm a health-check timer for a server that no longer has a
    // tracked client. The discovery-timeout handler deletes the client
    // before the discovery `finally` block runs `startHealthCheck`, and
    // without this guard we'd create a timer that fires every
    // checkIntervalMs and ultimately reconnects an intentionally
    // timed-out server (bypassing `runWithDiscoveryTimeout`).
    if (!this.clients.has(serverName)) {
      return;
    }

    // Clear existing timer if any
    this.stopHealthCheck(serverName);

    const timer = setInterval(async () => {
      await this.performHealthCheck(serverName);
    }, this.healthConfig.checkIntervalMs);
    // Health monitoring is background bookkeeping — it must never hold the
    // event loop open. Short-lived consumers (`qwen mcp reconnect`, other
    // one-shot Config users) call `config.shutdown()` while an incremental
    // discovery pass is still in flight; that pass's `finally` block then
    // re-arms health checks AFTER `stop()` already cleared them, and a
    // ref'd interval left the process hanging forever (issue #9944). Long-
    // running sessions keep their own loop refs (TTY / server sockets), so
    // unref'ing the monitor does not shorten its life where it matters.
    timer.unref?.();

    this.healthCheckTimers.set(serverName, timer);
  }

  /**
   * Stops health monitoring for a specific server
   */
  private stopHealthCheck(serverName: string): void {
    const timer = this.healthCheckTimers.get(serverName);
    if (timer) {
      clearInterval(timer);
      this.healthCheckTimers.delete(serverName);
    }
  }

  /**
   * Stops all health checks
   */
  private stopAllHealthChecks(): void {
    for (const [, timer] of this.healthCheckTimers.entries()) {
      clearInterval(timer);
    }
    this.healthCheckTimers.clear();
  }

  /**
   * Starts health checks for all connected servers
   */
  private startAllHealthChecks(): void {
    for (const serverName of this.clients.keys()) {
      this.startHealthCheck(serverName);
    }
  }

  /**
   * Performs a health check on a specific server
   */
  private async performHealthCheck(serverName: string): Promise<void> {
    const client = this.clients.get(serverName);
    if (!client) {
      return;
    }

    // Skip if already reconnecting
    if (this.isReconnecting.get(serverName)) {
      return;
    }

    try {
      // Check if client is connected by getting its status
      const status = client.getStatus();

      if (status !== MCPServerStatus.CONNECTED) {
        // Connection is not healthy
        const failures = (this.consecutiveFailures.get(serverName) || 0) + 1;
        this.consecutiveFailures.set(serverName, failures);

        debugLogger.warn(
          `Health check failed for server '${serverName}' (${failures}/${this.healthConfig.maxConsecutiveFailures})`,
        );

        if (failures >= this.healthConfig.maxConsecutiveFailures) {
          // Trigger reconnection
          await this.reconnectServer(serverName);
        }
      } else {
        // Connection is healthy, reset failure count
        this.consecutiveFailures.set(serverName, 0);
      }
    } catch (error) {
      debugLogger.error(
        `Error during health check for server '${serverName}': ${getErrorMessage(error)}`,
      );
    }
  }

  /**
   * Reconnects a specific server
   */
  private async reconnectServer(serverName: string): Promise<void> {
    if (this.isReconnecting.get(serverName)) {
      return;
    }

    this.isReconnecting.set(serverName, true);
    debugLogger.info(`Attempting to reconnect to server '${serverName}'...`);

    try {
      // Wait before reconnecting
      await new Promise((resolve) =>
        setTimeout(resolve, this.healthConfig.reconnectDelayMs),
      );

      await this.discoverMcpToolsForServer(serverName, this.cliConfig);

      // Reset failure count on successful reconnection
      this.consecutiveFailures.set(serverName, 0);
      debugLogger.info(`Successfully reconnected to server '${serverName}'`);
    } catch (error) {
      debugLogger.error(
        `Failed to reconnect to server '${serverName}': ${getErrorMessage(error)}`,
      );
    } finally {
      this.isReconnecting.set(serverName, false);
    }
  }

  /**
   * Discovers tools incrementally for all configured servers.
   * Only updates servers that have changed or are new.
   */
  async discoverAllMcpToolsIncremental(cliConfig: Config): Promise<void> {
    if (!cliConfig.isTrustedFolder()) {
      return;
    }
    const servers = this.getEffectiveMcpServers();

    this.discoveryState = MCPDiscoveryState.IN_PROGRESS;
    recordStartupEvent('mcp_discovery_start', {
      serverCount: Object.keys(servers).length,
      incremental: true,
    });
    // Mirrors `discoverAllMcpTools`: announce IN_PROGRESS so UI subscribers
    // (MCP status pill, AppContainer batch-flush effect) know discovery
    // started, even when no servers need updates this pass.
    this.eventEmitter?.emit('mcp-client-update', this.clients);

    // Tracks the first successful server discover so we can emit the
    // `mcp_first_tool_registered` event exactly once. "First successful
    // discover" rather than a tool-count delta — simpler and aligns with the
    // user-perceived metric ("first MCP server is ready").
    let firstToolEventFired = false;

    // Find servers that are new or have changed configuration
    const serversToUpdate: string[] = [];
    const currentServerNames = new Set(this.clients.keys());
    const newServerNames = new Set(Object.keys(servers));

    for (const name of currentServerNames) {
      if (!newServerNames.has(name)) {
        // Server was removed from configuration
        await this.removeServer(name);
      }
    }

    // Check for new servers or configuration changes
    for (const [name] of Object.entries(servers)) {
      // Mirror `discoverAllMcpTools` (line ~102): users who explicitly
      // disabled a server via `mcpServers.<name>.disabled: true` must not
      // see it reconnected by the incremental path. Without this, the
      // PR-A background path silently re-registers tools the user has
      // told us to ignore.
      // A project server (`.mcp.json`) that was pending approval at startup
      // is treated exactly like a disabled server here: never reconnected,
      // and torn down if a prior pass had connected it.
      if (
        cliConfig.isMcpServerDisabled(name) ||
        cliConfig.isMcpServerPendingApproval?.(name)
      ) {
        debugLogger.debug(
          cliConfig.isMcpServerDisabled(name)
            ? `Skipping disabled MCP server: ${name}`
            : `Skipping MCP server pending approval: ${name}`,
        );
        // If the server was previously enabled and got connected, we now
        // need to tear it down — otherwise its client, registered tools
        // and health checks linger after an enabled→disabled mid-session
        // transition (e.g. via `/mcp disable <name>`). `removeServer`
        // disconnects, drops the client entry, removes tools from the
        // registry, stops the health check, and removes the global
        // status so the Footer pill stops counting it.
        if (this.clients.has(name)) {
          await this.removeServer(name);
        }
        continue;
      }
      const existingClient = this.clients.get(name);
      if (!existingClient) {
        serversToUpdate.push(name);
      } else if (existingClient.getStatus() === MCPServerStatus.DISCONNECTED) {
        // Disconnected server, try to reconnect
        serversToUpdate.push(name);
      } else {
        // Still-connected server: detect an in-place config change
        // (command / args / env / cwd, plus the discovery metadata
        // trust / alwaysLoadTools / includeTools / excludeTools) by comparing
        // the connected-config key it was connected with against the desired
        // one. Without it, editing a live server's config at runtime would
        // leave it running on the stale config. `connectedConfigKeys` is set on
        // every successful connect, so a CONNECTED client without a recorded
        // key is not expected; guard against `undefined` anyway to avoid a
        // spurious reconnect of a healthy server.
        // `discoverMcpToolsForServerInternal` disconnects the stale client
        // before reconnecting with the freshly-read config, so pushing the
        // name is sufficient — no explicit teardown needed here.
        const currentKey = this.connectedConfigKeys.get(name);
        if (
          currentKey !== undefined &&
          currentKey !== this.singleSessionConnectedKeyOf(name, servers[name])
        ) {
          serversToUpdate.push(name);
        }
      }
    }

    // Update only the servers that need it. Each per-server discover is
    // wrapped in a discovery-only timeout (default 30s,
    // per-server override via `discoveryTimeoutMs`). Tool-call timeout is
    // intentionally left alone — a long-running tool invocation is not a
    // startup pathology.
    const discoveryPromises = serversToUpdate.map(async (name) => {
      const serverConfig = servers[name];
      try {
        await this.runWithDiscoveryTimeout(name, serverConfig, () =>
          this.discoverMcpToolsForServer(name, cliConfig),
        );
        // `discoverMcpToolsForServerInternal` swallows connect/discover
        // errors (best-effort discovery semantics — see its catch block),
        // so the try here resolves even for failed servers. Only the
        // timeout path reaches the catch below. Consult the actual
        // server status to decide which outcome to record, otherwise
        // every auth failure / crash / "no tools found" looks like
        // `ready` in the startup profile.
        const client = this.clients.get(name);
        const actuallyReady =
          !!client && getMCPServerStatus(name) === MCPServerStatus.CONNECTED;
        if (actuallyReady) {
          if (!firstToolEventFired) {
            firstToolEventFired = true;
            recordStartupEvent('mcp_first_tool_registered', {
              serverName: name,
            });
          }
          recordStartupEvent(`mcp_server_ready:${name}`, {
            outcome: 'ready',
          });
        } else {
          recordStartupEvent(`mcp_server_ready:${name}`, {
            outcome: 'failed',
            reason: 'connect or discover error',
          });
        }
      } catch (error) {
        // Defensive cleanup: the dedup Map entry is normally removed by
        // `discoverMcpToolsForServer`'s `finally`, but `runWithDiscoveryTimeout`
        // can reject before that finally runs (the timeout also disconnects
        // the client to abort the underlying handshake). Without this
        // explicit delete, a brief window exists where a subsequent
        // `discoverMcpToolsForServer(name)` call would short-circuit on
        // a now-doomed promise.
        this.serverDiscoveryPromises.delete(name);
        recordStartupEvent(`mcp_server_ready:${name}`, {
          outcome: 'failed',
          reason: getErrorMessage(error),
        });
        debugLogger.error(
          `Error during incremental discovery for server '${name}': ${getErrorMessage(error)}`,
        );
      }
    });

    await Promise.all(discoveryPromises);

    // Start health checks for all connected servers
    if (this.healthConfig.autoReconnect) {
      this.startAllHealthChecks();
    }

    this.discoveryState = MCPDiscoveryState.COMPLETED;
    recordStartupEvent('mcp_all_servers_settled', {
      serverCount: Object.keys(servers).length,
      incremental: true,
    });
    // Trailing `mcp-client-update` AFTER flipping discoveryState to
    // COMPLETED. Without this the per-server updates above all fire while
    // the state is still IN_PROGRESS, so the AppContainer batch-flush
    // subscriber never observes the terminal state.
    this.eventEmitter?.emit('mcp-client-update', this.clients);
    // Default startup path (`Config.startMcpDiscoveryInBackground`) and the
    // MCP hot-reload reconcile both land here, so this is where a misspelt
    // `tools.eager` entry becomes visible (#12435).
    warnOnUnmatchedEagerToolEntries(cliConfig);
  }

  /**
   * Caps how long a single MCP server's discover handshake is allowed to
   * take during startup. Defaults to 30s. Per-server override via
   * `mcpServers.<name>.discoveryTimeoutMs` in settings.
   */
  private runWithDiscoveryTimeout<T>(
    serverName: string,
    serverConfig: MCPServerConfig | undefined,
    fn: () => Promise<T>,
  ): Promise<T> {
    const timeoutMs = this.discoveryTimeoutFor(serverConfig);
    let timedOut = false;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(async () => {
        timedOut = true;
        // CRITICAL: rejecting `runWithDiscoveryTimeout` does NOT cancel
        // the underlying `discoverMcpToolsForServer` — it keeps trying
        // to `connect()` / `discover()`, and if the slow server
        // eventually responds, `discover()` registers its tools into
        // the live `toolRegistry` and re-emits `mcp-client-update`.
        // From the user's perspective the server "failed" but its tools
        // are silently active, including any that shadow built-ins.
        //
        // Disconnect the client to abort the handshake so the background
        // promise rejects, then drop any tools that DID slip through the
        // race window. A fire-and-forget `client.disconnect()` is NOT
        // enough: `disconnect()` awaits `transport.close()`, and the
        // in-flight `discover()` may have already pumped its `tools/list`
        // response through the transport AND iterated
        // `toolRegistry.registerTool(tool)` synchronously by the time
        // the close lands. The earlier fix's comment described the
        // pre-fix state as a "remote-exploitable silent-tool-registration
        // vector" — `await` plus `removeMcpToolsByServer` closes it.
        const client = this.clients.get(serverName);
        if (client) {
          try {
            const rootPid = client.getTransportPid?.();
            if (rootPid !== undefined) {
              const descendants = await listDescendantPids(rootPid);
              if (descendants.length > 0) {
                const signaled = sigtermPids(descendants);
                debugLogger.debug(
                  `Sent SIGTERM to ${signaled}/${descendants.length} descendants ` +
                    `of pid ${rootPid} for timed-out server '${serverName}'`,
                );
                if (signaled < descendants.length) {
                  debugLogger.warn(
                    `Partial signal for timed-out server '${serverName}': ` +
                      `${signaled}/${descendants.length} descendants of pid ${rootPid} signaled. ` +
                      'Remaining processes may leak.',
                  );
                }
              }
            } else {
              debugLogger.debug(
                `Skipping descendant pid sweep for timed-out server '${serverName}': transport pid unavailable`,
              );
            }
          } catch (err) {
            debugLogger.warn(
              `Descendant pid sweep for timed-out server '${serverName}' threw: ${getErrorMessage(err)}. Proceeding with disconnect.`,
            );
          }
          try {
            await client.disconnect();
          } catch (err) {
            debugLogger.debug(
              `Forced disconnect of timed-out server '${serverName}' threw: ${getErrorMessage(err)}`,
            );
          }
        }
        // Drop any tools/prompts/resources that registered during the
        // disconnect window. No-op if the server hadn't reached `discover()`
        // yet, so it's safe to always call. A server that registered prompts /
        // resources but stalled `tools/list` past the timeout would otherwise
        // leak them bound to the closed transport.
        this.purgeServerRegistries(serverName);
        // Prevent the discovery `finally` block's `startHealthCheck` from
        // resurrecting this server: without removing the client entry,
        // `performHealthCheck` would observe `status !== CONNECTED` for
        // ~maxConsecutiveFailures intervals and then call
        // `reconnectServer()` → `discoverMcpToolsForServer()` directly,
        // bypassing `runWithDiscoveryTimeout` entirely. The intentionally
        // timed-out server would silently come back. Removing the client
        // entry + stopping any pending health-check timer closes that
        // loop; `startHealthCheck` early-returns when the client is
        // absent, so the trailing `finally`-block call becomes a no-op.
        this.stopHealthCheck(serverName);
        this.clients.delete(serverName);
        this.connectedConfigKeys.delete(serverName);
        reject(
          new Error(
            `MCP server '${serverName}' discovery timed out after ${timeoutMs}ms`,
          ),
        );
      }, timeoutMs);
      fn().then(
        (value) => {
          clearTimeout(timer);
          // Suppress success after timeout — the timeout already
          // rejected the outer promise; resolving it again is a no-op
          // but the success path would also re-emit
          // `mcp_server_ready:ready` and `mcp_first_tool_registered`
          // even though the rest of the system has moved on.
          if (!timedOut) resolve(value);
        },
        (err) => {
          clearTimeout(timer);
          if (!timedOut) {
            reject(err instanceof Error ? err : new Error(String(err)));
          }
        },
      );
    });
  }

  /**
   * Minimum / maximum discovery timeouts. `0` or a negative value as a
   * per-server override would cause every discover to fire its timeout on
   * the next tick — combined with the lack of disconnect on timeout this
   * was a remote-exploitable silent-tool-registration vector (a
   * MITM/attacker-controlled MCP server could land its tools after the
   * timeout fired). `Infinity` / very large values would hang
   * `waitForMcpReady()` forever for non-interactive paths. The 100ms
   * floor is generous (real handshakes start in single-digit ms locally,
   * tens of ms remote); the 5-minute ceiling matches the longest tool
   * call timeouts we've documented.
   */
  private static readonly MIN_DISCOVERY_TIMEOUT_MS = 100;
  private static readonly MAX_DISCOVERY_TIMEOUT_MS = 300_000;

  private discoveryTimeoutFor(serverConfig?: MCPServerConfig): number {
    const override = serverConfig?.discoveryTimeoutMs;
    if (override !== undefined && Number.isFinite(override)) {
      return Math.max(
        McpClientManager.MIN_DISCOVERY_TIMEOUT_MS,
        Math.min(override, McpClientManager.MAX_DISCOVERY_TIMEOUT_MS),
      );
    }
    return 30_000;
  }

  /**
   * The reconnect key for a server config. `connectionIdOf` is transport-only
   * (it excludes the discovery filters), but the reconcile must ALSO reconnect
   * when only discovery metadata changes. Append the canonical metadata
   * identity so equivalent filters do not reconnect.
   */
  private singleSessionConnectedKeyOf(
    serverName: string,
    config: MCPServerConfig,
  ): string {
    return `${connectionIdOf(serverName, config)}|${mcpSessionMetadataKey(config)}`;
  }

  /**
   * Purge a server's entries from all three registries (tools + prompts +
   * resources). Every teardown path must clean all three atomically — a missed
   * registry leaves stale entries bound to a closed client (selectable by the
   * model, or surfaced by `listMcpResources`). Centralized here so adding a
   * future registry is one edit, not a hunt across teardown sites. Callers keep
   * their own transport disconnect / map deletes / health-check / status
   * handling — only the registry purge is shared.
   */
  private purgeServerRegistries(serverName: string): void {
    this.toolRegistry.removeMcpToolsByServer(serverName);
    this.cliConfig.getPromptRegistry().removePromptsByServer(serverName);
    this.cliConfig.getResourceRegistry().removeResourcesByServer(serverName);
  }

  /**
   * Removes a server and its tools
   */
  private async removeServer(serverName: string): Promise<void> {
    const client = this.clients.get(serverName);
    if (client) {
      try {
        await client.disconnect();
      } catch (error) {
        debugLogger.error(
          `Error disconnecting removed server '${serverName}': ${getErrorMessage(error)}`,
        );
      }
      this.clients.delete(serverName);
      this.stopHealthCheck(serverName);
      this.consecutiveFailures.delete(serverName);
    }
    this.connectedConfigKeys.delete(serverName);

    // Remove tools, prompts and resources for this server. Unlike
    // `ToolRegistry.disconnectServer`, this config-driven removal path never
    // cleaned up the prompt/resource registries, so a removed/changed server
    // leaked them across a hot-reload.
    this.purgeServerRegistries(serverName);

    // The server has been removed from configuration, so drop it from the
    // global status registry too — the health pill should no longer count it.
    removeMCPServerStatus(serverName);

    this.eventEmitter?.emit('mcp-client-update', this.clients);
  }

  async readResource(
    serverName: string,
    uri: string,
    options?: { signal?: AbortSignal },
  ): Promise<ReadResourceResult> {
    const servers = this.getEffectiveMcpServers();
    const serverConfig = servers[serverName];
    if (this.cliConfig.isMcpServerDisabled(serverName)) {
      throw new Error(`MCP server '${serverName}' is disabled.`);
    }
    let client = this.clients.get(serverName);
    if (!client) {
      if (!serverConfig) {
        throw new Error(`MCP server '${serverName}' is not configured.`);
      }

      // the lazy-spawn path
      // previously bypassed `isMcpServerDisabled`. A server the
      // operator disabled via `mcpServers.<name>.disabled: true` or
      // `/mcp disable <name>` could be resurrected by any resource
      // read call. Now matches the disabled-check pattern in
      // `discoverAllMcpTools` and `discoverAllMcpToolsIncremental`.
      if (this.cliConfig.isMcpServerDisabled(serverName)) {
        throw new Error(`MCP server '${serverName}' is disabled.`);
      }

      // A pending-approval project server (`.mcp.json`) must not be lazy-spawned
      // by a resource read either (#4615).
      if (this.cliConfig.isMcpServerPendingApproval?.(serverName)) {
        throw new Error(`MCP server '${serverName}' is pending approval.`);
      }

      // Discovery never starts servers in an untrusted folder; neither does a
      // resource read.
      if (!this.cliConfig.isTrustedFolder()) {
        throw new Error(
          `MCP server '${serverName}' cannot start in an untrusted folder.`,
        );
      }

      const sdkCallback = isSdkMcpServerConfig(serverConfig)
        ? this.sendSdkMcpMessage
        : undefined;

      client = new McpClient(
        serverName,
        serverConfig,
        this.toolRegistry,
        this.cliConfig.getPromptRegistry(),
        this.cliConfig.getWorkspaceContext(),
        this.cliConfig.getDebugMode(),
        sdkCallback,
      );
      this.clients.set(serverName, client);
      this.eventEmitter?.emit('mcp-client-update', this.clients);
    }

    // when an already-
    // tracked client exists (the `if (!client)` block above is
    // skipped), the disabled gate added in R3 #5 doesn't fire. So a
    // server connected pre-disable, then operator-disabled mid-
    // session via `/mcp disable <name>` or a settings reload, would
    // still serve resource reads via its existing CONNECTED client
    // until the next incremental discovery pass calls `removeServer`.
    // Re-check disabled state on every readResource, regardless of
    // whether the client was just lazy-spawned or pre-existing.
    if (this.cliConfig.isMcpServerDisabled(serverName)) {
      throw new Error(`MCP server '${serverName}' is disabled.`);
    }

    // Re-check pending approval on every readResource too (#4615): a server can
    // flip to pending if its `.mcp.json` config changed since approval.
    if (this.cliConfig.isMcpServerPendingApproval?.(serverName)) {
      throw new Error(`MCP server '${serverName}' is pending approval.`);
    }

    if (client.getStatus() !== MCPServerStatus.CONNECTED) {
      // Wrap the lazy-spawn `client.connect()` in the same discovery
      // timeout the bulk + incremental paths use so a hung MCP server
      // during a resource-read spawn cannot block forever. Reuses
      // `discoveryTimeoutFor` so per-server `discoveryTimeoutMs`
      // overrides apply uniformly across spawn paths.
      const timeoutMs = this.discoveryTimeoutFor(serverConfig);
      let timeoutId: NodeJS.Timeout | undefined;
      await Promise.race([
        client.connect(),
        new Promise<never>((_, reject) => {
          timeoutId = setTimeout(() => {
            reject(
              new Error(
                `MCP server '${serverName}' lazy connect timed out after ${timeoutMs}ms`,
              ),
            );
          }, timeoutMs);
        }),
      ]).finally(() => {
        if (timeoutId) clearTimeout(timeoutId);
      });
      // Record the fingerprint of the config this client connected with so a
      // later `discoverAllMcpToolsIncremental` can detect an in-place config
      // change. The reconcile guard skips a still-connected server whose
      // key is `undefined`; without this, a server first brought up by a lazy
      // resource read would silently ignore a subsequent edit.
      this.connectedConfigKeys.set(
        serverName,
        this.singleSessionConnectedKeyOf(serverName, serverConfig),
      );
      // start
      // the health monitor on a successful lazy spawn. Pre-fix
      // a lazy-spawned server that later disconnected (crash,
      // network) had no automatic reconnect path — the client
      // sat DISCONNECTED in `this.clients` until the next
      // readResource or incremental pass. Mirror the
      // `discoverMcpToolsForServerInternal` finally-block
      // pattern.
      this.startHealthCheck(serverName);
    }

    return client.readResource(uri, options);
  }
}
