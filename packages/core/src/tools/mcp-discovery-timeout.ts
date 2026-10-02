/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type { MCPServerConfig } from '../config/config.js';

/**
 * Discovery-timeout primitives. Mirrors
 * `McpClientManager.runWithDiscoveryTimeout` / `discoveryTimeoutFor`
 * exactly (default 30s, per-server `discoveryTimeoutMs` override clamped
 * to [100ms, 300s]).
 */

/** Hard floor for the per-server `discoveryTimeoutMs` override. */
const MIN_DISCOVERY_TIMEOUT_MS = 100;
/** Hard ceiling for the per-server `discoveryTimeoutMs` override. */
const MAX_DISCOVERY_TIMEOUT_MS = 300_000;
/** Default — local subprocesses get leeway for cold start. */
const DEFAULT_DISCOVERY_TIMEOUT_MS = 30_000;

/**
 * Resolve the discovery timeout for a server config. Defaults to 30s;
 * per-server `discoveryTimeoutMs` override is honored when present
 * (clamped to [100ms, 300s]).
 */
export function discoveryTimeoutFor(cfg: MCPServerConfig): number {
  const override = cfg.discoveryTimeoutMs;
  if (override !== undefined && Number.isFinite(override)) {
    return Math.max(
      MIN_DISCOVERY_TIMEOUT_MS,
      Math.min(override, MAX_DISCOVERY_TIMEOUT_MS),
    );
  }
  return DEFAULT_DISCOVERY_TIMEOUT_MS;
}

/**
 * Race `task` against a wall-clock timer. The background `task`
 * promise is NOT cancelled on timeout — Node's Promise model can't
 * cancel an in-flight `await`; the caller's catch block is responsible
 * for closing the transport.
 *
 * Returns the `task` value on success; rejects with a
 * `Timed out after Nms: <label>` Error if the timer fires first.
 */
export function runWithTimeout<T>(
  task: Promise<T>,
  timeoutMs: number,
  label: string,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(
        new Error(
          `Timed out after ${timeoutMs}ms: ${label}. The MCP server may be hung.`,
        ),
      );
    }, timeoutMs);
    timer.unref?.();
    task.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      },
    );
  });
}
