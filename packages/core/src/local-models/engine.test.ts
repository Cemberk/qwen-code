/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_ENGINE_OPTIONS,
  engineCommand,
  engineEnv,
  startLocalModelEngine,
} from './engine.js';
import type { LocalModelConfig } from './local-models.js';
import { setConfinementForTesting } from './confinement.js';

// The GPU and memory of the test machine must not decide these tests.
const gpu = vi.hoisted(() => ({
  limit: undefined as number | undefined,
  bytes: undefined as number | undefined,
  experts: [] as number[],
  others: undefined as number | undefined,
}));
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

vi.mock('./hardware.js', async (importActual) => {
  const actual = await importActual<typeof import('./hardware.js')>();
  return { ...actual, sharedGpuMemoryInUse: () => gpu.others };
});

vi.mock('./gpu-memory.js', async (importActual) => {
  const actual = await importActual<typeof import('./gpu-memory.js')>();
  return {
    ...actual,
    gpuBudget: () =>
      gpu.limit === undefined ? undefined : { limit: gpu.limit, unified: true },
    systemMemoryBytes: () => 24 * 1024 ** 3,
    localModelBytes: (model: LocalModelConfig) =>
      gpu.bytes ?? actual.localModelBytes(model),
    localModelExpertBytes: () => gpu.experts,
  };
});

const model: LocalModelConfig = {
  id: 'q',
  name: 'Qwen GGUF',
  repo: 'Qwen/Qwen3-8B-GGUF',
  file: 'Qwen3-8B-Q4_K_M.gguf',
  contextSize: 16384,
};

// Stands in for llama-server: serves 200 on every path, or exits with an
// error when the model path says "broken".
const FAKE_ENGINE = `#!${process.execPath}
const args = process.argv.slice(2);
// Answers no device list, so planning falls back to the machine's GPUs.
if (args.includes('--list-devices')) process.exit(1);
const model = args[args.indexOf('--model') + 1];
if (model.includes('broken')) {
  console.error('error loading model: ' + model);
  process.exit(3);
}
const host = args[args.indexOf('--host') + 1];
const server = require('node:http').createServer((req, res) =>
  res.end(req.url === '/args' ? JSON.stringify(args) : '{}'),
);
if (host.endsWith('.sock')) server.listen(host);
else server.listen(Number(args[args.indexOf('--port') + 1]), host);
`;

// Stands in for unshare: runs the command after "--", as unshare would in a
// new network namespace.
const FAKE_UNSHARE = `#!${process.execPath}
const args = process.argv.slice(2);
const rest = args.slice(args.indexOf('--') + 1);
const child = require('node:child_process').spawn(rest[0], rest.slice(1), { stdio: 'inherit' });
child.on('exit', (code) => process.exit(code ?? 1));
process.on('SIGTERM', () => child.kill('SIGTERM'));
`;

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), 'local-engine-'));
});
afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(dir, { recursive: true, force: true });
});

function installFakeEngine(): string {
  const bin = path.join(dir, 'bin');
  mkdirSync(bin);
  writeFileSync(path.join(bin, 'llama-server'), FAKE_ENGINE);
  chmodSync(path.join(bin, 'llama-server'), 0o755);
  return bin;
}

