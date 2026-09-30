/**
 * @license
 * Copyright 2026 Qwen Code
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  createDebugLogger,
  initializeTelemetry,
  type Config,
} from '@qwen-code/qwen-code-core';
import type { LoadedSettings } from '../config/settings.js';
import { recordStartupEvent } from '../utils/startupProfiler.js';

const debugLogger = createDebugLogger('STARTUP_PREFETCH');

const postRenderStarted = new WeakSet<Config>();

/**
 * Starts a best-effort startup task without adding it to the caller's
 * critical path. Failures are recorded for diagnostics and otherwise
 * swallowed so optional prefetch work cannot break REPL startup.
 */
function runDeferredTask(name: string, task: () => Promise<void> | void): void {
  recordStartupEvent('startup_prefetch_started', { name });
  void Promise.resolve()
    .then(task)
    .then(() => {
      recordStartupEvent('startup_prefetch_completed', { name });
    })
    .catch((err) => {
      recordStartupEvent('startup_prefetch_failed', { name });
      debugLogger.warn(`${name} failed:`, err);
    });
}

/**
 * Starts post-render startup prefetches for ordinary interactive TUI sessions.
 *
 * This runs immediately after Ink's `render()` returns (`first_paint`). Tasks
 * here may load heavier modules, but they must not affect
 * `startInteractiveUI()` success.
 */
export function startPostRenderPrefetches(
  config: Config,
  settings: LoadedSettings,
  options: { initializeTelemetry?: boolean } = {},
): void {
  if (postRenderStarted.has(config)) return;
  postRenderStarted.add(config);

  if (options.initializeTelemetry) {
    runDeferredTask('telemetry_init', () => initializeTelemetry(config));
  }

  if (config.isInteractive()) {
    runDeferredTask('background_housekeeping', async () => {
      const { startBackgroundHousekeeping } = await import(
        '../services/housekeeping/scheduler.js'
      );
      startBackgroundHousekeeping(config, settings);
    });
  }
}
