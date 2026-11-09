/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  driveReadRate,
  expertHitRate,
  measureDriveReadRate,
  streamingEstimate,
} from './streaming.js';

const GIB = 1024 ** 3;

describe('expertHitRate', () => {
  it('follows the measured curve, and is 0 and 1 at the ends', () => {
    expect(expertHitRate(0)).toBe(0);
    expect(expertHitRate(0.0625)).toBeCloseTo(0.59);
    expect(expertHitRate(0.17)).toBeCloseTo(0.78);
    expect(expertHitRate(0.5)).toBeCloseTo(0.94);
    expect(expertHitRate(1)).toBe(1);
    expect(expertHitRate(2)).toBe(1);
    expect(expertHitRate(0.335)).toBeCloseTo(0.86);
  });
});

describe('streamingEstimate', () => {
  it('is the drive rate over the expert bytes each token misses', () => {
    // 12 GiB of CPU experts, half of them in memory: 94% of reads hit.
    const estimate = streamingEstimate({
      cpuExpertBytes: 12 * GIB,
      ramForExperts: 6 * GIB,
      expertsUsed: 8,
      experts: 256,
      driveBytesPerSecond: 2e9,
    })!;
    expect(estimate.onDriveBytes).toBe(6 * GIB);
    expect(estimate.hitRate).toBeCloseTo(0.94);
    const perToken = 12 * GIB * (8 / 256) * 0.06;
    expect(estimate.driveBytesPerToken).toBeCloseTo(perToken);
    expect(estimate.maxTokensPerSecond).toBeCloseTo(2e9 / perToken);
  });

  it('is undefined when the experts fit, or the model has none', () => {
    const base = {
      cpuExpertBytes: 4 * GIB,
      expertsUsed: 8,
      experts: 256,
      driveBytesPerSecond: 1e9,
    };
    expect(streamingEstimate({ ...base, ramForExperts: 8 * GIB })).toBe(
      undefined,
    );
    expect(
      streamingEstimate({ ...base, ramForExperts: 0, experts: 0 }),
    ).toBeUndefined();
  });

  it('reads everything from the drive when memory holds nothing', () => {
    const estimate = streamingEstimate({
      cpuExpertBytes: 4 * GIB,
      ramForExperts: -GIB,
      expertsUsed: 8,
      experts: 256,
      driveBytesPerSecond: 1e9,
    })!;
    expect(estimate.hitRate).toBe(0);
    expect(estimate.driveBytesPerToken).toBe(4 * GIB * (8 / 256));
  });
});

describe('drive read rate', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(path.join(os.tmpdir(), 'drive-rate-'));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('measures a file by random reads', () => {
    const file = path.join(dir, 'model.gguf');
    writeFileSync(file, Buffer.alloc(16 * 1024 * 1024));
    expect(measureDriveReadRate(file)).toBeGreaterThan(0);
    const small = path.join(dir, 'small.gguf');
    writeFileSync(small, Buffer.alloc(1024));
    expect(measureDriveReadRate(small)).toBeUndefined();
  });

  it('measures once per file and keeps the result', () => {
    const file = path.join(dir, 'model.gguf');
    writeFileSync(file, 'x');
    const measure = vi.fn(() => 2e9);
    expect(driveReadRate(file, path.join(dir, 'cache'), measure)).toBe(2e9);
    expect(driveReadRate(file, path.join(dir, 'cache'), measure)).toBe(2e9);
    expect(measure).toHaveBeenCalledTimes(1);
    expect(
      driveReadRate(
        path.join(dir, 'missing'),
        path.join(dir, 'cache'),
        measure,
      ),
    ).toBeUndefined();
  });
});

describe('largestPart', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(path.join(os.tmpdir(), 'largest-part-'));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('measures the drive on the biggest file of a split model', async () => {
    const { largestPart } = await import('./engine.js');
    const part = (n: number) => path.join(dir, `M-0000${n}-of-00003.gguf`);
    writeFileSync(part(1), Buffer.alloc(10));
    writeFileSync(part(2), Buffer.alloc(3000));
    writeFileSync(part(3), Buffer.alloc(2000));
    expect(largestPart(part(1))).toBe(part(2));
    const whole = path.join(dir, 'whole.gguf');
    expect(largestPart(whole)).toBe(whole);
  });
});
