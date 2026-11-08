/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { LoadedSettings } from '../../config/settings.js';
import { SettingScope } from '../../config/settings.js';
import { createMockCommandContext } from '../../test-utils/mockCommandContext.js';
import { setHardwareProfileForTesting } from '@qwen-code/qwen-code-core/local-models/hardware.js';
import { getLocalModelServer } from '@qwen-code/qwen-code-core/local-models/local-model-server.js';
import {
  fitSummary,
  modelsCommand,
  networkConfinement,
} from './models-command.js';

// The stand-ins below are Node scripts with a shebang line, which Windows
// cannot run: there, start them with Node. Other platforms run them as is.
vi.mock('node:child_process', async (importActual) => {
  const actual = await importActual<typeof import('node:child_process')>();
  const { readFileSync } = await import('node:fs');
  const isScript = (command: string) => {
    try {
      return readFileSync(command, 'utf8').startsWith('#!');
    } catch {
      return false;
    }
  };
  return {
    ...actual,
    spawn: ((command: string, args: readonly string[], options: object) =>
      process.platform === 'win32' && isScript(command)
        ? actual.spawn(process.execPath, [command, ...args], options)
        : actual.spawn(command, args, options)) as typeof actual.spawn,
  };
});

// The GPU and memory of the test machine must not decide these tests.
// By default a GPU that holds any model.
const gpu = vi.hoisted(() => ({
  budget: { limit: 1024 ** 4, unified: false } as
    | { limit: number; unified: boolean }
    | undefined,
  bytes: undefined as number | undefined,
  experts: [] as number[],
}));
vi.mock(
  '@qwen-code/qwen-code-core/local-models/gpu-memory.js',
  async (importActual) => {
    const actual =
      await importActual<
        typeof import('@qwen-code/qwen-code-core/local-models/gpu-memory.js')
      >();
    return {
      ...actual,
      gpuBudget: () => gpu.budget,
      systemMemoryBytes: () => 24 * 1024 ** 3,
      localModelBytes: (model: Parameters<typeof actual.localModelBytes>[0]) =>
        gpu.bytes ?? actual.localModelBytes(model),
      localModelExpertBytes: () => gpu.experts,
    };
  },
);
import type { CommandContext } from './types.js';

const COMMIT = '75f1b73b657a50f5092502799457ccb4a4a1f9df';
const local = [
  { id: 'q-small', repo: 'Qwen/Qwen3-4B-GGUF', file: 'Qwen3-4B-Q4_K_M.gguf' },
  { id: 'q-big', repo: 'Qwen/Qwen3-14B-GGUF', file: 'Qwen3-14B-Q4_K_M.gguf' },
];

let dir: string;
let calls: string;

beforeEach(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), 'models-command-'));
  calls = path.join(dir, 'calls.jsonl');
  // A stand-in hf that records its arguments and the token settings it saw.
  const bin = path.join(dir, 'bin');
  mkdirSync(bin);
  writeFileSync(
    path.join(bin, 'hf'),
    `#!${process.execPath}
require('node:fs').appendFileSync(${JSON.stringify(calls)}, JSON.stringify({
  args: process.argv.slice(2),
  token: process.env.HF_TOKEN ?? null,
  implicitToken: process.env.HF_HUB_DISABLE_IMPLICIT_TOKEN ?? null,
}) + '\\n');
if (process.argv.includes('fail.gguf')) { console.error('404 not found'); process.exit(1); }
if (process.argv.includes('--dry-run')) {
  console.log('[dry-run] Will download 1 files (out of 1) totalling ' + (process.env.FAKE_HF_SIZE || '1.0G') + '.');
}
`,
  );
  chmodSync(path.join(bin, 'hf'), 0o755);
  vi.stubEnv('PATH', [bin, process.env['PATH']].join(path.delimiter));
  vi.stubEnv('HF_HUB_CACHE', path.join(dir, 'hub'));
  vi.stubEnv('HF_TOKEN', 'hf_secret');
});

afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(dir, { recursive: true, force: true });
});

const recorded = () =>
  readFileSync(calls, 'utf8')
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line));

function context(setValue = vi.fn()) {
  return createMockCommandContext({
    services: {
      settings: {
        merged: { localModels: local },
        setValue,
      } as unknown as LoadedSettings,
    },
  });
}

const sub = (name: string) =>
  modelsCommand.subCommands!.find((command) => command.name === name)!;

