/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { once } from 'node:events';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import {
  buildRuntimeFetchOptions,
  preloadRuntimeFetchModule,
  resetDispatcherCache,
} from './runtimeFetchOptions.js';

describe('buildRuntimeFetchOptions against a loopback server', () => {
  let server: Server | undefined;

  beforeAll(async () => {
    await preloadRuntimeFetchModule();
  });

  afterEach(async () => {
    resetDispatcherCache();
    if (server) {
      const closed = once(server, 'close');
      server.closeAllConnections();
      server.close();
      await closed;
      server = undefined;
    }
  });

  it.each([301, 302, 307])(
    'rejects a %i redirect without requesting the Location target',
    async (status) => {
      const requested: string[] = [];
      server = createServer((request, response) => {
        requested.push(request.url ?? '');
        if (request.url === '/v1/chat/completions') {
          response.writeHead(status, { Location: '/elsewhere' }).end();
          return;
        }
        response.end('{}');
      });
      server.listen(0, '127.0.0.1');
      await once(server, 'listening');
      const { port } = server.address() as AddressInfo;
      const { fetch, fetchOptions } = buildRuntimeFetchOptions();

      try {
        await expect(
          fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
            ...fetchOptions,
            method: 'POST',
            body: '{}',
            redirect: 'follow',
          } as RequestInit),
        ).rejects.toThrow(TypeError);
        expect(requested).toEqual(['/v1/chat/completions']);
      } finally {
        await fetchOptions?.dispatcher?.close();
      }
    },
  );
});
