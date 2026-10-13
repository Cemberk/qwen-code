/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { ModelConfig, ModelProvidersConfig } from '../models/types.js';

/** A GGUF model qwen runs itself with llama-server, from the Hugging Face cache (`localModels`). */
export interface LocalModelConfig {
  /** The name `/model`, `model.name` and `--model` use. */
  id: string;
  /** Display name; defaults to `id`. */
  name?: string;
  /** Hugging Face repository, `owner/name`. */
  repo: string;
  /** The `.gguf` file in the repository; the first part of a split file. */
  file: string;
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

/** The default `localModels`. */
export const BUILT_IN_LOCAL_MODELS: readonly LocalModelConfig[] = [
  {
    id: 'qwen3-8b',
    name: 'Qwen3 8B (Q4_K_M)',
    repo: 'Qwen/Qwen3-8B-GGUF',
    file: 'Qwen3-8B-Q4_K_M.gguf',
  },
  {
    id: 'qwen3-4b',
    name: 'Qwen3 4B (Q4_K_M)',
    repo: 'Qwen/Qwen3-4B-GGUF',
    file: 'Qwen3-4B-Q4_K_M.gguf',
  },
  {
    id: 'qwen3-14b',
    name: 'Qwen3 14B (Q4_K_M)',
    repo: 'Qwen/Qwen3-14B-GGUF',
    file: 'Qwen3-14B-Q4_K_M.gguf',
  },
  {
    id: 'qwen3-coder-30b-a3b',
    name: 'Qwen3 Coder 30B A3B (Q4_K_M, ~19 GB)',
    repo: 'unsloth/Qwen3-Coder-30B-A3B-Instruct-GGUF',
    file: 'Qwen3-Coder-30B-A3B-Instruct-Q4_K_M.gguf',
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
    if (
      typeof model['repo'] !== 'string' ||
      !REPO_PATTERN.test(model['repo'])
    ) {
      throw new Error(
        `${at}.repo must be a Hugging Face repository such as "Qwen/Qwen3-8B-GGUF".`,
      );
    }
    const file = model['file'];
    if (
      typeof file !== 'string' ||
      !file.endsWith('.gguf') ||
      file.startsWith('/') ||
      file.includes('\\') ||
      file.split('/').some((part) => part === '' || part === '..')
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
    description: `${model.repo}/${model.file}`,
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