describe('/models', () => {
  it('lists the local models and marks the downloaded ones', async () => {
    const snapshot = path.join(
      dir,
      'hub',
      'models--Qwen--Qwen3-4B-GGUF',
      'snapshots',
      COMMIT,
    );
    mkdirSync(snapshot, { recursive: true });
    writeFileSync(path.join(snapshot, 'Qwen3-4B-Q4_K_M.gguf'), 'x');
    mkdirSync(path.join(dir, 'hub', 'models--Qwen--Qwen3-4B-GGUF', 'refs'));
    writeFileSync(
      path.join(dir, 'hub', 'models--Qwen--Qwen3-4B-GGUF', 'refs', 'main'),
      COMMIT,
    );

    const result = await modelsCommand.action!(context(), '');

    expect(result).toMatchObject({ type: 'message', messageType: 'info' });
    const content = (result as { content: string }).content;
    expect(content).toContain(
      '✓ q-small  Qwen/Qwen3-4B-GGUF/Qwen3-4B-Q4_K_M.gguf',
    );
    expect(content).toContain(
      '  q-big  Qwen/Qwen3-14B-GGUF/Qwen3-14B-Q4_K_M.gguf',
    );
  });

  it('downloads a listed model by id with hf, without the token', async () => {
    const ctx = context();
    const result = await sub('download').action!(ctx, 'q-big');

    expect(recorded()).toEqual(
      [['--dry-run'], []].map((extra) => ({
        args: [
          'download',
          'Qwen/Qwen3-14B-GGUF',
          'Qwen3-14B-Q4_K_M.gguf',
          ...extra,
        ],
        token: null,
        implicitToken: '1',
      })),
    );
    expect(result).toMatchObject({
      messageType: 'info',
      content: 'Downloaded q-big. Switch to it with /model q-big.',
    });
  });

  it('adds a new repo and file to localModels and downloads it', async () => {
    const setValue = vi.fn();
    await sub('download').action!(
      context(setValue),
      'unsloth/Qwen3.6-35B-A3B-GGUF Qwen3.6-35B-A3B-UD-IQ4_XS.gguf',
    );

    expect(setValue).toHaveBeenCalledWith(SettingScope.User, 'localModels', [
      ...local,
      {
        id: 'qwen3.6-35b-a3b-ud-iq4_xs',
        repo: 'unsloth/Qwen3.6-35B-A3B-GGUF',
        file: 'Qwen3.6-35B-A3B-UD-IQ4_XS.gguf',
      },
    ]);
    expect(recorded()[1].args).toEqual([
      'download',
      'unsloth/Qwen3.6-35B-A3B-GGUF',
      'Qwen3.6-35B-A3B-UD-IQ4_XS.gguf',
    ]);
  });

  it('lists an added model in this session, so /model can switch to it', async () => {
    let listed: unknown = local;
    const settings = {
      get merged() {
        return { localModels: listed };
      },
      setValue: vi.fn((_scope: SettingScope, _key: string, value: unknown) => {
        listed = value;
      }),
    } as unknown as LoadedSettings;
    const reloadModelProvidersConfig = vi.fn();
    const setModels = vi.spyOn(getLocalModelServer(), 'setModels');
    const ctx = createMockCommandContext();
    ctx.services.settings = settings;
    ctx.services.config = {
      reloadModelProvidersConfig,
    } as unknown as CommandContext['services']['config'];
    try {
      await sub('download').action!(
        ctx,
        'unsloth/Qwen3.6-35B-A3B-GGUF Qwen3.6-35B-A3B-UD-IQ4_XS.gguf',
      );
      const ids = (
        reloadModelProvidersConfig.mock.calls[0][0] as {
          openai: Array<{ id: string }>;
        }
      ).openai.map((entry) => entry.id);
      expect(ids).toEqual(['q-small', 'q-big', 'qwen3.6-35b-a3b-ud-iq4_xs']);
      expect(setModels).toHaveBeenCalledWith(listed);
    } finally {
      setModels.mockRestore();
    }
  });

  describe('with a GPU that shares system memory', () => {
    const mac = process.platform === 'darwin';
    beforeEach(() => {
      gpu.budget = { limit: 16 * 1024 ** 3, unified: true };
    });
    afterEach(() => {
      gpu.budget = { limit: 1024 ** 4, unified: false };
      gpu.bytes = undefined;
      gpu.experts = [];
    });

    it('refuses a file too big for the memory of the Mac before downloading or listing it', async () => {
      vi.stubEnv('FAKE_HF_SIZE', '22.0G');
      const setValue = vi.fn();
      const result = await sub('download').action!(
        context(setValue),
        'Abiray/Qwen3.6-35B-A3B-heretic-GGUF Qwen3.6-35B-A3B-heretic-Q4_K_S.gguf',
      );
      expect(result).toMatchObject({
        messageType: 'error',
        content: expect.stringContaining(
          mac
            ? 'Not downloaded. qwen3.6-35b-a3b-heretic-q4_k_s is 22.0 GB, more than a 24 GB Mac can hold beside macOS and other apps.'
            : "Not downloaded. qwen3.6-35b-a3b-heretic-q4_k_s is 22.0 GB, more than this computer's 24 GB of memory can hold beside the system and other apps.",
        ),
      });
      expect(recorded().map((call) => call.args)).toEqual([
        [
          'download',
          'Abiray/Qwen3.6-35B-A3B-heretic-GGUF',
          'Qwen3.6-35B-A3B-heretic-Q4_K_S.gguf',
          '--dry-run',
        ],
      ]);
      expect(setValue).not.toHaveBeenCalled();
    });

    it('downloads a file that fits', async () => {
      vi.stubEnv('FAKE_HF_SIZE', '13.7G');
      await sub('download').action!(context(), 'q-small');
      expect(recorded().map((call) => call.args)).toEqual([
        ['download', 'Qwen/Qwen3-4B-GGUF', 'Qwen3-4B-Q4_K_M.gguf', '--dry-run'],
        ['download', 'Qwen/Qwen3-4B-GGUF', 'Qwen3-4B-Q4_K_M.gguf'],
      ]);
    });

    it('downloads a mixture-of-experts file too big for the GPU and says it runs partly on the CPU', async () => {
      vi.stubEnv('FAKE_HF_SIZE', '16.8G');
      gpu.bytes = 16_764_764_768;
      gpu.experts = [396, 396, ...Array<number>(38).fill(364)].map(
        (mib) => mib * 1024 ** 2,
      );
      const result = await sub('download').action!(context(), 'q-big');
      expect(recorded()).toHaveLength(2);
      expect(result).toMatchObject({
        messageType: 'info',
        content: mac
          ? 'Downloaded q-big. Switch to it with /model q-big. It is too big for the GPU, so the experts of 3 of its layers run on the CPU, which makes it slower.'
          : 'Downloaded q-big. Switch to it with /model q-big. It is too big for the GPU, so part of it runs on the CPU, which makes it slower.',
      });
    });

    it('says when a downloaded dense file cannot run', async () => {
      vi.stubEnv('FAKE_HF_SIZE', '18.0G');
      gpu.bytes = 18e9;
      const result = await sub('download').action!(context(), 'q-big');
      expect(result).toMatchObject({
        messageType: 'error',
        content: expect.stringContaining(
          mac
            ? 'Downloaded, but it cannot run on this machine. q-big is 18.0 GB, but macOS lets the GPU use only about 17.2 GB'
            : 'Downloaded, but it cannot run on this machine. q-big is 18.0 GB, but the GPU can use only about 17.2 GB',
        ),
      });
    });
  });

  it('reports a failed download with the output of hf', async () => {
    const result = await sub('download').action!(
      context(),
      'Qwen/Qwen3-14B-GGUF fail.gguf',
    );
    expect(result).toMatchObject({
      messageType: 'error',
      content: 'hf download failed:\n404 not found',
    });
  });

  describe('a model with a draft', () => {
    const drafted = (draftFile = 'Qwen3.8-27B-DFlash2-Q4_K_M.gguf') => ({
      id: 'q-drafted',
      repo: 'unsloth/Qwen3.8-27B-GGUF',
      file: 'Qwen3.8-27B-UD-IQ3_XXS.gguf',
      draft: { repo: 'z-lab/Qwen3.8-27B-DFlash2-GGUF', file: draftFile },
    });
    const withDraft = (draftFile?: string) =>
      createMockCommandContext({
        services: {
          settings: {
            merged: { localModels: [drafted(draftFile)] },
            setValue: vi.fn(),
          } as unknown as LoadedSettings,
        },
      });

    it('downloads the draft after the model', async () => {
      const result = await sub('download').action!(withDraft(), 'q-drafted');
      expect(recorded().map((call) => call.args)).toEqual([
        [
          'download',
          'unsloth/Qwen3.8-27B-GGUF',
          'Qwen3.8-27B-UD-IQ3_XXS.gguf',
          '--dry-run',
        ],
        ['download', 'unsloth/Qwen3.8-27B-GGUF', 'Qwen3.8-27B-UD-IQ3_XXS.gguf'],
        [
          'download',
          'z-lab/Qwen3.8-27B-DFlash2-GGUF',
          'Qwen3.8-27B-DFlash2-Q4_K_M.gguf',
        ],
      ]);
      expect(result).toMatchObject({ messageType: 'info' });
    });

    it('says the model runs without a draft that failed to download', async () => {
      const result = await sub('download').action!(
        withDraft('fail.gguf'),
        'q-drafted',
      );
      expect(result).toMatchObject({
        messageType: 'error',
        content:
          'Downloaded q-drafted, but its draft model failed; it runs without it:\n404 not found',
      });
    });

    it('shows under /models whether the draft is downloaded', async () => {
      const before = await modelsCommand.action!(withDraft(), '');
      expect((before as { content: string }).content).toContain(
        'draft z-lab/Qwen3.8-27B-DFlash2-GGUF/Qwen3.8-27B-DFlash2-Q4_K_M.gguf (not downloaded)',
      );

      const repo = path.join(
        dir,
        'hub',
        'models--z-lab--Qwen3.8-27B-DFlash2-GGUF',
      );
      mkdirSync(path.join(repo, 'snapshots', COMMIT), { recursive: true });
      writeFileSync(
        path.join(repo, 'snapshots', COMMIT, 'Qwen3.8-27B-DFlash2-Q4_K_M.gguf'),
        'x',
      );
      mkdirSync(path.join(repo, 'refs'));
      writeFileSync(path.join(repo, 'refs', 'main'), COMMIT);

      const after = await modelsCommand.action!(withDraft(), '');
      expect((after as { content: string }).content).toContain(
        'draft z-lab/Qwen3.8-27B-DFlash2-GGUF/Qwen3.8-27B-DFlash2-Q4_K_M.gguf ✓',
      );
    });
  });

  it.each([
    ['nothing', ''],
    ['an unknown id', 'nope'],
    ['an option instead of a file', 'Qwen/Qwen3-14B-GGUF --local-dir=x.gguf'],
    ['a bad repo', '../x y.gguf'],
  ])('refuses %s without running hf', async (_label, args) => {
    const setValue = vi.fn();
    const result = await sub('download').action!(context(setValue), args);
    expect(result).toMatchObject({ messageType: 'error' });
    expect(setValue).not.toHaveBeenCalled();
    expect(() => recorded()).toThrow();
  });

  it('removes a model by id or repo with hf cache rm', async () => {
    await sub('remove').action!(context(), 'q-small');
    await sub('remove').action!(context(), 'unsloth/Qwen3.6-35B-A3B-GGUF');
    expect(recorded().map((call) => call.args)).toEqual([
      ['cache', 'rm', 'model/Qwen/Qwen3-4B-GGUF', '-y'],
      ['cache', 'rm', 'model/unsloth/Qwen3.6-35B-A3B-GGUF', '-y'],
    ]);
  });

  it('refuses to remove something that is not a repo', async () => {
    const result = await sub('remove').action!(context(), '--all');
    expect(result).toMatchObject({ messageType: 'error' });
    expect(() => recorded()).toThrow();
  });
});

