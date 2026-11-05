/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { HardwareProfile } from './hardware.js';

/** The llama.cpp fork qwen's local engine is built from. */
export const ENGINE_REPO_URL = 'https://github.com/Cemberk/llama.cpp';

/** A llama.cpp GPU backend, chosen by the build. */
export type EngineBackend = 'metal' | 'cuda' | 'hip' | 'vulkan' | 'cpu';

export interface EngineSetup {
  /** The backend recommended for this machine. */
  backend: EngineBackend;
  /** What to install and run, one command or note per line. */
  lines: string[];
  /** Where the build puts llama-server, relative to the checkout. */
  binary: string;
}

/**
 * The backend that runs models best on this machine: Metal on Apple silicon,
 * CUDA on NVIDIA, Vulkan on AMD and Intel (no ROCm needed, and it covers
 * integrated graphics), else the CPU.
 */
export function recommendedBackend(profile: HardwareProfile): EngineBackend {
  if (profile.platform === 'darwin' && profile.arch === 'arm64') return 'metal';
  const vendors = new Set(profile.gpus.map((gpu) => gpu.vendor));
  if (vendors.has('nvidia')) return 'cuda';
  if (vendors.has('amd') || vendors.has('intel')) return 'vulkan';
  return 'cpu';
}

/**
 * Every build: one self-contained program (no ggml libraries beside it), and
 * no HTTPS, so the engine cannot download anything.
 */
const BASE_FLAGS =
  ' -DCMAKE_BUILD_TYPE=Release -DBUILD_SHARED_LIBS=OFF -DLLAMA_OPENSSL=OFF';

/** Parallel compile jobs for the engine build. */
const BUILD_JOBS = 4;

const CMAKE_FLAGS: Record<EngineBackend, string> = {
  metal: '',
  cuda: ' -DGGML_CUDA=ON',
  hip: ' -DGGML_HIP=ON',
  vulkan: ' -DGGML_VULKAN=ON',
  cpu: '',
};

function prerequisites(
  platform: NodeJS.Platform,
  backend: EngineBackend,
): string[] {
  if (platform === 'darwin') {
    return ['xcode-select --install', 'brew install cmake git'];
  }
  if (platform === 'win32') {
    const lines = [
      'winget install Git.Git Kitware.CMake',
      'winget install Microsoft.VisualStudio.2022.BuildTools --override "--wait --passive --add Microsoft.VisualStudio.Workload.VCTools --includeRecommended"',
    ];
    if (backend === 'vulkan')
      lines.push('winget install KhronosGroup.VulkanSDK');
    if (backend === 'cuda') lines.push('winget install Nvidia.CUDA');
    return lines;
  }
  const packages = ['build-essential', 'cmake', 'git'];
  if (backend === 'vulkan')
    packages.push('libvulkan-dev', 'glslc', 'spirv-headers');
  if (backend === 'cuda') packages.push('nvidia-cuda-toolkit');
  return [
    `sudo apt-get install ${packages.join(' ')}   # Debian/Ubuntu; use your distribution's names elsewhere`,
  ];
}

/** How to build and point qwen at the engine on this machine. */
export function engineSetup(profile: HardwareProfile): EngineSetup {
  const backend = recommendedBackend(profile);
  const windows = profile.platform === 'win32';
  const binary = windows
    ? 'build\\bin\\Release\\llama-server.exe'
    : 'build/bin/llama-server';
  const lines = [
    `Build llama-server from ${ENGINE_REPO_URL} with the ${backend === 'cpu' ? 'CPU' : backend.toUpperCase()} backend:`,
    ...prerequisites(profile.platform, backend),
    `git clone ${ENGINE_REPO_URL}`,
    'cd llama.cpp',
    `cmake -B build${BASE_FLAGS}${CMAKE_FLAGS[backend]}`,
    // A compiler process per core runs a 32 GB machine out of memory on the
    // Vulkan shaders.
    `cmake --build build --config Release --target llama-server -j ${BUILD_JOBS}`,
  ];
  if (windows && backend === 'vulkan') {
    lines.push(
      'Without administrator rights (the Vulkan SDK installer needs them), run powershell -ExecutionPolicy Bypass -File scripts\\windows-vulkan-noadmin.ps1 in the checkout instead of installing the SDK: it gathers the headers, vulkan-1.lib and glslc under %USERPROFILE%\\vulkan-local and prints the cmake command that uses them.',
    );
  }
  const amd = profile.gpus.find((gpu) => gpu.vendor === 'amd');
  if (amd && profile.platform === 'linux') {
    const target = amd.gfxTarget ? ` -DGPU_TARGETS=${amd.gfxTarget}` : '';
    lines.push(
      `With ROCm installed, HIP is an alternative to Vulkan: HIPCXX="$(hipconfig -l)/clang" HIP_PATH="$(hipconfig -R)" cmake -B build${BASE_FLAGS} -DGGML_HIP=ON${target}`,
    );
  }
  lines.push(
    `Then set "localModelEngine" in your user settings to the full path of ${binary} in the checkout, or put its folder on PATH.`,
  );
  return { backend, lines, binary };
}
