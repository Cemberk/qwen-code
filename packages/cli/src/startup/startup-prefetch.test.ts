/**
 * @license
 * Copyright 2026 Qwen Code
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Config } from '@qwen-code/qwen-code-core';
import type { LoadedSettings } from '../config/settings.js';
import {
  startEarlyStartupPrefetches,
  startPostRenderPrefetches,
  UPDATE_CHECK_DELAY_MS,
} from './startup-prefetch.js';

const mockDebug = vi.hoisted(() => vi.fn());
const mockWarn = vi.hoisted(() => vi.fn());
const mockPreconnectApi = vi.hoisted(() => vi.fn());
const mockRecordStartupEvent = vi.hoisted(() => vi.fn());
const mockCheckForUpdatesDetailed = vi.hoisted(() => vi.fn());
const mockHandleAutoUpdate = vi.hoisted(() => vi.fn());
const mockRequestUpdateOnExit = vi.hoisted(() => vi.fn());
const mockGetInstallationInfo = vi.hoisted(() => vi.fn());
const mockUpdateEventEmit = vi.hoisted(() => vi.fn());
const mockInitializeTelemetry = vi.hoisted(() => vi.fn());
const mockStartBackgroundHousekeeping = vi.hoisted(() => vi.fn());

vi.mock('@qwen-code/qwen-code-core', () => ({
  createDebugLogger: () => ({
    debug: mockDebug,
    warn: mockWarn,
  }),
  initializeTelemetry: (...args: unknown[]) => mockInitializeTelemetry(...args),
}));

vi.mock('../utils/apiPreconnect.js', () => ({
  preconnectApi: (...args: unknown[]) => mockPreconnectApi(...args),
}));

vi.mock('../utils/startupProfiler.js', () => ({
  recordStartupEvent: (...args: unknown[]) => mockRecordStartupEvent(...args),
}));

vi.mock('../ui/utils/updateCheck.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../ui/utils/updateCheck.js')>()),
  checkForUpdatesDetailed: (...args: unknown[]) =>
    mockCheckForUpdatesDetailed(...args),
}));

vi.mock('../utils/processUtils.js', () => ({
  CUSTOM_SANDBOX_IMAGE_ENV_VAR: 'QWEN_CODE_CUSTOM_SANDBOX_IMAGE',
  HOST_UPDATE_RELAUNCH_ENV_VAR: 'QWEN_CODE_HOST_UPDATE_RELAUNCH',
  SKIP_UPDATE_CHECK_ENV_VAR: 'QWEN_CODE_SKIP_UPDATE_CHECK_ONCE',
  requestUpdateOnExit: (...args: unknown[]) => mockRequestUpdateOnExit(...args),
}));

vi.mock('../ui/handleAutoUpdate.js', () => ({
  handleAutoUpdate: (...args: unknown[]) => mockHandleAutoUpdate(...args),
}));

vi.mock('../utils/installationInfo.js', () => ({
  getInstallationInfo: (...args: unknown[]) => mockGetInstallationInfo(...args),
}));

vi.mock('../utils/updateEventEmitter.js', () => ({
  updateEventEmitter: {
    emit: (...args: unknown[]) => mockUpdateEventEmit(...args),
  },
}));

vi.mock('../i18n/index.js', () => ({
  t: (key: string, params?: Record<string, string | number>) =>
    params
      ? key.replace(/\{\{(\w+)\}\}/g, (match, name) =>
          name in params ? String(params[name]) : match,
        )
      : key,
}));

vi.mock('../services/housekeeping/scheduler.js', () => ({
  startBackgroundHousekeeping: (...args: unknown[]) =>
    mockStartBackgroundHousekeeping(...args),
}));

function makeConfig(overrides: Partial<Config> = {}): Config {
  return {
    getModelsConfig: () => ({
      getCurrentAuthType: () => 'openai',
      getGenerationConfig: () => ({ baseUrl: 'https://api.openai.com/v1' }),
    }),
    getProxy: () => 'http://proxy.example',
    getProjectRoot: () => '/repo',
    getWorkingDir: () => '/repo',
    isInteractive: () => true,
    ...overrides,
  } as unknown as Config;
}

function makeSettings(
  enableAutoUpdate: boolean | undefined = undefined,
): LoadedSettings {
  return {
    merged: {
      general: enableAutoUpdate === undefined ? {} : { enableAutoUpdate },
    },
  } as LoadedSettings;
}

describe('startupPrefetch', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    delete process.env['QWEN_CODE_CUSTOM_SANDBOX_IMAGE'];
    delete process.env['QWEN_CODE_HOST_UPDATE_RELAUNCH'];
    delete process.env['QWEN_CODE_SKIP_UPDATE_CHECK_ONCE'];
    vi.useFakeTimers();
    mockCheckForUpdatesDetailed.mockResolvedValue({
      status: 'up-to-date',
      currentVersion: '1.0.0',
    });
    mockGetInstallationInfo.mockReturnValue({
      updateCommand: 'npm install -g @qwen-code/qwen-code@latest',
      packageManager: 'npm',
      isStandalone: false,
    });
    mockRequestUpdateOnExit.mockReturnValue(true);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  // The update check waits UPDATE_CHECK_DELAY_MS before it starts.
  async function settle() {
    await vi.advanceTimersByTimeAsync(UPDATE_CHECK_DELAY_MS);
    await vi.dynamicImportSettled();
  }

  it('starts API preconnect with resolved auth config', () => {
    const config = makeConfig();

    startEarlyStartupPrefetches(config);

    expect(mockPreconnectApi).toHaveBeenCalledWith('openai', {
      resolvedBaseUrl: 'https://api.openai.com/v1',
      proxy: 'http://proxy.example',
    });
  });

  it('does not record an unbalanced lifecycle event for API preconnect', () => {
    const config = makeConfig();

    startEarlyStartupPrefetches(config);

    expect(mockRecordStartupEvent).not.toHaveBeenCalledWith(
      'startup_prefetch_started',
      { name: 'api_preconnect' },
    );
  });

  it('starts early prefetch only once per config', () => {
    const config = makeConfig();

    startEarlyStartupPrefetches(config);
    startEarlyStartupPrefetches(config);

    expect(mockPreconnectApi).toHaveBeenCalledTimes(1);
  });

  it('skips preconnect errors without throwing', () => {
    const config = makeConfig({
      getModelsConfig: () => {
        throw new Error('bad config');
      },
    } as Partial<Config>);

    expect(() => startEarlyStartupPrefetches(config)).not.toThrow();
    expect(mockPreconnectApi).not.toHaveBeenCalled();
    expect(mockDebug).toHaveBeenCalled();
  });

  it('records completed profiler lifecycle events for successful deferred tasks', async () => {
    const config = makeConfig({
      isInteractive: () => false,
    } as Partial<Config>);

    startPostRenderPrefetches(config, makeSettings());

    await settle();

    expect(mockCheckForUpdatesDetailed).toHaveBeenCalledTimes(1);
    expect(mockRequestUpdateOnExit).not.toHaveBeenCalled();
    expect(mockRecordStartupEvent).toHaveBeenCalledWith(
      'startup_prefetch_started',
      { name: 'update_check' },
    );
    expect(mockRecordStartupEvent).toHaveBeenCalledWith(
      'startup_prefetch_completed',
      { name: 'update_check' },
    );
  });

  it('waits UPDATE_CHECK_DELAY_MS before checking for updates', async () => {
    startPostRenderPrefetches(makeConfig(), makeSettings());

    await vi.advanceTimersByTimeAsync(UPDATE_CHECK_DELAY_MS - 1);
    await vi.dynamicImportSettled();
    expect(mockCheckForUpdatesDetailed).not.toHaveBeenCalled();

    await settle();
    expect(mockCheckForUpdatesDetailed).toHaveBeenCalledTimes(1);
  });

  it('installs npm updates in the background after first render', async () => {
    const config = makeConfig();
    const settings = makeSettings();
    mockCheckForUpdatesDetailed.mockResolvedValue({
      status: 'update',
      info: {
        message: 'Update available',
        update: { latest: '2.0.0' },
      },
    });

    startPostRenderPrefetches(config, settings);

    await settle();

    expect(mockHandleAutoUpdate).toHaveBeenCalledWith(
      {
        message: 'Update available',
        update: { latest: '2.0.0' },
      },
      settings,
      '/repo',
    );
    expect(mockRequestUpdateOnExit).not.toHaveBeenCalled();
  });

  it('keeps manual guidance for npm installs without an update command', async () => {
    mockGetInstallationInfo.mockReturnValue({
      packageManager: 'npm',
      isGlobal: true,
      updateMessage: 'Update requires sudo.',
    });
    mockCheckForUpdatesDetailed.mockResolvedValue({
      status: 'update',
      info: {
        message: 'Update available',
        update: { latest: '2.0.0' },
      },
    });

    startPostRenderPrefetches(makeConfig(), makeSettings());
    await settle();

    expect(mockHandleAutoUpdate).toHaveBeenCalledOnce();
    expect(mockRequestUpdateOnExit).not.toHaveBeenCalled();
  });

  it('prompts non-npm installs when no parent supervisor is available', async () => {
    mockRequestUpdateOnExit.mockReturnValue(false);
    mockGetInstallationInfo.mockReturnValue({
      updateCommand: 'pnpm add -g @qwen-code/qwen-code@latest',
      packageManager: 'pnpm',
      isGlobal: true,
    });
    mockCheckForUpdatesDetailed.mockResolvedValue({
      status: 'update',
      info: {
        message: 'Update available',
        update: { latest: '2.0.0' },
      },
    });

    startPostRenderPrefetches(makeConfig(), makeSettings());
    await settle();

    expect(mockUpdateEventEmit).toHaveBeenCalledWith('update-info', {
      message: 'Update available\nRun /update to install the update.',
    });
  });

  it('defers standalone updates until the session exits', async () => {
    const config = makeConfig();
    mockCheckForUpdatesDetailed.mockResolvedValue({
      status: 'update',
      info: {
        message: 'Update available',
        update: { latest: '2.0.0' },
      },
    });
    mockGetInstallationInfo.mockReturnValue({
      updateCommand: 'standalone update',
      packageManager: 'standalone',
      isStandalone: true,
      standaloneDir: '/tmp/qwen-code',
    });

    startPostRenderPrefetches(config, makeSettings());

    await settle();

    expect(mockRequestUpdateOnExit).toHaveBeenCalledTimes(1);
    expect(mockHandleAutoUpdate).not.toHaveBeenCalled();
  });

  it('keeps a container running until the user updates the host', async () => {
    process.env['QWEN_CODE_HOST_UPDATE_RELAUNCH'] = 'true';
    mockCheckForUpdatesDetailed.mockResolvedValue({
      status: 'update',
      info: {
        message: 'Update available',
        update: { latest: '2.0.0' },
      },
    });

    startPostRenderPrefetches(makeConfig(), makeSettings());
    await settle();

    expect(mockRequestUpdateOnExit).not.toHaveBeenCalled();
    expect(mockGetInstallationInfo).not.toHaveBeenCalled();
    expect(mockUpdateEventEmit).toHaveBeenCalledWith('update-info', {
      message:
        'Update available\nRun /update to install the update on the host.',
    });
  });

  it('keeps a container running when the host requires manual updates', async () => {
    process.env['QWEN_CODE_HOST_UPDATE_RELAUNCH'] = 'false';
    mockCheckForUpdatesDetailed.mockResolvedValue({
      status: 'update',
      info: {
        message: 'Update available',
        update: { latest: '2.0.0' },
      },
    });

    startPostRenderPrefetches(makeConfig(), makeSettings());
    await settle();

    expect(mockRequestUpdateOnExit).not.toHaveBeenCalled();
    expect(mockHandleAutoUpdate).not.toHaveBeenCalled();
    expect(mockUpdateEventEmit).toHaveBeenCalledWith('update-info', {
      message:
        'Update available\nUpdate Qwen Code on the host, then restart the sandbox.',
    });
  });

  it('skips one automatic update check after an update relaunch', async () => {
    process.env['QWEN_CODE_SKIP_UPDATE_CHECK_ONCE'] = 'true';

    try {
      startPostRenderPrefetches(makeConfig(), makeSettings());
      await settle();

      expect(mockCheckForUpdatesDetailed).not.toHaveBeenCalled();
    } finally {
      delete process.env['QWEN_CODE_SKIP_UPDATE_CHECK_ONCE'];
    }
  });

  it('leaves explicitly configured sandbox images user-managed', async () => {
    process.env['QWEN_CODE_CUSTOM_SANDBOX_IMAGE'] =
      'example.com/custom-qwen:1.0.0';

    try {
      startPostRenderPrefetches(makeConfig(), makeSettings());
      await settle();

      expect(mockCheckForUpdatesDetailed).not.toHaveBeenCalled();
      expect(mockRequestUpdateOnExit).not.toHaveBeenCalled();
    } finally {
      delete process.env['QWEN_CODE_CUSTOM_SANDBOX_IMAGE'];
    }
  });

  it('starts post-render tasks without awaiting completion', async () => {
    const config = makeConfig();
    const updatePromise = new Promise<null>(() => {});
    mockCheckForUpdatesDetailed.mockReturnValue(updatePromise);

    startPostRenderPrefetches(config, makeSettings());

    await settle();

    expect(mockCheckForUpdatesDetailed).toHaveBeenCalledTimes(1);
    expect(mockStartBackgroundHousekeeping).toHaveBeenCalledWith(
      config,
      expect.any(Object),
    );
  });

  it('does not run update check when auto-update is disabled', async () => {
    const config = makeConfig();

    startPostRenderPrefetches(config, makeSettings(false));

    await settle();

    expect(mockCheckForUpdatesDetailed).not.toHaveBeenCalled();
  });

  it('surfaces update check errors as a warning through the update event emitter', async () => {
    const config = makeConfig();
    mockCheckForUpdatesDetailed.mockResolvedValue({
      status: 'error',
      error: new Error('registry unavailable'),
    });

    startPostRenderPrefetches(config, makeSettings());

    await settle();

    expect(mockUpdateEventEmit).toHaveBeenCalledWith('update-failed', {
      message: 'Update check skipped (registry error) — run /update to retry.',
      severity: 'warning',
    });
    expect(mockRequestUpdateOnExit).not.toHaveBeenCalled();
  });

  it('reports a timeout-specific reason when the update check times out', async () => {
    const config = makeConfig();
    const { UpdateCheckTimeoutError, FETCH_TIMEOUT_MS } = await import(
      '../ui/utils/updateCheck.js'
    );
    mockCheckForUpdatesDetailed.mockResolvedValue({
      status: 'error',
      error: new UpdateCheckTimeoutError(FETCH_TIMEOUT_MS, 'latest'),
    });

    startPostRenderPrefetches(config, makeSettings());

    await settle();

    expect(mockUpdateEventEmit).toHaveBeenCalledWith('update-failed', {
      message: `Update check skipped (registry did not respond within ${Math.round(FETCH_TIMEOUT_MS / 1000)}s) — run /update to retry.`,
      severity: 'warning',
    });
  });

  it('reports an offline-specific reason when the registry is unreachable', async () => {
    const config = makeConfig();
    const error = new Error('getaddrinfo failed') as NodeJS.ErrnoException;
    error.code = 'ENOTFOUND';
    mockCheckForUpdatesDetailed.mockResolvedValue({
      status: 'error',
      error,
    });

    startPostRenderPrefetches(config, makeSettings());

    await settle();

    expect(mockUpdateEventEmit).toHaveBeenCalledWith('update-failed', {
      message:
        'Update check skipped (registry unreachable) — run /update to retry.',
      severity: 'warning',
    });
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
    const error = new Error('network down');
    mockCheckForUpdatesDetailed.mockRejectedValue(error);

    expect(() =>
      startPostRenderPrefetches(config, makeSettings()),
    ).not.toThrow();

    await settle();

    expect(mockWarn).toHaveBeenCalledWith('update_check failed:', error);
    expect(mockUpdateEventEmit).toHaveBeenCalledWith('update-failed', {
      message: 'Update check skipped (registry error) — run /update to retry.',
      severity: 'warning',
    });
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

    startPostRenderPrefetches(config, makeSettings());
    startPostRenderPrefetches(config, makeSettings());

    await settle();

    expect(mockCheckForUpdatesDetailed).toHaveBeenCalledTimes(1);
    expect(mockStartBackgroundHousekeeping).toHaveBeenCalledTimes(1);
  });
});