describe('/models speculation', () => {
  afterEach(() => getLocalModelServer().setSpeculation(true));

  /** Settings whose `merged` follows setValue, like LoadedSettings. */
  function speculationContext(systemValue?: boolean) {
    let user: boolean | undefined;
    const setValue = vi.fn((_scope: SettingScope, _key: string, value) => {
      user = value as boolean;
    });
    const ctx = createMockCommandContext();
    ctx.services.settings = {
      get merged() {
        return { localModels: local, speculativeDecoding: systemValue ?? user };
      },
      setValue,
    } as unknown as LoadedSettings;
    return { ctx, setValue };
  }
  const speculation = sub('speculation');
  const turn = (name: string) =>
    speculation.subCommands!.find((command) => command.name === name)!;

  it('reports whether it is on', async () => {
    const result = await speculation.action!(speculationContext().ctx, '');
    expect(result).toMatchObject({
      messageType: 'info',
      content: expect.stringContaining('Speculative decoding is on.'),
    });
  });

  it('turns it off and on in the user settings and the engine', async () => {
    const { ctx, setValue } = speculationContext();
    const off = await turn('off').action!(ctx, '');
    expect(setValue).toHaveBeenLastCalledWith(
      SettingScope.User,
      'speculativeDecoding',
      false,
    );
    expect(getLocalModelServer().isSpeculationEnabled()).toBe(false);
    expect(off).toMatchObject({
      messageType: 'info',
      content: expect.stringContaining('Speculative decoding is off.'),
    });

    await turn('on').action!(ctx, '');
    expect(setValue).toHaveBeenLastCalledWith(
      SettingScope.User,
      'speculativeDecoding',
      true,
    );
    expect(getLocalModelServer().isSpeculationEnabled()).toBe(true);
  });

  it('says when a system setting keeps it on', async () => {
    const result = await turn('off').action!(speculationContext(true).ctx, '');
    expect(getLocalModelServer().isSpeculationEnabled()).toBe(true);
    expect(result).toMatchObject({
      messageType: 'error',
      content: expect.stringContaining('stays on'),
    });
  });

  it('shows the state under /models', async () => {
    getLocalModelServer().setSpeculation(false);
    const result = await modelsCommand.action!(context(), '');
    expect((result as { content: string }).content).toContain(
      'Speculative decoding is off',
    );
  });
});

