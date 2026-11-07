/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { readFileSync } from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { Storage } from '../config/storage.js';
import { SIDE_QUERY_SLOT } from './engine.js';
import type { LocalModelLease } from './local-model-server.js';

/** Speeds the engine reports for one request (llama-server `timings`). */
export interface BenchResult {
  promptTokens: number;
  promptPerSecond: number;
  generatedTokens: number;
  generatedPerSecond: number;
  /** Share of drafted tokens the model accepted (speculative decoding). */
  draftAcceptance?: number;
  /** Share of selected experts found in the MoE cache (--moe-cache-mib). */
  moeCacheHitRate?: number;
}

/** What `/models bench compare` advises about speculative decoding. */
export interface SpeculationAdvice {
  /** Generation speed with speculation on over off, averaged over workloads. */
  ratio: number;
  advice: 'on' | 'off' | 'either';
}

/**
 * Whether speculative decoding pays on this machine: the generation speeds
 * with it on and off, per workload, averaged as a geometric mean. Within 3%
 * either way it makes no clear difference.
 */
export function adviseSpeculation(
  on: ReadonlyMap<BenchWorkload, BenchResult>,
  off: ReadonlyMap<BenchWorkload, BenchResult>,
): SpeculationAdvice {
  const ratios: number[] = [];
  for (const [workload, withSpec] of on) {
    const without = off.get(workload);
    if (without && without.generatedPerSecond > 0) {
      ratios.push(withSpec.generatedPerSecond / without.generatedPerSecond);
    }
  }
  if (ratios.length === 0) return { ratio: 1, advice: 'either' };
  const ratio = Math.exp(
    ratios.reduce((sum, r) => sum + Math.log(r), 0) / ratios.length,
  );
  return {
    ratio,
    advice: ratio > 1.03 ? 'on' : ratio < 0.97 ? 'off' : 'either',
  };
}

/** Where /models bench appends its results, one JSON object per line. */
export function benchLogFile(): string {
  return path.join(Storage.getGlobalQwenDir(), 'local-model-bench.jsonl');
}

/** One line of the bench log. */
export interface BenchRecord extends BenchResult {
  date: string;
  model: string;
  hardware: string[];
  engine: string;
  speculation: boolean;
  workload?: BenchWorkload;
}

/** The bench log's records; none when it cannot be read. */
export function readBenchLog(file: string = benchLogFile()): BenchRecord[] {
  let text: string;
  try {
    text = readFileSync(file, 'utf8');
  } catch {
    return [];
  }
  const records: BenchRecord[] = [];
  for (const line of text.split('\n')) {
    try {
      const record = JSON.parse(line) as BenchRecord;
      if (typeof record.generatedPerSecond === 'number') records.push(record);
    } catch {
      // A partial or foreign line.
    }
  }
  return records;
}

/**
 * What the bench log says about speculative decoding for this model, engine
 * and machine: the newest run of each workload with it on and off, compared
 * as /models bench compare does. Undefined until both have been measured.
 */
export function speculationAdviceFromLog(
  records: readonly BenchRecord[],
  match: { model: string; engine: string; hardware: readonly string[] },
): SpeculationAdvice | undefined {
  const hardware = JSON.stringify(match.hardware);
  const newest = new Map<string, BenchRecord>();
  for (const record of records) {
    if (
      record.model !== match.model ||
      record.engine !== match.engine ||
      JSON.stringify(record.hardware) !== hardware
    ) {
      continue;
    }
    const key = `${record.speculation}\0${record.workload ?? 'prose'}`;
    const seen = newest.get(key);
    if (!seen || record.date > seen.date) newest.set(key, record);
  }
  const on = new Map<BenchWorkload, BenchResult>();
  const off = new Map<BenchWorkload, BenchResult>();
  for (const [key, record] of newest) {
    const [speculation, workload] = key.split('\0') as [string, BenchWorkload];
    (speculation === 'true' ? on : off).set(workload, record);
  }
  for (const workload of [...on.keys()]) {
    if (!off.has(workload)) on.delete(workload);
  }
  if (on.size === 0) return undefined;
  return adviseSpeculation(on, off);
}

/** Tokens the benchmark generates. */
export const BENCH_GENERATED_TOKENS = 128;

/**
 * A fixed prompt of about 4K tokens of code, so runs compare across machines
 * and builds: the same text every time.
 */
/**
 * What the benchmark has the model write: new text about the code (prose),
 * or the code again with one change (edit), as an agent's file edits do,
 * where drafting from the context pays most.
 */
export type BenchWorkload = 'prose' | 'edit';

export const BENCH_WORKLOADS: readonly BenchWorkload[] = ['prose', 'edit'];

