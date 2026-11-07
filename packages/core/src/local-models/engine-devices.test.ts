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
  clearEngineDevicesForTesting,
  describeEngineDevices,
  engineDevices,
  parseDeviceList,
} from './engine-devices.js';
import { engineGpuBudget } from './engine.js';

const MIB = 1024 ** 2;

describe('parseDeviceList', () => {
  it('reads the devices of a GPU build', () => {
    const devices = parseDeviceList(
      [
        'ggml_vulkan: Found 1 Vulkan devices:',
        'Available devices:',
        '  Vulkan0: AMD Radeon(TM) 780M Graphics (16384 MiB, 15012 MiB free)',
        '  CUDA0: NVIDIA GeForce RTX 4090 (24564 MiB, 23000 MiB free)',
        '',
      ].join('\r\n'),
    );
    expect(devices).toEqual([
      {
        name: 'Vulkan0',
        description: 'AMD Radeon(TM) 780M Graphics',
        backend: 'vulkan',
        totalBytes: 16384 * MIB,
        freeBytes: 15012 * MIB,
      },
      {
        name: 'CUDA0',
        description: 'NVIDIA GeForce RTX 4090',
        backend: 'cuda',
        totalBytes: 24564 * MIB,
        freeBytes: 23000 * MIB,
      },
    ]);
    expect(describeEngineDevices(devices!)).toBe(
      'Vulkan0 (AMD Radeon(TM) 780M Graphics, 17.2 GB), CUDA0 (NVIDIA GeForce RTX 4090, 25.8 GB)',
    );
  });

  it('reads a build without a GPU backend as no devices', () => {
    expect(parseDeviceList('Available devices:\n  (none)\n')).toEqual([]);
    expect(describeEngineDevices([])).toBe(
      'no GPU backend: models run on the CPU',
    );
  });

  it('is undefined for output that is not a device list', () => {
    expect(parseDeviceList('error: unknown argument')).toBeUndefined();
  });
});

describe('engineDevices', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(path.join(os.tmpdir(), 'engine-devices-'));
    clearEngineDevicesForTesting();
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('asks a build once, with the engine environment, and again when it changes', () => {
    const binary = path.join(dir, 'llama-server');
    writeFileSync(binary, 'v1');
    const run = vi.fn(() => 'Available devices:\n  (none)\n');
    const env = { PATH: '/bin' };
    expect(engineDevices(binary, env, run)).toEqual([]);
    expect(engineDevices(binary, env, run)).toEqual([]);
    expect(run).toHaveBeenCalledTimes(1);
    expect(run).toHaveBeenCalledWith(binary, ['--list-devices'], env);
    writeFileSync(binary, 'version 2');
    engineDevices(binary, env, run);
    expect(run).toHaveBeenCalledTimes(2);
  });

  it('is undefined for a missing binary or one that fails', () => {
    expect(engineDevices(path.join(dir, 'missing'), {}, () => 'x')).toBe(
      undefined,
    );
    const binary = path.join(dir, 'llama-server');
    writeFileSync(binary, 'x');
    expect(engineDevices(binary, {}, () => undefined)).toBeUndefined();
  });
});

describe('engineGpuBudget', () => {
  const vulkan = {
    name: 'Vulkan0',
    description: 'AMD Radeon(TM) 780M',
    backend: 'vulkan' as const,
    totalBytes: 16 * 1024 * MIB,
    freeBytes: 15 * 1024 * MIB,
  };

  it("uses the build's devices, shared when the machine's GPU is", () => {
    expect(
      engineGpuBudget([vulkan], { limit: 17 * 1024 * MIB, unified: true }),
    ).toEqual({ limit: 16 * 1024 * MIB, unified: true });
  });

  it('plans for the CPU with a build that has no GPU backend', () => {
    expect(
      engineGpuBudget([], { limit: 17 * 1024 * MIB, unified: true }),
    ).toBeUndefined();
  });

  it("falls back to the machine's GPUs when the build could not be asked", () => {
    const machine = { limit: 8 * 1024 * MIB, unified: false };
    expect(engineGpuBudget(undefined, machine)).toBe(machine);
  });
});

describe('engineGpuBudget without the hardware probe', () => {
  const device = (
    name: string,
    description: string,
    backend: 'vulkan' | 'cuda' | 'metal',
  ) => ({
    name,
    description,
    backend,
    totalBytes: 16 * 1024 * MIB,
    freeBytes: 15 * 1024 * MIB,
  });

  it('tells shared memory from the devices themselves', () => {
    expect(
      engineGpuBudget(
        [device('Vulkan0', 'AMD Radeon(TM) 780M', 'vulkan')],
        undefined,
      )?.unified,
    ).toBe(true);
    expect(
      engineGpuBudget([device('MTL0', 'Apple M4 Pro', 'metal')], undefined)
        ?.unified,
    ).toBe(true);
    expect(
      engineGpuBudget(
        [device('CUDA0', 'NVIDIA GeForce RTX 4090', 'cuda')],
        undefined,
      )?.unified,
    ).toBe(false);
    expect(
      engineGpuBudget(
        [device('Vulkan0', 'AMD Radeon RX 7900 XTX', 'vulkan')],
        undefined,
      )?.unified,
    ).toBe(false);
  });
});
