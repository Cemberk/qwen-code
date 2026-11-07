/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { findExecutable } from './executables.js';

const GIB = 1024 ** 3;
const MIB = 1024 ** 2;

export type GpuVendor = 'nvidia' | 'amd' | 'intel' | 'apple' | 'other';

/** A GPU llama.cpp can run a model on. */
export interface GpuDevice {
  name: string;
  vendor: GpuVendor;
  /** Memory of its own: VRAM, or the carve-out of an integrated GPU. */
  dedicatedBytes: number;
  /**
   * Shares system memory with the CPU (Apple silicon, integrated Radeon and
   * Intel graphics), so what it uses beside `dedicatedBytes` comes out of RAM.
   */
  integrated: boolean;
  /**
   * System memory it may use beside `dedicatedBytes`: macOS's GPU wired limit,
   * GTT on Linux, shared GPU memory on Windows. 0 for a discrete GPU.
   */
  sharedBytes: number;
  /** AMD's LLVM target (`gfx1103`), where known; picks the HIP build. */
  gfxTarget?: string;
}

/** What qwen knows about this machine when it plans how to run a model. */
export interface HardwareProfile {
  platform: NodeJS.Platform;
  arch: string;
  totalMemory: number;
  logicalCores: number;
  /** Physical cores, where the OS reports them. */
  physicalCores?: number;
  gpus: GpuDevice[];
}

/** Runs a command; its stdout, or undefined when it fails or is missing. */
export type CommandRunner = (
  command: string,
  args: readonly string[],
) => string | undefined;

/** Reads the file system; undefined (or []) when a path cannot be read. */
export interface FileReader {
  read(file: string): string | undefined;
  list(dir: string): string[];
}

export interface ProbeSources {
  platform: NodeJS.Platform;
  arch: string;
  totalMemory: number;
  logicalCores: number;
  run: CommandRunner;
  files: FileReader;
  /** Absolute path of a tool such as nvidia-smi or powershell, if present. */
  findTool(name: string): string | undefined;
}

