/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { existsSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { LocalModelConfig } from './local-models.js';

const SPLIT_GGUF_PATTERN = /^(.*)-(\d{5})-of-(\d{5})\.gguf$/;

function expandHome(value: string): string {
  return value === '~' || value.startsWith('~/')
    ? path.join(os.homedir(), value.slice(1))
    : value;
}

/** The Hugging Face hub cache, in the order `huggingface_hub` resolves it. */
export function huggingFaceHubCacheDir(
  env: NodeJS.ProcessEnv = process.env,
): string {
  const hubCache = env['HF_HUB_CACHE'] || env['HUGGINGFACE_HUB_CACHE'];
  if (hubCache) {
    return expandHome(hubCache);
  }
  const hfHome = env['HF_HOME']
    ? expandHome(env['HF_HOME'])
    : path.join(
        env['XDG_CACHE_HOME']
          ? expandHome(env['XDG_CACHE_HOME'])
          : path.join(os.homedir(), '.cache'),
        'huggingface',
      );
  return path.join(hfHome, 'hub');
}

/** The command that downloads `model` into the cache. The user runs it; qwen never downloads. */
export function huggingFaceDownloadCommand(model: LocalModelConfig): string {
  if (model.format === 'mlx') {
    return `hf download ${model.repo}`;
  }
  const split = SPLIT_GGUF_PATTERN.exec(model.file!);
  return split
    ? `hf download ${model.repo} --include "${split[1]}-*-of-${split[3]}.gguf"`
    : `hf download ${model.repo} ${model.file}`;
}

function weightFiles(snapshot: string): string[] {
  const index = path.join(snapshot, 'model.safetensors.index.json');
  if (!existsSync(index)) {
    return ['model.safetensors'];
  }
  const weightMap = (
    JSON.parse(readFileSync(index, 'utf8')) as {
      weight_map?: Record<string, string>;
    }
  ).weight_map;
  return [...new Set(Object.values(weightMap ?? {}))];
}

function ggufParts(file: string): string[] {
  const split = SPLIT_GGUF_PATTERN.exec(file);
  if (!split) {
    return [file];
  }
  const total = Number(split[3]);
  return Array.from(
    { length: total },
    (_, i) =>
      `${split[1]}-${String(i + 1).padStart(5, '0')}-of-${split[3]}.gguf`,
  );
}

/**
 * Locate a downloaded model: the GGUF file, or the MLX snapshot directory.
 * Reads only the local cache.
 *
 * @throws Error with the download command when the model is not (fully) in the cache.
 */
export function resolveLocalModelPath(
  model: LocalModelConfig,
  cacheDir: string = huggingFaceHubCacheDir(),
): string {
  const repoDir = path.join(
    cacheDir,
    `models--${model.repo.replace('/', '--')}`,
  );
  let snapshot: string | undefined;
  try {
    const commit = readFileSync(
      path.join(repoDir, 'refs', 'main'),
      'utf8',
    ).trim();
    if (/^[0-9a-f]{40}$/.test(commit)) {
      snapshot = path.join(repoDir, 'snapshots', commit);
    }
  } catch {
    // Not downloaded; reported below.
  }
  const required =
    model.format === 'gguf'
      ? ggufParts(model.file!)
      : snapshot && existsSync(path.join(snapshot, 'config.json'))
        ? weightFiles(snapshot)
        : ['config.json'];
  if (
    !snapshot ||
    !required.every((file) => existsSync(path.join(snapshot, file)))
  ) {
    throw new Error(
      `${model.name ?? model.id} is not downloaded (looked in ${cacheDir}). ` +
        `Download it with:\n  ${huggingFaceDownloadCommand(model)}\n` +
        'That command contacts huggingface.co; qwen itself never does.',
    );
  }
  return model.format === 'gguf' ? path.join(snapshot, model.file!) : snapshot;
}
