/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it, vi } from 'vitest';

// D11: libvips chooses its loader from the bytes, so anything that is not a
// PNG/JPEG/WebP signature must be refused before sharp sees it. Kept in its
// own file because vi.mock('sharp') is file-scoped.
const sharpCalls = vi.hoisted(() => [] as unknown[]);
vi.mock('sharp', () => ({
  default: (input: unknown) => {
    sharpCalls.push(input);
    return { metadata: async () => ({ format: 'svg', width: 1, height: 1 }) };
  },
}));

import { boundImageBuffer } from './image-view.js';

describe('image-view input sniffing', () => {
  it.each([
    [
      'SVG',
      '<svg xmlns="http://www.w3.org/2000/svg"><image href="http://127.0.0.1:9/x"/></svg>',
    ],
    ['PDF', '%PDF-1.7\n'],
    ['TIFF', 'II*\u0000'],
    ['text', 'not an image'],
  ])('never hands %s bytes to sharp', async (_name, content) => {
    sharpCalls.length = 0;
    await expect(
      boundImageBuffer(
        Buffer.from(content, 'latin1'),
        'label',
        new AbortController().signal,
      ),
    ).rejects.toMatchObject({ code: 'unsupported_image' });
    expect(sharpCalls).toEqual([]);
  });
});
