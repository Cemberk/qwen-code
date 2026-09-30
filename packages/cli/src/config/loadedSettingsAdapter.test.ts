/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createLoadedSettingsAdapter,
  getRawModelProviders,
} from './loadedSettingsAdapter.js';
import { SettingScope, loadSettings } from './settings.js';
import type { LoadedSettings } from './settings.js';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  AuthType,
  applyProviderInstallPlan,
  buildInstallPlan,
  customProvider,
  generateCustomEnvKey,
  getProviderModels,
} from '@qwen-code/qwen-code-core';

const LOCAL_BASE_URL = 'http://127.0.0.1:11434/v1';

const temporaryRoots: string[] = [];
afterEach(() => {
  for (const root of temporaryRoots.splice(0))
    fs.rmSync(root, { recursive: true, force: true });
});

// Named shape so dot-access on the known keys (`env`, `modelProviders`) is not
// treated as access through an index signature — keeps the strict TS option
// `noPropertyAccessFromIndexSignature` happy while still allowing arbitrary
// extra keys via the index signature.
interface SettingsShape {
  env?: Record<string, unknown>;
  modelProviders?: Record<string, unknown>;
  [key: string]: unknown;
}

interface MutableSettingsFile {
  settings: SettingsShape;
  originalSettings: SettingsShape;
  path: string;
}

function makeSettings(initial: SettingsShape = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'provider-adapter-'));
  temporaryRoots.push(root);
  const file: MutableSettingsFile = {
    settings: structuredClone(initial),
    originalSettings: structuredClone(initial),
    path: path.join(root, 'settings.json'),
  };
  const setValue = vi.fn(
    (_scope: SettingScope, key: string, value: unknown) => {
      const parts = key.split('.');
      let current: Record<string, unknown> = file.settings as Record<
        string,
        unknown
      >;
      for (let i = 0; i < parts.length; i++) {
        const part = parts[i]!;
        // Mirror setNestedPropertySafe's reserved-segment rejection. Inline
        // literal === comparisons (rather than e.g. Set.has) are what
        // CodeQL's prototype-pollution sanitiser recognises, so we use them
        // at the only step that actually writes to `current`.
        if (
          part === '__proto__' ||
          part === 'constructor' ||
          part === 'prototype'
        ) {
          throw new Error(`mock setValue refused reserved segment in: ${key}`);
        }
        if (i === parts.length - 1) {
          current[part] = value;
        } else {
          if (!current[part] || typeof current[part] !== 'object') {
            current[part] = {};
          }
          current = current[part] as Record<string, unknown>;
        }
      }
      file.originalSettings = structuredClone(file.settings);
    },
  );
  const recomputeMerged = vi.fn(() => {
    /* merged() is computed lazily via the getter below */
  });
  const settings = {
    get merged() {
      return file.settings;
    },
    forScope: vi.fn(() => file),
    setValue,
    recomputeMerged,
  };
  return { settings, file, setValue, recomputeMerged };
}

