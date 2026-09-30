/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AuthType } from '../../core/contentGenerator.js';
import type { ModelConfig, ModelProvidersConfig } from '../../models/types.js';
import {
  applyProviderInstallPlan,
  buildInstallPlan,
  customProvider,
  generateCustomEnvKey,
  getProviderModels,
  ProviderInstallError,
  type ProviderInstallPlan,
  type ProviderSettingsAdapter,
} from '../index.js';

const BASE_URL = 'http://127.0.0.1:11434/v1';

function createAdapter(modelProviders: ModelProvidersConfig = {}) {
  let snapshot = modelProviders;
  const adapter: ProviderSettingsAdapter & {
    setValue: ReturnType<typeof vi.fn>;
    persist: ReturnType<typeof vi.fn>;
    backup: ReturnType<typeof vi.fn>;
    restore: ReturnType<typeof vi.fn>;
    cleanupBackup: ReturnType<typeof vi.fn>;
  } = {
    getValue: vi.fn(),
    setValue: vi.fn((key: string, value: unknown) => {
      if (key.startsWith('modelProviders.'))
        modelProviders = {
          ...modelProviders,
          [key.slice('modelProviders.'.length)]:
            value as ModelProvidersConfig[string],
        };
    }),
    getModelProviders: vi.fn(() => modelProviders),
    persist: vi.fn(),
    backup: vi.fn(() => {
      snapshot = modelProviders;
    }),
    restore: vi.fn(() => {
      modelProviders = snapshot;
    }),
    cleanupBackup: vi.fn(),
  };
  return adapter;
}

function mockCurrentModel(
  adapter: ProviderSettingsAdapter,
  values: Record<string, unknown>,
) {
  vi.mocked(adapter.getValue).mockImplementation((key) => values[key]);
}

