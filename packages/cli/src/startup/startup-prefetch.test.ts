/**
 * @license
 * Copyright 2026 Qwen Code
 * SPDX-License-Identifier: Apache-2.0
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Config } from '@qwen-code/qwen-code-core';
import type { LoadedSettings } from '../config/settings.js';
import { startPostRenderPrefetches } from './startup-prefetch.js';

const mockDebug = vi.hoisted(() => vi.fn());
const mockWarn = vi.hoisted(() => vi.fn());
const mockRecordStartupEvent = vi.hoisted(() => vi.fn());
const mockInitializeTelemetry = vi.hoisted(() => vi.fn());
const mockStartBackgroundHousekeeping = vi.hoisted(() => vi.fn());

vi.mock('@qwen-code/qwen-code-core', () => ({
  createDebugLogger: () => ({
    debug: mockDebug,
    warn: mockWarn,
  }),
  initializeTelemetry: (...args: unknown[]) => mockInitializeTelemetry(...args),
}));

vi.mock('../utils/startupProfiler.js', () => ({
  recordStartupEvent: (...args: unknown[]) => mockRecordStartupEvent(...args),
}));

vi.mock('../services/housekeeping/scheduler.js', () => ({
  startBackgroundHousekeeping: (...args: unknown[]) =>
    mockStartBackgroundHousekeeping(...args),
}));

function makeConfig(overrides: Partial<Config> = {}): Config {
  return {
    getProjectRoot: () => '/repo',
    getWorkingDir: () => '/repo',
    isInteractive: () => true,
    ...overrides,
  } as unknown as Config;
}

function makeSettings(): LoadedSettings {
  return { merged: {} } as LoadedSettings;
}

describe('startupPrefetch', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  async function settle() {
    await vi.dynamicImportSettled();
    await new Promise((resolve) => setTimeout(resolve, 0));
  }

  it('records completed profiler lifecycle events for successful deferred tasks', async () => {
    const config = makeConfig();

    startPostRenderPrefetches(config, makeSettings());

    await settle();

    expect(mockRecordStartupEvent).toHaveBeenCalledWith(
      'startup_prefetch_started',
      { name: 'background_housekeeping' },
    );
    expect(mockRecordStartupEvent).toHaveBeenCalledWith(
      'startup_prefetch_completed',
      { name: 'background_housekeeping' },
    );
  });

  it('starts post-render tasks without awaiting completion', async () => {
    const config = makeConfig();
    mockInitializeTelemetry.mockReturnValue(new Promise<void>(() => {}));

    startPostRenderPrefetches(config, makeSettings(), {
      initializeTelemetry: true,
    });

    await settle();

    expect(mockInitializeTelemetry).toHaveBeenCalledTimes(1);
    expect(mockStartBackgroundHousekeeping).toHaveBeenCalledWith(
      config,
      expect.any(Object),
    );
  });

  it('initializes telemetry when requested', async () => {
    const config = makeConfig();

    startPostRenderPrefetches(config, makeSettings(), {
      initializeTelemetry: true,
    });

    await settle();

    expect(mockInitializeTelemetry).toHaveBeenCalledWith(config);
  });

  it('does not initialize telemetry unless requested', async () => {
    const config = makeConfig();

    startPostRenderPrefetches(config, makeSettings());

    await settle();

    expect(mockInitializeTelemetry).not.toHaveBeenCalled();
  });

  it('swallows telemetry initialization failures', async () => {
    const config = makeConfig();
    const error = new Error('otel unavailable');
    mockInitializeTelemetry.mockImplementation(() => {
      throw error;
    });

    expect(() =>
      startPostRenderPrefetches(config, makeSettings(), {
        initializeTelemetry: true,
      }),
    ).not.toThrow();

    await settle();

    expect(mockWarn).toHaveBeenCalledWith('telemetry_init failed:', error);
  });

  it('swallows deferred task failures', async () => {
    const config = makeConfig();
    const error = new Error('housekeeping failed');
    mockStartBackgroundHousekeeping.mockImplementation(() => {
      throw error;
    });

    expect(() =>
      startPostRenderPrefetches(config, makeSettings()),
    ).not.toThrow();

    await settle();

    expect(mockWarn).toHaveBeenCalledWith(
      'background_housekeeping failed:',
      error,
    );
    expect(mockRecordStartupEvent).toHaveBeenCalledWith(
      'startup_prefetch_failed',
      { name: 'background_housekeeping' },
    );
  });

  it('does not start housekeeping for non-interactive configs', async () => {
    const config = makeConfig({
      isInteractive: () => false,
    } as Partial<Config>);

    startPostRenderPrefetches(config, makeSettings());

    await settle();

    expect(mockStartBackgroundHousekeeping).not.toHaveBeenCalled();
  });

  it('starts post-render prefetch only once per config', async () => {
    const config = makeConfig();

    startPostRenderPrefetches(config, makeSettings(), {
      initializeTelemetry: true,
    });
    startPostRenderPrefetches(config, makeSettings(), {
      initializeTelemetry: true,
    });

    await settle();

    expect(mockInitializeTelemetry).toHaveBeenCalledTimes(1);
    expect(mockStartBackgroundHousekeeping).toHaveBeenCalledTimes(1);
  });
});
