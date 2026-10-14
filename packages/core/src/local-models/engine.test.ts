/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_ENGINE_OPTIONS,
  engineCommand,
  startLocalModelEngine,
} from './engine.js';
import type { LocalModelConfig } from './local-models.js';

// The GPU memory limit of the test machine must not decide these tests.
const gpu = vi.hoisted(() => ({ limit: undefined as number | undefined }));
vi.mock('./gpu-memory.js', async (importActual) => ({
  ...(await importActual<typeof import('./gpu-memory.js')>()),
  appleGpuMemoryLimit: () => gpu.limit,
}));

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
const model = args[args.indexOf('--model') + 1];
if (model.includes('broken')) {
  console.error('error loading model: ' + model);
  process.exit(3);
}
require('node:http')
  .createServer((req, res) => res.end('{}'))
  .listen(Number(args[args.indexOf('--port') + 1]), '127.0.0.1');
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
    ).toThrow(
      /llama-server was not found on PATH[\s\S]*brew install llama\.cpp/,
    );
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
  });

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

  it('refuses a model too big for the GPU memory before starting the engine', async () => {
    download(model.file);
    gpu.limit = 1024;
    try {
      await expect(startLocalModelEngine(model, 'k')).rejects.toThrow(
        /is 0\.0 GB, but macOS lets the GPU use only about 0\.0 GB on this Mac/,
      );
    } finally {
      gpu.limit = undefined;
    }
  });

  it('fails before starting anything when the model is not downloaded', async () => {
    await expect(startLocalModelEngine(model, 'k')).rejects.toThrow(
      /not downloaded[\s\S]*hf download Qwen\/Qwen3-8B-GGUF/,
    );
  });
});
