/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import { AuthType } from '@qwen-code/qwen-code-core';
import {
  buildAuthMethods,
  pickAuthMethodsForAuthRequired,
} from './authMethods.js';

describe('ACP auth methods', () => {
  it('advertises only the local OpenAI-compatible server method', () => {
    expect(buildAuthMethods()).toEqual([
      expect.objectContaining({
        id: AuthType.USE_OPENAI,
        name: 'Local OpenAI-compatible server',
        _meta: { type: 'terminal', args: ['--auth-type=openai'] },
      }),
    ]);
  });

  it('selects only the OpenAI method for a stored openai selection', () => {
    const authMethods = pickAuthMethodsForAuthRequired('openai');

    expect(authMethods.map((method) => method.id)).toEqual([
      AuthType.USE_OPENAI,
    ]);
  });

  it.each(['qwen-oauth', 'openai-responses', 'not-a-real-auth-type'])(
    'falls back to the local method for an unsupported stored %s selection',
    (selectedType) => {
      expect(pickAuthMethodsForAuthRequired(selectedType)).toEqual(
        buildAuthMethods(),
      );
    },
  );
});
