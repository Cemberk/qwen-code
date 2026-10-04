/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createWorktreeSessionMarker,
  GitWorktreeService,
  readWorktreeSessionMarker,
  readWorktreeSessionMarkerOutcome,
  replaceWorktreeSessionMarker,
  writeWorktreeSessionMarker,
} from './gitWorktreeService.js';

let repo: string;

beforeEach(async () => {
  repo = await fs.mkdtemp(path.join(os.tmpdir(), 'qwen-worktree-marker-'));
  execFileSync('git', ['init', '-q'], { cwd: repo });
  execFileSync('git', ['config', 'user.name', 'Qwen Test'], { cwd: repo });
  execFileSync('git', ['config', 'user.email', 'qwen@example.invalid'], {
    cwd: repo,
  });
});

afterEach(async () => {
  await fs.rm(repo, { recursive: true, force: true });
});

describe('strict worktree session markers', () => {
  it.each(['', ' \n'])('repairs an invalid regular marker', async (content) => {
    await fs.writeFile(path.join(repo, '.qwen-session'), content, 'utf8');

    await writeWorktreeSessionMarker(repo, 'session-b');

    await expect(readWorktreeSessionMarker(repo)).resolves.toBe('session-b');
  });

  it.each([
    'GIT_ASKPASS',
    'SSH_ASKPASS',
    'GIT_SSH',
    'GIT_SSH_COMMAND',
    'GIT_EXEC_PATH',
    'GIT_TEMPLATE_DIR',
    'GIT_EXTERNAL_DIFF',
    'GIT_PROXY_COMMAND',
    'PREFIX',
  ])('sanitizes %s before a real simple-git call', async (key) => {
    const previous = process.env[key];
    process.env[key] = '/definitely/not/a/git-helper';
    try {
      await expect(
        new GitWorktreeService(repo).getRepoTopLevel(),
      ).resolves.toBe(await fs.realpath(repo));
    } finally {
      if (previous === undefined) delete process.env[key];
      else process.env[key] = previous;
    }
  });

  it('creates once and refuses to overwrite an existing owner', async () => {
    await createWorktreeSessionMarker(repo, 'session-a');

    expect(await readWorktreeSessionMarker(repo)).toBe('session-a');
    await expect(
      createWorktreeSessionMarker(repo, 'session-b'),
    ).rejects.toMatchObject({ code: 'EEXIST' });
    expect(await readWorktreeSessionMarker(repo)).toBe('session-a');
  });

  it('replaces only the expected regular-file owner', async () => {
    await createWorktreeSessionMarker(repo, 'session-a');

    await expect(
      replaceWorktreeSessionMarker(repo, 'session-other', 'session-b'),
    ).rejects.toThrow('owner changed');
    expect(await readWorktreeSessionMarker(repo)).toBe('session-a');

    await replaceWorktreeSessionMarker(repo, 'session-a', 'session-b');
    expect(await readWorktreeSessionMarker(repo)).toBe('session-b');
  });

  it.skipIf(process.platform === 'win32')(
    'refuses a symlink marker',
    async () => {
      const target = path.join(repo, 'target');
      await fs.writeFile(target, 'session-a', 'utf8');
      await fs.symlink(target, path.join(repo, '.qwen-session'));

      await expect(
        createWorktreeSessionMarker(repo, 'session-b'),
      ).rejects.toBeDefined();
      await expect(
        replaceWorktreeSessionMarker(repo, 'session-a', 'session-b'),
      ).rejects.toBeDefined();
      await expect(
        writeWorktreeSessionMarker(repo, 'session-b'),
      ).rejects.toBeDefined();
      await expect(readWorktreeSessionMarker(repo)).resolves.toBeNull();
      expect(await fs.readFile(target, 'utf8')).toBe('session-a');
    },
  );

  it('refuses a hard-linked marker', async () => {
    const target = path.join(repo, 'target');
    await fs.writeFile(target, 'session-a', 'utf8');
    await fs.link(target, path.join(repo, '.qwen-session'));

    await expect(
      replaceWorktreeSessionMarker(repo, 'session-a', 'session-b'),
    ).rejects.toBeDefined();
    await expect(
      writeWorktreeSessionMarker(repo, 'session-b'),
    ).rejects.toBeDefined();
    // Deliberate: lenient reads resolve the owner even at nlink > 1.
    // Reading through a hard link is harmless — writing through one is what
    // the strict-guarded write paths above refuse — and the publisher's own
    // link-then-unlink leaves complete content at nlink 2, which a null here
    // would misreport as "no marker" to exit_worktree's removal guard.
    await expect(readWorktreeSessionMarker(repo)).resolves.toBe('session-a');
    expect(await fs.readFile(target, 'utf8')).toBe('session-a');
  });

  it('reads a marker caught in the link-then-unlink publish window', async () => {
    // createWorktreeSessionMarkerExclusive publishes by linking the staged
    // sibling onto the marker path and only then unlinking the sibling, so
    // a crash between the two (or a concurrent reader) leaves the marker at
    // nlink 2 holding complete, fsync'd content. exit_worktree reads a null
    // owner as "no marker — allow removal", so the lenient read must still
    // resolve the owner while writes stay refused.
    const markerPath = path.join(repo, '.qwen-session');
    const stagedPath = `${markerPath}.deadbeef.tmp`;
    await fs.writeFile(stagedPath, 'session-a', 'utf8');
    await fs.link(stagedPath, markerPath);

    await expect(readWorktreeSessionMarker(repo)).resolves.toBe('session-a');
    await expect(
      writeWorktreeSessionMarker(repo, 'session-b'),
    ).rejects.toBeDefined();
    await expect(readWorktreeSessionMarker(repo)).resolves.toBe('session-a');
  });

  it('reports inconclusive — never absence — when the marker identity changes mid-read', async () => {
    // A concurrent ownership transfer publishes through atomicWriteFile
    // (sibling temp + rename), so the marker path gets a new inode while
    // the reader holds it open. Collapsing that into null would read as
    // "no marker — allow removal" to exit_worktree's ownership guard.
    await createWorktreeSessionMarker(repo, 'session-a');
    const markerPath = path.join(repo, '.qwen-session');

    const probe = await fs.open(markerPath, 'r');
    const prototype = Object.getPrototypeOf(probe) as typeof probe;
    await probe.close();
    const originalStat = prototype.stat;
    const statSpy = vi
      .spyOn(prototype, 'stat')
      .mockImplementation(async function (this: typeof probe) {
        const stats = await originalStat.call(this);
        return Object.assign(stats, { ino: stats.ino === 1 ? 2 : 1 });
      });
    try {
      await expect(readWorktreeSessionMarkerOutcome(repo)).resolves.toEqual({
        state: 'inconclusive',
      });
      // The collapsing variant keeps its contract for badge-style callers.
      await expect(readWorktreeSessionMarker(repo)).resolves.toBeNull();
    } finally {
      statSpy.mockRestore();
    }

    await expect(readWorktreeSessionMarkerOutcome(repo)).resolves.toEqual({
      state: 'owned',
      sessionId: 'session-a',
    });
  });

  it('distinguishes a missing marker from an owned one', async () => {
    await expect(readWorktreeSessionMarkerOutcome(repo)).resolves.toEqual({
      state: 'missing',
    });
    await createWorktreeSessionMarker(repo, 'session-a');
    await expect(readWorktreeSessionMarkerOutcome(repo)).resolves.toEqual({
      state: 'owned',
      sessionId: 'session-a',
    });
  });

  it('reads an oversized marker as present, never as absent', async () => {
    // Writers cap owner ids at 512 bytes, so bounded content beyond that cap
    // can never equal a real owner — returning it keeps exit_worktree's
    // "owner !== current session" refusal engaged instead of collapsing the
    // marker into "no marker — allow removal". 513 = 512-byte cap + 1.
    await fs.writeFile(path.join(repo, '.qwen-session'), 'x'.repeat(600));

    await expect(readWorktreeSessionMarker(repo)).resolves.toBe(
      'x'.repeat(513),
    );
  });

  it('writes the exclude rule to the owning repo despite inherited git env', async () => {
    const decoy = await fs.mkdtemp(path.join(os.tmpdir(), 'git-env-decoy-'));
    execFileSync('git', ['init', '-q'], { cwd: decoy });
    const previousGitDir = process.env['GIT_DIR'];
    const previousGitWorkTree = process.env['GIT_WORK_TREE'];
    const previousGitAskpass = process.env['GIT_ASKPASS'];
    process.env['GIT_DIR'] = path.join(decoy, '.git');
    process.env['GIT_WORK_TREE'] = decoy;
    process.env['GIT_ASKPASS'] = '/definitely/not/an/askpass';
    try {
      await createWorktreeSessionMarker(repo, 'session-a');
    } finally {
      if (previousGitDir === undefined) delete process.env['GIT_DIR'];
      else process.env['GIT_DIR'] = previousGitDir;
      if (previousGitWorkTree === undefined) {
        delete process.env['GIT_WORK_TREE'];
      } else {
        process.env['GIT_WORK_TREE'] = previousGitWorkTree;
      }
      if (previousGitAskpass === undefined) {
        delete process.env['GIT_ASKPASS'];
      } else {
        process.env['GIT_ASKPASS'] = previousGitAskpass;
      }
    }

    await expect(
      fs.readFile(path.join(repo, '.git', 'info', 'exclude'), 'utf8'),
    ).resolves.toContain('/.qwen-session');
    await expect(
      fs.readFile(path.join(decoy, '.git', 'info', 'exclude'), 'utf8'),
    ).resolves.not.toContain('/.qwen-session');
    await fs.rm(decoy, { recursive: true, force: true });
  });
});
