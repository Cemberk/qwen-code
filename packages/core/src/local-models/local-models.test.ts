/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import { validateModelProvidersConfig } from '../models/modelRegistry.js';
import {
  BUILT_IN_LOCAL_MODELS,
  LOCAL_MODEL_BASE_URL,
  LOCAL_MODEL_KEY_ENV,
  validateLocalModels,
  withLocalModelProviders,
} from './local-models.js';

const gguf = {
  id: 'q-gguf',
  repo: 'Qwen/Qwen3-8B-GGUF',
  file: 'Qwen3-8B-Q4_K_M.gguf',
};

describe('validateLocalModels', () => {
  it('accepts the built-in list', () => {
    expect(validateLocalModels([...BUILT_IN_LOCAL_MODELS])).toHaveLength(
      BUILT_IN_LOCAL_MODELS.length,
    );
  });

  it.each([
    ['a non-array', {}, /must be an array/],
    ['a missing id', [{ ...gguf, id: ' ' }], /\[0\]\.id/],
    ['a duplicate id', [gguf, gguf], /used by another entry/],
    ['a repo without an owner', [{ ...gguf, repo: 'Qwen3-8B' }], /\.repo/],
    ['a repo with a path', [{ ...gguf, repo: 'a/b/c' }], /\.repo/],
    ['a missing file', [{ ...gguf, file: undefined }], /\.file/],
    ['a file outside the repo', [{ ...gguf, file: '../x.gguf' }], /\.file/],
    ['an absolute file', [{ ...gguf, file: '/x.gguf' }], /\.file/],
    ['a non-gguf file', [{ ...gguf, file: 'x.bin' }], /\.file/],
    [
      'a fractional context size',
      [{ ...gguf, contextSize: 1.5 }],
      /contextSize/,
    ],
  ])('rejects %s', (_label, value, message) => {
    expect(() => validateLocalModels(value)).toThrow(message);
  });
});

describe('withLocalModelProviders', () => {
  it('lists local models first, with the placeholder URL and key variable', () => {
    const own = {
      id: 'mine',
      baseUrl: 'http://127.0.0.1:11434/v1',
      envKey: 'OLLAMA_API_KEY',
    };
    const providers = withLocalModelProviders({ openai: [own] }, [
      gguf,
      {
        id: 'q-14b',
        repo: 'Qwen/Qwen3-14B-GGUF',
        file: 'Qwen3-14B-Q4_K_M.gguf',
        contextSize: 8192,
      },
    ]);
    expect(providers?.['openai']).toEqual([
      {
        id: 'q-gguf',
        name: 'q-gguf',
        description: 'Qwen/Qwen3-8B-GGUF/Qwen3-8B-Q4_K_M.gguf',
        baseUrl: LOCAL_MODEL_BASE_URL,
        envKey: LOCAL_MODEL_KEY_ENV,
        generationConfig: { contextWindowSize: 32768 },
      },
      {
        id: 'q-14b',
        name: 'q-14b',
        description: 'Qwen/Qwen3-14B-GGUF/Qwen3-14B-Q4_K_M.gguf',
        baseUrl: LOCAL_MODEL_BASE_URL,
        envKey: LOCAL_MODEL_KEY_ENV,
        generationConfig: { contextWindowSize: 8192 },
      },
      own,
    ]);
    // The placeholder passes the loopback-only provider validation.
    expect(() => validateModelProvidersConfig(providers)).not.toThrow();
  });

  it('leaves the providers alone when there are no local models', () => {
    const own = { openai: [{ id: 'mine', baseUrl: 'http://127.0.0.1:1/v1' }] };
    expect(withLocalModelProviders(own, [])).toBe(own);
  });
});
