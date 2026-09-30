/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('node:child_process', () => ({
  execFile: vi.fn(),
}));

import { execFile } from 'node:child_process';
import {
  fetchAttributionRepoKeys,
  fetchCurrentBranchName,
  fetchCurrentBranchPullRequest,
  repoKeyFromWebUrl,
} from './github-prs.js';

const mockExecFile = vi.mocked(execFile);

type ExecCallback = (err: Error | null, stdout: string, stderr: string) => void;

function mockGhSuccess(payload: unknown) {
  mockExecFile.mockImplementation(
    (_cmd: unknown, _args: unknown, _opts: unknown, cb: unknown) => {
      (cb as ExecCallback)(null, JSON.stringify(payload), '');
      return {} as ReturnType<typeof execFile>;
    },
  );
}

function mockGhError(error: Error & { code?: string; stderr?: string }) {
  mockExecFile.mockImplementation(
    (_cmd: unknown, _args: unknown, _opts: unknown, cb: unknown) => {
      (cb as ExecCallback)(error, '', error.stderr ?? '');
      return {} as ReturnType<typeof execFile>;
    },
  );
}

describe('repoKeyFromWebUrl', () => {
  it('extracts host/owner/repo from web and PR URLs', () => {
    expect(repoKeyFromWebUrl('https://github.com/o/r')).toBe('github.com/o/r');
    expect(repoKeyFromWebUrl('https://github.com/o/r/pull/42')).toBe(
      'github.com/o/r',
    );
  });

  it('lowercases host, owner, and repo', () => {
    expect(repoKeyFromWebUrl('https://GitHub.com/Owner/Repo/pull/1')).toBe(
      'github.com/owner/repo',
    );
  });

  it('canonicalizes a www. host prefix', () => {
    // An origin remote spelled with www. must key identically to gh's own
    // page URLs or the repo gate never matches them.
    expect(repoKeyFromWebUrl('https://www.github.com/o/r')).toBe(
      'github.com/o/r',
    );
  });

  it('returns undefined for non-http URLs and missing path segments', () => {
    expect(repoKeyFromWebUrl('javascript:alert(1)')).toBeUndefined();
    expect(repoKeyFromWebUrl('https://github.com/o')).toBeUndefined();
    expect(repoKeyFromWebUrl('not a url')).toBeUndefined();
  });
});

describe('fetchCurrentBranchPullRequest', () => {
  let dir: string;

  beforeEach(() => {
    vi.resetAllMocks();
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'github-prs-branch-pr-'));
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('resolves number, url, state, and head branch from gh', async () => {
    fs.mkdirSync(path.join(dir, '.git'));
    mockExecFile.mockImplementation(
      (_cmd: unknown, args: unknown, _opts: unknown, cb: unknown) => {
        expect(args).toEqual([
          'pr',
          'view',
          '--json',
          'number,url,state,headRefName',
        ]);
        (cb as ExecCallback)(
          null,
          JSON.stringify({
            number: 77,
            url: 'https://github.com/o/r/pull/77',
            state: 'OPEN',
            headRefName: 'feat/x',
          }),
          '',
        );
        return {} as ReturnType<typeof execFile>;
      },
    );

    expect(await fetchCurrentBranchPullRequest(dir)).toEqual({
      status: 'pr',
      number: 77,
      url: 'https://github.com/o/r/pull/77',
      state: 'open',
      headRefName: 'feat/x',
    });
  });

  it('fails closed when gh reports no recognizable state', async () => {
    // A retry that resolves the branch's existing PR must never bind on a
    // shape the caller cannot gate on — an unparseable pre-state is an
    // error, not a proved absence.
    fs.mkdirSync(path.join(dir, '.git'));
    mockGhSuccess({ number: 77, url: 'https://github.com/o/r/pull/77' });
    expect(await fetchCurrentBranchPullRequest(dir)).toEqual({
      status: 'error',
    });
    mockGhSuccess({
      number: 77,
      url: 'https://github.com/o/r/pull/77',
      state: 'SOMETHING_NEW',
    });
    expect(await fetchCurrentBranchPullRequest(dir)).toEqual({
      status: 'error',
    });
  });

  it('reports none when gh proves the branch has no PR', async () => {
    // gh exits non-zero with a characteristic message when the branch
    // simply has no PR — a proved absence, distinct from a fetch failure.
    fs.mkdirSync(path.join(dir, '.git'));
    mockGhError(
      Object.assign(new Error('exit code 1'), {
        stderr: 'no pull requests found for branch "feat/x"',
      }),
    );
    expect(await fetchCurrentBranchPullRequest(dir)).toEqual({
      status: 'none',
    });
  });

  it('reports error when the gh fetch fails', async () => {
    // Timeouts, rate limits, and auth failures prove nothing about the
    // branch's PRs; the attribution gate must decline on them instead of
    // reading them as "no prior PR".
    fs.mkdirSync(path.join(dir, '.git'));
    mockGhError(Object.assign(new Error('network timeout'), { killed: true }));
    expect(await fetchCurrentBranchPullRequest(dir)).toEqual({
      status: 'error',
    });
  });

  it('reports error outside a git repository without spawning gh', async () => {
    // No repo proves nothing about a branch's PR — a gate-passing command
    // may clone the repo into the working dir and resolve its existing PR
    // post-run — so the pre-state fails closed instead of reading as
    // "no prior PR".
    expect(await fetchCurrentBranchPullRequest(dir)).toEqual({
      status: 'error',
    });
    expect(mockExecFile).not.toHaveBeenCalled();
  });
});