describe('createLoadedSettingsAdapter', () => {
  it.each([
    { duplicate: true, headers: false, rotate: true, urlPlaceholder: true },
    { duplicate: false, headers: false, rotate: true, urlPlaceholder: true },
    { duplicate: false, headers: true, rotate: false, urlPlaceholder: true },
    { duplicate: false, headers: true, rotate: true, urlPlaceholder: true },
    { duplicate: false, headers: true, rotate: true, urlPlaceholder: false },
    {
      duplicate: false,
      headers: true,
      rotate: true,
      urlPlaceholder: true,
      failRefresh: true,
    },
  ])(
    'preserves placeholders and rejects same-bucket ambiguity (%j)',
    async ({ duplicate, headers, rotate, urlPlaceholder, failRefresh }) => {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bucket-duplicates-'));
      temporaryRoots.push(root);
      vi.stubEnv('QWEN_HOME', root);
      vi.stubEnv('FIRST_URL', LOCAL_BASE_URL);
      vi.stubEnv('SECOND_URL', LOCAL_BASE_URL);
      vi.stubEnv('FIRST_KEY', 'test-only-first');
      vi.stubEnv('SECOND_KEY', 'test-only-second');
      const first = {
        id: 'same',
        name: 'same',
        baseUrl: urlPlaceholder ? '${FIRST_URL}' : LOCAL_BASE_URL,
        envKey: 'FIRST_KEY',
        ...(headers && {
          generationConfig: { customHeaders: { 'X-Key': '${FIRST_KEY}' } },
        }),
      };
      const second = {
        ...first,
        baseUrl: urlPlaceholder ? '${SECOND_URL}' : LOCAL_BASE_URL,
        envKey: 'SECOND_KEY',
        ...(headers && {
          generationConfig: { customHeaders: { 'X-Key': '${SECOND_KEY}' } },
        }),
      };
      const apiKey = rotate ? 'test-only-new' : 'test-only-first';
      const settingsPath = path.join(root, 'settings.json');
      fs.writeFileSync(
        settingsPath,
        JSON.stringify({
          $version: 4,
          env: { FIRST_KEY: 'test-only-first', SECOND_KEY: 'test-only-second' },
          modelProviders: { openai: duplicate ? [first, second] : [first] },
        }),
      );
      const before = fs.readFileSync(settingsPath, 'utf8');
      try {
        const loaded = loadSettings(root, {
          skipLoadEnvironment: true,
          skipWorkspaceSettings: true,
        });
        const plan = buildInstallPlan(
          customProvider,
          {
            baseUrl: process.env['FIRST_URL']!,
            modelIds: ['same'],
            apiKey,
          },
          getProviderModels(loaded.merged.modelProviders),
        );
        expect(plan.env).toEqual({ FIRST_KEY: apiKey });
        const originalMerged = structuredClone(loaded.merged);
        const reloadModelProviders = vi.fn();
        const install = applyProviderInstallPlan(plan, {
          settings: createLoadedSettingsAdapter(loaded, SettingScope.User),
          doRefreshAuth: Boolean(failRefresh),
          reloadModelProviders,
          refreshAuth: vi.fn().mockRejectedValue(new Error('refresh failed')),
        });
        if (duplicate || failRefresh) {
          await expect(install).rejects.toThrow(
            duplicate
              ? 'Cannot preserve placeholders in an ambiguous model configuration'
              : 'refresh failed',
          );
          expect(fs.readFileSync(settingsPath, 'utf8')).toBe(before);
          expect(process.env['FIRST_KEY']).toBe('test-only-first');
          expect(loaded.merged).toEqual(originalMerged);
          if (failRefresh) {
            expect(reloadModelProviders).toHaveBeenCalledTimes(2);
            expect(
              reloadModelProviders.mock.calls[0]?.[0].openai[0],
            ).toMatchObject({
              generationConfig: { customHeaders: { 'X-Key': apiKey } },
            });
            expect(reloadModelProviders).toHaveBeenLastCalledWith(
              originalMerged.modelProviders,
            );
          }
          return;
        }
        const result = await install;
        const saved = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
        expect(saved.modelProviders.openai).toEqual([first]);
        expect(saved.env).toEqual({
          FIRST_KEY: apiKey,
          SECOND_KEY: 'test-only-second',
        });
        const expected = {
          baseUrl: LOCAL_BASE_URL,
          envKey: 'FIRST_KEY',
          ...(headers && {
            generationConfig: { customHeaders: { 'X-Key': apiKey } },
          }),
        };
        expect(loaded.merged.modelProviders?.['openai']?.[0]).toMatchObject(
          expected,
        );
        expect(
          getProviderModels(result.updatedModelProviders)[0],
        ).toMatchObject(expected);
      } finally {
        vi.unstubAllEnvs();
      }
    },
  );

  it('preserves each entry placeholder when a bucket is reordered', () => {
    const root = fs.mkdtempSync(
      path.join(os.tmpdir(), 'provider-reorder-placeholders-'),
    );
    temporaryRoots.push(root);
    vi.stubEnv('QWEN_HOME', root);
    vi.stubEnv('TEST_FIRST_URL', LOCAL_BASE_URL);
    vi.stubEnv('TEST_SECOND_URL', 'http://localhost:1234/v1');
    vi.stubEnv('TEST_FIRST_HEADER', 'first-header');
    vi.stubEnv('TEST_SECOND_HEADER', 'second-header');
    const first = {
      id: 'same',
      baseUrl: '${TEST_FIRST_URL}',
      generationConfig: {
        customHeaders: { 'X-Test': '${TEST_FIRST_HEADER}' },
      },
    };
    const second = {
      id: 'same',
      baseUrl: '${TEST_SECOND_URL}',
      generationConfig: {
        customHeaders: { 'X-Test': '${TEST_SECOND_HEADER}' },
      },
    };
    fs.writeFileSync(
      path.join(root, 'settings.json'),
      JSON.stringify({
        $version: 4,
        modelProviders: { openai: [first, second] },
      }),
    );
    try {
      const loaded = loadSettings(root, {
        skipLoadEnvironment: true,
        skipWorkspaceSettings: true,
      });
      const models = loaded.merged.modelProviders!['openai']!;
      createLoadedSettingsAdapter(loaded, SettingScope.User).setValue(
        'modelProviders.openai',
        [models[1], models[0]],
      );
      const saved = JSON.parse(
        fs.readFileSync(path.join(root, 'settings.json'), 'utf8'),
      );
      expect(saved.modelProviders.openai).toEqual([second, first]);
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it('rejects a User install shadowed by the System bucket without changing either scope', async () => {
    const root = fs.mkdtempSync(
      path.join(os.tmpdir(), 'provider-shadow-placeholder-'),
    );
    temporaryRoots.push(root);
    const userHome = path.join(root, 'home');
    const workspace = path.join(root, 'workspace');
    fs.mkdirSync(userHome);
    fs.mkdirSync(path.join(workspace, '.qwen'), { recursive: true });
    vi.stubEnv('QWEN_HOME', userHome);
    vi.stubEnv('SHADOW_SIBLING_HEADER', 'test-only-secret');
    const userFile = path.join(userHome, 'settings.json');
    const systemFile = path.join(root, 'system-settings.json');
    vi.stubEnv('QWEN_CODE_SYSTEM_SETTINGS_PATH', systemFile);
    const sibling = {
      id: 'keep',
      baseUrl: 'http://localhost:1234/v1',
      envKey: 'KEEP_KEY',
      generationConfig: {
        customHeaders: { 'X-Key': '${SHADOW_SIBLING_HEADER}' },
      },
    };
    fs.writeFileSync(
      userFile,
      JSON.stringify({
        $version: 4,
        modelProviders: {
          openai: [{ id: 'selected', baseUrl: LOCAL_BASE_URL }, sibling],
        },
      }),
    );
    const systemBytes = JSON.stringify({
      $version: 4,
      modelProviders: {
        openai: [{ id: 'system', baseUrl: LOCAL_BASE_URL }],
      },
    });
    fs.writeFileSync(systemFile, systemBytes);
    try {
      const loaded = loadSettings(workspace, {
        skipLoadEnvironment: true,
        workspaceTrusted: true,
      });
      const plan = buildInstallPlan(customProvider, {
        baseUrl: LOCAL_BASE_URL,
        modelIds: ['selected'],
        apiKey: 'test-only-new',
      });
      const key = Object.keys(plan.env!)[0]!;
      vi.stubEnv(key, 'test-only-old');
      const before = fs.readFileSync(userFile, 'utf8');
      await expect(
        applyProviderInstallPlan(plan, {
          settings: createLoadedSettingsAdapter(loaded, SettingScope.User),
          doRefreshAuth: false,
        }),
      ).rejects.toThrow('higher-precedence');
      expect(fs.readFileSync(userFile, 'utf8')).toBe(before);
      const saved = JSON.parse(fs.readFileSync(userFile, 'utf8'));
      expect(saved.modelProviders.openai[1]).toEqual(sibling);
      expect(fs.readFileSync(userFile, 'utf8')).not.toContain(
        'test-only-secret',
      );
      expect(fs.readFileSync(systemFile, 'utf8')).toBe(systemBytes);
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it.each([true, false])(
    'restores actual file contents or absence after a shadowed install (existing: %s)',
    async (existingFile) => {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), 'provider-rollback-'));
      const workspace = path.join(root, 'workspace');
      const userHome = path.join(root, 'home');
      fs.mkdirSync(path.join(workspace, '.qwen'), { recursive: true });
      fs.mkdirSync(userHome);
      vi.stubEnv('QWEN_HOME', userHome);
      const userFile = path.join(userHome, 'settings.json');
      const systemFile = path.join(root, 'system-settings.json');
      vi.stubEnv('QWEN_CODE_SYSTEM_SETTINGS_PATH', systemFile);
      const originalUser =
        '{"$version":4,"modelProviders":{"openai":[{"id":"old-user","baseUrl":"http://127.0.0.1:11434/v1"}]}}\n';
      const originalSystem = JSON.stringify({
        $version: 4,
        modelProviders: {
          openai: [{ id: 'system-chat', baseUrl: LOCAL_BASE_URL }],
        },
      });
      if (existingFile) fs.writeFileSync(userFile, originalUser);
      fs.writeFileSync(systemFile, originalSystem);
      try {
        const loaded = loadSettings(workspace, {
          skipLoadEnvironment: true,
          workspaceTrusted: true,
        });
        const before = structuredClone(loaded.merged);
        const plan = buildInstallPlan(
          customProvider,
          {
            baseUrl: LOCAL_BASE_URL,
            apiKey: 'test-only',
            modelIds: ['new-model'],
          },
          loaded.merged.modelProviders?.['openai'],
        );
        const envKey = Object.keys(plan.env!)[0]!;
        const originalEnv = process.env[envKey];
        await expect(
          applyProviderInstallPlan(plan, {
            settings: createLoadedSettingsAdapter(loaded, SettingScope.User),
            doRefreshAuth: false,
          }),
        ).rejects.toThrow('higher-precedence');
        expect(fs.existsSync(userFile)).toBe(existingFile);
        if (existingFile)
          expect(fs.readFileSync(userFile, 'utf8')).toBe(originalUser);
        expect(fs.readFileSync(systemFile, 'utf8')).toBe(originalSystem);
        expect(loaded.merged).toEqual(before);
        expect(process.env[envKey]).toBe(originalEnv);
        expect(fs.existsSync(userFile + '.orig')).toBe(false);
      } finally {
        vi.unstubAllEnvs();
        fs.rmSync(root, { recursive: true, force: true });
      }
    },
  );

  it.each([SettingScope.User])(
    'preserves placeholders on disk and resolved runtime values during reconnect (%s)',
    async (scope) => {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), 'provider-raw-'));
      const workspace = path.join(root, 'workspace');
      const userHome = path.join(root, 'home');
      fs.mkdirSync(path.join(workspace, '.qwen'), { recursive: true });
      fs.mkdirSync(userHome);
      vi.stubEnv('QWEN_HOME', userHome);
      vi.stubEnv('RECONNECT_TEST_TOKEN', 'resolved-private-token');
      vi.stubEnv('RECONNECT_TEST_ID', 'local-model');
      vi.stubEnv('RECONNECT_TEST_URL', LOCAL_BASE_URL);
      const envKey = generateCustomEnvKey(AuthType.USE_OPENAI, LOCAL_BASE_URL);
      vi.stubEnv(envKey, 'old-service-key');
      const filename = path.join(
        scope === SettingScope.User ? userHome : path.join(workspace, '.qwen'),
        'settings.json',
      );
      const raw = {
        id: '${RECONNECT_TEST_ID}',
        baseUrl: '${RECONNECT_TEST_URL}',
        envKey,
        generationConfig: {
          contextWindowSize: 65536,
          customHeaders: {
            Authorization: '${RECONNECT_TEST_TOKEN}',
            'X-Rotated': 'Bearer ${' + envKey + '}',
          },
        },
      };
      fs.writeFileSync(
        filename,
        JSON.stringify({ $version: 4, modelProviders: { openai: [raw] } }),
      );
      try {
        const loaded = loadSettings(workspace, {
          skipLoadEnvironment: true,
          workspaceTrusted: true,
        });
        const plan = buildInstallPlan(
          customProvider,
          {
            baseUrl: LOCAL_BASE_URL,
            apiKey: 'new-service-key',
            modelIds: ['local-model'],
          },
          loaded.merged.modelProviders?.['openai'],
        );
        const result = await applyProviderInstallPlan(plan, {
          settings: createLoadedSettingsAdapter(loaded, scope),
        });
        const saved = JSON.parse(fs.readFileSync(filename, 'utf8'));
        expect(saved.modelProviders.openai[0]).toMatchObject(raw);
        expect(JSON.stringify(saved)).not.toContain('resolved-private-token');
        expect(saved.env[envKey]).toBe('new-service-key');
        expect(loaded.merged.modelProviders?.['openai']?.[0]).toMatchObject({
          id: 'local-model',
          baseUrl: LOCAL_BASE_URL,
          generationConfig: {
            customHeaders: {
              Authorization: 'resolved-private-token',
              'X-Rotated': 'Bearer new-service-key',
            },
          },
        });
        expect(result.updatedModelProviders['openai']).toEqual(
          loaded.merged.modelProviders?.['openai'],
        );
      } finally {
        vi.unstubAllEnvs();
        fs.rmSync(root, { recursive: true, force: true });
      }
    },
  );

  it('forwards setValue to LoadedSettings.setValue with the resolved scope', () => {
    const { settings, setValue } = makeSettings();
    const adapter = createLoadedSettingsAdapter(
      settings as never,
      SettingScope.User,
    );
    adapter.setValue('env.MY_KEY', 'val');
    expect(setValue).toHaveBeenCalledWith(
      SettingScope.User,
      'env.MY_KEY',
      'val',
    );
  });

  it('rejects prototype-pollution keys before reaching LoadedSettings', () => {
    const { settings, setValue } = makeSettings();
    const adapter = createLoadedSettingsAdapter(
      settings as never,
      SettingScope.User,
    );
    expect(() => adapter.setValue('__proto__.polluted', 'x')).toThrow(
      /reserved segment/,
    );
    expect(() => adapter.setValue('foo.constructor.bar', 'x')).toThrow(
      /reserved segment/,
    );
    expect(() => adapter.setValue('prototype.x', 'x')).toThrow(
      /reserved segment/,
    );
    // The guard short-circuits before delegating to LoadedSettings — that's the
    // contract this test exists to lock in.
    expect(setValue).not.toHaveBeenCalled();
  });

  it('getValue reads from settings.merged via dotted key', () => {
    const { settings } = makeSettings({
      env: { MY_KEY: 'from-merged' },
      modelProviders: { openai: [{ id: 'gpt' }] },
    });
    const adapter = createLoadedSettingsAdapter(
      settings as never,
      SettingScope.User,
    );
    expect(adapter.getValue('env.MY_KEY')).toBe('from-merged');
    expect(adapter.getValue('modelProviders.openai')).toEqual([{ id: 'gpt' }]);
    expect(adapter.getValue('missing.path')).toBeUndefined();
  });

  it('backup() snapshots in-memory state; restore() reverts and recomputes merged', () => {
    const { settings, file, recomputeMerged } = makeSettings({
      env: { ORIGINAL: '1' },
    });
    const adapter = createLoadedSettingsAdapter(
      settings as never,
      SettingScope.User,
    );

    // backup/restore/cleanupBackup are optional in the contract, but
    // createLoadedSettingsAdapter always installs them — assert + use !.
    expect(adapter.backup).toBeTypeOf('function');
    adapter.backup!();

    // Simulate mutations that would happen during an install plan apply.
    adapter.setValue('env.NEW_KEY', 'new-value');
    expect(file.settings.env).toEqual({
      ORIGINAL: '1',
      NEW_KEY: 'new-value',
    });

    expect(adapter.restore).toBeTypeOf('function');
    adapter.restore!();

    expect(file.settings).toEqual({ env: { ORIGINAL: '1' } });
    expect(file.originalSettings).toEqual({ env: { ORIGINAL: '1' } });
    expect(recomputeMerged).toHaveBeenCalled();
  });

  it('cleanupBackup() clears the in-memory snapshot so a later restore is a no-op', () => {
    const { settings, file } = makeSettings({ env: { K: 'v1' } });
    const adapter = createLoadedSettingsAdapter(
      settings as never,
      SettingScope.User,
    );
    expect(adapter.backup).toBeTypeOf('function');
    adapter.backup!();
    adapter.setValue('env.K', 'v2');
    expect(adapter.cleanupBackup).toBeTypeOf('function');
    adapter.cleanupBackup!();
    // restore after cleanup should not bring v1 back
    expect(adapter.restore).toBeTypeOf('function');
    adapter.restore!();
    expect(file.settings.env).toEqual({ K: 'v2' });
  });
});

