/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Storage } from '@qwen-code/qwen-code-core';

describe('bundled locale fallback', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    vi.doUnmock('node:fs');
    vi.restoreAllMocks();
  });

  it('loads bundled builtin translations when locale files are absent on disk', async () => {
    const qwenLocalePathPattern =
      /([\\/]\.qwen|[\\/]i18n)[\\/]locales([\\/]|$)/;

    vi.doMock('node:fs', async (importOriginal) => {
      const actualFs = await importOriginal<typeof import('node:fs')>();
      return {
        ...actualFs,
        existsSync: (target: Parameters<typeof actualFs.existsSync>[0]) => {
          if (qwenLocalePathPattern.test(String(target))) {
            return false;
          }
          return actualFs.existsSync(target);
        },
      };
    });

    const { setLanguageAsync, t } = await import('./index.js');
    const { languageCommand } = await import(
      '../ui/commands/languageCommand.js'
    );

    await setLanguageAsync('fr');

    expect(t('show version info')).toBe('afficher les informations de version');
    expect(languageCommand.description).not.toBe(
      'View or change the language setting',
    );
  }, 20000);

  it('never imports locale modules from the user settings directory', async () => {
    const tempDir = await fs.mkdtemp(
      path.join(os.tmpdir(), 'qwen-i18n-user-locale-'),
    );
    const localesDir = path.join(tempDir, 'locales');
    await fs.mkdir(localesDir, { recursive: true });
    await fs.writeFile(
      path.join(localesDir, 'fr.js'),
      "globalThis.__qwenUserLocaleLoaded = true;\nexport default { 'show version info': 'user override' };\n",
      'utf-8',
    );
    vi.spyOn(Storage, 'getGlobalQwenDir').mockReturnValue(tempDir);

    try {
      const { setLanguageAsync, t } = await import('./index.js');
      await setLanguageAsync('fr');

      expect(t('show version info')).toBe(
        'afficher les informations de version',
      );
      expect(
        (globalThis as { __qwenUserLocaleLoaded?: boolean })
          .__qwenUserLocaleLoaded,
      ).toBeUndefined();
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  }, 20000);
});

describe('locale code validation', () => {
  let tempDir: string;

  beforeEach(async () => {
    vi.resetModules();
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'qwen-i18n-traversal-'));
    await fs.writeFile(
      path.join(tempDir, 'evil.js'),
      "globalThis.__qwenEvilLocaleLoaded = true;\nexport default { 'show version info': 'pwned' };\n",
      'utf-8',
    );
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    delete (globalThis as { __qwenEvilLocaleLoaded?: boolean })
      .__qwenEvilLocaleLoaded;
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  function traversalCode(): string {
    const localesDir = path.join(
      path.dirname(new URL(import.meta.url).pathname),
      'locales',
    );
    return path.relative(localesDir, path.join(tempDir, 'evil'));
  }

  it('rejects a path-traversal language setting before any import', async () => {
    const { setLanguageAsync, getCurrentLanguage, t } = await import(
      './index.js'
    );

    await setLanguageAsync(traversalCode() as never);

    expect(getCurrentLanguage()).toBe('en');
    expect(t('show version info')).toBe('show version info');
    expect(
      (globalThis as { __qwenEvilLocaleLoaded?: boolean })
        .__qwenEvilLocaleLoaded,
    ).toBeUndefined();
  });

  it('rejects a path-traversal QWEN_CODE_LANG', async () => {
    vi.stubEnv('QWEN_CODE_LANG', traversalCode());
    const { initializeI18n, resolveLanguageSetting, getCurrentLanguage } =
      await import('./index.js');

    await initializeI18n(resolveLanguageSetting('fr'));

    expect(getCurrentLanguage()).toBe('en');
    expect(
      (globalThis as { __qwenEvilLocaleLoaded?: boolean })
        .__qwenEvilLocaleLoaded,
    ).toBeUndefined();
  });

  it('falls back to English for unshipped language codes', async () => {
    const { resolveLanguage } = await import('./index.js');

    expect(resolveLanguage('es' as never)).toBe('en');
    expect(resolveLanguage('pt-BR' as never)).toBe('pt');
  });
});

describe('public i18n exports', () => {
  it('re-exports supported languages and required translation keys', async () => {
    const i18n = await import('./index.js');

    expect(i18n.SUPPORTED_LANGUAGES.length).toBeGreaterThan(0);
    expect(i18n.MUST_TRANSLATE_KEYS.length).toBeGreaterThan(0);
  });
});

describe('language normalization', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  it('normalizes explicit locale IDs before loading translations', async () => {
    const { setLanguageAsync, getCurrentLanguage, t } = await import(
      './index.js'
    );

    await setLanguageAsync('ja-JP');

    expect(getCurrentLanguage()).toBe('ja');
    expect(t('show version info')).toBe('バージョン情報を表示');
  });

  it('normalizes explicit POSIX locale strings before loading translations', async () => {
    const { initializeI18n, getCurrentLanguage, t } = await import(
      './index.js'
    );

    await initializeI18n('pt_BR.UTF-8');

    expect(getCurrentLanguage()).toBe('pt');
    expect(t('show version info')).toBe('mostrar informações de versão');
  });
});

describe('supported language resolution', () => {
  it('resolves locale IDs and POSIX spellings to a shipped language', async () => {
    const { resolveSupportedLanguage } = await import('./languages.js');

    expect(resolveSupportedLanguage('pt-BR')).toBe('pt');
    expect(resolveSupportedLanguage('pt_BR')).toBe('pt');
    expect(resolveSupportedLanguage('pt-BR.UTF-8')).toBe('pt');
  });
});

describe('localizeToolDisplayName', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it('falls back to the English display name for untranslated tools', async () => {
    const { setLanguageAsync, localizeToolDisplayName } = await import(
      './index.js'
    );
    await setLanguageAsync('en');

    expect(localizeToolDisplayName('TodoList')).toBe('TodoList');
    expect(localizeToolDisplayName('Shell')).toBe('Shell');
    // An unknown tool name passes through unchanged.
    expect(localizeToolDisplayName('MysteryTool')).toBe('MysteryTool');
  });
});
