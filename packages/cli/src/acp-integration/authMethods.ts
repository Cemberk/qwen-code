/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { AuthType } from '@qwen-code/qwen-code-core';
import type { AuthMethod } from '@agentclientprotocol/sdk';

export function buildAuthMethods(): AuthMethod[] {
  return [
    {
      id: AuthType.USE_OPENAI,
      name: 'Local OpenAI-compatible server',
      description:
        'Requires `OPENAI_BASE_URL` (host 127.0.0.1, ::1 or localhost), `OPENAI_API_KEY` and `OPENAI_MODEL`, or a configured modelProviders entry',
      _meta: {
        type: 'terminal',
        args: ['--auth-type=openai'],
      },
    },
  ];
}

export function pickAuthMethodsForAuthRequired(
  selectedType?: AuthType | string,
): AuthMethod[] {
  const authMethods = buildAuthMethods();
  if (selectedType) {
    const matched = authMethods.filter((method) => method.id === selectedType);
    return matched.length ? matched : authMethods;
  }

  return authMethods;
}
