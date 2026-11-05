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
  counterRates,
  parseMetrics,
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
    let scrapes = 0;
    server = http.createServer((req, res) => {
      let text = '';
      req.on('data', (chunk) => (text += chunk));
      req.on('end', () => {
        if (req.url === '/metrics') {
          // 30 of 40 drafted tokens accepted, and 90 of 120 experts found
          // in the cache, between the two scrapes.
          const n = scrapes++;
          res.end(
            [
              '# TYPE llamacpp:spec_decode_num_draft_tokens_total counter',
              `llamacpp:spec_decode_num_draft_tokens_total ${100 + 40 * n}`,
              `llamacpp:spec_decode_num_accepted_tokens_total ${50 + 30 * n}`,
              `llamacpp:moe_cache_hits_total ${1000 + 90 * n}`,
              `llamacpp:moe_cache_misses_total ${500 + 30 * n}`,
            ].join('\n'),
          );
          return;
        }
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
    expect(result.draftAcceptance).toBe(0.75);
    expect(result.moeCacheHitRate).toBe(0.75);
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

describe('counterRates', () => {
  it('reports nothing an engine did not count', () => {
    expect(counterRates(new Map(), new Map())).toEqual({});
    // Counters that did not move: no drafts, no cached layers used.
    const same = new Map([
      ['spec_decode_num_draft_tokens_total', 10],
      ['spec_decode_num_accepted_tokens_total', 5],
      ['moe_cache_hits_total', 7],
      ['moe_cache_misses_total', 3],
    ]);
    expect(counterRates(same, same)).toEqual({});
  });

  it('reads Prometheus lines', () => {
    expect(
      parseMetrics(
        '# HELP llamacpp:n_decode_total x\nllamacpp:n_decode_total 12\nother 3\n',
      ),
    ).toEqual(new Map([['n_decode_total', 12]]));
  });
});