describe('/models setup', () => {
  afterEach(() => {
    setHardwareProfileForTesting(undefined);
    getLocalModelServer().setEnginePath(undefined);
  });

  it('shows the GPUs and the build of the engine for this machine', async () => {
    setHardwareProfileForTesting({
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
    });
    getLocalModelServer().setEnginePath('C:\\llama.cpp\\llama-server.exe');
    const result = await sub('setup').action!(context(), '');
    const content = (result as { content: string }).content;
    expect(content).toContain(
      'AMD Radeon(TM) 780M: shares system memory, 1.0 GB reserved, up to 17.0 GB usable',
    );
    expect(content).toContain(
      'Engine: C:\\llama.cpp\\llama-server.exe is not a program qwen can run',
    );
    expect(content).toContain(
      '-DLLAMA_OPENSSL=OFF -DGGML_RPC=ON -DGGML_VULKAN=ON',
    );
  });
});

describe('networkConfinement', () => {
  it('names how the engine is kept off the network on each platform', () => {
    const unused = () => {
      throw new Error('probed');
    };
    expect(networkConfinement('darwin', unused)).toMatch(/Seatbelt/);
    expect(networkConfinement('win32', unused)).toMatch(/--offline/);
    expect(
      networkConfinement('linux', () => ({
        kind: 'bwrap',
        tool: '/usr/bin/bwrap',
      })),
    ).toMatch(
      /without network access \(bwrap\), reached through a Unix socket/,
    );
    expect(networkConfinement('linux', () => ({ kind: 'none' }))).toMatch(
      /Install bubblewrap/,
    );
  });
});

