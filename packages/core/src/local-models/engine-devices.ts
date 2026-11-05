/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { execFileSync } from 'node:child_process';
import { statSync } from 'node:fs';

const MIB = 1024 ** 2;

/** A llama.cpp GPU backend, from the name ggml gives the device. */
export type DeviceBackend =
  | 'cuda'
  | 'rocm'
  | 'vulkan'
  | 'metal'
  | 'sycl'
  | 'other';

/** A device a llama-server build can run models on. */
export interface EngineDevice {
  /** ggml's name: CUDA0, ROCm0, Vulkan0, MTL0, SYCL0, ... */
  name: string;
  description: string;
  backend: DeviceBackend;
  totalBytes: number;
  freeBytes: number;
}

function backendOf(name: string): DeviceBackend {
  const lower = name.toLowerCase();
  if (lower.startsWith('cuda')) return 'cuda';
  if (lower.startsWith('rocm') || lower.startsWith('hip')) return 'rocm';
  if (lower.startsWith('vulkan')) return 'vulkan';
  if (lower.startsWith('mtl') || lower.startsWith('metal')) return 'metal';
  if (lower.startsWith('sycl')) return 'sycl';
  return 'other';
}

/**
 * Devices from `llama-server --list-devices`, which prints
 * "  Vulkan0: AMD Radeon(TM) 780M (16384 MiB, 15000 MiB free)" per device,
 * or "  (none)" for a build without a GPU backend. Undefined when the output
 * is not a device list.
 */
export function parseDeviceList(output: string): EngineDevice[] | undefined {
  const lines = output.split(/\r?\n/);
  const start = lines.findIndex((line) => line.trim() === 'Available devices:');
  if (start < 0) return undefined;
  const devices: EngineDevice[] = [];
  for (const line of lines.slice(start + 1)) {
    const match =
      /^\s+([^:\s]+):\s+(.*)\s+\((\d+)\s+MiB,\s+(\d+)\s+MiB free\)\s*$/.exec(
        line,
      );
    if (!match) continue;
    devices.push({
      name: match[1],
      description: match[2].trim(),
      backend: backendOf(match[1]),
      totalBytes: Number(match[3]) * MIB,
      freeBytes: Number(match[4]) * MIB,
    });
  }
  return devices;
}

/** Runs the engine binary with arguments; its stdout, or undefined. */
export type EngineRunner = (
  binary: string,
  args: readonly string[],
  env: NodeJS.ProcessEnv,
) => string | undefined;

const runEngine: EngineRunner = (binary, args, env) => {
  try {
    return execFileSync(binary, args, {
      encoding: 'utf8',
      env,
      timeout: 60_000,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
  } catch {
    return undefined;
  }
};

const cache = new Map<string, EngineDevice[] | undefined>();

/**
 * The devices the llama-server at `binary` can use, asked once per build
 * (the file's size and modification time), with the environment the engine
 * runs with. Undefined when the binary does not answer with a device list.
 */
export function engineDevices(
  binary: string,
  env: NodeJS.ProcessEnv,
  run: EngineRunner = runEngine,
): EngineDevice[] | undefined {
  let key = binary;
  try {
    const stat = statSync(binary);
    key = `${binary}\0${stat.size}\0${stat.mtimeMs}`;
  } catch {
    return undefined;
  }
  if (!cache.has(key)) {
    const output = run(binary, ['--list-devices'], env);
    cache.set(key, output === undefined ? undefined : parseDeviceList(output));
  }
  return cache.get(key);
}

/** For tests: forget the devices of every binary. */
export function clearEngineDevicesForTesting(): void {
  cache.clear();
}

const gb = (bytes: number) => `${(bytes / 1e9).toFixed(1)} GB`;

/** One line for /models plan and /models setup. */
export function describeEngineDevices(devices: EngineDevice[]): string {
  if (devices.length === 0) return 'no GPU backend: models run on the CPU';
  return devices
    .map(
      (device) =>
        `${device.name} (${device.description}, ${gb(device.totalBytes)})`,
    )
    .join(', ');
}