describe('engineCommand', () => {
  const env = (bin: string): NodeJS.ProcessEnv => ({
    PATH: ['relative/bin', bin].join(path.delimiter),
    HOME: '/home/u',
    TMPDIR: '/tmp/u',
    HF_TOKEN: 'secret',
    LLAMA_ARG_HF_REPO: 'someone/else',
    LLAMA_ARG_TOOLS: 'all',
    OPENAI_API_KEY: 'sk-other',
  });

  it('runs llama-server on loopback, offline, with n-gram speculation, the key and nothing else from the environment', () => {
    const bin = installFakeEngine();
    const command = engineCommand(
      model,
      '/m.gguf',
      4321,
      'k',
      DEFAULT_ENGINE_OPTIONS,
      env(bin),
      'linux',
    );
    expect(command).toEqual({
      command: path.join(bin, 'llama-server'),
      args: [
        '--model',
        '/m.gguf',
        '--host',
        '127.0.0.1',
        '--port',
        '4321',
        '--ctx-size',
        '16384',
        '--alias',
        'q',
        '--jinja',
        '--offline',
        '--no-webui',
        '--no-slots',
        '--metrics',
        '--temp',
        '0.6',
        '--top-p',
        '0.95',
        '--top-k',
        '20',
        '--min-p',
        '0',
        '--spec-type',
        'ngram-simple',
      ],
      env: {
        PATH: env(bin)['PATH'],
        HOME: '/home/u',
        TMPDIR: '/tmp/u',
        LLAMA_API_KEY: 'k',
      },
    });
  });

  it('keeps what Windows programs and GPU drivers need, and ggml tuning, but no llama.cpp settings', () => {
    expect(
      engineEnv(
        'k',
        {
          PATH: 'C:\\bin',
          SystemRoot: 'C:\\Windows',
          TEMP: 'C:\\t',
          LOCALAPPDATA: 'C:\\Users\\u\\AppData\\Local',
          HIP_VISIBLE_DEVICES: '0',
          HSA_OVERRIDE_GFX_VERSION: '11.0.0',
          GGML_VK_VISIBLE_DEVICES: '1',
          LLAMA_ARG_HF_REPO: 'someone/else',
          HF_TOKEN: 'secret',
          LD_LIBRARY_PATH: '/opt/rocm/lib',
        },
        'win32',
      ),
    ).toEqual({
      LLAMA_API_KEY: 'k',
      PATH: 'C:\\bin',
      SystemRoot: 'C:\\Windows',
      TEMP: 'C:\\t',
      LOCALAPPDATA: 'C:\\Users\\u\\AppData\\Local',
      HIP_VISIBLE_DEVICES: '0',
      HSA_OVERRIDE_GFX_VERSION: '11.0.0',
      GGML_VK_VISIBLE_DEVICES: '1',
    });
    expect(
      engineEnv(
        'k',
        { LD_LIBRARY_PATH: '/opt/rocm/lib', SystemRoot: 'x' },
        'linux',
      ),
    ).toEqual({ LLAMA_API_KEY: 'k', LD_LIBRARY_PATH: '/opt/rocm/lib' });
  });

  it('runs the llama-server named by localModelEngine instead of the one on PATH', () => {
    const bin = installFakeEngine();
    const own = path.join(dir, 'own-llama-server');
    writeFileSync(own, FAKE_ENGINE);
    chmodSync(own, 0o755);
    const command = (enginePath: string) =>
      engineCommand(
        model,
        '/m.gguf',
        1,
        'k',
        { speculation: true, enginePath },
        env(bin),
        'linux',
      );
    expect(command(own).command).toBe(own);
    expect(() => command('llama-server')).toThrow(/must be the full path/);
    expect(() => command(path.join(dir, 'missing'))).toThrow(
      /not a program qwen can run[\s\S]*\/models setup/,
    );
  });

  it('listens on a socket inside bwrap without network access when confined on Linux', () => {
    const bin = installFakeEngine();
    const command = engineCommand(
      model,
      '/m.gguf',
      8080,
      'k',
      DEFAULT_ENGINE_OPTIONS,
      env(bin),
      'linux',
      {
        socketPath: '/tmp/qwen-engine-x/engine.sock',
        confinement: { kind: 'bwrap', tool: '/usr/bin/bwrap' },
      },
    );
    expect(command.command).toBe('/usr/bin/bwrap');
    expect(command.args.slice(0, 7)).toEqual([
      '--dev-bind',
      '/',
      '/',
      '--unshare-net',
      '--die-with-parent',
      '--',
      path.join(bin, 'llama-server'),
    ]);
    expect(command.args).toContain('/tmp/qwen-engine-x/engine.sock');
  });

  it('drafts with the draft model instead of n-grams when one is given', () => {
    const bin = installFakeEngine();
    const args = (speculation: boolean) =>
      engineCommand(
        model,
        '/m.gguf',
        1,
        'k',
        { speculation },
        env(bin),
        'linux',
        { draftPath: '/d.gguf' },
      ).args;
    expect(args(true).slice(-4)).toEqual([
      '--spec-draft-model',
      '/d.gguf',
      '--spec-draft-n-max',
      '6',
    ]);
    expect(args(true)).not.toContain('ngram-simple');
    expect(args(false)).not.toContain('--spec-draft-model');
  });

  it('gives the engine a conversation slot, a side-query slot and the prompt cache folder', () => {
    const bin = installFakeEngine();
    const command = engineCommand(
      model,
      '/m.gguf',
      1,
      'k',
      DEFAULT_ENGINE_OPTIONS,
      env(bin),
      'linux',
      { promptCacheDir: '/cache/prompts' },
    );
    expect(command.args.slice(-5)).toEqual([
      '--parallel',
      '2',
      '--kv-unified',
      '--slot-save-path',
      `/cache/prompts${path.sep}`,
    ]);
  });

  it('serves as many conversations as asked, and exits with its parent when told to', () => {
    const bin = installFakeEngine();
    const command = engineCommand(
      model,
      '/m.gguf',
      1,
      'k',
      { ...DEFAULT_ENGINE_OPTIONS, slots: 6 },
      env(bin),
      'linux',
      { promptCacheDir: '/cache/prompts', exitWithParent: true },
    );
    expect(command.args.slice(-6)).toEqual([
      '--exit-with-parent',
      '--parallel',
      '6',
      '--kv-unified',
      '--slot-save-path',
      `/cache/prompts${path.sep}`,
    ]);
  });

  it('keeps the experts of the first layers in memory when asked to', () => {
    const bin = installFakeEngine();
    const args = (cpuMoeLayers?: number) =>
      engineCommand(
        model,
        '/m.gguf',
        1,
        'k',
        DEFAULT_ENGINE_OPTIONS,
        env(bin),
        'linux',
        { cpuMoeLayers },
      ).args;
    expect(args(3).join(' ')).toContain('--n-cpu-moe 3 --load-mode none');
    expect(args(0)).not.toContain('--n-cpu-moe');
    expect(args()).not.toContain('--load-mode');
  });

  it('leaves out speculative decoding when it is turned off', () => {
    const bin = installFakeEngine();
    const command = engineCommand(
      model,
      '/m.gguf',
      1,
      'k',
      { speculation: false },
      env(bin),
      'linux',
    );
    expect(command.args).not.toContain('--spec-type');
    expect(command.args).toContain('--offline');
  });

  it('wraps the engine in a Seatbelt profile that confines its network and writes on macOS', () => {
    const bin = installFakeEngine();
    const command = engineCommand(
      model,
      '/m.gguf',
      1,
      'k',
      DEFAULT_ENGINE_OPTIONS,
      env(bin),
      'darwin',
    );
    expect(command.command).toBe('/usr/bin/sandbox-exec');
    expect(command.args.slice(0, 3)).toEqual(['-D', 'HOME=/home/u', '-p']);
    const profile = command.args[3];
    expect(profile).toContain('(deny network-outbound)');
    expect(profile).toContain(
      '(allow network-outbound (remote ip "localhost:*"))',
    );
    expect(profile).toContain('(deny file-write*)');
    expect(command.args[4]).toBe(path.join(bin, 'llama-server'));
  });

  it('lets the engine inherit qwen’s own Seatbelt sandbox, which cannot nest', () => {
    const bin = installFakeEngine();
    const command = engineCommand(
      model,
      '/m.gguf',
      1,
      'k',
      DEFAULT_ENGINE_OPTIONS,
      { ...env(bin), SANDBOX: 'sandbox-exec' },
      'darwin',
    );
    expect(command.command).toBe(path.join(bin, 'llama-server'));
  });

  it('ignores relative PATH entries and says how to install a missing engine', () => {
    const relative = path.join(dir, 'relative');
    mkdirSync(relative);
    writeFileSync(path.join(relative, 'llama-server'), FAKE_ENGINE);
    chmodSync(path.join(relative, 'llama-server'), 0o755);
    expect(() =>
      engineCommand(
        model,
        '/m.gguf',
        1,
        'k',
        DEFAULT_ENGINE_OPTIONS,
        { PATH: path.relative(process.cwd(), relative) },
        'linux',
      ),
    ).toThrow(/llama-server was not found on PATH[\s\S]*\/models setup/);
  });
});

