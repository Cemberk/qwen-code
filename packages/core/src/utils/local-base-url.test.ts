/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import { assertLocalBaseUrl, getLocalBaseUrlError } from './local-base-url.js';

describe('getLocalBaseUrlError', () => {
  it.each([
    'http://127.0.0.1:11434/v1',
    'http://localhost:1234/v1',
    'http://[::1]:8000/v1',
    'https://localhost:8443/v1',
    '  http://127.0.0.1:8080/v1  ',
  ])('accepts the loopback URL %j', (baseUrl) => {
    expect(getLocalBaseUrlError(baseUrl)).toBeNull();
  });

  it.each([undefined, null, '', '   '])(
    'rejects a missing base URL (%j) instead of defaulting',
    (baseUrl) => {
      expect(getLocalBaseUrlError(baseUrl)).toMatch(
        /^No model server base URL is configured\./,
      );
    },
  );

  it.each([
    'https://api.openai.com/v1',
    'http://192.168.1.5:8000/v1',
    'http://127.0.0.1@evil.com/',
    'http://localhost.evil.com/',
    'http://127.0.0.2:8000/v1',
  ])('rejects the non-loopback host in %j', (baseUrl) => {
    expect(getLocalBaseUrlError(baseUrl)).toContain(
      'is not allowed: the host must be 127.0.0.1, ::1 or localhost.',
    );
  });

  it('rejects a non-http(s) scheme', () => {
    expect(getLocalBaseUrlError('ftp://127.0.0.1/')).toContain(
      'must use http or https',
    );
  });

  it('rejects a value that is not a URL', () => {
    expect(getLocalBaseUrlError('127.0.0.1:11434')).toContain(
      'is not a valid URL',
    );
  });

  it('names the source of the value in the message', () => {
    expect(
      getLocalBaseUrlError(
        'https://api.openai.com/v1',
        'settings.security.auth.baseUrl',
      ),
    ).toContain('(from settings.security.auth.baseUrl)');
    expect(getLocalBaseUrlError('', 'OPENAI_BASE_URL')).toContain(
      'No model server base URL is configured (from OPENAI_BASE_URL).',
    );
  });
});

describe('assertLocalBaseUrl', () => {
  it('returns the trimmed base URL when it is loopback', () => {
    expect(assertLocalBaseUrl('  http://127.0.0.1:11434/v1 ')).toBe(
      'http://127.0.0.1:11434/v1',
    );
  });

  it('throws for a cloud base URL', () => {
    expect(() => assertLocalBaseUrl('https://api.openai.com/v1')).toThrow(
      'is not allowed: the host must be 127.0.0.1, ::1 or localhost.',
    );
  });

  it('throws for a missing base URL', () => {
    expect(() => assertLocalBaseUrl(undefined)).toThrow(
      'No model server base URL is configured',
    );
  });
});
