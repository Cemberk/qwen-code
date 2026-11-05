/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import {
  appleGpuLimitBytes,
  describeHardware,
  gfxTargetName,
  isIntegratedGpuName,
  probeHardware,
  type CommandRunner,
  type ProbeSources,
} from './hardware.js';

const GIB = 1024 ** 3;

function sources(
  platform: NodeJS.Platform,
  {
    run = () => undefined,
    files = {},
    tools = {},
    arch = 'x64',
  }: {
    run?: CommandRunner;
    files?: Record<string, string>;
    tools?: Record<string, string>;
    arch?: string;
  } = {},
): ProbeSources {
  return {
    platform,
    arch,
    totalMemory: 32 * GIB,
    logicalCores: 16,
    run,
    files: {
      read: (file) => files[file],
      list: (dir) => {
        const prefix = dir.endsWith('/') ? dir : `${dir}/`;
        const names = new Set<string>();
        for (const file of Object.keys(files)) {
          if (file.startsWith(prefix)) {
            names.add(file.slice(prefix.length).split('/')[0]);
          }
        }
        return [...names];
      },
    },
    findTool: (name) => tools[name],
  };
}

describe('appleGpuLimitBytes', () => {
  it('is two thirds of RAM up to 36 GiB and three quarters above', () => {
    expect(appleGpuLimitBytes(24 * GIB, 0)).toBe(16 * GIB);
    expect(appleGpuLimitBytes(64 * GIB, 0)).toBe(48 * GIB);
  });

  it('uses iogpu.wired_limit_mb when it is set', () => {
    expect(appleGpuLimitBytes(24 * GIB, 20480)).toBe(20 * GIB);
  });
});

describe('isIntegratedGpuName', () => {
  it.each([
    ['amd', 'AMD Radeon(TM) 780M', true],
    ['amd', 'AMD Radeon(TM) 8060S Graphics', true],
    ['amd', 'AMD Radeon(TM) Graphics', true],
    ['amd', 'AMD Radeon 890M', true],
    ['amd', 'AMD Radeon RX 7900 XTX', false],
    ['amd', 'AMD Radeon AI PRO R9700', false],
    ['intel', 'Intel(R) UHD Graphics', true],
    ['intel', 'Intel(R) Arc(TM) Graphics', true],
    ['intel', 'Intel(R) Arc(TM) 140V GPU (16GB)', true],
    ['intel', 'Intel(R) Arc(TM) B580 Graphics', false],
    ['intel', 'Intel(R) Arc(TM) A770 Graphics', false],
    ['nvidia', 'NVIDIA GeForce RTX 4090', false],
  ] as const)('%s %s: %s', (vendor, name, integrated) => {
    expect(isIntegratedGpuName(vendor, name)).toBe(integrated);
  });
});

describe('gfxTargetName', () => {
  it('turns KFD versions into LLVM targets', () => {
    expect(gfxTargetName(110003)).toBe('gfx1103');
    expect(gfxTargetName(110501)).toBe('gfx1151');
    expect(gfxTargetName(90012)).toBe('gfx90c');
    expect(gfxTargetName(120001)).toBe('gfx1201');
    expect(gfxTargetName(0)).toBeUndefined();
  });
});

