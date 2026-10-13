/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  huggingFaceDownloadCommand,
  huggingFaceHubCacheDir,
  resolveLocalModelPath,
} from './hf-cache.js';
import type { LocalModelConfig } from './local-models.js';

const COMMIT = '75f1b73b657a50f5092502799457ccb4a4a1f9df';
const gguf: LocalModelConfig = {
  id: 'q',
  name: 'Qwen GGUF',
  repo: 'Qwen/Qwen3-8B-GGUF',
  file: 'Qwen3-8B-Q4_K_M.gguf',
};

describe('huggingFaceHubCacheDir', () => {
  const home = os.homedir();
  it.each([
    [{}, path.join(home, '.cache', 'huggingface', 'hub')],
    [{ XDG_CACHE_HOME: '/x' }, path.join('/x', 'huggingface', 'hub')],
    [{ HF_HOME: '~/hf', XDG_CACHE_HOME: '/x' }, path.join(home, 'hf', 'hub')],
    [{ HUGGINGFACE_HUB_CACHE: '/legacy', HF_HOME: '/h' }, '/legacy'],
    [{ HF_HUB_CACHE: '/new', HUGGINGFACE_HUB_CACHE: '/legacy' }, '/new'],
  ])('resolves %o like huggingface_hub', (env, expected) => {
    expect(huggingFaceHubCacheDir(env)).toBe(expected);
  });
});

describe('huggingFaceDownloadCommand', () => {
  it('names the file, or every part of a split file', () => {
    expect(huggingFaceDownloadCommand(gguf)).toBe(
      'hf download Qwen/Qwen3-8B-GGUF Qwen3-8B-Q4_K_M.gguf',
    );
    expect(
      huggingFaceDownloadCommand({
        ...gguf,
        file: 'Q8_0/Big-Q8_0-00001-of-00003.gguf',
      }),
    ).toBe(
      'hf download Qwen/Qwen3-8B-GGUF --include "Q8_0/Big-Q8_0-*-of-00003.gguf"',
    );
  });
});

describe('resolveLocalModelPath', () => {
  let cache: string;
  const snapshotOf = (repo: string) =>
    path.join(cache, `models--${repo.replace('/', '--')}`, 'snapshots', COMMIT);
  const download = (repo: string, files: Record<string, string>) => {
    const repoDir = path.join(cache, `models--${repo.replace('/', '--')}`);
    mkdirSync(path.join(repoDir, 'refs'), { recursive: true });
    writeFileSync(path.join(repoDir, 'refs', 'main'), `${COMMIT}\n`);
    for (const [file, content] of Object.entries(files)) {
      const target = path.join(repoDir, 'snapshots', COMMIT, file);
      mkdirSync(path.dirname(target), { recursive: true });
      writeFileSync(target, content);
    }
  };

  beforeEach(() => {
    cache = mkdtempSync(path.join(os.tmpdir(), 'hf-cache-'));
  });
  afterEach(() => {
    rmSync(cache, { recursive: true, force: true });
  });

  it('reports a missing model with its download command', () => {
    expect(() => resolveLocalModelPath(gguf, cache)).toThrow(
      /Qwen GGUF is not downloaded[\s\S]*hf download Qwen\/Qwen3-8B-GGUF Qwen3-8B-Q4_K_M\.gguf[\s\S]*qwen itself never does/,
    );
  });

  it('returns the GGUF file in the snapshot named by refs/main', () => {
    download(gguf.repo, { 'Qwen3-8B-Q4_K_M.gguf': 'x' });
    expect(resolveLocalModelPath(gguf, cache)).toBe(
      path.join(snapshotOf(gguf.repo), 'Qwen3-8B-Q4_K_M.gguf'),
    );
  });

  it('needs every part of a split GGUF', () => {
    const split = { ...gguf, file: 'm-00001-of-00002.gguf' };
    download(gguf.repo, { 'm-00001-of-00002.gguf': 'x' });
    expect(() => resolveLocalModelPath(split, cache)).toThrow(/not downloaded/);
    download(gguf.repo, { 'm-00002-of-00002.gguf': 'x' });
    expect(resolveLocalModelPath(split, cache)).toBe(
      path.join(snapshotOf(gguf.repo), 'm-00001-of-00002.gguf'),
    );
  });

  it('ignores a ref that is not a commit hash', () => {
    download(gguf.repo, { 'Qwen3-8B-Q4_K_M.gguf': 'x' });
    writeFileSync(
      path.join(cache, 'models--Qwen--Qwen3-8B-GGUF', 'refs', 'main'),
      '../../elsewhere',
    );
    expect(() => resolveLocalModelPath(gguf, cache)).toThrow(/not downloaded/);
  });
});
