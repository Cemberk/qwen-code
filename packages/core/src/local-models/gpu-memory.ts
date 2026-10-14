/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { execFileSync } from 'node:child_process';
import { statSync } from 'node:fs';
import os from 'node:os';
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

/**
 * Why a model of `bytes` cannot run within `limit` bytes of GPU memory, or
 * undefined when its weights fit with room for a context (or there is no
 * known limit).
 */
export function modelSizeProblem(
  model: LocalModelConfig,
  bytes: number,
  limit: number | undefined,
): string | undefined {
  if (limit === undefined || bytes + GPU_HEADROOM_BYTES <= limit) {
    return undefined;
  }
  return (
    `${model.name ?? model.id} is ${gb(bytes)}, but macOS lets the GPU use only ` +
    `about ${gb(limit)} on this Mac, and the model also needs room for its ` +
    'context. Pick a smaller quantization of the model.'
  );
}
