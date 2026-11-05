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
  downloadSizeProblem,
  expertBytesByLayer,
  fitModel,
  gpuBudget,
  localModelBytes,
  type GpuBudget,
} from './gpu-memory.js';
import type { GpuDevice, HardwareProfile } from './hardware.js';
import type { LocalModelConfig } from './local-models.js';

const GIB = 1024 ** 3;

/** An Apple silicon GPU limit, which shares system memory. */
const mac = (limit: number): GpuBudget => ({ limit, unified: true });
const discrete = (limit: number): GpuBudget => ({ limit, unified: false });

function profile(gpus: GpuDevice[]): HardwareProfile {
  return {
    platform: 'linux',
    arch: 'x64',
    totalMemory: 32 * GIB,
    logicalCores: 16,
    gpus,
  };
}

describe('gpuBudget', () => {
  const radeon780m: GpuDevice = {
    name: 'AMD Radeon(TM) 780M',
    vendor: 'amd',
    dedicatedBytes: GIB,
    integrated: true,
    sharedBytes: 16 * GIB,
  };
  const rtx4090: GpuDevice = {
    name: 'NVIDIA GeForce RTX 4090',
    vendor: 'nvidia',
    dedicatedBytes: 24 * GIB,
    integrated: false,
    sharedBytes: 0,
  };

  it('adds up the discrete GPUs and ignores integrated graphics beside them', () => {
    expect(gpuBudget(profile([radeon780m, rtx4090, rtx4090]))).toEqual(
      discrete(48 * GIB),
    );
  });

  it('counts the carve-out and shared memory of an integrated GPU', () => {
    expect(gpuBudget(profile([radeon780m]))).toEqual({
      limit: 17 * GIB,
      unified: true,
    });
  });

  it('is undefined without a GPU', () => {
    expect(gpuBudget(profile([]))).toBeUndefined();
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
        mac(16 * GIB),
        24 * GIB,
        'darwin',
      ),
    ).toEqual({ cpuMoeLayers: 0 });
  });

  it('runs a model on the CPU without a GPU, if it fits in RAM', () => {
    expect(fitModel(model, 10 * GIB, unread, undefined, 24 * GIB)).toEqual({
      cpuMoeLayers: 0,
      partial: true,
    });
    expect(
      fitModel(model, 21 * GIB, unread, undefined, 24 * GIB, 'linux'),
    ).toEqual({
      problem:
        "Big (Q4_K_M) is 22.5 GB, more than this computer's 24 GB of memory can hold beside the system and other apps. Pick a smaller quantization of the model.",
    });
  });

  it('moves the experts of as few first layers as needed to system memory', () => {
    // 3 layers leave about 0.9 GB of the GPU free at a 32K context; 2 leave
    // 0.5 GB, where it runs at half speed.
    expect(
      fitModel(
        model,
        Q3_K_M_BYTES,
        () => Q3_K_M_EXPERTS,
        mac(16 * GIB),
        24 * GIB,
        'darwin',
      ),
    ).toEqual({ cpuMoeLayers: 3, partial: true });
    expect(
      fitModel(
        model,
        16 * GIB + GPU_HEADROOM_BYTES,
        () => [0, GIB, 2 * GIB],
        mac(16 * GIB),
        24 * GIB,
        'darwin',
      ),
    ).toEqual({ cpuMoeLayers: 3, partial: true });
  });

  it('cannot run a dense model, or experts that do not free enough, past the GPU limit', () => {
    const problem =
      'Big (Q4_K_M) is 18.3 GB, but macOS lets the GPU use only about 17.2 GB on this Mac, and the model also needs room for its context. Pick a smaller quantization of the model.';
    expect(
      fitModel(model, 17 * GIB, () => [], mac(16 * GIB), 24 * GIB, 'darwin'),
    ).toEqual({ problem });
    expect(
      fitModel(
        model,
        17 * GIB,
        () => [GIB / 4],
        mac(16 * GIB),
        24 * GIB,
        'darwin',
      ),
    ).toEqual({ problem });
  });

  it("cannot run a model that leaves too little of the Mac's memory, without reading its layers", () => {
    expect(
      fitModel(
        model,
        21_166_758_496,
        unread,
        mac(16 * GIB),
        24 * GIB,
        'darwin',
      ),
    ).toEqual({
      problem:
        'Big (Q4_K_M) is 21.2 GB, more than a 24 GB Mac can hold beside macOS and other apps. Pick a smaller quantization of the model.',
    });
  });

  it('names the GPU limit of integrated graphics off the Mac', () => {
    expect(
      fitModel(model, 17 * GIB, () => [], mac(16 * GIB), 32 * GIB, 'win32'),
    ).toEqual({
      problem:
        'Big (Q4_K_M) is 18.3 GB, but the GPU can use only about 17.2 GB of memory, and the model also needs room for its context. Pick a smaller quantization of the model.',
    });
  });

  it('runs what does not fit discrete GPUs from RAM', () => {
    expect(
      fitModel(model, 16 * GIB, unread, discrete(24 * GIB), 32 * GIB),
    ).toEqual({ cpuMoeLayers: 0 });
    // A dense model past VRAM still runs, partly on the CPU.
    expect(
      fitModel(model, 30 * GIB, () => [], discrete(16 * GIB), 32 * GIB),
    ).toEqual({ cpuMoeLayers: 0, partial: true });
    expect(
      fitModel(
        model,
        Q3_K_M_BYTES,
        () => Q3_K_M_EXPERTS,
        discrete(12 * GIB),
        32 * GIB,
      ),
    ).toMatchObject({ partial: true });
  });

  it('cannot run a model too big for VRAM and RAM together', () => {
    expect(
      fitModel(model, 50 * GIB, unread, discrete(16 * GIB), 32 * GIB, 'linux'),
    ).toEqual({
      problem:
        "Big (Q4_K_M) is 53.7 GB, more than this computer's 48 GB of memory can hold beside the system and other apps. Pick a smaller quantization of the model.",
    });
  });
});

describe('downloadSizeProblem', () => {
  it('refuses only a file too big for the memory of the Mac', () => {
    expect(
      downloadSizeProblem(model, 19 * GIB, mac(16 * GIB), 24 * GIB, 'darwin'),
    ).toBeUndefined();
    expect(
      downloadSizeProblem(model, 20 * GIB, mac(16 * GIB), 24 * GIB, 'darwin'),
    ).toMatch(/^Big \(Q4_K_M\) is 21\.5 GB, more than a 24 GB Mac can hold/);
  });

  it('counts VRAM and RAM together beside discrete GPUs', () => {
    expect(
      downloadSizeProblem(model, 40 * GIB, discrete(24 * GIB), 32 * GIB),
    ).toBeUndefined();
    expect(
      downloadSizeProblem(model, 60 * GIB, discrete(24 * GIB), 32 * GIB),
    ).toBeDefined();
  });

  it('checks RAM alone without a GPU', () => {
    expect(
      downloadSizeProblem(model, 100 * GIB, undefined, 24 * GIB),
    ).toBeDefined();
    expect(
      downloadSizeProblem(model, 10 * GIB, undefined, 24 * GIB),
    ).toBeUndefined();
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
