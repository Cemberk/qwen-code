/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Integration tests that worktree creation leaves git hook configuration
 * alone. Uses real git invocations against a temp repo because the existing
 * `gitWorktreeService.test.ts` mocks simple-git heavily, making it
 * unsuitable for verifying actual `git config` side effects.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { GitWorktreeService } from './gitWorktreeService.js';

// Real git invocations + user-global hooks (e.g. trustup) can take
// 10–20s per setUp on slower runners; bump per-test and per-hook
// timeouts so the suite isn't flaky on CI. (Phase C reviewer #4174.)
describe('GitWorktreeService.createUserWorktree() — git hooks', () => {
  vi.setConfig({ testTimeout: 30000, hookTimeout: 30000 });

  let repoRoot: string;

  beforeEach(async () => {
    repoRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'qwen-wt-hooks-'));
    execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: repoRoot });
    execFileSync('git', ['config', 'user.email', 't@e.com'], { cwd: repoRoot });
    execFileSync('git', ['config', 'user.name', 't'], { cwd: repoRoot });
    execFileSync('git', ['config', 'commit.gpgsign', 'false'], {
      cwd: repoRoot,
    });
    await fs.writeFile(path.join(repoRoot, 'README.md'), 'hi\n');
    execFileSync('git', ['add', '.'], { cwd: repoRoot });
    execFileSync('git', ['commit', '-q', '-m', 'init', '--no-verify'], {
      cwd: repoRoot,
    });
  });

  afterEach(async () => {
    await fs.rm(repoRoot, { recursive: true, force: true });
  });

  function readWorktreeConfig(worktreePath: string, key: string): string {
    try {
      return execFileSync('git', ['config', '--local', key], {
        cwd: worktreePath,
        encoding: 'utf8',
      }).trim();
    } catch {
      return '';
    }
  }

  it('never enables repository-tracked .husky hooks the user did not install', async () => {
    const huskyDir = path.join(repoRoot, '.husky');
    await fs.mkdir(huskyDir, { recursive: true });
    await fs.writeFile(path.join(huskyDir, 'pre-commit'), '#!/bin/sh\n', {
      mode: 0o755,
    });

    const svc = new GitWorktreeService(repoRoot);
    const result = await svc.createUserWorktree('husky-test');
    expect(result.success).toBe(true);

    expect(readWorktreeConfig(result.worktree!.path, 'core.hooksPath')).toBe(
      '',
    );
    expect(readWorktreeConfig(repoRoot, 'core.hooksPath')).toBe('');
  });

  it('creates the worktree', async () => {
    const svc = new GitWorktreeService(repoRoot);
    const result = await svc.createUserWorktree('always-creates');
    expect(result.success).toBe(true);
    expect(result.worktree).toBeDefined();
  });
});
