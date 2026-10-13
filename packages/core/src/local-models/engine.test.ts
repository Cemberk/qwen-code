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
import { engineCommand, startLocalModelEngine } from './engine.js';
import type { LocalModelConfig } from './local-models.js';

const gguf: LocalModelConfig = {
  id: 'q-gguf',
  name: 'Qwen GGUF',
  format: 'gguf',
  repo: 'Qwen/Qwen3-8B-GGUF',
  file: 'Qwen3-8B-Q4_K_M.gguf',
  contextSize: 16384,
};
const mlx: LocalModelConfig = {
  id: 'q-mlx',
  format: 'mlx',
  repo: 'mlx-community/Qwen3-8B-4bit',
};

// Stands in for both engines: serves 200 on every path, or exits with an
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

const QWEN3_SAMPLING = [
  '--temp',
  '0.6',
  '--top-p',
  '0.95',
  '--top-k',
  '20',
  '--min-p',
  '0',
];

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), 'local-engine-'));
});
afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(dir, { recursive: true, force: true });
});

function installFakeEngines(): string {
  const bin = path.join(dir, 'bin');
  mkdirSync(bin);
  for (const name of ['llama-server', 'mlx_lm.server']) {
    writeFileSync(path.join(bin, name), FAKE_ENGINE);
    chmodSync(path.join(bin, name), 0o755);
  }
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

  it('runs llama-server on loopback, offline, with the key and nothing else from the environment', () => {
    const bin = installFakeEngines();
    const command = engineCommand(
      gguf,
      '/m.gguf',
      4321,
      'k',
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
        'q-gguf',
        '--jinja',
        '--offline',
        '--no-webui',
        '--no-slots',
        ...QWEN3_SAMPLING,
      ],
      env: {
        PATH: env(bin)['PATH'],
        HOME: '/home/u',
        TMPDIR: '/tmp/u',
        LLAMA_API_KEY: 'k',
      },
      requestModel: undefined,
    });
  });

  it('runs mlx_lm.server on loopback with the Hugging Face hub offline', () => {
    const bin = installFakeEngines();
    const command = engineCommand(mlx, '/snap', 4321, 'k', env(bin), 'linux');
    expect(command.command).toBe(path.join(bin, 'mlx_lm.server'));
    expect(command.args).toEqual([
      '--model',
      '/snap',
      '--host',
      '127.0.0.1',
      '--port',
      '4321',
      '--allowed-origins',
      'none',
      ...QWEN3_SAMPLING,
    ]);
    // It loads whatever a request names, so requests name its own model.
    expect(command.requestModel).toBe('default_model');
    expect(command.env).toEqual({
      PATH: env(bin)['PATH'],
      HOME: '/home/u',
      TMPDIR: '/tmp/u',
      HF_HUB_OFFLINE: '1',
      HF_HUB_DISABLE_TELEMETRY: '1',
    });
  });

  it('wraps the engine in a Seatbelt profile that confines its network and writes on macOS', () => {
    const bin = installFakeEngines();
    const command = engineCommand(gguf, '/m.gguf', 1, 'k', env(bin), 'darwin');
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
    const bin = installFakeEngines();
    const command = engineCommand(
      gguf,
      '/m.gguf',
      1,
      'k',
      { ...env(bin), SANDBOX: 'sandbox-exec' },
      'darwin',
    );
    expect(command.command).toBe(path.join(bin, 'llama-server'));
  });

  it('ignores relative PATH entries and says how to install a missing engine', () => {
    const relative = path.join(dir, 'relative');
    mkdirSync(relative);
    writeFileSync(path.join(relative, 'mlx_lm.server'), FAKE_ENGINE);
    chmodSync(path.join(relative, 'mlx_lm.server'), 0o755);
    expect(() =>
      engineCommand(
        mlx,
        '/snap',
        1,
        'k',
        { PATH: path.relative(process.cwd(), relative) },
        'linux',
      ),
    ).toThrow(
      /mlx_lm\.server was not found on PATH[\s\S]*uv tool install mlx-lm/,
    );
  });
});

describe('startLocalModelEngine', () => {
  const COMMIT = '75f1b73b657a50f5092502799457ccb4a4a1f9df';
  const downloadGguf = (file: string) => {
    const repoDir = path.join(dir, 'hub', 'models--Qwen--Qwen3-8B-GGUF');
    mkdirSync(path.join(repoDir, 'refs'), { recursive: true });
    writeFileSync(path.join(repoDir, 'refs', 'main'), COMMIT);
    mkdirSync(path.join(repoDir, 'snapshots', COMMIT), { recursive: true });
    writeFileSync(path.join(repoDir, 'snapshots', COMMIT, file), 'x');
  };

  beforeEach(() => {
    vi.stubEnv(
      'PATH',
      [installFakeEngines(), process.env['PATH']].join(path.delimiter),
    );
    vi.stubEnv('HF_HUB_CACHE', path.join(dir, 'hub'));
    // The tests may already run inside a Seatbelt sandbox, which cannot nest.
    vi.stubEnv('SANDBOX', 'sandbox-exec');
  });

  it('starts the engine on a loopback port, waits until it answers, and stops it', async () => {
    downloadGguf(gguf.file!);
    const engine = await startLocalModelEngine(gguf, 'k');
    expect(engine.baseUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/v1$/);
    const health = await fetch(engine.baseUrl.replace('/v1', '/health'));
    expect(health.status).toBe(200);
    expect(engine.alive).toBe(true);
    await engine.stop();
    expect(engine.alive).toBe(false);
  });

  it('fails with the engine output when the engine exits during startup', async () => {
    const broken = { ...gguf, file: 'broken.gguf' };
    downloadGguf(broken.file);
    await expect(startLocalModelEngine(broken, 'k')).rejects.toThrow(
      /Qwen GGUF failed to start: the engine exited \(code 3\)\.\nerror loading model: .*broken\.gguf/,
    );
  });

  it('fails before starting anything when the model is not downloaded', async () => {
    await expect(startLocalModelEngine(gguf, 'k')).rejects.toThrow(
      /not downloaded[\s\S]*hf download Qwen\/Qwen3-8B-GGUF/,
    );
  });
});
