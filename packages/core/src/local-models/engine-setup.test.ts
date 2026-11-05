/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import { engineSetup, recommendedBackend } from './engine-setup.js';
import type { GpuDevice, HardwareProfile } from './hardware.js';

const GIB = 1024 ** 3;

const gpu = (
  vendor: GpuDevice['vendor'],
  extra: Partial<GpuDevice> = {},
): GpuDevice => ({
  name: vendor,
  vendor,
  dedicatedBytes: 8 * GIB,
  integrated: false,
  sharedBytes: 0,
  ...extra,
});

function machine(
  platform: NodeJS.Platform,
  gpus: GpuDevice[],
  arch = 'x64',
): HardwareProfile {
  return { platform, arch, totalMemory: 32 * GIB, logicalCores: 16, gpus };
}

describe('recommendedBackend', () => {
  it('picks the backend for each kind of machine', () => {
    expect(recommendedBackend(machine('darwin', [gpu('apple')], 'arm64'))).toBe(
      'metal',
    );
    expect(
      recommendedBackend(machine('linux', [gpu('amd'), gpu('nvidia')])),
    ).toBe('cuda');
    expect(recommendedBackend(machine('win32', [gpu('amd')]))).toBe('vulkan');
    expect(recommendedBackend(machine('linux', [gpu('intel')]))).toBe('vulkan');
    expect(recommendedBackend(machine('linux', []))).toBe('cpu');
  });
});

describe('engineSetup', () => {
  it('builds the Vulkan engine on Windows with Visual Studio and the Vulkan SDK', () => {
    const setup = engineSetup(
      machine('win32', [gpu('amd', { integrated: true })]),
    );
    expect(setup.backend).toBe('vulkan');
    expect(setup.binary).toBe('build\\bin\\Release\\llama-server.exe');
    expect(setup.lines).toContain('winget install KhronosGroup.VulkanSDK');
    expect(setup.lines).toContain(
      'cmake -B build -DCMAKE_BUILD_TYPE=Release -DBUILD_SHARED_LIBS=OFF -DLLAMA_OPENSSL=OFF -DGGML_VULKAN=ON',
    );
    expect(setup.lines).toContain(
      'git clone https://github.com/Cemberk/llama.cpp',
    );
    expect(setup.lines.at(-1)).toMatch(/localModelEngine/);
  });

  it('builds CUDA on Linux and names no Vulkan packages', () => {
    const setup = engineSetup(machine('linux', [gpu('nvidia')]));
    expect(setup.lines).toContain(
      'cmake -B build -DCMAKE_BUILD_TYPE=Release -DBUILD_SHARED_LIBS=OFF -DLLAMA_OPENSSL=OFF -DGGML_CUDA=ON',
    );
    expect(setup.lines.join('\n')).toMatch(/nvidia-cuda-toolkit/);
    expect(setup.lines.join('\n')).not.toMatch(/libvulkan-dev/);
    expect(setup.binary).toBe('build/bin/llama-server');
  });

  it('offers HIP for the AMD GPU target on Linux', () => {
    const setup = engineSetup(
      machine('linux', [gpu('amd', { gfxTarget: 'gfx1100' })]),
    );
    expect(setup.lines.join('\n')).toMatch(
      /-DGGML_HIP=ON -DGPU_TARGETS=gfx1100/,
    );
  });

  it('builds Metal by default on Apple silicon', () => {
    const setup = engineSetup(machine('darwin', [gpu('apple')], 'arm64'));
    expect(setup.lines).toContain(
      'cmake -B build -DCMAKE_BUILD_TYPE=Release -DBUILD_SHARED_LIBS=OFF -DLLAMA_OPENSSL=OFF',
    );
    expect(setup.lines).toContain('xcode-select --install');
  });
});
