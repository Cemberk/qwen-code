/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect } from 'vitest';
import {
  resolveLocalizableString,
  resolveExtensionConfigLocale,
  type RawExtensionConfig,
} from './i18n.js';

describe('resolveLocalizableString', () => {
  it('should return undefined for undefined input', () => {
    expect(resolveLocalizableString(undefined, 'en')).toBeUndefined();
  });

  it('should return plain string unchanged', () => {
    expect(resolveLocalizableString('hello', 'en')).toBe('hello');
    expect(resolveLocalizableString('hello', 'pt')).toBe('hello');
  });

  it('should resolve exact locale match', () => {
    const value = { en: 'Hello', pt: 'Olá', ja: 'こんにちは' };
    expect(resolveLocalizableString(value, 'pt')).toBe('Olá');
    expect(resolveLocalizableString(value, 'ja')).toBe('こんにちは');
  });

  it('should fall back to base language', () => {
    const value = { en: 'Hello', pt: 'Olá' };
    expect(resolveLocalizableString(value, 'pt-BR')).toBe('Olá');
    expect(resolveLocalizableString(value, 'pt-PT')).toBe('Olá');
  });

  it('should prefer exact match over base language', () => {
    const value = { en: 'Hello', pt: 'Olá', 'pt-BR': 'Olá (Brasil)' };
    expect(resolveLocalizableString(value, 'pt-BR')).toBe('Olá (Brasil)');
    expect(resolveLocalizableString(value, 'pt')).toBe('Olá');
  });

  it('should fall back to en when no match', () => {
    const value = { en: 'Hello', pt: 'Olá' };
    expect(resolveLocalizableString(value, 'ja')).toBe('Hello');
    expect(resolveLocalizableString(value, 'de')).toBe('Hello');
  });

  it('should fall back to first value when no en', () => {
    const value = { pt: 'Olá', ja: 'こんにちは' };
    expect(resolveLocalizableString(value, 'de')).toBe('Olá');
  });

  it('should return undefined for empty record', () => {
    expect(resolveLocalizableString({}, 'en')).toBeUndefined();
  });

  it('should skip non-string values in locale map', () => {
    const value = { en: 123, pt: 'Português' } as unknown as Record<
      string,
      string
    >;
    expect(resolveLocalizableString(value, 'en')).toBe('Português');
  });

  it('should return undefined when all values are non-string', () => {
    const value = { en: 123, pt: 456 } as unknown as Record<string, string>;
    expect(resolveLocalizableString(value, 'en')).toBeUndefined();
  });
});

describe('resolveExtensionConfigLocale', () => {
  const baseConfig: RawExtensionConfig = {
    name: 'test-ext',
    version: '1.0.0',
  };

  it('should pass through config with plain string fields', () => {
    const raw: RawExtensionConfig = {
      ...baseConfig,
      description: 'A test extension',
      displayName: 'Test Extension',
    };
    const resolved = resolveExtensionConfigLocale(raw, 'en');
    expect(resolved.name).toBe('test-ext');
    expect(resolved.description).toBe('A test extension');
    expect(resolved.displayName).toBe('Test Extension');
  });

  it('should resolve locale map description', () => {
    const raw: RawExtensionConfig = {
      ...baseConfig,
      description: { en: 'English desc', pt: 'Descrição em português' },
    };
    expect(resolveExtensionConfigLocale(raw, 'pt').description).toBe(
      'Descrição em português',
    );
    expect(resolveExtensionConfigLocale(raw, 'en').description).toBe(
      'English desc',
    );
  });

  it('should resolve locale map displayName', () => {
    const raw: RawExtensionConfig = {
      ...baseConfig,
      displayName: { en: 'My Extension', pt: 'Minha extensão' },
    };
    expect(resolveExtensionConfigLocale(raw, 'pt').displayName).toBe(
      'Minha extensão',
    );
    expect(resolveExtensionConfigLocale(raw, 'en').displayName).toBe(
      'My Extension',
    );
  });

  it('should resolve settings descriptions', () => {
    const raw: RawExtensionConfig = {
      ...baseConfig,
      settings: [
        {
          name: 'api-key',
          description: { en: 'API key', pt: 'Chave de API' },
          envVar: 'API_KEY',
        },
        {
          name: 'plain-setting',
          description: 'A plain setting',
          envVar: 'PLAIN',
        },
      ],
    };
    const resolved = resolveExtensionConfigLocale(raw, 'pt');
    expect(resolved.settings![0]!.description).toBe('Chave de API');
    expect(resolved.settings![1]!.description).toBe('A plain setting');
  });

  it('should handle missing optional fields', () => {
    const resolved = resolveExtensionConfigLocale(baseConfig, 'en');
    expect(resolved.description).toBeUndefined();
    expect(resolved.displayName).toBeUndefined();
    expect(resolved.settings).toBeUndefined();
  });

  it('should preserve non-localizable fields', () => {
    const raw: RawExtensionConfig = {
      ...baseConfig,
      contextFileName: 'CUSTOM.md',
      commands: ['commands/'],
    };
    const resolved = resolveExtensionConfigLocale(raw, 'en');
    expect(resolved.contextFileName).toBe('CUSTOM.md');
    expect(resolved.commands).toEqual(['commands/']);
  });
});