describe('/models plan', () => {
  it('says how to download a model that is not downloaded', async () => {
    const result = await sub('plan').action!(context(), 'q-big');
    expect(result).toMatchObject({
      messageType: 'error',
      content: expect.stringMatching(/not downloaded/),
    });
  });

  it('refuses a name that is not a local model', async () => {
    const result = await sub('plan').action!(context(), 'nope');
    expect(result).toMatchObject({
      messageType: 'error',
      content: 'nope is not a local model; /models lists them.',
    });
  });

  it('shows the planned options of a downloaded model', async () => {
    const snapshot = path.join(
      dir,
      'hub',
      'models--Qwen--Qwen3-4B-GGUF',
      'snapshots',
      COMMIT,
    );
    mkdirSync(snapshot, { recursive: true });
    writeFileSync(path.join(snapshot, 'Qwen3-4B-Q4_K_M.gguf'), 'x');
    mkdirSync(path.join(dir, 'hub', 'models--Qwen--Qwen3-4B-GGUF', 'refs'));
    writeFileSync(
      path.join(dir, 'hub', 'models--Qwen--Qwen3-4B-GGUF', 'refs', 'main'),
      COMMIT,
    );
    gpu.bytes = 2.5 * 1024 ** 3;
    try {
      const result = await sub('plan').action!(context(), 'q-small');
      const content = (result as { content: string }).content;
      expect(content).toContain('Its GGUF metadata could not be read.');
      expect(content).toContain('Planned options: -b 2048 -ub 2048');
    } finally {
      gpu.bytes = undefined;
    }
  });
});

describe('fitSummary', () => {
  it('says in a few words how a model runs here', () => {
    expect(fitSummary({ cpuMoeLayers: 0 }, true)).toBe('fits the GPU');
    expect(fitSummary({ cpuMoeLayers: 3, partial: true }, true)).toBe(
      'partly on the CPU (slower)',
    );
    expect(fitSummary({ cpuMoeLayers: 0, partial: true }, false)).toBe(
      'runs on the CPU',
    );
    expect(fitSummary({ problem: 'Too big.' }, true)).toBe(
      'cannot run here: Too big.',
    );
  });
});
