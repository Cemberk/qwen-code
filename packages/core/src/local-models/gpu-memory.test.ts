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
  downloadSizeProblem,
  expertBytesByLayer,
  fitModel,
  localModelBytes,
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

const model: LocalModelConfig = {
  id: 'big',
  name: 'Big (Q4_K_M)',
  repo: 'o/r',
  file: 'big.gguf',
};
const MIB = 1024 ** 2;
// Qwen3.6 35B A3B at Q3_K_M: 16.8 GB, of which 2 x 396 and 38 x 364 MiB are
// expert weights.
const Q3_K_M_BYTES = 16_764_764_768;
const Q3_K_M_EXPERTS = [396, 396, ...Array<number>(38).fill(364)].map(
  (mib) => mib * MIB,
);

describe('expertBytesByLayer', () => {
  it('adds up the expert weights llama.cpp moves per layer', () => {
    const layers = expertBytesByLayer(
      new Map([
        ['blk.0.ffn_gate_exps.weight', 100],
        ['blk.0.ffn_up_exps.weight', 100],
        ['blk.0.ffn_down_exps.weight', 100],
        ['blk.0.attn_q.weight', 50],
        ['blk.0.ffn_gate_shexp.weight', 10],
        ['blk.2.ffn_gate_up_exps.weight', 200],
        ['blk.3.ffn_down_chexps.weight', 5],
      ]),
    );
    expect(layers).toEqual([300, 0, 200, 5]);
  });

  it('is empty for a dense model', () => {
    expect(expertBytesByLayer(new Map([['blk.0.ffn_up.weight', 100]]))).toEqual(
      [],
    );
  });
});

describe('fitModel', () => {
  const unread = () => {
    throw new Error('the layers were read');
  };

  it('keeps a model that fits on the GPU, without reading its layers', () => {
    expect(
      fitModel(
        model,
        16 * GIB - GPU_HEADROOM_BYTES,
        unread,
        16 * GIB,
        24 * GIB,
      ),
    ).toEqual({ cpuMoeLayers: 0 });
    expect(fitModel(model, 100 * GIB, unread, undefined, 24 * GIB)).toEqual({
      cpuMoeLayers: 0,
    });
  });

  it('moves the experts of as few first layers as needed to system memory', () => {
    // 3 layers leave about 0.9 GB of the GPU free at a 32K context; 2 leave
    // 0.5 GB, where it runs at half speed.
    expect(
      fitModel(model, Q3_K_M_BYTES, () => Q3_K_M_EXPERTS, 16 * GIB, 24 * GIB),
    ).toEqual({ cpuMoeLayers: 3 });
    expect(
      fitModel(
        model,
        16 * GIB + GPU_HEADROOM_BYTES,
        () => [0, GIB, 2 * GIB],
        16 * GIB,
        24 * GIB,
      ),
    ).toEqual({ cpuMoeLayers: 3 });
  });

  it('cannot run a dense model, or experts that do not free enough, past the GPU limit', () => {
    const problem =
      'Big (Q4_K_M) is 18.3 GB, but macOS lets the GPU use only about 17.2 GB on this Mac, and the model also needs room for its context. Pick a smaller quantization of the model.';
    expect(fitModel(model, 17 * GIB, () => [], 16 * GIB, 24 * GIB)).toEqual({
      problem,
    });
    expect(
      fitModel(model, 17 * GIB, () => [GIB / 4], 16 * GIB, 24 * GIB),
    ).toEqual({ problem });
  });

  it("cannot run a model that leaves too little of the Mac's memory, without reading its layers", () => {
    expect(fitModel(model, 21_166_758_496, unread, 16 * GIB, 24 * GIB)).toEqual(
      {
        problem:
          'Big (Q4_K_M) is 21.2 GB, more than a 24 GB Mac can hold beside macOS and other apps. Pick a smaller quantization of the model.',
      },
    );
  });
});

describe('downloadSizeProblem', () => {
  it('refuses only a file too big for the memory of the Mac', () => {
    expect(
      downloadSizeProblem(model, 19 * GIB, 16 * GIB, 24 * GIB),
    ).toBeUndefined();
    expect(
      downloadSizeProblem(model, 100 * GIB, undefined, 24 * GIB),
    ).toBeUndefined();
    expect(downloadSizeProblem(model, 20 * GIB, 16 * GIB, 24 * GIB)).toMatch(
      /^Big \(Q4_K_M\) is 21\.5 GB, more than a 24 GB Mac can hold/,
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
