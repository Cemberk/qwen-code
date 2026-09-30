/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */
// @vitest-environment jsdom

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import {
  AuthType,
  customProvider,
  generateCustomEnvKey as generateCustomApiKeyEnvKey,
  logAuth,
  type ProviderSetupInputs,
} from '@qwen-code/qwen-code-core';
import {
  useAuthCommand,
  normalizeCustomModelIds,
  maskApiKey,
} from './useAuth.js';
import { setNestedPropertySafe } from '../../config/settingsUtils.js';

vi.mock('@qwen-code/qwen-code-core', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@qwen-code/qwen-code-core')>()),
  logAuth: vi.fn(),
}));

vi.mock('../../config/settingsUtils.js', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('../../config/settingsUtils.js')>();
  return {
    ...actual,
    backupSettingsFile: vi.fn(),
    restoreSettingsFromBackup: vi.fn(),
    cleanupSettingsBackup: vi.fn(),
  };
});

vi.mock('../../config/modelProvidersScope.js', () => ({
  getPersistScopeForModelSelection: vi.fn(() => 'user'),
}));

const LOCAL_BASE_URL = 'http://127.0.0.1:11434/v1';

const localInputs = (
  overrides: Partial<ProviderSetupInputs> = {},
): ProviderSetupInputs => ({
  baseUrl: LOCAL_BASE_URL,
  apiKey: 'sk-local',
  modelIds: ['qwen3-coder'],
  ...overrides,
});

const createSettings = () => {
  const file = {
    path: '/tmp/settings.json',
    settings: { modelProviders: {} } as Record<string, unknown>,
    originalSettings: {} as Record<string, unknown>,
  };
  return {
    get merged() {
      return file.settings;
    },
    setValue: vi.fn((_scope: unknown, key: string, value: unknown) => {
      setNestedPropertySafe(file.settings, key, value);
      setNestedPropertySafe(file.originalSettings, key, value);
    }),
    recomputeMerged: vi.fn(),
    forScope: vi.fn(() => file),
  };
};

const createConfig = (recordSlashCommand = vi.fn()) => {
  const modelsConfig = {
    syncAfterAuthRefresh: vi.fn(),
  };
  return {
    getAuthType: vi.fn(() => AuthType.USE_OPENAI),
    getUsageStatisticsEnabled: vi.fn(() => false),
    reloadModelProvidersConfig: vi.fn(),
    syncModelSelection: vi.fn(),
    refreshAuth: vi.fn(async () => undefined),
    getModelsConfig: vi.fn(() => modelsConfig),
    getChatRecordingService: vi.fn(() => ({ recordSlashCommand })),
  };
};