describe('fetchCurrentBranchName', () => {
  let dir: string;

  beforeEach(() => {
    vi.resetAllMocks();
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'github-prs-branch-name-'));
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('resolves the checked-out branch', async () => {
    fs.mkdirSync(path.join(dir, '.git'));
    mockExecFile.mockImplementation(
      (_cmd: unknown, args: unknown, _opts: unknown, cb: unknown) => {
        expect(args).toEqual(['branch', '--show-current']);
        (cb as ExecCallback)(null, 'feat/x\n', '');
        return {} as ReturnType<typeof execFile>;
      },
    );

    expect(await fetchCurrentBranchName(dir)).toBe('feat/x');
  });

  it('returns undefined outside a git repository without spawning git', async () => {
    expect(await fetchCurrentBranchName(dir)).toBeUndefined();
    expect(mockExecFile).not.toHaveBeenCalled();
  });

  it('returns undefined on a detached HEAD or git failure', async () => {
    fs.mkdirSync(path.join(dir, '.git'));
    mockExecFile.mockImplementation(
      (_cmd: unknown, _args: unknown, _opts: unknown, cb: unknown) => {
        (cb as ExecCallback)(null, '', '');
        return {} as ReturnType<typeof execFile>;
      },
    );
    expect(await fetchCurrentBranchName(dir)).toBeUndefined();

    mockExecFile.mockImplementation(
      (_cmd: unknown, _args: unknown, _opts: unknown, cb: unknown) => {
        (cb as ExecCallback)(new Error('not a git repository'), '', '');
        return {} as ReturnType<typeof execFile>;
      },
    );
    expect(await fetchCurrentBranchName(dir)).toBeUndefined();
  });
});

describe('fetchAttributionRepoKeys', () => {
  let dir: string;

  beforeEach(() => {
    vi.resetAllMocks();
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'github-prs-repo-keys-'));
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('resolves the repo key and the fork-parent key', async () => {
    fs.mkdirSync(path.join(dir, '.git'));
    mockExecFile.mockImplementation(
      (_cmd: unknown, args: unknown, _opts: unknown, cb: unknown) => {
        expect(args).toEqual(['repo', 'view', '--json', 'url,parent']);
        (cb as ExecCallback)(
          null,
          JSON.stringify({
            url: 'https://github.com/fork/r',
            parent: { url: 'https://github.com/parent/r' },
          }),
          '',
        );
        return {} as ReturnType<typeof execFile>;
      },
    );

    expect(await fetchAttributionRepoKeys(dir)).toEqual({
      resolved: 'github.com/fork/r',
      parent: 'github.com/parent/r',
    });
  });

  it('omits the parent key for a non-fork repo', async () => {
    fs.mkdirSync(path.join(dir, '.git'));
    mockGhSuccess({ url: 'https://github.com/o/r', parent: {} });
    expect(await fetchAttributionRepoKeys(dir)).toEqual({
      resolved: 'github.com/o/r',
    });
  });

  it('returns no keys outside a git repository without spawning gh', async () => {
    expect(await fetchAttributionRepoKeys(dir)).toEqual({});
    expect(mockExecFile).not.toHaveBeenCalled();
  });

  it('fails closed when gh cannot answer', async () => {
    // An unresolvable pre-run identity must decline attribution, not read
    // as "any repo may bind".
    fs.mkdirSync(path.join(dir, '.git'));
    mockGhError(Object.assign(new Error('network timeout'), { killed: true }));
    expect(await fetchAttributionRepoKeys(dir)).toEqual({});

    mockExecFile.mockImplementation(
      (_cmd: unknown, _args: unknown, _opts: unknown, cb: unknown) => {
        (cb as ExecCallback)(null, 'not json', '');
        return {} as ReturnType<typeof execFile>;
      },
    );
    expect(await fetchAttributionRepoKeys(dir)).toEqual({});
  });
});
