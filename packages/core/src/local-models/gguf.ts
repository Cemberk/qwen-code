/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { closeSync, fstatSync, openSync, readSync } from 'node:fs';

/** "GGUF" read as a little-endian 32-bit number. */
const GGUF_MAGIC = 0x46554747;
const CHUNK_BYTES = 1 << 20;
const DEFAULT_ALIGNMENT = 32;
/** Byte sizes of the fixed-size GGUF value types, by type id. */
const VALUE_BYTES: Readonly<Record<number, number>> = {
  0: 1, // uint8
  1: 1, // int8
  2: 2, // uint16
  3: 2, // int16
  4: 4, // uint32
  5: 4, // int32
  6: 4, // float32
  7: 1, // bool
  10: 8, // uint64
  11: 8, // int64
  12: 8, // float64
};
const STRING = 8;
const ARRAY = 9;
const UINT32 = 4;

/** Reads a file front to back, a chunk at a time. */
class Reader {
  private buffer = Buffer.alloc(0);
  /** File offset of buffer[0]. */
  private start = 0;
  /** File offset of the next byte to read. */
  private position = 0;

  constructor(private readonly fd: number) {}

  get offset(): number {
    return this.position;
  }

  private bytes(length: number): Buffer {
    const at = this.position - this.start;
    if (at + length > this.buffer.length) {
      const kept = this.buffer.subarray(at);
      const more = Buffer.alloc(Math.max(length - kept.length, CHUNK_BYTES));
      const read = readSync(
        this.fd,
        more,
        0,
        more.length,
        this.position + kept.length,
      );
      this.buffer = Buffer.concat([kept, more.subarray(0, read)]);
      this.start = this.position;
      if (length > this.buffer.length) {
        throw new Error('The GGUF header is truncated.');
      }
    }
    const from = this.position - this.start;
    this.position += length;
    return this.buffer.subarray(from, from + length);
  }

  skip(length: number): void {
    const at = this.position - this.start;
    if (at + length <= this.buffer.length) {
      this.position += length;
    } else {
      this.position += length;
      this.start = this.position;
      this.buffer = Buffer.alloc(0);
    }
  }

  u32(): number {
    return this.bytes(4).readUInt32LE(0);
  }

  u64(): number {
    const value = this.bytes(8).readBigUInt64LE(0);
    if (value > BigInt(Number.MAX_SAFE_INTEGER)) {
      throw new Error('A GGUF number is out of range.');
    }
    return Number(value);
  }

  string(): string {
    return this.bytes(this.u64()).toString('utf8');
  }
}

function skipValue(reader: Reader, type: number): void {
  if (type === STRING) {
    reader.skip(reader.u64());
  } else if (type === ARRAY) {
    const itemType = reader.u32();
    const count = reader.u64();
    const size = VALUE_BYTES[itemType];
    if (size !== undefined) {
      reader.skip(size * count);
    } else {
      for (let i = 0; i < count; i++) skipValue(reader, itemType);
    }
  } else if (VALUE_BYTES[type] !== undefined) {
    reader.skip(VALUE_BYTES[type]);
  } else {
    throw new Error(`Unknown GGUF value type ${type}.`);
  }
}

/**
 * Bytes of each tensor stored in a GGUF file, read from its header: each
 * tensor runs to the next one's offset (alignment padding included).
 *
 * @throws Error when the file is not a GGUF file of version 2 or 3.
 */
function tensorBytes(file: string): Map<string, number> {
  const fd = openSync(file, 'r');
  try {
    const reader = new Reader(fd);
    if (reader.u32() !== GGUF_MAGIC) {
      throw new Error(`${file} is not a GGUF file.`);
    }
    const version = reader.u32();
    if (version !== 2 && version !== 3) {
      throw new Error(`${file} is GGUF version ${version}.`);
    }
    const tensorCount = reader.u64();
    const keyCount = reader.u64();
    let alignment = DEFAULT_ALIGNMENT;
    for (let i = 0; i < keyCount; i++) {
      const key = reader.string();
      const type = reader.u32();
      if (key === 'general.alignment' && type === UINT32) {
        alignment = reader.u32() || DEFAULT_ALIGNMENT;
      } else {
        skipValue(reader, type);
      }
    }
    const tensors: Array<{ name: string; offset: number }> = [];
    for (let i = 0; i < tensorCount; i++) {
      const name = reader.string();
      reader.skip(8 * reader.u32()); // dimensions
      reader.u32(); // type
      tensors.push({ name, offset: reader.u64() });
    }
    const dataStart = Math.ceil(reader.offset / alignment) * alignment;
    const dataEnd = fstatSync(fd).size - dataStart;
    tensors.sort((a, b) => a.offset - b.offset);
    const sizes = new Map<string, number>();
    tensors.forEach(({ name, offset }, i) => {
      sizes.set(name, (tensors[i + 1]?.offset ?? dataEnd) - offset);
    });
    return sizes;
  } finally {
    closeSync(fd);
  }
}

/**
 * Bytes of each tensor of a model stored in one GGUF file or split across
 * several.
 *
 * @throws Error when a file is not a readable GGUF file.
 */
export function ggufTensorBytes(files: readonly string[]): Map<string, number> {
  const sizes = new Map<string, number>();
  for (const file of files) {
    for (const [name, bytes] of tensorBytes(file)) sizes.set(name, bytes);
  }
  return sizes;
}
