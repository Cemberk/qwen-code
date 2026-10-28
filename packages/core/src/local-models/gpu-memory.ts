/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { execFileSync } from 'node:child_process';
import { statSync } from 'node:fs';
import os from 'node:os';
import { ggufTensorBytes } from './gguf.js';
import { huggingFaceHubCacheDir, resolveLocalModelFiles } from './hf-cache.js';
import type { LocalModelConfig } from './local-models.js';

const GIB = 1024 ** 3;

/** Room a model needs beside its weights: context cache and compute buffers. */
export const GPU_HEADROOM_BYTES = GIB;

function readWiredLimitMb(): number {
  try {
    const value = execFileSync(
      '/usr/sbin/sysctl',
      ['-n', 'iogpu.wired_limit_mb'],
      {
        encoding: 'utf8',
        timeout: 2000,
      },
    );
    return Number(value.trim()) || 0;
  } catch {
    return 0;
  }
}

/**
 * Bytes of memory macOS lets the GPU use on Apple silicon:
 * `iogpu.wired_limit_mb` when it is set, otherwise macOS's default of two
 * thirds of RAM up to 36 GiB and three quarters above. Undefined on other
 * platforms, where llama.cpp keeps what does not fit in system memory.
 */
export function appleGpuMemoryLimit(
  platform: NodeJS.Platform = process.platform,
  arch: string = process.arch,
  totalMemory: number = os.totalmem(),
  wiredLimitMb: () => number = readWiredLimitMb,
): number | undefined {
  if (platform !== 'darwin' || arch !== 'arm64') return undefined;
  const set = wiredLimitMb();
  if (set > 0) return set * 1024 * 1024;
  return totalMemory <= 36 * GIB
    ? (totalMemory * 2) / 3
    : (totalMemory * 3) / 4;
}

/** Total bytes of a downloaded model's files. */
export function localModelBytes(
  model: LocalModelConfig,
  cacheDir: string = huggingFaceHubCacheDir(),
): number {
  return resolveLocalModelFiles(model, cacheDir).reduce(
    (total, file) => total + statSync(file).size,
    0,
  );
}

const gb = (bytes: number) => `${(bytes / 1e9).toFixed(1)} GB`;

/** Bytes of RAM in this machine. */
export function systemMemoryBytes(): number {
  return os.totalmem();
}

/**
 * Memory left to macOS and other apps by a model that runs partly from
 * system memory.
 */
export const SYSTEM_RESERVE_BYTES = 4 * GIB;

/**
 * Extra GPU memory left free when part of a model moves to system memory:
 * a model at the very edge of the limit runs at half speed.
 */
export const CPU_LAYERS_MARGIN_BYTES = GIB / 2;

/** llama.cpp's `--n-cpu-moe` pattern: the expert weights of layer N. */
const EXPERT_TENSOR = /^blk\.(\d+)\.ffn_(?:up|down|gate|gate_up)_(?:ch)?exps/;

/**
 * Bytes of the mixture-of-experts weights of each layer, indexed by layer;
 * 0 for dense layers, and empty for a dense model.
 */
export function expertBytesByLayer(
  tensors: ReadonlyMap<string, number>,
): number[] {
  const layers: number[] = [];
  for (const [name, bytes] of tensors) {
    const match = EXPERT_TENSOR.exec(name);
    if (!match) continue;
    const layer = Number(match[1]);
    while (layers.length <= layer) layers.push(0);
    layers[layer] += bytes;
  }
  return layers;
}

/**
 * Expert bytes per layer of a downloaded model, read from its GGUF header;
 * empty when the files cannot be read.
 */
export function localModelExpertBytes(
  model: LocalModelConfig,
  cacheDir: string = huggingFaceHubCacheDir(),
): number[] {
  try {
    return expertBytesByLayer(
      ggufTensorBytes(resolveLocalModelFiles(model, cacheDir)),
    );
  } catch {
    return [];
  }
}

/**
 * How a model runs: `cpuMoeLayers` is how many of its first layers keep their
 * experts in system memory (`--n-cpu-moe`), or `problem` says why it cannot
 * run on this Mac.
 */
export type ModelFit = { cpuMoeLayers: number } | { problem: string };

function memoryProblem(
  model: LocalModelConfig,
  bytes: number,
  totalMemory: number,
): string {
  return (
    `${model.name ?? model.id} is ${gb(bytes)}, more than a ` +
    `${Math.round(totalMemory / GIB)} GB Mac can hold beside macOS and other ` +
    'apps. Pick a smaller quantization of the model.'
  );
}

/**
 * Fit a model of `bytes` (with its draft) in `limit` bytes of GPU memory.
 * A mixture-of-experts model that does not fit keeps the experts of as few
 * of its first layers as needed in system memory, where the CPU runs them:
 * slower, but most of the model stays on the GPU. A dense model that does
 * not fit, or a model too big for the Mac's memory, cannot run.
 *
 * @param expertBytes the model's expert bytes per layer; only read when the
 *   model does not fit.
 */
export function fitModel(
  model: LocalModelConfig,
  bytes: number,
  expertBytes: () => readonly number[],
  limit: number | undefined,
  totalMemory: number,
): ModelFit {
  if (limit === undefined || bytes + GPU_HEADROOM_BYTES <= limit) {
    return { cpuMoeLayers: 0 };
  }
  if (bytes + GPU_HEADROOM_BYTES + SYSTEM_RESERVE_BYTES > totalMemory) {
    return { problem: memoryProblem(model, bytes, totalMemory) };
  }
  let onGpu = bytes;
  const layers = expertBytes();
  for (let count = 1; count <= layers.length; count++) {
    onGpu -= layers[count - 1];
    if (onGpu + GPU_HEADROOM_BYTES + CPU_LAYERS_MARGIN_BYTES <= limit) {
      return { cpuMoeLayers: count };
    }
  }
  return {
    problem:
      `${model.name ?? model.id} is ${gb(bytes)}, but macOS lets the GPU use only ` +
      `about ${gb(limit)} on this Mac, and the model also needs room for its ` +
      'context. Pick a smaller quantization of the model.',
  };
}

/**
 * Why a model file of `bytes` should not be downloaded, before its layers
 * are known: only a file too big for the Mac's memory is refused.
 */
export function downloadSizeProblem(
  model: LocalModelConfig,
  bytes: number,
  limit: number | undefined,
  totalMemory: number,
): string | undefined {
  if (limit === undefined || bytes + GPU_HEADROOM_BYTES <= limit) {
    return undefined;
  }
  return bytes + GPU_HEADROOM_BYTES + SYSTEM_RESERVE_BYTES > totalMemory
    ? memoryProblem(model, bytes, totalMemory)
    : undefined;
}
