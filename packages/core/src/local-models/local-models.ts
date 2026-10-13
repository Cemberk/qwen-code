/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { ModelConfig, ModelProvidersConfig } from '../models/types.js';

/** `mlx` models run in `mlx_lm.server`; `gguf` models run in `llama-server`. */
export type LocalModelFormat = 'mlx' | 'gguf';

/** A model qwen runs itself, from the Hugging Face cache (`localModels`). */
export interface LocalModelConfig {
  /** The name `/model`, `model.name` and `--model` use. */
  id: string;
  /** Display name; defaults to `id`. */
  name?: string;
  format: LocalModelFormat;
  /** Hugging Face repository, `owner/name`. */
  repo: string;
  /** The `.gguf` file in the repository (GGUF only); the first part of a split file. */
  file?: string;
  /** Context window in tokens. */
  contextSize?: number;
}

export const DEFAULT_LOCAL_MODEL_CONTEXT_SIZE = 32768;

/**
 * Base URL of every local model's provider entry. Nothing listens on port 0;
 * the content generator sends requests to the running engine instead.
 */
export const LOCAL_MODEL_BASE_URL = 'http://127.0.0.1:0/v1';

/**
 * Names the API key of local model entries. It only holds a placeholder that
 * satisfies the "key configured" checks; the engine's real key never leaves
 * the engine manager.
 */
export const LOCAL_MODEL_KEY_ENV = 'QWEN_LOCAL_MODEL_KEY';
export const LOCAL_MODEL_KEY_PLACEHOLDER = 'local';

/** The default `localModels`: MLX first, since the fork mainly runs on Apple Silicon. */
export const BUILT_IN_LOCAL_MODELS: readonly LocalModelConfig[] = [
  {
    id: 'qwen3-8b-mlx',
    name: 'Qwen3 8B (MLX 4-bit)',
    format: 'mlx',
    repo: 'mlx-community/Qwen3-8B-4bit',
  },
  {
    id: 'qwen3-4b-mlx',
    name: 'Qwen3 4B (MLX 4-bit)',
    format: 'mlx',
    repo: 'mlx-community/Qwen3-4B-4bit',
  },
  {
    id: 'qwen3-14b-mlx',
    name: 'Qwen3 14B (MLX 4-bit)',
    format: 'mlx',
    repo: 'mlx-community/Qwen3-14B-4bit',
  },
  {
    id: 'qwen3-coder-30b-a3b-mlx',
    name: 'Qwen3 Coder 30B A3B (MLX 4-bit, needs 32 GB)',
    format: 'mlx',
    repo: 'mlx-community/Qwen3-Coder-30B-A3B-Instruct-4bit',
  },
  {
    id: 'qwen3-8b-gguf',
    name: 'Qwen3 8B (GGUF Q4_K_M)',
    format: 'gguf',
    repo: 'Qwen/Qwen3-8B-GGUF',
    file: 'Qwen3-8B-Q4_K_M.gguf',
  },
  {
    id: 'qwen3-4b-gguf',
    name: 'Qwen3 4B (GGUF Q4_K_M)',
    format: 'gguf',
    repo: 'Qwen/Qwen3-4B-GGUF',
    file: 'Qwen3-4B-Q4_K_M.gguf',
  },
  {
    id: 'qwen3-14b-gguf',
    name: 'Qwen3 14B (GGUF Q4_K_M)',
    format: 'gguf',
    repo: 'Qwen/Qwen3-14B-GGUF',
    file: 'Qwen3-14B-Q4_K_M.gguf',
  },
];

const REPO_PATTERN = /^[A-Za-z0-9][\w.-]*\/[A-Za-z0-9][\w.-]*$/;

/**
 * Validate a `localModels` value and return it typed.
 *
 * @throws Error naming the first invalid entry.
 */
export function validateLocalModels(value: unknown): LocalModelConfig[] {
  if (!Array.isArray(value)) {
    throw new Error('localModels must be an array of model entries.');
  }
  const ids = new Set<string>();
  value.forEach((entry, index) => {
    const at = `localModels[${index}]`;
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
      throw new Error(`${at} must be an object.`);
    }
    const model = entry as Record<string, unknown>;
    if (typeof model['id'] !== 'string' || !model['id'].trim()) {
      throw new Error(`${at}.id must be a non-empty string.`);
    }
    if (ids.has(model['id'])) {
      throw new Error(`${at}.id "${model['id']}" is used by another entry.`);
    }
    ids.add(model['id']);
    if (model['name'] !== undefined && typeof model['name'] !== 'string') {
      throw new Error(`${at}.name must be a string.`);
    }
    if (model['format'] !== 'mlx' && model['format'] !== 'gguf') {
      throw new Error(`${at}.format must be "mlx" or "gguf".`);
    }
    if (
      typeof model['repo'] !== 'string' ||
      !REPO_PATTERN.test(model['repo'])
    ) {
      throw new Error(
        `${at}.repo must be a Hugging Face repository such as "Qwen/Qwen3-8B-GGUF".`,
      );
    }
    const file = model['file'];
    if (model['format'] === 'mlx' && file !== undefined) {
      throw new Error(
        `${at}.file is only used by gguf models; an mlx model is the whole repository.`,
      );
    }
    if (
      model['format'] === 'gguf' &&
      (typeof file !== 'string' ||
        !file.endsWith('.gguf') ||
        file.startsWith('/') ||
        file.includes('\\') ||
        file.split('/').some((part) => part === '' || part === '..'))
    ) {
      throw new Error(
        `${at}.file must be the path of a .gguf file inside the repository.`,
      );
    }
    const contextSize = model['contextSize'];
    if (
      contextSize !== undefined &&
      (!Number.isInteger(contextSize) || (contextSize as number) <= 0)
    ) {
      throw new Error(`${at}.contextSize must be a positive whole number.`);
    }
  });
  return value as LocalModelConfig[];
}

/**
 * Add a provider entry for each local model ahead of the configured
 * `modelProviders.openai` entries, so the first local model is the default.
 */
export function withLocalModelProviders(
  modelProviders: ModelProvidersConfig | undefined,
  localModels: readonly LocalModelConfig[],
): ModelProvidersConfig | undefined {
  if (localModels.length === 0) {
    return modelProviders;
  }
  const entries: ModelConfig[] = localModels.map((model) => ({
    id: model.id,
    name: model.name ?? model.id,
    description:
      model.format === 'mlx'
        ? `MLX · ${model.repo}`
        : `GGUF · ${model.repo}/${model.file}`,
    baseUrl: LOCAL_MODEL_BASE_URL,
    envKey: LOCAL_MODEL_KEY_ENV,
    generationConfig: {
      contextWindowSize: model.contextSize ?? DEFAULT_LOCAL_MODEL_CONTEXT_SIZE,
    },
  }));
  return {
    ...modelProviders,
    openai: [...entries, ...(modelProviders?.['openai'] ?? [])],
  };
}
