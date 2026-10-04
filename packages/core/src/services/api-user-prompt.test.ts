/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect } from 'vitest';
import type { Content } from '@google/genai';
import { isApiUserPrompt } from './api-user-prompt.js';
import {
  SYSTEM_REMINDER_OPEN,
  SYSTEM_REMINDER_CLOSE,
} from '../core/environmentContext.js';

const user = (text: string): Content => ({
  role: 'user',
  parts: [{ text }],
});
const model = (text: string): Content => ({
  role: 'model',
  parts: [{ text }],
});
const reminder = (text: string): Content => ({
  role: 'user',
  parts: [{ text: `${SYSTEM_REMINDER_OPEN}${text}${SYSTEM_REMINDER_CLOSE}` }],
});
const toolResult = (): Content => ({
  role: 'user',
  parts: [{ functionResponse: { name: 'x', response: { output: 'ok' } } }],
});

const CLEARED_MEDIA = '[Old inline media cleared: image/png]';

describe('isApiUserPrompt', () => {
  it('accepts a plain user prompt and rejects non-prompt entries', () => {
    expect(isApiUserPrompt(user('hello'))).toBe(true);
    expect(isApiUserPrompt(model('hi'))).toBe(false);
    expect(isApiUserPrompt(toolResult())).toBe(false);
    expect(isApiUserPrompt(reminder('startup'))).toBe(false);
    expect(isApiUserPrompt({ role: 'user', parts: [] })).toBe(false);
  });

  it('keeps a genuine turn that merely carries a prepended reminder', () => {
    const content: Content = {
      role: 'user',
      parts: [
        { text: `${SYSTEM_REMINDER_OPEN}ctx${SYSTEM_REMINDER_CLOSE}` },
        { text: 'the real prompt' },
      ],
    };
    expect(isApiUserPrompt(content)).toBe(true);
  });

  it('rejects an entry mixing a tool result with prompt text', () => {
    const content: Content = {
      role: 'user',
      parts: [
        { functionResponse: { name: 'x', response: { output: 'ok' } } },
        { text: 'trailing text' },
      ],
    };
    expect(isApiUserPrompt(content)).toBe(false);
  });

  describe('excludeClearedMediaPlaceholders (the TUI binding)', () => {
    it('drops a placeholder-only entry only when the option is set', () => {
      expect(isApiUserPrompt(user(CLEARED_MEDIA))).toBe(true);
      expect(
        isApiUserPrompt(user(CLEARED_MEDIA), {
          excludeClearedMediaPlaceholders: true,
        }),
      ).toBe(false);
    });

    it('keeps a prompt that merely begins with the placeholder prefix', () => {
      const prefixed = user('[Old inline media cleared: what does this mean?');
      expect(
        isApiUserPrompt(prefixed, { excludeClearedMediaPlaceholders: true }),
      ).toBe(true);
    });

    it('keeps an entry that mixes a placeholder with real prompt text', () => {
      const mixed: Content = {
        role: 'user',
        parts: [{ text: CLEARED_MEDIA }, { text: 'and my question' }],
      };
      expect(
        isApiUserPrompt(mixed, { excludeClearedMediaPlaceholders: true }),
      ).toBe(true);
    });
  });
});
