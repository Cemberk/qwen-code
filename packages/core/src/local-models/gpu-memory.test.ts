/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  GPU_HEADROOM_BYTES,
  appleGpuMemoryLimit,
  localModelBytes,
  modelSizeProblem,
} from './gpu-memory.js';
import type { LocalModelConfig } from './local-models.js';

const GIB = 1024 ** 3;
const unset = () => 0;

describe('appleGpuMemoryLimit', () => {
  it('is two thirds of RAM up to 36 GiB and three quarters above', () => {
    expect(appleGpuMemoryLimit('darwin', 'arm64', 24 * GIB, unset)).toBe(
      16 * GIB,
    );
    expect(appleGpuMemoryLimit('darwin', 'arm64', 64 * GIB, unset)).toBe(
      48 * GIB,
    );
  });

  it('uses iogpu.wired_limit_mb when it is set', () => {
    expect(appleGpuMemoryLimit('darwin', 'arm64', 24 * GIB, () => 20480)).toBe(
      20 * GIB,
    );
  });

  it('has no limit off Apple silicon', () => {
    expect(
      appleGpuMemoryLimit('linux', 'x64', 24 * GIB, unset),
    ).toBeUndefined();
    expect(
      appleGpuMemoryLimit('darwin', 'x64', 24 * GIB, unset),
    ).toBeUndefined();
  });
});

describe('modelSizeProblem', () => {
  const model: LocalModelConfig = {
    id: 'big',
    name: 'Big (Q4_K_M)',
    repo: 'o/r',
    file: 'big.gguf',
  };

  it('accepts a model that fits with room for its context', () => {
    expect(
      modelSizeProblem(model, 16 * GIB - GPU_HEADROOM_BYTES, 16 * GIB),
    ).toBeUndefined();
    expect(modelSizeProblem(model, 100 * GIB, undefined)).toBeUndefined();
  });

  it('names the size and the limit of a model that does not', () => {
    expect(modelSizeProblem(model, 21_166_758_496, 16 * GIB)).toBe(
      'Big (Q4_K_M) is 21.2 GB, but macOS lets the GPU use only about 17.2 GB on this Mac, and the model also needs room for its context. Pick a smaller quantization of the model.',
    );
  });
});

describe('localModelBytes', () => {
  let cache: string;
  const commit = 'a'.repeat(40);
  beforeEach(() => {
    cache = mkdtempSync(path.join(os.tmpdir(), 'gpu-memory-'));
  });
  afterEach(() => rmSync(cache, { recursive: true, force: true }));

  function download(repo: string, files: Record<string, number>) {
    const repoDir = path.join(cache, `models--${repo.replace('/', '--')}`);
    mkdirSync(path.join(repoDir, 'refs'), { recursive: true });
    writeFileSync(path.join(repoDir, 'refs', 'main'), commit);
    for (const [file, size] of Object.entries(files)) {
      const target = path.join(repoDir, 'snapshots', commit, file);
      mkdirSync(path.dirname(target), { recursive: true });
      writeFileSync(target, Buffer.alloc(size));
    }
  }

  it('adds up every part of a split model', () => {
    download('o/split', {
      'q/m-00001-of-00002.gguf': 300,
      'q/m-00002-of-00002.gguf': 200,
    });
    expect(
      localModelBytes(
        { id: 's', repo: 'o/split', file: 'q/m-00001-of-00002.gguf' },
        cache,
      ),
    ).toBe(500);
  });
});
