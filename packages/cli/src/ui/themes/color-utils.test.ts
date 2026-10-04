/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect } from 'vitest';
import {
  resolveColor,
  CSS_NAME_TO_HEX_MAP,
  INK_SUPPORTED_NAMES,
} from './color-utils.js';

describe('Color Utils', () => {
  describe('resolveColor', () => {
    it('should resolve hex colors', () => {
      expect(resolveColor('#ff0000')).toBe('#ff0000');
      expect(resolveColor('#00ff00')).toBe('#00ff00');
      expect(resolveColor('#0000ff')).toBe('#0000ff');
      expect(resolveColor('#fff')).toBe('#fff');
      expect(resolveColor('#000')).toBe('#000');
    });

    it('should resolve Ink-supported color names', () => {
      expect(resolveColor('black')).toBe('black');
      expect(resolveColor('red')).toBe('red');
      expect(resolveColor('green')).toBe('green');
      expect(resolveColor('yellow')).toBe('yellow');
      expect(resolveColor('blue')).toBe('blue');
      expect(resolveColor('cyan')).toBe('cyan');
      expect(resolveColor('magenta')).toBe('magenta');
      expect(resolveColor('white')).toBe('white');
      expect(resolveColor('gray')).toBe('gray');
      expect(resolveColor('grey')).toBe('grey');
    });

    it('should resolve CSS color names to hex', () => {
      expect(resolveColor('darkkhaki')).toBe('#bdb76b');
      expect(resolveColor('coral')).toBe('#ff7f50');
      expect(resolveColor('teal')).toBe('#008080');
      expect(resolveColor('tomato')).toBe('#ff6347');
      expect(resolveColor('turquoise')).toBe('#40e0d0');
      expect(resolveColor('violet')).toBe('#ee82ee');
      expect(resolveColor('wheat')).toBe('#f5deb3');
      expect(resolveColor('whitesmoke')).toBe('#f5f5f5');
      expect(resolveColor('yellowgreen')).toBe('#9acd32');
    });

    it('should handle case insensitive color names', () => {
      expect(resolveColor('DARKKHAKI')).toBe('#bdb76b');
      expect(resolveColor('Coral')).toBe('#ff7f50');
      expect(resolveColor('TEAL')).toBe('#008080');
    });

    it('should return undefined for invalid colors', () => {
      expect(resolveColor('invalidcolor')).toBeUndefined();
      expect(resolveColor('notacolor')).toBeUndefined();
      expect(resolveColor('')).toBeUndefined();
    });
  });

  describe('CSS_NAME_TO_HEX_MAP', () => {
    it('should contain expected CSS color mappings', () => {
      expect(CSS_NAME_TO_HEX_MAP['darkkhaki']).toBe('#bdb76b');
      expect(CSS_NAME_TO_HEX_MAP['coral']).toBe('#ff7f50');
      expect(CSS_NAME_TO_HEX_MAP['teal']).toBe('#008080');
      expect(CSS_NAME_TO_HEX_MAP['tomato']).toBe('#ff6347');
      expect(CSS_NAME_TO_HEX_MAP['turquoise']).toBe('#40e0d0');
    });

    it('should not contain Ink-supported color names', () => {
      expect(CSS_NAME_TO_HEX_MAP['black']).toBeUndefined();
      expect(CSS_NAME_TO_HEX_MAP['red']).toBeUndefined();
      expect(CSS_NAME_TO_HEX_MAP['green']).toBeUndefined();
      expect(CSS_NAME_TO_HEX_MAP['blue']).toBeUndefined();
    });
  });

  describe('INK_SUPPORTED_NAMES', () => {
    it('should contain all Ink-supported color names', () => {
      expect(INK_SUPPORTED_NAMES.has('black')).toBe(true);
      expect(INK_SUPPORTED_NAMES.has('red')).toBe(true);
      expect(INK_SUPPORTED_NAMES.has('green')).toBe(true);
      expect(INK_SUPPORTED_NAMES.has('yellow')).toBe(true);
      expect(INK_SUPPORTED_NAMES.has('blue')).toBe(true);
      expect(INK_SUPPORTED_NAMES.has('cyan')).toBe(true);
      expect(INK_SUPPORTED_NAMES.has('magenta')).toBe(true);
      expect(INK_SUPPORTED_NAMES.has('white')).toBe(true);
      expect(INK_SUPPORTED_NAMES.has('gray')).toBe(true);
      expect(INK_SUPPORTED_NAMES.has('grey')).toBe(true);
      expect(INK_SUPPORTED_NAMES.has('blackbright')).toBe(true);
      expect(INK_SUPPORTED_NAMES.has('redbright')).toBe(true);
      expect(INK_SUPPORTED_NAMES.has('greenbright')).toBe(true);
      expect(INK_SUPPORTED_NAMES.has('yellowbright')).toBe(true);
      expect(INK_SUPPORTED_NAMES.has('bluebright')).toBe(true);
      expect(INK_SUPPORTED_NAMES.has('cyanbright')).toBe(true);
      expect(INK_SUPPORTED_NAMES.has('magentabright')).toBe(true);
      expect(INK_SUPPORTED_NAMES.has('whitebright')).toBe(true);
    });

    it('should not contain CSS color names', () => {
      expect(INK_SUPPORTED_NAMES.has('darkkhaki')).toBe(false);
      expect(INK_SUPPORTED_NAMES.has('coral')).toBe(false);
      expect(INK_SUPPORTED_NAMES.has('teal')).toBe(false);
    });
  });
});