describe('useAuthCommand', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('exposes closeAuthDialog that flips isAuthDialogOpen to false', () => {
    const settings = createSettings();
    const config = createConfig();
    const addItem = vi.fn();

    const { result } = renderHook(() =>
      useAuthCommand(settings as never, config as never, addItem),
    );

    act(() => {
      result.current.openAuthDialog();
    });
    expect(result.current.isAuthDialogOpen).toBe(true);

    act(() => {
      result.current.closeAuthDialog();
    });
    expect(result.current.isAuthDialogOpen).toBe(false);
    expect(result.current.authError).toBe(null);
  });

  it('configures a local server via the provider install plan flow', async () => {
    const envKey = generateCustomApiKeyEnvKey(
      AuthType.USE_OPENAI,
      LOCAL_BASE_URL,
    );
    const settings = createSettings();
    const recordSlashCommand = vi.fn();
    const config = createConfig(recordSlashCommand);
    const addItem = vi.fn();

    const { result } = renderHook(() =>
      useAuthCommand(settings as never, config as never, addItem),
    );

    act(() => {
      result.current.openAuthDialog();
    });

    await act(async () => {
      await result.current.handleProviderSubmit(
        customProvider,
        localInputs({
          modelIds: ['qwen3-coder', 'llama3'],
          advancedConfig: { enableThinking: true },
        }),
      );
    });

    expect(settings.setValue).toHaveBeenCalledWith(
      'user',
      `env.${envKey}`,
      'sk-local',
    );
    expect(settings.setValue).toHaveBeenCalledWith(
      'user',
      'security.auth.selectedType',
      AuthType.USE_OPENAI,
    );
    expect(settings.setValue).toHaveBeenCalledWith(
      'user',
      'model.name',
      'qwen3-coder',
    );
    expect(settings.setValue).toHaveBeenCalledWith(
      'user',
      'model.baseUrl',
      LOCAL_BASE_URL,
    );
    expect(config.refreshAuth).toHaveBeenCalledWith(AuthType.USE_OPENAI);
    expect(result.current.isAuthDialogOpen).toBe(false);
    const expectedText = expect.stringContaining(
      `Successfully configured ${customProvider.label}`,
    );
    expect(addItem).toHaveBeenCalledWith(
      expect.objectContaining({ text: expectedText }),
      expect.any(Number),
    );
    expect(recordSlashCommand).toHaveBeenCalledWith({
      phase: 'result',
      rawCommand: '/auth',
      outputHistoryItems: [expect.objectContaining({ text: expectedText })],
    });
  });

  it('keeps live feedback but skips the /auth record when the dialog auto-opened', async () => {
    const settings = createSettings();
    const recordSlashCommand = vi.fn();
    const config = createConfig(recordSlashCommand);
    const addItem = vi.fn();

    const { result } = renderHook(() =>
      useAuthCommand(settings as never, config as never, addItem),
    );

    await act(async () => {
      await result.current.handleProviderSubmit(customProvider, localInputs());
    });

    expect(addItem).toHaveBeenCalledWith(
      expect.objectContaining({
        text: expect.stringContaining('Successfully configured'),
      }),
      expect.any(Number),
    );
    expect(recordSlashCommand).not.toHaveBeenCalled();
  });

  it('clears the /auth recording latch when a command-opened dialog closes', async () => {
    const settings = createSettings();
    const recordSlashCommand = vi.fn();
    const config = createConfig(recordSlashCommand);
    const addItem = vi.fn();

    const { result } = renderHook(() =>
      useAuthCommand(settings as never, config as never, addItem),
    );

    act(() => {
      result.current.openAuthDialog();
      result.current.closeAuthDialog();
      result.current.onAuthError('later unauthorized');
    });

    await act(async () => {
      await result.current.handleProviderSubmit(customProvider, localInputs());
    });

    expect(addItem).toHaveBeenCalledTimes(1);
    expect(recordSlashCommand).not.toHaveBeenCalled();
  });

  it.each(['https://api.openai.com/v1', 'http://192.168.1.5:8000/v1', ''])(
    'refuses to save a non-loopback base URL (%j)',
    async (baseUrl) => {
      const settings = createSettings();
      const config = createConfig();
      const addItem = vi.fn();

      const { result } = renderHook(() =>
        useAuthCommand(settings as never, config as never, addItem),
      );

      await act(async () => {
        await result.current.handleProviderSubmit(
          customProvider,
          localInputs({ baseUrl }),
        );
      });

      expect(settings.setValue).not.toHaveBeenCalled();
      expect(config.refreshAuth).not.toHaveBeenCalled();
      expect(addItem).not.toHaveBeenCalled();
      expect(result.current.isAuthDialogOpen).toBe(true);
      expect(result.current.authError).toEqual(
        expect.stringContaining('Failed to authenticate'),
      );
    },
  );

  it('surfaces install-plan rejection as an auth error and records telemetry', async () => {
    const settings = createSettings();
    const config = createConfig();
    config.refreshAuth = vi.fn(async () => {
      throw new Error('refreshAuth rejected: bad endpoint');
    });
    const addItem = vi.fn();

    const { result } = renderHook(() =>
      useAuthCommand(settings as never, config as never, addItem),
    );

    await act(async () => {
      await result.current.handleProviderSubmit(
        customProvider,
        localInputs({ apiKey: 'sk-bad' }),
      );
    });

    // handleAuthFailure should have set the error, reopened the dialog, and
    // cleared the in-flight flag. The success toast must NOT have fired.
    expect(result.current.authError).toEqual(
      expect.stringContaining('refreshAuth rejected'),
    );
    expect(result.current.isAuthDialogOpen).toBe(true);
    expect(result.current.isAuthenticating).toBe(false);
    expect(addItem).not.toHaveBeenCalled();
    expect(logAuth).toHaveBeenCalledWith(
      config,
      expect.objectContaining({
        auth_type: AuthType.USE_OPENAI,
        action_type: 'manual',
        status: 'error',
      }),
    );
  });
});

