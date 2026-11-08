/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { closeSync, openSync, readFileSync, readSync, statSync } from 'node:fs';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';

/**
 * Models larger than memory: the experts that do not fit stay in the model
 * file, mapped into memory, and are read from the drive as tokens use them.
 * Most tokens reuse experts recent tokens used, so the share of reads that
 * reach the drive falls fast with the share of experts memory holds.
 */

/** A plan below this many tokens per second is refused. */
export const MIN_STREAMING_TOKENS_PER_SECOND = 1;

/**
 * Share of expert reads served from memory when memory holds `fraction` of
 * the experts. Measured by Pooled on Qwen3.6 35B A3B (6.25% of a layer's
 * experts cached served 59% of lookups, 17% served 78%, 50% served 94%),
 * interpolated linearly; our own traces replace it once a profile exists.
 */
export function expertHitRate(fraction: number): number {
  const points: Array<[number, number]> = [
    [0, 0],
    [0.0625, 0.59],
    [0.17, 0.78],
    [0.5, 0.94],
    [1, 1],
  ];
  const f = Math.min(1, Math.max(0, fraction));
  for (let i = 1; i < points.length; i++) {
    const [x1, y1] = points[i];
    if (f <= x1) {
      const [x0, y0] = points[i - 1];
      return y0 + ((y1 - y0) * (f - x0)) / (x1 - x0);
    }
  }
  return 1;
}

export interface StreamingEstimate {
  /** Expert bytes kept on the drive, read as tokens need them. */
  onDriveBytes: number;
  /** Share of expert reads memory serves. */
  hitRate: number;
  /** Bytes read from the drive per generated token, on average. */
  driveBytesPerToken: number;
  /** The drive's random read rate used, bytes per second. */
  driveBytesPerSecond: number;
  /** Generation cannot be faster than this: the drive's limit. */
  maxTokensPerSecond: number;
}

/**
 * How fast a model whose CPU experts do not all fit in memory can generate,
 * at most: each token reads its share of experts (`expertsUsed` of
 * `experts` per layer) and finds `hitRate` of them in memory.
 */
export function streamingEstimate(params: {
  /** Expert bytes of the layers whose experts run on the CPU. */
  cpuExpertBytes: number;
  /** Memory left for those experts. */
  ramForExperts: number;
  expertsUsed: number;
  experts: number;
  driveBytesPerSecond: number;
}): StreamingEstimate | undefined {
  const {
    cpuExpertBytes,
    ramForExperts,
    expertsUsed,
    experts,
    driveBytesPerSecond,
  } = params;
  if (cpuExpertBytes <= 0 || experts <= 0 || expertsUsed <= 0) return undefined;
  const inRam = Math.max(0, Math.min(cpuExpertBytes, ramForExperts));
  if (inRam >= cpuExpertBytes) return undefined;
  const hitRate = expertHitRate(inRam / cpuExpertBytes);
  const driveBytesPerToken =
    cpuExpertBytes * (expertsUsed / experts) * (1 - hitRate);
  return {
    onDriveBytes: cpuExpertBytes - inRam,
    hitRate,
    driveBytesPerToken,
    driveBytesPerSecond,
    maxTokensPerSecond:
      driveBytesPerToken > 0
        ? driveBytesPerSecond / driveBytesPerToken
        : Number.POSITIVE_INFINITY,
  };
}

/** Bytes of each probe read: about one expert of a large MoE model. */
const PROBE_READ_BYTES = 2 * 1024 * 1024;
const PROBE_READS = 24;
const PROBE_ROUNDS = 3;

/**
 * Random-read rate of the drive holding `file`, in bytes per second: 3
 * rounds of 24 reads of 2 MiB at random places in the file, the median
 * round. Reads the page cache already holds make it read high; the file of
 * a model that is too big for memory is mostly not there.
 */
export function measureDriveReadRate(file: string): number | undefined {
  let fd: number | undefined;
  try {
    const size = statSync(file).size;
    if (size < PROBE_READ_BYTES * 4) return undefined;
    fd = openSync(file, 'r');
    const buffer = Buffer.allocUnsafe(PROBE_READ_BYTES);
    const rates: number[] = [];
    for (let round = 0; round < PROBE_ROUNDS; round++) {
      const started = process.hrtime.bigint();
      for (let i = 0; i < PROBE_READS; i++) {
        const blocks = Math.floor((size - PROBE_READ_BYTES) / 4096);
        const offset = Math.floor(Math.random() * blocks) * 4096;
        readSync(fd, buffer, 0, PROBE_READ_BYTES, offset);
      }
      const seconds = Number(process.hrtime.bigint() - started) / 1e9;
      rates.push((PROBE_READ_BYTES * PROBE_READS) / Math.max(seconds, 1e-6));
    }
    rates.sort((a, b) => a - b);
    return rates[Math.floor(rates.length / 2)];
  } catch {
    return undefined;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

/**
 * The drive's read rate for `file`, measured once and kept in `cacheDir`
 * (keyed by the file's folder, size and time), so planning does not read
 * 150 MB each time.
 */
export function driveReadRate(
  file: string,
  cacheDir: string,
  measure: (file: string) => number | undefined = measureDriveReadRate,
): number | undefined {
  const cacheFile = path.join(cacheDir, 'drive-read-rates.json');
  let cache: Record<string, number> = {};
  try {
    cache = JSON.parse(readFileSync(cacheFile, 'utf8')) as Record<
      string,
      number
    >;
  } catch {
    // None yet.
  }
  let key: string;
  try {
    const stat = statSync(file);
    key = `${path.dirname(file)}\0${stat.size}\0${stat.mtimeMs}`;
  } catch {
    return undefined;
  }
  if (typeof cache[key] === 'number') return cache[key];
  const rate = measure(file);
  if (rate === undefined) return undefined;
  cache[key] = rate;
  try {
    mkdirSync(cacheDir, { recursive: true });
    writeFileSync(cacheFile, JSON.stringify(cache));
  } catch {
    // Measured again next time.
  }
  return rate;
}