describe('probeHardware', () => {
  it('reads Apple silicon from sysctl', () => {
    const run: CommandRunner = (_command, args) =>
      ({ 'hw.physicalcpu': '12\n', 'iogpu.wired_limit_mb': '0\n' })[args[1]];
    const profile = probeHardware(sources('darwin', { run, arch: 'arm64' }));
    expect(profile.physicalCores).toBe(12);
    expect(profile.gpus).toEqual([
      {
        name: 'Apple GPU',
        vendor: 'apple',
        dedicatedBytes: 0,
        integrated: true,
        sharedBytes: appleGpuLimitBytes(32 * GIB, 0),
      },
    ]);
  });

  it('reads Windows adapters, with shared memory for integrated graphics', () => {
    const output = JSON.stringify({
      gpus: [
        {
          name: 'AMD Radeon(TM) 780M',
          id: 'PCI\\VEN_1002&DEV_15BF&SUBSYS_50D917AA&REV_DD',
          mem: GIB,
        },
        {
          name: 'NVIDIA GeForce RTX 4070 Laptop GPU',
          id: 'PCI\\VEN_10DE&DEV_2860',
          mem: 8 * GIB,
        },
        {
          name: 'Microsoft Basic Display Adapter',
          id: 'PCI\\VEN_1414&DEV_008E',
          mem: 0,
        },
      ],
      cores: 8,
    });
    const calls: string[] = [];
    const profile = probeHardware(
      sources('win32', {
        run: (command) => {
          calls.push(command);
          return output;
        },
        tools: { powershell: 'C:\\Windows\\System32\\powershell.exe' },
      }),
    );
    expect(calls).toEqual(['C:\\Windows\\System32\\powershell.exe']);
    expect(profile.physicalCores).toBe(8);
    expect(profile.gpus).toEqual([
      {
        name: 'AMD Radeon(TM) 780M',
        vendor: 'amd',
        dedicatedBytes: GIB,
        integrated: true,
        sharedBytes: 16 * GIB,
      },
      {
        name: 'NVIDIA GeForce RTX 4070 Laptop GPU',
        vendor: 'nvidia',
        dedicatedBytes: 8 * GIB,
        integrated: false,
        sharedBytes: 0,
      },
    ]);
  });

  it('reads a single Windows adapter, which PowerShell does not wrap in an array', () => {
    const output = JSON.stringify({
      gpus: {
        name: 'AMD Radeon RX 7900 XTX',
        id: 'PCI\\VEN_1002&DEV_744C',
        mem: 24 * GIB,
      },
      cores: 16,
    });
    const profile = probeHardware(
      sources('win32', { run: () => output, tools: { powershell: 'ps' } }),
    );
    expect(profile.gpus).toMatchObject([
      { vendor: 'amd', integrated: false, dedicatedBytes: 24 * GIB },
    ]);
  });

  it('has no GPU when the Windows probe fails', () => {
    const profile = probeHardware(
      sources('win32', { run: () => 'not json', tools: { powershell: 'ps' } }),
    );
    expect(profile.gpus).toEqual([]);
    expect(profile.physicalCores).toBeUndefined();
  });

  it('reads Linux GPUs from sysfs, KFD and nvidia-smi', () => {
    const files: Record<string, string> = {
      // A Ryzen 7840U's 780M with a 2 GiB carve-out.
      '/sys/class/drm/card0/device/vendor': '0x1002\n',
      '/sys/class/drm/card0/device/device': '0x15bf\n',
      '/sys/class/drm/card0/device/mem_info_vram_total': `${2 * GIB}\n`,
      '/sys/class/drm/card0/device/mem_info_gtt_total': `${15 * GIB}\n`,
      '/sys/class/drm/card0/device/drm/card0/x': '',
      '/sys/class/drm/card0/device/drm/renderD128/x': '',
      // A Radeon RX 7900 XTX.
      '/sys/class/drm/card1/device/vendor': '0x1002\n',
      '/sys/class/drm/card1/device/device': '0x744c\n',
      '/sys/class/drm/card1/device/mem_info_vram_total': `${24 * GIB}\n`,
      '/sys/class/drm/card1/device/mem_info_gtt_total': `${15 * GIB}\n`,
      '/sys/class/drm/card1/device/drm/renderD129/x': '',
      // An NVIDIA card: memory comes from nvidia-smi.
      '/sys/class/drm/card2/device/vendor': '0x10de\n',
      // Connectors are not cards.
      '/sys/class/drm/card0-eDP-1/status': 'connected\n',
      '/sys/class/kfd/kfd/topology/nodes/0/properties':
        'cpu_cores_count 16\nsimd_count 0\ngfx_target_version 0\ndrm_render_minor 0\n',
      '/sys/class/kfd/kfd/topology/nodes/1/properties':
        'simd_count 24\ngfx_target_version 110003\ndrm_render_minor 128\n',
      '/sys/class/kfd/kfd/topology/nodes/2/properties':
        'simd_count 192\ngfx_target_version 110000\ndrm_render_minor 129\n',
      '/proc/cpuinfo': [0, 1, 2, 3]
        .flatMap((core) => [core, core])
        .map(
          (core) => `processor\t: x\nphysical id\t: 0\ncore id\t\t: ${core}\n`,
        )
        .join('\n'),
    };
    const run: CommandRunner = (command) =>
      command === '/usr/bin/nvidia-smi'
        ? 'NVIDIA GeForce RTX 3060, 12288\n'
        : undefined;
    const profile = probeHardware(
      sources('linux', {
        run,
        files,
        tools: { 'nvidia-smi': '/usr/bin/nvidia-smi' },
      }),
    );
    expect(profile.physicalCores).toBe(4);
    expect(profile.gpus).toEqual([
      {
        name: 'NVIDIA GeForce RTX 3060',
        vendor: 'nvidia',
        dedicatedBytes: 12 * GIB,
        integrated: false,
        sharedBytes: 0,
      },
      {
        name: 'AMD GPU gfx1103',
        vendor: 'amd',
        dedicatedBytes: 2 * GIB,
        integrated: true,
        sharedBytes: 15 * GIB,
        gfxTarget: 'gfx1103',
      },
      {
        name: 'AMD GPU gfx1100',
        vendor: 'amd',
        dedicatedBytes: 24 * GIB,
        integrated: false,
        sharedBytes: 0,
        gfxTarget: 'gfx1100',
      },
    ]);
  });

  it('treats a Strix Halo with a large carve-out as integrated, by its target', () => {
    const files = {
      '/sys/class/drm/card0/device/vendor': '0x1002',
      '/sys/class/drm/card0/device/mem_info_vram_total': `${96 * GIB}`,
      '/sys/class/drm/card0/device/mem_info_gtt_total': `${16 * GIB}`,
      '/sys/class/drm/card0/device/drm/renderD128/x': '',
      '/sys/class/kfd/kfd/topology/nodes/1/properties':
        'gfx_target_version 110501\ndrm_render_minor 128\n',
    };
    expect(probeHardware(sources('linux', { files })).gpus).toMatchObject([
      { integrated: true, dedicatedBytes: 96 * GIB, gfxTarget: 'gfx1151' },
    ]);
  });
});

describe('describeHardware', () => {
  it('lists the machine and each GPU', () => {
    expect(
      describeHardware({
        platform: 'win32',
        arch: 'x64',
        totalMemory: 32e9,
        logicalCores: 16,
        physicalCores: 8,
        gpus: [
          {
            name: 'AMD Radeon(TM) 780M',
            vendor: 'amd',
            dedicatedBytes: 1e9,
            integrated: true,
            sharedBytes: 16e9,
          },
        ],
      }),
    ).toEqual([
      'win32 x64, 32.0 GB RAM, 8 cores (16 threads)',
      'AMD Radeon(TM) 780M: shares system memory, 1.0 GB reserved, up to 17.0 GB usable',
    ]);
  });

  it('says when there is no GPU', () => {
    expect(
      describeHardware({
        platform: 'linux',
        arch: 'x64',
        totalMemory: 16e9,
        logicalCores: 4,
        gpus: [],
      })[1],
    ).toBe('No GPU found: models run on the CPU.');
  });
});
