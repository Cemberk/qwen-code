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
import { getLocalModelServer } from '@qwen-code/qwen-code-core/local-models/local-model-server.js';
import { modelsCommand } from './models-command.js';
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

    expect(recorded()).toEqual([
      {
        args: ['download', 'Qwen/Qwen3-14B-GGUF', 'Qwen3-14B-Q4_K_M.gguf'],
        token: null,
        implicitToken: '1',
      },
    ]);
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
    expect(recorded()[0].args).toEqual([
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
