/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { statSync } from 'node:fs';
import os from 'node:os';
import { ggufTensorBytes } from './gguf.js';
import { getHardwareProfile, type HardwareProfile } from './hardware.js';
import { huggingFaceHubCacheDir, resolveLocalModelFiles } from './hf-cache.js';
import type { LocalModelConfig } from './local-models.js';

const GIB = 1024 ** 3;

/** Room a model needs beside its weights: context cache and compute buffers. */
export const GPU_HEADROOM_BYTES = GIB;

/** The GPU memory a model may use on this machine. */
export interface GpuBudget {
  /** Bytes the GPU (or all discrete GPUs together) may hold. */
  limit: number;
  /**
   * The GPU shares system memory (Apple silicon, integrated graphics), so the
   * whole model also has to fit in RAM.
   */
  unified: boolean;
}

/**
 * The GPU memory llama.cpp can use: every discrete GPU together (it splits
 * the layers between them), else the integrated GPU's carve-out plus the
 * system memory it may share. Undefined without a GPU: the model runs on the
 * CPU, from RAM.
 */
export function gpuBudget(
  profile: HardwareProfile = getHardwareProfile(),
): GpuBudget | undefined {
  const discrete = profile.gpus.filter((gpu) => !gpu.integrated);
  if (discrete.length > 0) {
    return {
      limit: discrete.reduce((sum, gpu) => sum + gpu.dedicatedBytes, 0),
      unified: false,
    };
  }
  const integrated = profile.gpus
    .map((gpu) => gpu.dedicatedBytes + gpu.sharedBytes)
    .filter((bytes) => bytes > 0);
  if (integrated.length === 0) return undefined;
  return { limit: Math.max(...integrated), unified: true };
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
 * Memory left to the system and other apps by a model that runs partly from
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
 * How a model runs. `cpuMoeLayers` is how many of its first layers keep their
 * experts in system memory (`--n-cpu-moe`); `partial` says part of the model
 * runs on the CPU, which makes it slower. `problem` says why it cannot run on
 * this machine.
 */
export type ModelFit =
  | { cpuMoeLayers: number; partial?: boolean }
  | { problem: string };

function ramProblem(
  model: LocalModelConfig,
  bytes: number,
  totalMemory: number,
  platform: NodeJS.Platform,
): string {
  const name = model.name ?? model.id;
  const ram = Math.round(totalMemory / GIB);
  return (
    (platform === 'darwin'
      ? `${name} is ${gb(bytes)}, more than a ${ram} GB Mac can hold beside macOS and other apps.`
      : `${name} is ${gb(bytes)}, more than this computer's ${ram} GB of memory can hold beside the system and other apps.`) +
    ' Pick a smaller quantization of the model.'
  );
}

function gpuLimitProblem(
  model: LocalModelConfig,
  bytes: number,
  limit: number,
  platform: NodeJS.Platform,
): string {
  const name = model.name ?? model.id;
  return (
    (platform === 'darwin'
      ? `${name} is ${gb(bytes)}, but macOS lets the GPU use only about ${gb(limit)} on this Mac,`
      : `${name} is ${gb(bytes)}, but the GPU can use only about ${gb(limit)} of memory,`) +
    ' and the model also needs room for its context. Pick a smaller quantization of the model.'
  );
}

/**
 * Fit a model of `bytes` (with its draft) on this machine.
 *
 * - Without a GPU it runs from RAM.
 * - On a GPU that shares system memory, the whole model must fit in RAM and
 *   in the GPU's limit; a mixture-of-experts model past the limit keeps the
 *   experts of as few first layers as needed in system memory, where the CPU
 *   runs them. A dense model past the limit cannot run.
 * - On discrete GPUs, what does not fit in VRAM runs from RAM (llama.cpp's
 *   `--fit` places it); only a model too big for VRAM and RAM together cannot
 *   run.
 *
 * @param expertBytes the model's expert bytes per layer; only read when the
 *   model does not fit the GPU.
 */
export function fitModel(
  model: LocalModelConfig,
  bytes: number,
  expertBytes: () => readonly number[],
  gpu: GpuBudget | undefined,
  totalMemory: number,
  platform: NodeJS.Platform = process.platform,
): ModelFit {
  if (gpu === undefined) {
    return bytes + GPU_HEADROOM_BYTES + SYSTEM_RESERVE_BYTES > totalMemory
      ? { problem: ramProblem(model, bytes, totalMemory, platform) }
      : { cpuMoeLayers: 0, partial: true };
  }
  if (bytes + GPU_HEADROOM_BYTES <= gpu.limit) {
    return { cpuMoeLayers: 0 };
  }
  const ram = gpu.unified ? totalMemory : gpu.limit + totalMemory;
  if (bytes + GPU_HEADROOM_BYTES + SYSTEM_RESERVE_BYTES > ram) {
    return { problem: ramProblem(model, bytes, ram, platform) };
  }
  let onGpu = bytes;
  const layers = expertBytes();
  for (let count = 1; count <= layers.length; count++) {
    onGpu -= layers[count - 1];
    if (onGpu + GPU_HEADROOM_BYTES + CPU_LAYERS_MARGIN_BYTES <= gpu.limit) {
      return { cpuMoeLayers: count, partial: true };
    }
  }
  return gpu.unified
    ? { problem: gpuLimitProblem(model, bytes, gpu.limit, platform) }
    : { cpuMoeLayers: layers.length, partial: true };
}

/**
 * Why a model file of `bytes` should not be downloaded, before its layers
 * are known: only a file too big for this machine's memory is refused.
 */
export function downloadSizeProblem(
  model: LocalModelConfig,
  bytes: number,
  gpu: GpuBudget | undefined,
  totalMemory: number,
  platform: NodeJS.Platform = process.platform,
): string | undefined {
  if (gpu !== undefined && bytes + GPU_HEADROOM_BYTES <= gpu.limit) {
    return undefined;
  }
  const ram =
    gpu === undefined || gpu.unified ? totalMemory : gpu.limit + totalMemory;
  return bytes + GPU_HEADROOM_BYTES + SYSTEM_RESERVE_BYTES > ram
    ? ramProblem(model, bytes, ram, platform)
    : undefined;
}
