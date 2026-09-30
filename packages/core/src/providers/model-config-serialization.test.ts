/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import { AuthType } from '../core/contentGenerator.js';
import type { ModelProvidersConfig } from '../models/types.js';
import { resolveEnvVarsInObject } from '../utils/envVarResolver.js';
import { getProviderModels } from './provider-config.js';
import { preserveModelProviderPlaceholders } from './model-config-serialization.js';

const first = {
  id: 'same',
  baseUrl: '${FIRST_URL}',
  envKey: 'FIRST_KEY',
  generationConfig: { customHeaders: { 'X-Key': '${FIRST_KEY}' } },
};
const second = {
  ...first,
  baseUrl: '${SECOND_URL}',
  envKey: 'SECOND_KEY',
  generationConfig: { customHeaders: { 'X-Key': '${SECOND_KEY}' } },
};
const env = {
  FIRST_URL: 'http://127.0.0.1:11434/v1',
  SECOND_URL: 'http://127.0.0.1:11434/v1',
  FIRST_KEY: 'test-only-first',
  SECOND_KEY: 'test-only-second',
};

function serialize(raw: ModelProvidersConfig) {
  const resolved = resolveEnvVarsInObject(raw, env);
  return preserveModelProviderPlaceholders(
    getProviderModels(resolved).slice(0, 1),
    AuthType.USE_OPENAI,
    resolved,
    raw,
  );
}

describe('preserveModelProviderPlaceholders', () => {
  it('restores the placeholders of the matching raw entry', () => {
    const raw = { openai: [first] };
    expect(serialize(raw)).toEqual([first]);
    expect(raw.openai).toEqual([first]);
  });

  it('rejects ambiguous placeholders for duplicate identities', () => {
    expect(() => serialize({ openai: [first, second] })).toThrow(
      'Cannot preserve placeholders in an ambiguous model configuration',
    );
  });

  it('accepts duplicate identities without placeholders', () => {
    const plain = {
      id: 'same',
      baseUrl: 'http://127.0.0.1:11434/v1',
      envKey: 'PLAIN_KEY',
    };
    expect(serialize({ openai: [plain, { ...plain }] })).toEqual([plain]);
  });

  it('leaves a model without a matching entry unchanged', () => {
    const raw = { openai: [first] };
    const other = { id: 'other', baseUrl: 'http://localhost:1234/v1' };
    expect(
      preserveModelProviderPlaceholders(
        [other],
        AuthType.USE_OPENAI,
        resolveEnvVarsInObject(raw, env),
        raw,
      ),
    ).toEqual([other]);
  });
});