describe('getRawModelProviders', () => {
  const scoped = (
    files: Partial<Record<SettingScope, Record<string, unknown>>>,
    merged: Record<string, unknown>,
    isTrusted = true,
  ) =>
    ({
      isTrusted,
      merged,
      forScope: (scope: SettingScope) => ({
        originalSettings: files[scope] ?? {},
      }),
    }) as unknown as LoadedSettings;
  const userModel = {
    id: 'gpt-5',
    envKey: 'K',
    generationConfig: { extra_body: { api_key: '${GATEWAY_KEY}' } },
  };
  const files = {
    [SettingScope.User]: { modelProviders: { openai: [userModel] } },
    [SettingScope.Workspace]: {
      modelProviders: { openai: [{ id: 'local-ws', envKey: '${WS_KEY}' }] },
    },
  };

  it.each([true, false])(
    'returns the unresolved operator bucket and never a workspace one (trusted: %s)',
    (isTrusted) => {
      const settings = scoped(
        files,
        {
          modelProviders: {
            openai: [
              {
                ...userModel,
                generationConfig: { extra_body: { api_key: 'sk-live' } },
              },
            ],
          },
        },
        isTrusted,
      );
      expect(getRawModelProviders(settings)).toEqual({ openai: [userModel] });
    },
  );
});
