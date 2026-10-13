/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect } from 'vitest';
import {
  estimateTextTokens,
  estimateTextTokenUnits,
  TOKEN_ESTIMATE_UNITS_PER_TOKEN,
} from './textTokenizer.js';

describe('estimateTextTokens', () => {
  describe('character-based estimation', () => {
    it('keeps token-unit estimates aligned with token estimates', () => {
      for (const text of ['', 'Hello', 'おはよう', 'Hello かな']) {
        expect(
          Math.ceil(
            estimateTextTokenUnits(text) / TOKEN_ESTIMATE_UNITS_PER_TOKEN,
          ),
        ).toBe(estimateTextTokens(text));
      }
    });

    it('should return 0 for empty text', () => {
      const result = estimateTextTokens('');
      expect(result).toBe(0);
    });

    it('should return 0 for null/undefined text', () => {
      const result1 = estimateTextTokens(null as unknown as string);
      const result2 = estimateTextTokens(undefined as unknown as string);
      expect(result1).toBe(0);
      expect(result2).toBe(0);
    });

    it('should calculate tokens using character-based estimation for ASCII text', () => {
      const testText = 'Hello, world!'; // 13 ASCII chars
      const result = estimateTextTokens(testText);
      // 13 / 4 = 3.25 -> ceil = 4
      expect(result).toBe(4);
    });

    it('should calculate tokens for code (ASCII)', () => {
      const code = 'function test() { return 42; }'; // 30 ASCII chars
      const result = estimateTextTokens(code);
      // 30 / 4 = 7.5 -> ceil = 8
      expect(result).toBe(8);
    });

    it('should calculate tokens for non-ASCII text (CJK)', () => {
      const unicodeText = 'おはよう'; // 4 non-ASCII chars
      const result = estimateTextTokens(unicodeText);
      // 4 * 1.1 = 4.4 -> ceil = 5
      expect(result).toBe(5);
    });

    it('should calculate tokens for mixed ASCII and non-ASCII text', () => {
      const mixedText = 'Hello かな'; // 6 ASCII + 2 non-ASCII
      const result = estimateTextTokens(mixedText);
      // (6 / 4) + (2 * 1.1) = 1.5 + 2.2 = 3.7 -> ceil = 4
      expect(result).toBe(4);
    });

    it('should calculate tokens for emoji', () => {
      const emojiText = '🌍'; // 2 UTF-16 code units (non-ASCII)
      const result = estimateTextTokens(emojiText);
      // 2 * 1.1 = 2.2 -> ceil = 3
      expect(result).toBe(3);
    });

    it('should handle very long text', () => {
      const longText = 'a'.repeat(10000); // 10000 ASCII chars
      const result = estimateTextTokens(longText);
      // 10000 / 4 = 2500 -> ceil = 2500
      expect(result).toBe(2500);
    });

    it('should handle text with only whitespace', () => {
      const whitespaceText = '   \n\t  '; // 7 ASCII chars
      const result = estimateTextTokens(whitespaceText);
      // 7 / 4 = 1.75 -> ceil = 2
      expect(result).toBe(2);
    });

    it('should handle special characters and symbols', () => {
      const specialText = '!@#$%^&*()_+-=[]{}|;:,.<>?'; // 26 ASCII chars
      const result = estimateTextTokens(specialText);
      // 26 / 4 = 6.5 -> ceil = 7
      expect(result).toBe(7);
    });

    it('should handle very short text', () => {
      const result = estimateTextTokens('a');
      // 1 / 4 = 0.25 -> ceil = 1
      expect(result).toBe(1);
    });
  });

  describe('edge cases', () => {
    it('should handle text with only newlines', () => {
      const text = '\n\n\n'; // 3 ASCII chars
      const result = estimateTextTokens(text);
      // 3 / 4 = 0.75 -> ceil = 1
      expect(result).toBe(1);
    });

    it('should handle text with tabs', () => {
      const text = '\t\t\t\t'; // 4 ASCII chars
      const result = estimateTextTokens(text);
      // 4 / 4 = 1 -> ceil = 1
      expect(result).toBe(1);
    });

    it('should handle surrogate pairs correctly', () => {
      // Character outside BMP (Basic Multilingual Plane)
      const text = '𝕳𝖊𝖑𝖑𝖔'; // Mathematical bold letters (2 UTF-16 units each)
      const result = estimateTextTokens(text);
      // Each character is 2 UTF-16 units, all non-ASCII
      // Total: 10 non-ASCII units
      // 10 * 1.1 = 11 -> ceil = 11
      expect(result).toBe(11);
    });

    it('should handle combining characters', () => {
      // e + combining acute accent
      const text = 'e\u0301'; // 2 chars: 'e' (ASCII) + combining acute (non-ASCII)
      const result = estimateTextTokens(text);
      // ASCII: 1 / 4 = 0.25
      // Non-ASCII: 1 * 1.1 = 1.1
      // Total: 0.25 + 1.1 = 1.35 -> ceil = 2
      expect(result).toBe(2);
    });

    it('should handle accented characters', () => {
      const text = 'café'; // 'caf' = 3 ASCII, 'é' = 1 non-ASCII
      const result = estimateTextTokens(text);
      // ASCII: 3 / 4 = 0.75
      // Non-ASCII: 1 * 1.1 = 1.1
      // Total: 0.75 + 1.1 = 1.85 -> ceil = 2
      expect(result).toBe(2);
    });

    it('should handle various unicode scripts', () => {
      const cyrillic = 'Привет'; // 6 non-ASCII chars
      const arabic = 'مرحبا'; // 5 non-ASCII chars
      const japanese = 'こんにちは'; // 5 non-ASCII chars

      const result1 = estimateTextTokens(cyrillic);
      const result2 = estimateTextTokens(arabic);
      const result3 = estimateTextTokens(japanese);

      // All should use 1.1 tokens per char
      expect(result1).toBe(7); // 6 * 1.1 = 6.6 -> ceil = 7
      expect(result2).toBe(6); // 5 * 1.1 = 5.5 -> ceil = 6
      expect(result3).toBe(6); // 5 * 1.1 = 5.5 -> ceil = 6
    });
  });

  describe('ASCII/non-ASCII boundary', () => {
    it('should treat DEL (U+007F) as ASCII and U+0080 as non-ASCII', () => {
      // '\x7F' = 1 ASCII char: 1 / 4 = 0.25 -> ceil = 1
      expect(estimateTextTokens('\x7F')).toBe(1);
      // '\u0080' = 1 non-ASCII char: 1 * 1.1 = 1.1 -> ceil = 2
      expect(estimateTextTokens('\u0080')).toBe(2);
    });

    it('should count pure-ASCII text of any length as ceil(length / 4)', () => {
      for (const len of [1, 3, 4, 5, 4096, 4097]) {
        const text = 'a'.repeat(len);
        expect(estimateTextTokens(text)).toBe(Math.ceil(len / 4));
      }
    });

    it('should stay consistent when a single non-ASCII char joins long ASCII text', () => {
      const ascii = 'x'.repeat(1000);
      // 1000 / 4 = 250
      expect(estimateTextTokens(ascii)).toBe(250);
      // 1000 / 4 + 1 * 1.1 = 251.1 -> ceil = 252, wherever the char sits
      expect(estimateTextTokens(ascii + 'あ')).toBe(252);
      expect(estimateTextTokens('あ' + ascii)).toBe(252);
    });

    it('should count surrogate pairs as two non-ASCII units within mixed text', () => {
      const text = 'abcd🚀'; // 4 ASCII + 2 UTF-16 units
      // 4 / 4 + 2 * 1.1 = 3.2 -> ceil = 4
      expect(estimateTextTokens(text)).toBe(4);
    });
  });

  describe('large inputs', () => {
    it('should handle very long text', () => {
      const longText = 'a'.repeat(200000); // 200k characters
      const result = estimateTextTokens(longText);
      expect(result).toBe(50000); // 200000 / 4
    });
  });
});