describe('startLocalModelEngine', () => {
  const COMMIT = '75f1b73b657a50f5092502799457ccb4a4a1f9df';
  const download = (file: string) => {
    const repoDir = path.join(dir, 'hub', 'models--Qwen--Qwen3-8B-GGUF');
    mkdirSync(path.join(repoDir, 'refs'), { recursive: true });
    writeFileSync(path.join(repoDir, 'refs', 'main'), COMMIT);
    mkdirSync(path.join(repoDir, 'snapshots', COMMIT), { recursive: true });
    writeFileSync(path.join(repoDir, 'snapshots', COMMIT, file), 'x');
  };

  beforeEach(() => {
    vi.stubEnv(
      'PATH',
      [installFakeEngine(), process.env['PATH']].join(path.delimiter),
    );
    vi.stubEnv('HF_HUB_CACHE', path.join(dir, 'hub'));
    // The tests may already run inside a Seatbelt sandbox, which cannot nest.
    vi.stubEnv('SANDBOX', 'sandbox-exec');
    // The tools of the test machine must not decide these tests.
    setConfinementForTesting({ kind: 'none' });
  });
  afterEach(() => setConfinementForTesting(undefined));

  it.runIf(process.platform === 'linux')(
    'runs the engine without network access on Linux, reached through a Unix socket',
    async () => {
      download(model.file);
      const unshare = path.join(dir, 'unshare');
      writeFileSync(unshare, FAKE_UNSHARE);
      chmodSync(unshare, 0o755);
      setConfinementForTesting({ kind: 'unshare', tool: unshare });
      const engine = await startLocalModelEngine(model, 'k');
      try {
        expect(engine.baseUrl).toBe('http://localhost/v1');
        expect(engine.socketPath).toMatch(/qwen-engine-.*engine\.sock$/);
        const args = await new Promise<string[]>((resolve, reject) => {
          http
            .get({ socketPath: engine.socketPath, path: '/args' }, (res) => {
              let text = '';
              res.on('data', (chunk) => (text += chunk));
              res.on('end', () => resolve(JSON.parse(text)));
            })
            .on('error', reject);
        });
        expect(
          args.slice(args.indexOf('--host'), args.indexOf('--host') + 2),
        ).toEqual(['--host', engine.socketPath]);
      } finally {
        await engine.stop();
      }
      expect(existsSync(path.dirname(engine.socketPath!))).toBe(false);
    },
  );

  it('starts the engine on a loopback port, waits until it answers, and stops it', async () => {
    download(model.file);
    const engine = await startLocalModelEngine(model, 'k');
    expect(engine.baseUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/v1$/);
    const health = await fetch(engine.baseUrl.replace('/v1', '/health'));
    expect(health.status).toBe(200);
    expect(engine.alive).toBe(true);
    await engine.stop();
    expect(engine.alive).toBe(false);
  });

  it('fails with the engine output when the engine exits during startup', async () => {
    const broken = { ...model, file: 'broken.gguf' };
    download(broken.file);
    await expect(startLocalModelEngine(broken, 'k')).rejects.toThrow(
      /Qwen GGUF failed to start: the engine exited \(code 3\)\.\nerror loading model: .*broken\.gguf/,
    );
  });

  describe('with a model too big for the GPU', () => {
    const GIB = 1024 ** 3;
    beforeEach(() => {
      gpu.limit = 16 * GIB;
      gpu.bytes = 16 * GIB;
    });
    afterEach(() => {
      gpu.limit = undefined;
      gpu.bytes = undefined;
      gpu.experts = [];
    });

    it('runs the experts of as few first layers as needed on the CPU', async () => {
      download(model.file);
      gpu.experts = Array<number>(40).fill(0.4 * GIB);
      const engine = await startLocalModelEngine(model, 'k');
      try {
        const args = (await (
          await fetch(engine.baseUrl.replace('/v1', '/args'))
        ).json()) as string[];
        // Elsewhere llama.cpp's --fit places what does not fit.
        if (process.platform === 'darwin') {
          expect(args.join(' ')).toContain('--n-cpu-moe 4 --load-mode none');
        } else {
          expect(args).not.toContain('--n-cpu-moe');
        }
      } finally {
        await engine.stop();
      }
    });

    it('leaves room for what other programs hold of shared GPU memory', async () => {
      download(model.file);
      gpu.experts = Array<number>(40).fill(0.4 * GIB);
      gpu.others = 2 * GIB;
      try {
        const engine = await startLocalModelEngine(model, 'k');
        try {
          const args = (await (
            await fetch(engine.baseUrl.replace('/v1', '/args'))
          ).json()) as string[];
          // 16 GiB of a 16 GiB budget less 2 GiB, 1.5 GiB headroom: 9 of
          // the 0.4 GiB expert layers move, and stay mapped from the file.
          expect(args.join(' ')).toContain('--n-cpu-moe 9 --load-mode mmap');
        } finally {
          await engine.stop();
        }
      } finally {
        gpu.others = undefined;
      }
    });

    it('refuses a dense model before starting the engine', async () => {
      download(model.file);
      await expect(startLocalModelEngine(model, 'k')).rejects.toThrow(
        /is 17\.2 GB, but (?:macOS lets the GPU use only about 17\.2 GB on this Mac|the GPU can use only about 17\.2 GB of memory)/,
      );
    });
  });

  it('fails before starting anything when the model is not downloaded', async () => {
    await expect(startLocalModelEngine(model, 'k')).rejects.toThrow(
      /not downloaded[\s\S]*hf download Qwen\/Qwen3-8B-GGUF/,
    );
  });
});
