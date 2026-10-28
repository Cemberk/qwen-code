/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ggufTensorBytes } from './gguf.js';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), 'gguf-'));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const u32 = (value: number) => {
  const buffer = Buffer.alloc(4);
  buffer.writeUInt32LE(value);
  return buffer;
};
const u64 = (value: number) => {
  const buffer = Buffer.alloc(8);
  buffer.writeBigUInt64LE(BigInt(value));
  return buffer;
};
const str = (value: string) =>
  Buffer.concat([u64(Buffer.byteLength(value)), Buffer.from(value)]);

/** A GGUF file with a tokenizer-like header and zeroed tensor data. */
function gguf(
  name: string,
  tensors: Array<[string, number]>,
  alignment?: number,
): string {
  const align = alignment ?? 32;
  const keys = [
    Buffer.concat([str('general.architecture'), u32(8), str('qwen35moe')]),
    // An array of strings and an array of numbers, as tokenizers store them.
    Buffer.concat([
      str('tokenizer.ggml.tokens'),
      u32(9),
      u32(8),
      u64(3),
      str('a'),
      str('bb'),
      str('ccc'),
    ]),
    Buffer.concat([
      str('tokenizer.ggml.token_type'),
      u32(9),
      u32(5),
      u64(3),
      Buffer.alloc(12),
    ]),
    ...(alignment
      ? [Buffer.concat([str('general.alignment'), u32(4), u32(align)])]
      : []),
  ];
  let offset = 0;
  const infos = tensors.map(([tensor, bytes]) => {
    const info = Buffer.concat([
      str(tensor),
      u32(2),
      u64(4),
      u64(4),
      u32(12),
      u64(offset),
    ]);
    offset += Math.ceil(bytes / align) * align;
    return info;
  });
  const header = Buffer.concat([
    u32(0x46554747),
    u32(3),
    u64(tensors.length),
    u64(keys.length),
    ...keys,
    ...infos,
  ]);
  const padded = Math.ceil(header.length / align) * align;
  const file = path.join(dir, name);
  writeFileSync(
    file,
    Buffer.concat([header, Buffer.alloc(padded - header.length + offset)]),
  );
  return file;
}

describe('ggufTensorBytes', () => {
  it('reads each tensor size from the header, the last one included', () => {
    const file = gguf('m.gguf', [
      ['token_embd.weight', 64],
      ['blk.0.ffn_up_exps.weight', 320],
      ['output.weight', 96],
    ]);
    expect(Object.fromEntries(ggufTensorBytes([file]))).toEqual({
      'token_embd.weight': 64,
      'blk.0.ffn_up_exps.weight': 320,
      'output.weight': 96,
    });
  });

  it('counts the alignment padding the file declares', () => {
    const file = gguf(
      'm.gguf',
      [
        ['a', 10],
        ['b', 10],
      ],
      64,
    );
    expect(Object.fromEntries(ggufTensorBytes([file]))).toEqual({
      a: 64,
      b: 64,
    });
  });

  it('adds up the parts of a split model', () => {
    const first = gguf('m-00001-of-00002.gguf', [['blk.0.attn_q.weight', 32]]);
    const second = gguf('m-00002-of-00002.gguf', [['blk.1.attn_q.weight', 64]]);
    expect(Object.fromEntries(ggufTensorBytes([first, second]))).toEqual({
      'blk.0.attn_q.weight': 32,
      'blk.1.attn_q.weight': 64,
    });
  });

  it('rejects a file that is not GGUF', () => {
    const file = path.join(dir, 'x.gguf');
    writeFileSync(file, 'not a model');
    expect(() => ggufTensorBytes([file])).toThrow('is not a GGUF file');
  });
});