describe('generateCustomApiKeyEnvKey', () => {
  it('generates deterministic URL-based env key', () => {
    const key = generateCustomApiKeyEnvKey(AuthType.USE_OPENAI, LOCAL_BASE_URL);
    expect(key).toMatch(/^QWEN_CUSTOM_API_KEY_[A-Z0-9_]+$/);
    const key2 = generateCustomApiKeyEnvKey(
      AuthType.USE_OPENAI,
      LOCAL_BASE_URL,
    );
    expect(key).toBe(key2);
  });

  it('produces different keys for different base URLs', () => {
    const key1 = generateCustomApiKeyEnvKey(
      AuthType.USE_OPENAI,
      'http://127.0.0.1:1234/v1',
    );
    const key2 = generateCustomApiKeyEnvKey(
      AuthType.USE_OPENAI,
      'http://localhost:11434/v1',
    );
    expect(key1).not.toBe(key2);
  });

  it('produces equal keys for URLs that differ only in trailing slash', () => {
    const key1 = generateCustomApiKeyEnvKey(
      AuthType.USE_OPENAI,
      'http://localhost:8000/v1/',
    );
    const key2 = generateCustomApiKeyEnvKey(
      AuthType.USE_OPENAI,
      'http://localhost:8000/v1',
    );
    expect(key1).toBe(key2);
  });
});

describe('normalizeCustomModelIds', () => {
  it('splits comma-separated model IDs', () => {
    const result = normalizeCustomModelIds('qwen/qwen3-coder,openai/gpt-4.1');
    expect(result).toEqual(['qwen/qwen3-coder', 'openai/gpt-4.1']);
  });

  it('trims whitespace from each model ID', () => {
    const result = normalizeCustomModelIds(
      ' qwen/qwen3-coder , openai/gpt-4.1 ',
    );
    expect(result).toEqual(['qwen/qwen3-coder', 'openai/gpt-4.1']);
  });

  it('deduplicates while preserving order', () => {
    const result = normalizeCustomModelIds(
      'qwen/qwen3-coder,openai/gpt-4.1,qwen/qwen3-coder',
    );
    expect(result).toEqual(['qwen/qwen3-coder', 'openai/gpt-4.1']);
  });

  it('removes empty entries', () => {
    const result = normalizeCustomModelIds('qwen/qwen3-coder,,openai/gpt-4.1');
    expect(result).toEqual(['qwen/qwen3-coder', 'openai/gpt-4.1']);
  });

  it('returns empty array for empty input', () => {
    const result = normalizeCustomModelIds('');
    expect(result).toEqual([]);
  });

  it('returns empty array for whitespace-only input', () => {
    const result = normalizeCustomModelIds('  ,  ,  ');
    expect(result).toEqual([]);
  });

  it('handles single model ID', () => {
    const result = normalizeCustomModelIds('qwen/qwen3-coder');
    expect(result).toEqual(['qwen/qwen3-coder']);
  });
});

describe('maskApiKey', () => {
  it('masks a standard API key showing first 3 and last 4 chars', () => {
    const result = maskApiKey('sk-or-v1-1234567890abcdef');
    expect(result).toBe('sk-...cdef');
  });

  it('shows placeholder for empty string', () => {
    const result = maskApiKey('');
    expect(result).toBe('(not set)');
  });

  it('masks short keys with asterisks', () => {
    const result = maskApiKey('abc');
    expect(result).toBe('***');
  });

  it('masks 6-char keys with asterisks', () => {
    const result = maskApiKey('abcdef');
    expect(result).toBe('***');
  });

  it('trims whitespace before masking', () => {
    const result = maskApiKey('  sk-or-v1-1234567890abcdef  ');
    expect(result).toBe('sk-...cdef');
  });
});
