/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import http from 'node:http';
import { SIDE_QUERY_SLOT } from './engine.js';
import type { LocalModelLease } from './local-model-server.js';

/** Speeds the engine reports for one request (llama-server `timings`). */
export interface BenchResult {
  promptTokens: number;
  promptPerSecond: number;
  generatedTokens: number;
  generatedPerSecond: number;
}

/** Tokens the benchmark generates. */
export const BENCH_GENERATED_TOKENS = 128;

/**
 * A fixed prompt of about 4K tokens of code, so runs compare across machines
 * and builds: the same text every time.
 */
export function benchPrompt(functions = 48): string {
  const parts: string[] = [];
  for (let i = 0; i < functions; i++) {
    parts.push(
      [
        `export function step${i}(values: number[], limit = ${i + 3}): number[] {`,
        `  const kept = values.filter((value) => value % ${(i % 7) + 2} !== 0);`,
        `  const scaled = kept.map((value, index) => value * ${i + 1} + index);`,
        `  // Keep at most ${i + 3} values, largest first.`,
        `  return scaled.sort((a, b) => b - a).slice(0, limit);`,
        '}',
      ].join('\n'),
    );
  }
  return (
    'Here is a TypeScript module:\n\n' +
    parts.join('\n\n') +
    '\n\nDescribe in one paragraph what these functions have in common.'
  );
}

interface Timings {
  prompt_n?: number;
  prompt_per_second?: number;
  predicted_n?: number;
  predicted_per_second?: number;
}

/** Parse llama-server's `timings` out of a completion response. */
export function benchResult(response: unknown): BenchResult {
  const timings = (response as { timings?: Timings } | undefined)?.timings;
  if (
    !timings ||
    typeof timings.prompt_per_second !== 'number' ||
    typeof timings.predicted_per_second !== 'number'
  ) {
    throw new Error(
      'The engine did not report timings; /models bench needs llama-server.',
    );
  }
  return {
    promptTokens: timings.prompt_n ?? 0,
    promptPerSecond: timings.prompt_per_second,
    generatedTokens: timings.predicted_n ?? 0,
    generatedPerSecond: timings.predicted_per_second,
  };
}

/**
 * Run the benchmark on a leased engine: the prompt is read without the
 * prompt cache, and generation runs at temperature 0. With a prompt cache it
 * runs in the side-query slot, so the conversation's cache stays.
 */
export function runBench(
  lease: LocalModelLease,
  timeoutMs = 10 * 60_000,
): Promise<BenchResult> {
  const body = JSON.stringify({
    messages: [{ role: 'user', content: benchPrompt() }],
    max_tokens: BENCH_GENERATED_TOKENS,
    temperature: 0,
    cache_prompt: false,
    // Generate the whole budget, so every run measures the same work.
    ignore_eos: true,
    ...(lease.pinSlots ? { id_slot: SIDE_QUERY_SLOT } : {}),
  });
  const url = new URL(lease.baseUrl);
  const target: http.RequestOptions = lease.socketPath
    ? { socketPath: lease.socketPath }
    : { host: url.hostname, port: Number(url.port) };
  return new Promise((resolve, reject) => {
    const request = http.request(
      {
        ...target,
        path: `${url.pathname.replace(/\/$/, '')}/chat/completions`,
        method: 'POST',
        timeout: timeoutMs,
        headers: {
          authorization: `Bearer ${lease.apiKey}`,
          'content-type': 'application/json',
          'content-length': Buffer.byteLength(body),
        },
      },
      (response) => {
        let text = '';
        response.on('data', (chunk) => (text += chunk));
        response.on('end', () => {
          if (response.statusCode !== 200) {
            reject(
              new Error(
                `The engine answered HTTP ${response.statusCode}: ${text.slice(0, 300)}`,
              ),
            );
            return;
          }
          try {
            resolve(benchResult(JSON.parse(text)));
          } catch (error) {
            reject(error);
          }
        });
      },
    );
    request.on('timeout', () => request.destroy(new Error('timed out')));
    request.on('error', reject);
    request.end(body);
  });
}
