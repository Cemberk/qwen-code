/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import {
  BENCH_GENERATED_TOKENS,
  benchPrompt,
  benchResult,
  runBench,
} from './bench.js';

describe('benchPrompt', () => {
  it('is the same text every time, about 4K tokens of code', () => {
    expect(benchPrompt()).toBe(benchPrompt());
    // About four characters per token.
    expect(benchPrompt().length).toBeGreaterThan(12_000);
    expect(benchPrompt().length).toBeLessThan(20_000);
  });
});

describe('benchResult', () => {
  it("reads llama-server's timings", () => {
    expect(
      benchResult({
        timings: {
          prompt_n: 4100,
          prompt_per_second: 812.5,
          predicted_n: 128,
          predicted_per_second: 31.2,
        },
      }),
    ).toEqual({
      promptTokens: 4100,
      promptPerSecond: 812.5,
      generatedTokens: 128,
      generatedPerSecond: 31.2,
    });
  });

  it('fails without timings', () => {
    expect(() => benchResult({ choices: [] })).toThrow(
      /did not report timings/,
    );
  });
});

describe('runBench', () => {
  let server: http.Server | undefined;
  afterEach(() => server?.close());

  it('sends the prompt without the cache, in the side-query slot, and reads the timings', async () => {
    let request: {
      url?: string;
      auth?: string;
      body?: Record<string, unknown>;
    } = {};
    server = http.createServer((req, res) => {
      let text = '';
      req.on('data', (chunk) => (text += chunk));
      req.on('end', () => {
        request = {
          url: req.url,
          auth: req.headers.authorization,
          body: JSON.parse(text),
        };
        res.end(
          JSON.stringify({
            timings: {
              prompt_n: 4000,
              prompt_per_second: 500,
              predicted_n: 128,
              predicted_per_second: 25,
            },
          }),
        );
      });
    });
    await new Promise<void>((resolve) =>
      server!.listen(0, '127.0.0.1', resolve),
    );
    const { port } = server.address() as AddressInfo;
    const result = await runBench({
      baseUrl: `http://127.0.0.1:${port}/v1`,
      apiKey: 'k',
      pinSlots: true,
      release: () => {},
    });
    expect(result.generatedPerSecond).toBe(25);
    expect(request.url).toBe('/v1/chat/completions');
    expect(request.auth).toBe('Bearer k');
    expect(request.body).toMatchObject({
      max_tokens: BENCH_GENERATED_TOKENS,
      temperature: 0,
      cache_prompt: false,
      ignore_eos: true,
      id_slot: 1,
    });
  });

  it('reports an engine error', async () => {
    server = http.createServer((_req, res) => {
      res.statusCode = 500;
      res.end('out of memory');
    });
    await new Promise<void>((resolve) =>
      server!.listen(0, '127.0.0.1', resolve),
    );
    const { port } = server.address() as AddressInfo;
    await expect(
      runBench({
        baseUrl: `http://127.0.0.1:${port}/v1`,
        apiKey: 'k',
        pinSlots: false,
        release: () => {},
      }),
    ).rejects.toThrow(/HTTP 500: out of memory/);
  });
});
