/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { once } from 'node:events';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { describe, it, expect, afterEach, vi } from 'vitest';
import { FetchError, fetchWithPolicy } from './fetch.js';

describe('fetchWithPolicy', () => {
  const realFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  const opts = { timeoutMs: 5000, maxBytes: 1000 };

  function stubFetch(
    handler: (url: string, init?: RequestInit) => Response | Promise<Response>,
  ): void {
    globalThis.fetch = vi.fn(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = typeof input === 'string' ? input : input.toString();
        const signal = init?.signal;
        if (signal?.aborted) throw signal.reason ?? new Error('aborted');
        return handler(url, init);
      },
    ) as typeof fetch;
  }

  it('returns the response body and status without following redirects', async () => {
    stubFetch(
      () =>
        new Response('hello', {
          status: 200,
          headers: { 'content-type': 'text/plain' },
        }),
    );
    const result = await fetchWithPolicy('https://example.com/x', opts);
    expect(result.status).toBe(200);
    expect(result.contentType).toBe('text/plain');
    expect(result.body.toString()).toBe('hello');
    expect(globalThis.fetch).toHaveBeenCalledWith(
      'https://example.com/x',
      expect.objectContaining({ redirect: 'error' }),
    );
  });

  it('rejects oversized responses via Content-Length before reading', async () => {
    stubFetch(
      () =>
        new Response('irrelevant', {
          status: 200,
          headers: { 'content-length': '999999' },
        }),
    );
    await expect(
      fetchWithPolicy('https://example.com/big', opts),
    ).rejects.toThrow(/Response too large/);
  });

  it('rejects oversized responses while streaming when no Content-Length', async () => {
    const chunk = new Uint8Array(600).fill(120);
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(chunk);
        controller.enqueue(chunk); // 1200 > maxBytes 1000
        controller.close();
      },
    });
    stubFetch(() => new Response(body, { status: 200 }));
    await expect(
      fetchWithPolicy('https://example.com/big-stream', opts),
    ).rejects.toThrow(/exceeded the 1000-byte limit while streaming/);
  });

  it('propagates caller aborts', async () => {
    const controller = new AbortController();
    controller.abort(new Error('user cancelled'));
    stubFetch(() => new Response('never', { status: 200 }));
    await expect(
      fetchWithPolicy('https://example.com/x', {
        ...opts,
        signal: controller.signal,
      }),
    ).rejects.toThrow('user cancelled');
  });

  it('returns a non-2xx status without buffering its body', async () => {
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      // No data and never closes: a body that would stall a reader until the
      // timeout. The non-2xx path must cancel it, not read it.
      pull() {},
      cancel() {
        cancelled = true;
      },
    });
    stubFetch(
      () =>
        new Response(body, {
          status: 500,
          statusText: 'Internal Server Error',
        }),
    );
    const result = await fetchWithPolicy('https://example.com/boom', opts);
    expect(result.status).toBe(500);
    expect(result.statusText).toBe('Internal Server Error');
    expect(result.body.length).toBe(0);
    expect(cancelled).toBe(true);
  });

  it('reports the status of an oversized error page, not a size error', async () => {
    // A 404 whose body exceeds maxBytes must surface as 404, not EMSGSIZE:
    // the status is what the caller acts on, and the body is discarded.
    stubFetch(
      () =>
        new Response('x'.repeat(5000), {
          status: 404,
          statusText: 'Not Found',
          headers: { 'content-length': '5000' },
        }),
    );
    const result = await fetchWithPolicy('https://example.com/missing', opts);
    expect(result.status).toBe(404);
    expect(result.body.length).toBe(0);
  });
});