export function benchPrompt(
  workload: BenchWorkload = 'prose',
  functions = 48,
): string {
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
    (workload === 'edit'
      ? '\n\nRewrite the module with every function renamed from stepN to stageN and nothing else changed. Reply with the code only.'
      : '\n\nDescribe in one paragraph what these functions have in common.')
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

/** One HTTP request to a leased engine; the status and the body. */
function engineRequest(
  lease: LocalModelLease,
  method: 'GET' | 'POST',
  urlPath: string,
  timeoutMs: number,
  body?: string,
): Promise<{ status: number; text: string }> {
  const url = new URL(lease.baseUrl);
  const target: http.RequestOptions = lease.socketPath
    ? { socketPath: lease.socketPath }
    : { host: url.hostname, port: Number(url.port) };
  return new Promise((resolve, reject) => {
    const request = http.request(
      {
        ...target,
        path: urlPath,
        method,
        timeout: timeoutMs,
        headers: {
          ...lease.headers,
          authorization: `Bearer ${lease.apiKey}`,
          ...(body === undefined
            ? {}
            : {
                'content-type': 'application/json',
                'content-length': Buffer.byteLength(body),
              }),
        },
      },
      (response) => {
        let text = '';
        response.on('data', (chunk) => (text += chunk));
        response.on('end', () =>
          resolve({ status: response.statusCode ?? 0, text }),
        );
      },
    );
    request.on('timeout', () => request.destroy(new Error('timed out')));
    request.on('error', reject);
    request.end(body);
  });
}

/** Counters from llama-server's Prometheus `/metrics`, by name. */
export function parseMetrics(text: string): Map<string, number> {
  const metrics = new Map<string, number>();
  for (const line of text.split('\n')) {
    const match = /^llamacpp:([a-z_]+)\s+(\S+)$/.exec(line.trim());
    if (match) metrics.set(match[1], Number(match[2]));
  }
  return metrics;
}

/** The engine's counters, or an empty map when it does not serve them. */
async function readMetrics(
  lease: LocalModelLease,
): Promise<Map<string, number>> {
  try {
    const { status, text } = await engineRequest(
      lease,
      'GET',
      '/metrics',
      10_000,
    );
    return status === 200 ? parseMetrics(text) : new Map();
  } catch {
    return new Map();
  }
}

/**
 * What changed in the counters during a run: the share of drafted tokens the
 * model accepted, and the MoE cache hit rate, when the engine counted them.
 */
export function counterRates(
  before: ReadonlyMap<string, number>,
  after: ReadonlyMap<string, number>,
): Pick<BenchResult, 'draftAcceptance' | 'moeCacheHitRate'> {
  const delta = (name: string) =>
    after.has(name)
      ? (after.get(name) ?? 0) - (before.get(name) ?? 0)
      : undefined;
  const drafted = delta('spec_decode_num_draft_tokens_total');
  const accepted = delta('spec_decode_num_accepted_tokens_total');
  const hits = delta('moe_cache_hits_total');
  const misses = delta('moe_cache_misses_total');
  return {
    ...(drafted && accepted !== undefined
      ? { draftAcceptance: accepted / drafted }
      : {}),
    ...(hits !== undefined && misses !== undefined && hits + misses > 0
      ? { moeCacheHitRate: hits / (hits + misses) }
      : {}),
  };
}

/**
 * Run the benchmark on a leased engine: the prompt is read without the
 * prompt cache, and generation runs at temperature 0. With a prompt cache it
 * runs in the side-query slot, so the conversation's cache stays.
 */
export async function runBench(
  lease: LocalModelLease,
  workload: BenchWorkload = 'prose',
  timeoutMs = 10 * 60_000,
): Promise<BenchResult> {
  const body = JSON.stringify({
    messages: [{ role: 'user', content: benchPrompt(workload) }],
    max_tokens: BENCH_GENERATED_TOKENS,
    temperature: 0,
    cache_prompt: false,
    // Answer at once: a thinking block would make every run write prose.
    chat_template_kwargs: { enable_thinking: false },
    // Generate the whole budget, so every run measures the same work.
    ignore_eos: true,
    ...(lease.pinSlots ? { id_slot: SIDE_QUERY_SLOT } : {}),
  });
  const before = await readMetrics(lease);
  const root = new URL(lease.baseUrl).pathname.replace(/\/$/, '');
  const { status, text } = await engineRequest(
    lease,
    'POST',
    `${root}/chat/completions`,
    timeoutMs,
    body,
  );
  if (status !== 200) {
    throw new Error(
      `The engine answered HTTP ${status}: ${text.slice(0, 300)}`,
    );
  }
  const result = benchResult(JSON.parse(text));
  const after = await readMetrics(lease);
  return { ...result, ...counterRates(before, after) };
}