const runCommand: CommandRunner = (command, args) => {
  try {
    return execFileSync(command, args, {
      encoding: 'utf8',
      timeout: 30_000,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
  } catch {
    return undefined;
  }
};

const realFiles: FileReader = {
  read(file) {
    try {
      return readFileSync(file, 'utf8');
    } catch {
      return undefined;
    }
  },
  list(dir) {
    try {
      return readdirSync(dir);
    } catch {
      return [];
    }
  },
};

function defaultSources(): ProbeSources {
  return {
    platform: process.platform,
    arch: process.arch,
    totalMemory: os.totalmem(),
    logicalCores: os.availableParallelism(),
    run: runCommand,
    files: realFiles,
    findTool: findSystemTool,
  };
}

/**
 * System tools by absolute path: on Windows a bare name could resolve to a
 * file of that name in the current directory.
 */
function findSystemTool(name: string): string | undefined {
  if (process.platform === 'win32' && name === 'powershell') {
    const root = process.env['SystemRoot'] ?? 'C:\\Windows';
    return path.win32.join(
      root,
      'System32',
      'WindowsPowerShell',
      'v1.0',
      'powershell.exe',
    );
  }
  return findExecutable(name);
}

/** NVIDIA GPUs from `nvidia-smi`, on Linux and Windows. */
export function nvidiaGpus(run: CommandRunner, smi: string): GpuDevice[] {
  const output = run(smi, [
    '--query-gpu=name,memory.total',
    '--format=csv,noheader,nounits',
  ]);
  if (!output) return [];
  const gpus: GpuDevice[] = [];
  for (const line of output.split(/\r?\n/)) {
    const match = /^(.*),\s*(\d+)\s*$/.exec(line.trim());
    if (!match) continue;
    gpus.push({
      name: match[1].trim(),
      vendor: 'nvidia',
      dedicatedBytes: Number(match[2]) * MIB,
      integrated: false,
      sharedBytes: 0,
    });
  }
  return gpus;
}

/**
 * Integrated Radeon and Intel graphics by name: "AMD Radeon(TM) 780M",
 * "AMD Radeon(TM) 8060S Graphics", "AMD Radeon(TM) Graphics",
 * "Intel(R) UHD Graphics", "Intel(R) Arc(TM) Graphics". Discrete cards carry a
 * model line: "Radeon RX 7900 XTX", "Radeon AI PRO R9700", "Arc(TM) B580".
 */
export function isIntegratedGpuName(vendor: GpuVendor, name: string): boolean {
  if (vendor === 'amd') {
    return /Radeon(?:\(TM\))?\s+(?:\d{3}M|\d{4}S|Graphics|Vega\s+\d{1,2}\s+Graphics)\b/i.test(
      name,
    );
  }
  if (vendor === 'intel') {
    return !/Arc(?:\(TM\))?\s+(?:Pro\s+)?[AB]\d{2,3}\b/i.test(name);
  }
  return false;
}

function vendorFromPciId(id: string): GpuVendor {
  const vendor = id.toLowerCase();
  if (vendor.includes('10de')) return 'nvidia';
  if (vendor.includes('1002')) return 'amd';
  if (vendor.includes('8086')) return 'intel';
  return 'other';
}

/**
 * The display adapters Windows knows, with 64-bit memory sizes (WMI's
 * AdapterRAM stops at 4 GB), and the physical core count, in one PowerShell
 * call.
 */
const WINDOWS_PROBE = `
$ErrorActionPreference = 'SilentlyContinue'
$gpus = @(Get-ChildItem 'HKLM:\\SYSTEM\\CurrentControlSet\\Control\\Class\\{4d36e968-e325-11ce-bfc1-08002be10318}' | ForEach-Object {
  $p = Get-ItemProperty $_.PSPath
  if ($p.DriverDesc -and $p.MatchingDeviceId -like 'PCI\\*') {
    $mem = $p.'HardwareInformation.qwMemorySize'
    if ($mem -eq $null) { $mem = $p.'HardwareInformation.MemorySize' }
    if ($mem -is [byte[]]) { $mem = [BitConverter]::ToUInt32($mem, 0) }
    [pscustomobject]@{ name = $p.DriverDesc; id = $p.MatchingDeviceId; mem = [uint64]$mem }
  }
})
$cores = (Get-CimInstance Win32_Processor | Measure-Object -Property NumberOfCores -Sum).Sum
[pscustomobject]@{ gpus = $gpus; cores = $cores } | ConvertTo-Json -Compress -Depth 3`;

interface WindowsProbe {
  gpus?: Array<{ name?: string; id?: string; mem?: number }> | null;
  cores?: number | null;
}

/**
 * GPUs on Windows. An integrated GPU may use up to half of RAM as shared GPU
 * memory (WDDM's default) beside its carve-out.
 */
export function windowsHardware(sources: ProbeSources): {
  gpus: GpuDevice[];
  physicalCores?: number;
} {
  const powershell = sources.findTool('powershell');
  const output =
    powershell &&
    sources.run(powershell, [
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      WINDOWS_PROBE,
    ]);
  let parsed: WindowsProbe = {};
  try {
    parsed = output ? (JSON.parse(output) as WindowsProbe) : {};
  } catch {
    // Treated as no GPU.
  }
  const entries = Array.isArray(parsed.gpus)
    ? parsed.gpus
    : parsed.gpus
      ? [parsed.gpus]
      : [];
  const gpus: GpuDevice[] = [];
  for (const entry of entries) {
    const name = entry.name ?? '';
    const vendor = vendorFromPciId(entry.id ?? '');
    if (vendor === 'other') continue;
    const dedicatedBytes = Number(entry.mem) || 0;
    const integrated =
      isIntegratedGpuName(vendor, name) ||
      (vendor !== 'nvidia' && dedicatedBytes > 0 && dedicatedBytes <= 2 * GIB);
    gpus.push({
      name,
      vendor,
      dedicatedBytes,
      integrated,
      sharedBytes: integrated ? Math.floor(sources.totalMemory / 2) : 0,
    });
  }
  return {
    gpus,
    physicalCores:
      typeof parsed.cores === 'number' && parsed.cores > 0
        ? parsed.cores
        : undefined,
  };
}

/**
 * APU targets: the GPU of a Ryzen or Ryzen AI processor, which shares RAM.
 * gfx90c Renoir/Cezanne, gfx1033 Van Gogh, gfx1035/1036 Rembrandt and
 * Raphael, gfx1103 Phoenix/Hawk Point (780M), gfx1150-1153 Strix Point,
 * Strix Halo, Krackan.
 */
const APU_GFX_TARGETS = new Set([
  'gfx90c',
  'gfx1033',
  'gfx1035',
  'gfx1036',
  'gfx1037',
  'gfx1103',
  'gfx1150',
  'gfx1151',
  'gfx1152',
  'gfx1153',
]);

/** KFD's `gfx_target_version` (110003) as an LLVM target (gfx1103). */
export function gfxTargetName(version: number): string | undefined {
  if (!Number.isFinite(version) || version <= 0) return undefined;
  const major = Math.floor(version / 10000);
  const minor = Math.floor(version / 100) % 100;
  const step = version % 100;
  return `gfx${major}${minor.toString(16)}${step.toString(16)}`;
}

/** gfx target per DRM render minor, from the KFD topology (ROCm not needed). */
function kfdTargets(files: FileReader): Map<number, string> {
  const targets = new Map<number, string>();
  const nodes = '/sys/class/kfd/kfd/topology/nodes';
  for (const node of files.list(nodes)) {
    const properties = files.read(path.posix.join(nodes, node, 'properties'));
    if (!properties) continue;
    const value = (key: string) => {
      const match = new RegExp(`^${key}\\s+(\\d+)$`, 'm').exec(properties);
      return match ? Number(match[1]) : undefined;
    };
    const minor = value('drm_render_minor');
    const target = gfxTargetName(value('gfx_target_version') ?? 0);
    if (minor !== undefined && target) targets.set(minor, target);
  }
  return targets;
}

/**
 * GPUs on Linux from `/sys/class/drm`. NVIDIA's driver does not report memory
 * there, so NVIDIA cards come from `nvidia-smi`. An integrated AMD GPU may use
 * GTT (by default half of RAM) beside its carve-out; integrated Intel
 * graphics use system memory only.
 */
export function linuxGpus(sources: ProbeSources): GpuDevice[] {
  const { files } = sources;
  const gpus: GpuDevice[] = [];
  const drm = '/sys/class/drm';
  const targets = kfdTargets(files);
  let sawNvidia = false;
  for (const card of files.list(drm).filter((c) => /^card\d+$/.test(c))) {
    const device = path.posix.join(drm, card, 'device');
    const vendor = vendorFromPciId(
      files.read(path.posix.join(device, 'vendor')) ?? '',
    );
    if (vendor === 'nvidia') {
      sawNvidia = true;
      continue;
    }
    if (vendor === 'other') continue;
    const number = (file: string) =>
      Number(files.read(path.posix.join(device, file))?.trim()) || 0;
    const vram = number('mem_info_vram_total');
    const gtt = number('mem_info_gtt_total');
    // The render node of this card names its KFD node.
    const render = files
      .list(path.posix.join(device, 'drm'))
      .map((n) => /^renderD(\d+)$/.exec(n))
      .find((m) => m !== null);
    const gfxTarget = render ? targets.get(Number(render[1])) : undefined;
    const pciId = (files.read(path.posix.join(device, 'device')) ?? '').trim();
    const integrated =
      vendor === 'intel'
        ? vram === 0
        : gfxTarget !== undefined
          ? APU_GFX_TARGETS.has(gfxTarget)
          : vram > 0 && vram <= 2 * GIB;
    gpus.push({
      name: `${vendor === 'amd' ? 'AMD' : 'Intel'} GPU ${gfxTarget ?? pciId}`.trim(),
      vendor,
      dedicatedBytes: vram,
      integrated,
      sharedBytes: integrated ? gtt || Math.floor(sources.totalMemory / 2) : 0,
      ...(gfxTarget ? { gfxTarget } : {}),
    });
  }
  const smi = sawNvidia ? sources.findTool('nvidia-smi') : undefined;
  return [...(smi ? nvidiaGpus(sources.run, smi) : []), ...gpus];
}

function linuxPhysicalCores(files: FileReader): number | undefined {
  const cpuinfo = files.read('/proc/cpuinfo');
  if (!cpuinfo) return undefined;
  const cores = new Set<string>();
  for (const block of cpuinfo.split(/\n\s*\n/)) {
    const socket = /^physical id\s*:\s*(\d+)/m.exec(block)?.[1];
    const core = /^core id\s*:\s*(\d+)/m.exec(block)?.[1];
    if (socket !== undefined && core !== undefined) {
      cores.add(`${socket}:${core}`);
    }
  }
  return cores.size || undefined;
}

/**
 * Bytes of memory macOS lets the GPU use on Apple silicon:
 * `iogpu.wired_limit_mb` when it is set, otherwise macOS's default of two
 * thirds of RAM up to 36 GiB and three quarters above.
 */
export function appleGpuLimitBytes(totalMemory: number, wiredLimitMb: number) {
  if (wiredLimitMb > 0) return wiredLimitMb * MIB;
  return totalMemory <= 36 * GIB
    ? (totalMemory * 2) / 3
    : (totalMemory * 3) / 4;
}

/** Probe the machine. Each source is injectable for tests. */
export function probeHardware(
  sources: ProbeSources = defaultSources(),
): HardwareProfile {
  const { platform, arch, totalMemory, logicalCores, run, files } = sources;
  const base = { platform, arch, totalMemory, logicalCores };
  if (platform === 'darwin') {
    const sysctl = (name: string) =>
      Number(run('/usr/sbin/sysctl', ['-n', name])?.trim()) || 0;
    const physicalCores = sysctl('hw.physicalcpu') || undefined;
    if (arch !== 'arm64') return { ...base, physicalCores, gpus: [] };
    return {
      ...base,
      physicalCores,
      gpus: [
        {
          name: 'Apple GPU',
          vendor: 'apple',
          dedicatedBytes: 0,
          integrated: true,
          sharedBytes: appleGpuLimitBytes(
            totalMemory,
            sysctl('iogpu.wired_limit_mb'),
          ),
        },
      ],
    };
  }
  if (platform === 'win32') {
    return { ...base, ...windowsHardware(sources) };
  }
  if (platform === 'linux') {
    return {
      ...base,
      physicalCores: linuxPhysicalCores(files),
      gpus: linuxGpus(sources),
    };
  }
  return { ...base, gpus: [] };
}

let cached: HardwareProfile | undefined;

/** This machine's profile, probed once per process. */
export function getHardwareProfile(): HardwareProfile {
  cached ??= probeHardware();
  return cached;
}

/** For tests: forget the cached profile, or replace it. */
export function setHardwareProfileForTesting(
  profile: HardwareProfile | undefined,
): void {
  cached = profile;
}

const gb = (bytes: number) => `${(bytes / 1e9).toFixed(1)} GB`;

/** One line per device, for /models setup. */
export function describeHardware(profile: HardwareProfile): string[] {
  const lines = [
    `${profile.platform} ${profile.arch}, ${gb(profile.totalMemory)} RAM, ` +
      (profile.physicalCores
        ? `${profile.physicalCores} cores (${profile.logicalCores} threads)`
        : `${profile.logicalCores} threads`),
  ];
  if (profile.gpus.length === 0)
    lines.push('No GPU found: models run on the CPU.');
  for (const gpu of profile.gpus) {
    lines.push(
      gpu.integrated
        ? `${gpu.name}: shares system memory` +
            (gpu.dedicatedBytes ? `, ${gb(gpu.dedicatedBytes)} reserved` : '') +
            `, up to ${gb(gpu.dedicatedBytes + gpu.sharedBytes)} usable`
        : `${gpu.name}: ${gb(gpu.dedicatedBytes)} VRAM`,
    );
  }
  return lines;
}