describe('fetchWithPolicy retry', () => {
  const realFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  const opts = { timeoutMs: 10_000, maxBytes: 1000 };

  it('retries once on 403 and returns the successful second response', async () => {
    let calls = 0;
    globalThis.fetch = vi.fn(async () => {
      calls++;
      return calls === 1
        ? new Response('blocked', { status: 403 })
        : new Response('recovered', { status: 200 });
    }) as typeof fetch;

    const result = await fetchWithPolicy('https://example.com/flaky', opts);
    expect(calls).toBe(2);
    expect(result.status).toBe(200);
    expect(result.body.toString()).toBe('recovered');
  });

  it('retries once on 429 and returns the successful second response', async () => {
    let calls = 0;
    globalThis.fetch = vi.fn(async () => {
      calls++;
      return calls === 1
        ? new Response('rate limited', { status: 429 })
        : new Response('recovered', { status: 200 });
    }) as typeof fetch;

    const result = await fetchWithPolicy('https://example.com/limited', opts);
    expect(calls).toBe(2);
    expect(result.status).toBe(200);
    expect(result.body.toString()).toBe('recovered');
  });

  it('returns the original 403 when the retry also fails', async () => {
    let calls = 0;
    globalThis.fetch = vi.fn(async () => {
      calls++;
      return new Response('blocked', { status: 403 });
    }) as typeof fetch;

    const result = await fetchWithPolicy('https://example.com/blocked', opts);
    expect(calls).toBe(2);
    expect(result.status).toBe(403);
  });

  it.each(['ECONNRESET', 'EAI_AGAIN'])(
    'retries once on transient network errors (%s)',
    async (code) => {
      let calls = 0;
      globalThis.fetch = vi.fn(async () => {
        calls++;
        if (calls === 1) {
          const err = new TypeError('fetch failed') as TypeError & {
            cause?: unknown;
          };
          err.cause = Object.assign(new Error('transient failure'), { code });
          throw err;
        }
        return new Response('ok', { status: 200 });
      }) as typeof fetch;

      const result = await fetchWithPolicy('https://example.com/reset', opts);
      expect(calls).toBe(2);
      expect(result.status).toBe(200);
    },
  );

  it('does not retry deterministic statuses like 404', async () => {
    let calls = 0;
    globalThis.fetch = vi.fn(async () => {
      calls++;
      return new Response('nope', { status: 404 });
    }) as typeof fetch;

    const result = await fetchWithPolicy('https://example.com/missing', opts);
    expect(calls).toBe(1);
    expect(result.status).toBe(404);
  });

  it('does not retry non-transient network errors', async () => {
    let calls = 0;
    globalThis.fetch = vi.fn(async () => {
      calls++;
      const err = new TypeError('fetch failed') as TypeError & {
        cause?: unknown;
      };
      err.cause = Object.assign(new Error('cert invalid'), {
        code: 'CERT_HAS_EXPIRED',
      });
      throw err;
    }) as typeof fetch;

    await expect(
      fetchWithPolicy('https://example.com/tls', opts),
    ).rejects.toThrow('fetch failed');
    expect(calls).toBe(1);
  });
});

describe('fetchWithPolicy retry abort handling', () => {
  const realFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  const opts = { timeoutMs: 10_000, maxBytes: 1000 };

  it('retries once on undici socket errors (UND_ERR_SOCKET)', async () => {
    let calls = 0;
    globalThis.fetch = vi.fn(async () => {
      calls++;
      if (calls === 1) {
        const err = new TypeError('fetch failed') as TypeError & {
          cause?: unknown;
        };
        err.cause = Object.assign(new Error('other side closed'), {
          code: 'UND_ERR_SOCKET',
        });
        throw err;
      }
      return new Response('ok', { status: 200 });
    }) as typeof fetch;

    const result = await fetchWithPolicy('https://example.com/reset', opts);
    expect(calls).toBe(2);
    expect(result.status).toBe(200);
  });

  it('propagates caller abort over the original 403 during the retry window', async () => {
    const controller = new AbortController();
    let calls = 0;
    globalThis.fetch = vi.fn(async () => {
      calls++;
      return new Response('blocked', { status: 403 });
    }) as typeof fetch;
    setTimeout(() => controller.abort(new Error('user cancelled')), 100);

    await expect(
      fetchWithPolicy('https://example.com/blocked', {
        ...opts,
        signal: controller.signal,
      }),
    ).rejects.toThrow('user cancelled');
    expect(calls).toBe(1);
  });

  it('propagates timeout over the original 403 during the retry window', async () => {
    globalThis.fetch = vi.fn(
      async () => new Response('blocked', { status: 403 }),
    ) as typeof fetch;

    // 200ms budget expires inside the 500ms retry delay.
    await expect(
      fetchWithPolicy('https://example.com/blocked', {
        ...opts,
        timeoutMs: 200,
      }),
    ).rejects.toThrow(/timed out after 200ms/);
  });
});

describe('fetchWithPolicy against a loopback server', () => {
  let server: Server | undefined;

  afterEach(async () => {
    if (server) {
      const closed = once(server, 'close');
      server.closeAllConnections();
      server.close();
      await closed;
      server = undefined;
    }
  });

  it.each([301, 302])(
    'rejects a %i redirect without requesting the Location target',
    async (status) => {
      const requested: string[] = [];
      server = createServer((request, response) => {
        requested.push(request.url ?? '');
        if (request.url === '/start') {
          response.writeHead(status, { Location: '/target' }).end();
          return;
        }
        response.end('target');
      });
      server.listen(0, '127.0.0.1');
      await once(server, 'listening');
      const { port } = server.address() as AddressInfo;

      const error = await fetchWithPolicy(`http://127.0.0.1:${port}/start`, {
        timeoutMs: 5000,
        maxBytes: 1000,
      }).catch((caught: unknown) => caught);

      expect(error).toBeInstanceOf(FetchError);
      expect(requested).toEqual(['/start']);
    },
  );
});