describe('applyProviderInstallPlan', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    delete process.env['TEST_API_KEY'];
    delete process.env['BRAND_NEW_KEY'];
    delete process.env['SHADOW_KEY'];
    delete process.env['EMPTY_SHADOW_KEY'];
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('rolls back a provider write shadowed by a higher-precedence scope before selecting it', async () => {
    const original = { openai: [{ id: 'workspace-chat', baseUrl: BASE_URL }] };
    const adapter = createAdapter(original);
    vi.mocked(adapter.getModelProviders).mockReturnValue(original);
    const plan: ProviderInstallPlan = {
      providerId: 'test',
      authType: AuthType.USE_OPENAI,
      modelSelection: { modelId: 'new-user-model' },
      modelProviders: [
        {
          authType: AuthType.USE_OPENAI,
          models: [{ id: 'new-user-model', baseUrl: BASE_URL }],
        },
      ],
    };
    const reload = vi.fn();
    await expect(
      applyProviderInstallPlan(plan, {
        settings: adapter,
        reloadModelProviders: reload,
      }),
    ).rejects.toMatchObject({ step: 'modelProviders' });
    expect(adapter.setValue).toHaveBeenCalledWith('modelProviders.openai', [
      { id: 'new-user-model', baseUrl: BASE_URL },
      { id: 'workspace-chat', baseUrl: BASE_URL },
    ]);
    expect(adapter.setValue).not.toHaveBeenCalledWith(
      'model.name',
      expect.anything(),
    );
    expect(adapter.setValue).not.toHaveBeenCalledWith(
      'security.auth.selectedType',
      expect.anything(),
    );
    expect(adapter.restore).toHaveBeenCalledOnce();
    expect(reload).toHaveBeenCalledExactlyOnceWith(original);
  });

  it('rejects an install when the owning scope differs from the effective models', async () => {
    const model = { id: 'model', baseUrl: BASE_URL, envKey: 'TEST_API_KEY' };
    const adapter = createAdapter();
    vi.mocked(adapter.getModelProviders).mockReturnValue({
      openai: [{ ...model, name: 'workspace override' }],
    });
    adapter.getModelProvidersForWrite = vi.fn(() => ({
      modelProviders: { openai: [model] },
    }));

    await expect(
      applyProviderInstallPlan(
        {
          providerId: 'test',
          authType: AuthType.USE_OPENAI,
          modelProviders: [{ authType: AuthType.USE_OPENAI, models: [model] }],
        },
        { settings: adapter },
      ),
    ).rejects.toMatchObject({
      name: 'ProviderInstallError',
      step: 'modelProviders',
    });
    expect(adapter.persist).not.toHaveBeenCalled();
  });

  it.each([
    [
      'a non-loopback base URL',
      { baseUrl: 'https://api.openai.com/v1' },
      /is not allowed/,
    ],
    [
      'a LAN base URL',
      { baseUrl: 'http://192.168.1.5:8000/v1' },
      /is not allowed/,
    ],
    ['no base URL', {}, /No model server base URL is configured/],
    [
      'the Responses API',
      { baseUrl: BASE_URL, wireApi: 'responses' },
      /wireApi "responses" is not supported/,
    ],
  ])(
    'rejects a model with %s before touching settings',
    async (_label, fields, message) => {
      const adapter = createAdapter();
      const plan: ProviderInstallPlan = {
        providerId: 'test',
        authType: AuthType.USE_OPENAI,
        env: { TEST_API_KEY: 'sk-test' },
        modelSelection: { modelId: 'model' },
        modelProviders: [
          {
            authType: AuthType.USE_OPENAI,
            models: [{ id: 'model', ...fields } as ModelConfig],
          },
        ],
      };

      await expect(
        applyProviderInstallPlan(plan, { settings: adapter }),
      ).rejects.toThrow(message);
      expect(adapter.backup).not.toHaveBeenCalled();
      expect(adapter.setValue).not.toHaveBeenCalled();
      expect(process.env['TEST_API_KEY']).toBeUndefined();
    },
  );

  it('rejects a model bucket other than openai before touching settings', async () => {
    const adapter = createAdapter();
    const plan: ProviderInstallPlan = {
      providerId: 'test',
      authType: 'anthropic' as AuthType,
      modelProviders: [
        {
          authType: 'anthropic' as AuthType,
          models: [{ id: 'claude', baseUrl: BASE_URL }],
        },
      ],
    };

    await expect(
      applyProviderInstallPlan(plan, { settings: adapter }),
    ).rejects.toThrow(/modelProviders\.anthropic is not supported/);
    expect(adapter.setValue).not.toHaveBeenCalled();
  });

  it.each([false, true])(
    'installs into an empty or null openai bucket (null: %s)',
    async (targetNull) => {
      const providers = {
        openai: targetNull ? null : [],
      } as unknown as ModelProvidersConfig;
      const plan = buildInstallPlan(
        customProvider,
        { baseUrl: BASE_URL, apiKey: 'test', modelIds: ['chat'] },
        getProviderModels(providers),
      );
      const envKey = Object.keys(plan.env!)[0]!;
      const previous = process.env[envKey];
      try {
        const result = await applyProviderInstallPlan(plan, {
          settings: createAdapter(providers),
        });
        expect(result.updatedModelProviders['openai']).toEqual([
          expect.objectContaining({ id: 'chat', baseUrl: BASE_URL }),
        ]);
      } finally {
        if (previous === undefined) delete process.env[envKey];
        else process.env[envKey] = previous;
      }
    },
  );

  it('refuses an install plan that sets a reserved env var (NODE_OPTIONS)', async () => {
    const adapter = createAdapter();
    // CI sets NODE_OPTIONS (e.g. --max-old-space-size); snapshot whatever it
    // is so we can assert the rejected plan left it UNCHANGED rather than
    // assuming it's unset.
    const originalNodeOptions = process.env['NODE_OPTIONS'];
    const plan: ProviderInstallPlan = {
      providerId: 'evil',
      authType: AuthType.USE_OPENAI,
      env: { NODE_OPTIONS: '--require /tmp/evil.js' },
    };

    await expect(
      applyProviderInstallPlan(plan, { settings: adapter }),
    ).rejects.toThrow(/reserved environment variable: NODE_OPTIONS/);
    // The evil value must not have leaked into the live process; the
    // pre-existing value (if any) is untouched.
    expect(process.env['NODE_OPTIONS']).toBe(originalNodeOptions);
    expect(process.env['NODE_OPTIONS']).not.toBe('--require /tmp/evil.js');
    expect(adapter.setValue).not.toHaveBeenCalledWith(
      'env.NODE_OPTIONS',
      expect.anything(),
    );
  });

  it('matches the env denylist case-insensitively (Path)', async () => {
    const adapter = createAdapter();
    const plan: ProviderInstallPlan = {
      providerId: 'evil',
      authType: AuthType.USE_OPENAI,
      env: { Path: 'C:\\evil' },
    };

    await expect(
      applyProviderInstallPlan(plan, { settings: adapter }),
    ).rejects.toThrow(/reserved environment variable: Path/);
  });

  it.each(['TMP', 'TEMP', 'tmp'])(
    'rejects the Windows temp-redirect env var %s',
    async (key) => {
      const adapter = createAdapter();
      const plan: ProviderInstallPlan = {
        providerId: 'evil',
        authType: AuthType.USE_OPENAI,
        env: { [key]: 'C:\\evil-temp' },
      };

      await expect(
        applyProviderInstallPlan(plan, { settings: adapter }),
      ).rejects.toThrow(/reserved environment variable/);
    },
  );

  it('persists env, auth selection, selected model, and merged model providers', async () => {
    const adapter = createAdapter({
      [AuthType.USE_OPENAI]: [
        {
          id: 'new-model',
          baseUrl: BASE_URL,
          envKey: 'TEST_API_KEY',
          generationConfig: { contextWindowSize: 123 },
        },
        {
          id: 'preserved',
          baseUrl: BASE_URL,
          envKey: 'OTHER_API_KEY',
          generationConfig: { contextWindowSize: 456 },
        },
      ],
    });
    const reloadModelProviders = vi.fn();
    const syncAuthState = vi.fn();
    const refreshAuth = vi.fn(async () => undefined);
    const newModel = {
      id: 'new-model',
      baseUrl: BASE_URL,
      envKey: 'TEST_API_KEY',
    };
    const preserved = {
      id: 'preserved',
      baseUrl: BASE_URL,
      envKey: 'OTHER_API_KEY',
      generationConfig: { contextWindowSize: 456 },
    };

    const plan: ProviderInstallPlan = {
      providerId: 'test-provider',
      authType: AuthType.USE_OPENAI,
      env: { TEST_API_KEY: 'sk-test' },
      modelSelection: { modelId: 'new-model' },
      modelProviders: [{ authType: AuthType.USE_OPENAI, models: [newModel] }],
    };

    await applyProviderInstallPlan(plan, {
      settings: adapter,
      reloadModelProviders,
      syncAuthState,
      refreshAuth,
    });

    expect(adapter.setValue).toHaveBeenCalledWith(
      'env.TEST_API_KEY',
      'sk-test',
    );
    expect(process.env['TEST_API_KEY']).toBe('sk-test');
    expect(adapter.setValue).toHaveBeenCalledWith('modelProviders.openai', [
      newModel,
      preserved,
    ]);
    expect(adapter.setValue).toHaveBeenCalledWith(
      'security.auth.selectedType',
      AuthType.USE_OPENAI,
    );
    expect(adapter.setValue).toHaveBeenCalledWith('model.name', 'new-model');
    // Id-only model selection must clear any stale baseUrl disambiguator
    // (empty-string tombstone overrides a lower-scope value on merge).
    expect(adapter.setValue).toHaveBeenCalledWith('model.baseUrl', '');
    expect(adapter.persist).toHaveBeenCalled();
    expect(reloadModelProviders).toHaveBeenCalledWith({
      [AuthType.USE_OPENAI]: [newModel, preserved],
    });
    expect(syncAuthState).toHaveBeenCalledWith(
      AuthType.USE_OPENAI,
      'new-model',
      undefined,
    );
    expect(refreshAuth).toHaveBeenCalledWith(AuthType.USE_OPENAI);
    expect(adapter.cleanupBackup).toHaveBeenCalled();
  });

  it('can skip immediate auth refresh', async () => {
    const adapter = createAdapter();
    const refreshAuth = vi.fn(async () => undefined);
    const plan: ProviderInstallPlan = {
      providerId: 'test-provider',
      authType: AuthType.USE_OPENAI,
      env: { TEST_API_KEY: 'sk-test' },
    };

    await applyProviderInstallPlan(plan, {
      settings: adapter,
      refreshAuth,
      doRefreshAuth: false,
    });

    expect(adapter.setValue).toHaveBeenCalledWith(
      'env.TEST_API_KEY',
      'sk-test',
    );
    expect(refreshAuth).not.toHaveBeenCalled();
  });

  it('prints a shadowing warning when an env key changes', async () => {
    process.env['SHADOW_KEY'] = 'old-value';
    const adapter = createAdapter();
    const consoleError = vi
      .spyOn(console, 'error')
      .mockImplementation(() => {});
    const plan: ProviderInstallPlan = {
      providerId: 'test-provider',
      authType: AuthType.USE_OPENAI,
      env: { SHADOW_KEY: 'new-value' },
    };

    await applyProviderInstallPlan(plan, { settings: adapter });

    expect(consoleError).toHaveBeenCalledWith(
      expect.stringContaining('SHADOW_KEY is also set'),
    );
    expect(process.env['SHADOW_KEY']).toBe('new-value');
  });

  it('does not print a shadowing warning for same or empty env values', async () => {
    process.env['SHADOW_KEY'] = 'same-value';
    process.env['EMPTY_SHADOW_KEY'] = '';
    const adapter = createAdapter();
    const consoleError = vi
      .spyOn(console, 'error')
      .mockImplementation(() => {});
    const plan: ProviderInstallPlan = {
      providerId: 'test-provider',
      authType: AuthType.USE_OPENAI,
      env: {
        SHADOW_KEY: 'same-value',
        EMPTY_SHADOW_KEY: 'filled-value',
      },
    };

    await applyProviderInstallPlan(plan, { settings: adapter });

    expect(consoleError).not.toHaveBeenCalled();
    expect(process.env['SHADOW_KEY']).toBe('same-value');
    expect(process.env['EMPTY_SHADOW_KEY']).toBe('filled-value');
  });

  it('replaces only the entries with the same id and base URL', async () => {
    const otherBaseUrl = 'http://localhost:1234/v1';
    const adapter = createAdapter({
      [AuthType.USE_OPENAI]: [
        // Same id, different baseUrl → preserved (different identity)
        { id: 'qwen3', baseUrl: otherBaseUrl },
        // Same id+baseUrl as incoming → replaced
        { id: 'qwen3', baseUrl: BASE_URL, name: 'old' },
        // Different id, same baseUrl as incoming → preserved
        { id: 'llama3', baseUrl: BASE_URL },
      ],
    });
    const plan: ProviderInstallPlan = {
      providerId: 'test-provider',
      authType: AuthType.USE_OPENAI,
      modelProviders: [
        {
          authType: AuthType.USE_OPENAI,
          models: [{ id: 'qwen3', baseUrl: BASE_URL }],
        },
      ],
    };

    await applyProviderInstallPlan(plan, { settings: adapter });

    expect(adapter.setValue).toHaveBeenCalledWith('modelProviders.openai', [
      { id: 'qwen3', baseUrl: BASE_URL },
      { id: 'qwen3', baseUrl: otherBaseUrl },
      { id: 'llama3', baseUrl: BASE_URL },
    ]);
  });

  it.each([BASE_URL, '', undefined])(
    'keeps a non-first current model when a reinstall still offers it (current baseUrl: %j)',
    async (currentBaseUrl) => {
      const models = ['first', 'chosen'].map((id) => ({
        id,
        baseUrl: BASE_URL,
      }));
      const adapter = createAdapter({ openai: models });
      mockCurrentModel(adapter, {
        'security.auth.selectedType': AuthType.USE_OPENAI,
        'model.name': 'chosen',
        'model.baseUrl': currentBaseUrl,
      });
      const syncAuthState = vi.fn();
      await applyProviderInstallPlan(
        {
          providerId: 'test',
          authType: AuthType.USE_OPENAI,
          modelSelection: { modelId: 'first', baseUrl: BASE_URL },
          modelProviders: [{ authType: AuthType.USE_OPENAI, models }],
        },
        { settings: adapter, syncAuthState },
      );
      // The reinstall still persists the merged providers map — preserving
      // the selection must not silently skip the install itself.
      expect(adapter.setValue).toHaveBeenCalledWith(
        'modelProviders.openai',
        models,
      );
      expect(adapter.setValue).not.toHaveBeenCalledWith(
        'model.name',
        expect.anything(),
      );
      expect(syncAuthState).not.toHaveBeenCalled();
    },
  );

  it('selects the plan model when the current model is at another base URL', async () => {
    const models = [{ id: 'chosen', baseUrl: BASE_URL }];
    const adapter = createAdapter({ openai: models });
    mockCurrentModel(adapter, {
      'model.name': 'chosen',
      'model.baseUrl': 'http://localhost:1234/v1',
    });
    const syncAuthState = vi.fn();
    await applyProviderInstallPlan(
      {
        providerId: 'test',
        authType: AuthType.USE_OPENAI,
        modelSelection: { modelId: 'chosen', baseUrl: BASE_URL },
        modelProviders: [{ authType: AuthType.USE_OPENAI, models }],
      },
      { settings: adapter, syncAuthState },
    );
    expect(adapter.setValue).toHaveBeenCalledWith('model.name', 'chosen');
    expect(adapter.setValue).toHaveBeenCalledWith('model.baseUrl', BASE_URL);
    expect(syncAuthState).toHaveBeenCalledWith(
      AuthType.USE_OPENAI,
      'chosen',
      BASE_URL,
    );
  });

  it('preserves existing custom provider models and selects the installed endpoint', async () => {
    const otherBaseUrl = 'http://localhost:1234/v1';
    const envKey = generateCustomEnvKey(AuthType.USE_OPENAI, BASE_URL);
    const otherEnvKey = generateCustomEnvKey(AuthType.USE_OPENAI, otherBaseUrl);
    const syncAuthState = vi.fn();
    const adapter = createAdapter({
      [AuthType.USE_OPENAI]: [
        // Same model id, different baseUrl: keep both and select the one just
        // installed.
        {
          id: 'model-b',
          name: 'model-b',
          baseUrl: otherBaseUrl,
          envKey: otherEnvKey,
        },
        { id: 'model-a', name: 'model-a', baseUrl: BASE_URL, envKey },
        {
          id: 'shared-model',
          name: 'shared-model',
          baseUrl: otherBaseUrl,
          envKey: otherEnvKey,
        },
      ],
    });
    const plan = buildInstallPlan(customProvider, {
      baseUrl: BASE_URL,
      apiKey: 'sk-new',
      modelIds: ['model-b'],
    });

    expect(plan.modelSelection).toEqual({
      modelId: 'model-b',
      baseUrl: BASE_URL,
    });

    try {
      await applyProviderInstallPlan(plan, {
        settings: adapter,
        syncAuthState,
        doRefreshAuth: false,
      });
    } finally {
      delete process.env[envKey];
    }

    expect(adapter.setValue).toHaveBeenCalledWith('modelProviders.openai', [
      { id: 'model-b', name: 'model-b', baseUrl: BASE_URL, envKey },
      {
        id: 'model-b',
        name: 'model-b',
        baseUrl: otherBaseUrl,
        envKey: otherEnvKey,
      },
      { id: 'model-a', name: 'model-a', baseUrl: BASE_URL, envKey },
      {
        id: 'shared-model',
        name: 'shared-model',
        baseUrl: otherBaseUrl,
        envKey: otherEnvKey,
      },
    ]);
    expect(adapter.setValue).toHaveBeenCalledWith('model.name', 'model-b');
    expect(adapter.setValue).toHaveBeenCalledWith('model.baseUrl', BASE_URL);
    expect(syncAuthState).toHaveBeenCalledWith(
      AuthType.USE_OPENAI,
      'model-b',
      BASE_URL,
    );
  });

  it('rolls back process.env on error', async () => {
    process.env['TEST_API_KEY'] = 'old-value';
    const adapter = createAdapter();
    const refreshAuth = vi.fn(async () => {
      throw new Error('network error');
    });
    const plan: ProviderInstallPlan = {
      providerId: 'test-provider',
      authType: AuthType.USE_OPENAI,
      env: { TEST_API_KEY: 'new-value' },
    };

    await expect(
      applyProviderInstallPlan(plan, { settings: adapter, refreshAuth }),
    ).rejects.toThrow('network error');

    expect(process.env['TEST_API_KEY']).toBe('old-value');
    expect(adapter.restore).toHaveBeenCalled();
  });

  it('deletes env var on rollback if it did not exist before', async () => {
    const adapter = createAdapter();
    const refreshAuth = vi.fn(async () => {
      throw new Error('fail');
    });
    const plan: ProviderInstallPlan = {
      providerId: 'test-provider',
      authType: AuthType.USE_OPENAI,
      env: { BRAND_NEW_KEY: 'value' },
    };

    await expect(
      applyProviderInstallPlan(plan, { settings: adapter, refreshAuth }),
    ).rejects.toThrow('fail');

    expect(process.env['BRAND_NEW_KEY']).toBeUndefined();
  });

  // -- Rollback safety nets -------------------------------------------------
  // The catch path in applyProviderInstallPlan has three deliberate
  // safety nets that were previously untested. These tests pin them down so
  // a future refactor that "simplifies" the catch can't silently regress.

  it('restores runtime model providers when refreshAuth rejects after reloadModelProviders ran', async () => {
    const previousProviders = {
      [AuthType.USE_OPENAI]: [
        { id: 'previous', baseUrl: BASE_URL, envKey: 'OLD_KEY' },
      ],
    };
    const adapter = createAdapter(previousProviders);
    const reloadModelProviders = vi.fn();
    const refreshAuth = vi.fn(async () => {
      throw new Error('refreshAuth rejected');
    });
    const plan: ProviderInstallPlan = {
      providerId: 'test-provider',
      authType: AuthType.USE_OPENAI,
      env: { TEST_API_KEY: 'sk-new' },
      modelProviders: [
        {
          authType: AuthType.USE_OPENAI,
          models: [
            { id: 'new-model', baseUrl: BASE_URL, envKey: 'TEST_API_KEY' },
          ],
        },
      ],
    };

    await expect(
      applyProviderInstallPlan(plan, {
        settings: adapter,
        reloadModelProviders,
        refreshAuth,
      }),
    ).rejects.toThrow('refreshAuth rejected');

    // Two reload calls: the success-path one with the patched providers,
    // then a rollback one that hands back the snapshot we took *before*
    // applying any patches.
    expect(reloadModelProviders).toHaveBeenCalledTimes(2);
    expect(reloadModelProviders).toHaveBeenLastCalledWith(previousProviders);
  });

  it('still rolls back env vars when backup() throws before persist', async () => {
    process.env['TEST_API_KEY'] = 'old-value';
    const adapter = createAdapter();
    adapter.backup.mockImplementation(() => {
      throw new Error('backup failed');
    });
    const plan: ProviderInstallPlan = {
      providerId: 'test-provider',
      authType: AuthType.USE_OPENAI,
      env: { TEST_API_KEY: 'new-value' },
    };

    await expect(
      applyProviderInstallPlan(plan, { settings: adapter }),
    ).rejects.toThrow('backup failed');

    // backup() throwing inside the try must still hand control to the
    // catch path so env vars are restored. (Before this commit's
    // "backup inside try" fix the throw escaped uncaught and env vars
    // leaked.)
    expect(process.env['TEST_API_KEY']).toBe('old-value');
  });

  it('continues env rollback even when settings.restore itself throws', async () => {
    process.env['TEST_API_KEY'] = 'before-install';
    const adapter = createAdapter();
    adapter.restore.mockImplementation(() => {
      throw new Error('restore failed');
    });
    const refreshAuth = vi.fn(async () => {
      throw new Error('original error');
    });
    const plan: ProviderInstallPlan = {
      providerId: 'test-provider',
      authType: AuthType.USE_OPENAI,
      env: { TEST_API_KEY: 'during-install' },
    };

    await expect(
      applyProviderInstallPlan(plan, { settings: adapter, refreshAuth }),
    ).rejects.toThrow('original error');

    // restore() throwing must not mask the original error and must not skip
    // the env-var rollback loop that runs after it.
    expect(adapter.restore).toHaveBeenCalled();
    expect(process.env['TEST_API_KEY']).toBe('before-install');
  });

  it('annotates the rethrown error with the failing step and preserves the original cause', async () => {
    process.env['TEST_API_KEY'] = 'old';
    const adapter = createAdapter();
    const refreshAuth = vi.fn(async () => {
      throw new Error('endpoint unreachable');
    });
    const plan: ProviderInstallPlan = {
      providerId: 'test-provider',
      authType: AuthType.USE_OPENAI,
      env: { TEST_API_KEY: 'new' },
    };

    let caught: unknown;
    try {
      await applyProviderInstallPlan(plan, {
        settings: adapter,
        refreshAuth,
      });
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeInstanceOf(Error);
    // ProviderInstallError is a class, so instanceof works at runtime.
    expect(caught).toBeInstanceOf(ProviderInstallError);
    const err = caught as ProviderInstallError & { cause?: Error };
    // Step + authType are structured properties (not baked into the
    // user-facing message, which stays the underlying error text).
    expect(err.step).toBe('refreshAuth');
    expect(err.authType).toBe('openai');
    expect(err.message).toBe('endpoint unreachable');
    // Original error preserved via cause so callers matching on err.code
    // (NodeJS.ErrnoException) still work.
    expect(err.cause).toBeInstanceOf(Error);
    expect((err.cause as Error).message).toBe('endpoint unreachable');
  });

  it('continues throw + env rollback when reloadModelProviders rollback itself throws', async () => {
    process.env['TEST_API_KEY'] = 'before';
    const previousProviders = {
      [AuthType.USE_OPENAI]: [
        { id: 'previous', baseUrl: BASE_URL, envKey: 'OLD' },
      ],
    };
    const adapter = createAdapter(previousProviders);
    let reloadCalls = 0;
    const reloadModelProviders = vi.fn(() => {
      reloadCalls += 1;
      if (reloadCalls === 2) {
        // The rollback-time reload (the second call) explodes.
        throw new Error('reload restore failed');
      }
    });
    const refreshAuth = vi.fn(async () => {
      throw new Error('original error');
    });
    const plan: ProviderInstallPlan = {
      providerId: 'test-provider',
      authType: AuthType.USE_OPENAI,
      env: { TEST_API_KEY: 'during' },
    };

    await expect(
      applyProviderInstallPlan(plan, {
        settings: adapter,
        reloadModelProviders,
        refreshAuth,
      }),
    ).rejects.toThrow('original error');

    // The rethrow must still carry the original error, env vars must still
    // be rolled back, and the broken rollback reload must not mask anything.
    expect(reloadModelProviders).toHaveBeenCalledTimes(2);
    expect(process.env['TEST_API_KEY']).toBe('before');
  });
});
