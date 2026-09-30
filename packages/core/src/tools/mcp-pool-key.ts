/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { createHash } from 'node:crypto';
import {
  isSdkMcpServerConfig,
  type MCPServerConfig,
} from '../config/config.js';
import { type McpTransportKind, mcpTransportOf } from './mcp-client-manager.js';
import {
  effectiveAppResourceMaxBytes,
  effectiveAppResourceTimeoutMs,
} from './mcp-app-resource-limits.js';
import type { ConnectionId } from './mcp-pool-events.js';

/**
 * Truncated SHA-256 hex (first 16 chars = 64 bits). At realistic pool
 * size (N < 1000 entries per workspace, typically < 100), birthday-
 * collision probability is < 10^-15 — safe to use as map key without
 * a fallback path.
 */
export type PoolKey = string;

/**
 * `McpTransportKind` and `mcpTransportOf` re-exported from
 * `mcp-client-manager.ts` (where they originated as part of the
 * budget guardrail accounting). imports + re-exports
 * via the pool barrel for downstream daemon code.
 */
export { mcpTransportOf, type McpTransportKind } from './mcp-client-manager.js';

/**
 * Default set of transports the pool will share. stdio servers are true
 * OS subprocesses whose state is observable and isolatable. See
 * `docs/design/f2-mcp-transport-pool.md`.
 */
export const POOLED_TRANSPORTS_DEFAULT: ReadonlySet<McpTransportKind> = new Set(
  ['stdio'],
);

/**
 * Decide whether a server config is eligible for pool sharing.
 * SDK MCP servers always bypass (per-session by design); other
 * transports gated on the operator's `pooledTransports` selection.
 */
export function isPoolable(
  cfg: MCPServerConfig,
  pooledTransports: ReadonlySet<McpTransportKind>,
): boolean {
  if (isSdkMcpServerConfig(cfg)) return false;
  return pooledTransports.has(mcpTransportOf(cfg));
}

/**
 * Sort entries by key for stable JSON. Returns `[]` for nullish input
 * so callsites can treat `undefined` env identically to empty objects.
 */
function sortedEntries(
  obj: Record<string, string> | undefined | null,
): Array<[string, string]> {
  if (!obj) return [];
  return Object.entries(obj).sort((a, b) =>
    a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0,
  );
}

/**
 * Compute the pool fingerprint for an MCP server config. Two configs
 * with identical transport, env, and shared tool-snapshot settings
 * produce the same fingerprint and thus share a pool entry; any divergence
 * creates a distinct entry. App resource limits belong in the key because
 * discovery stores them in the shared tool snapshot without per-session
 * re-projection. They hash at their enforced (clamped/floored/defaulted)
 * values — the same normalization the read site applies — so configs whose
 * effective policy is byte-identical share one entry instead of spawning a
 * second process for one server.
 *
 * Hashed fields (transport and shared tool-snapshot settings):
 *   transport, command, args, cwd, env,
 *   timeout, appResourceMaxBytes, appResourceTimeoutMs, versionNegotiation
 *
 * Excluded fields (per-session filter / metadata; do NOT change the
 * underlying transport):
 *   includeTools, excludeTools, trust, alwaysLoadTools, description,
 *   extensionName,
 *   discoveryTimeoutMs (operational tuning; honored from the first
 *   acquire's config but not in the key — see TODO below)
 *
 * TODO(follow-up): if two sessions race-acquire the same key with
 * different discoveryTimeoutMs values, the first wins. This matches
 * previous behavior (per-session managers each used their own timeout)
 * but could surprise operators tuning per-session. Acceptable for v1.
 */
export function fingerprint(cfg: MCPServerConfig): PoolKey {
  const canonical = {
    transport: mcpTransportOf(cfg),
    command: cfg.command ?? null,
    args: cfg.args ?? [],
    cwd: cfg.cwd ?? null,
    env: sortedEntries(cfg.env),
    timeout: cfg.timeout ?? null,
    appResourceMaxBytes: effectiveAppResourceMaxBytes(cfg.appResourceMaxBytes),
    appResourceTimeoutMs: effectiveAppResourceTimeoutMs(
      cfg.appResourceTimeoutMs,
    ),
    automaticVersionNegotiation: cfg.versionNegotiation === 'auto',
  };
  return createHash('sha256')
    .update(JSON.stringify(canonical))
    .digest('hex')
    .slice(0, 16);
}

/**
 * Build the `ConnectionId` from server name + computed fingerprint.
 * Form: `${name}::${fp16hex}`. Same name + different fingerprints
 * (e.g. divergent env between sessions) yields
 * distinct ConnectionIds — see global state coexistence for how
 * the global `serverStatuses` Map handles multi-entry name collisions.
 */
export function connectionIdOf(
  serverName: string,
  cfg: MCPServerConfig,
): ConnectionId {
  return `${serverName}::${fingerprint(cfg)}` as ConnectionId;
}

/**
 * Parse a ConnectionId back into its components. Useful for status
 * routes that need to surface the (serverName, entryIndex) pair
 * without exposing the raw fingerprint to clients.
 */
export function parseConnectionId(id: ConnectionId): {
  serverName: string;
  fingerprint: PoolKey;
} {
  const sep = id.lastIndexOf('::');
  if (sep < 0) {
    throw new Error(`Invalid ConnectionId: ${id}`);
  }
  return {
    serverName: id.slice(0, sep),
    fingerprint: id.slice(sep + 2),
  };
}
