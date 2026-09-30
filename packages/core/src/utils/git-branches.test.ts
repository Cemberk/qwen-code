/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { gitEnv, runGitCapture } from './git-branches.js';

const tmpRoots: string[] = [];

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' });
}

function makeRepo(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qwen-gitbranches-'));
  tmpRoots.push(dir);
  git(dir, 'init', '-q', '-b', 'master');
  git(dir, 'config', 'user.email', 'test@example.com');
  git(dir, 'config', 'user.name', 'Test');
  git(dir, 'config', 'commit.gpgsign', 'false');
  git(dir, 'config', 'tag.gpgsign', 'false');
  git(dir, 'config', 'core.autocrlf', 'false');
  git(dir, 'config', 'core.hooksPath', path.join(dir, '.git', 'hooks'));
  fs.writeFileSync(path.join(dir, 'a.txt'), 'one\n');
  git(dir, 'add', '.');
  git(dir, 'commit', '-q', '-m', 'init');
  return dir;
}

/**
 * The code under test honors HOME/XDG config (gitEnv only strips the
 * GIT_CONFIG_* overrides), so point both at an empty directory: the host's
 * `~/.gitconfig` must not decide how these merges behave.
 */
function hermeticEnv(): Record<string, string | undefined> {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'qwen-githome-'));
  tmpRoots.push(home);
  return { ...process.env, HOME: home, XDG_CONFIG_HOME: home };
}

afterEach(() => {
  for (const dir of tmpRoots.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe('gitEnv (R12 env isolation)', () => {
  it('preserves commit identity while scrubbing repository selectors', () => {
    const env = gitEnv({
      GIT_AUTHOR_NAME: 'CI Bot',
      GIT_AUTHOR_EMAIL: 'bot@example.invalid',
      GIT_COMMITTER_NAME: 'CI Bot',
      GIT_COMMITTER_EMAIL: 'bot@example.invalid',
      GIT_SSL_CAINFO: '/operator/ca.pem',
      GIT_SSL_CAPATH: '/operator/certs',
      GIT_DIR: '/elsewhere/.git',
    });
    expect(env).toMatchObject({
      GIT_AUTHOR_NAME: 'CI Bot',
      GIT_AUTHOR_EMAIL: 'bot@example.invalid',
      GIT_COMMITTER_NAME: 'CI Bot',
      GIT_COMMITTER_EMAIL: 'bot@example.invalid',
      GIT_SSL_CAINFO: '/operator/ca.pem',
      GIT_SSL_CAPATH: '/operator/certs',
    });
    expect(env['GIT_DIR']).toBeUndefined();
  });

  it('strips repository-shaping variables from the child environment', () => {
    const env = gitEnv({
      PATH: '/usr/bin',
      GH_REPO: 'evil/repo',
      GIT_DIR: '/elsewhere/.git',
      GIT_CONFIG_GLOBAL: '/tmp/evil.gitconfig',
      GIT_CONFIG_SYSTEM: '/etc/evil-gitconfig',
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_CONFIG_COUNT: '1',
      GIT_CONFIG_KEY_0: 'url.https://evil.insteadOf',
      GIT_CONFIG_VALUE_0: 'https://github.com/',
      GIT_CONFIG_PARAMETERS: "'foo=bar'",
      GIT_OBJECT_DIRECTORY: '/tmp/objects',
      GIT_ALTERNATE_OBJECT_DIRECTORIES: '/tmp/alt',
      GIT_ASKPASS: '/tmp/askpass',
      SSH_ASKPASS: '/tmp/ssh-askpass',
      GIT_SSH: '/tmp/git-ssh',
      GIT_SSH_COMMAND: '/tmp/git-ssh-command',
      GIT_EXEC_PATH: '/tmp/git-exec',
      GIT_TEMPLATE_DIR: '/tmp/git-template',
      GIT_EXTERNAL_DIFF: '/tmp/git-diff',
      GIT_PROXY_COMMAND: '/tmp/git-proxy',
      PREFIX: '/tmp/prefix',
      GIT_CONFIG: '/tmp/git-config',
      XDG_CONFIG_HOME: '/tmp/evil-xdg',
      GIT_TRACE2: '/tmp/trace',
      GIT_DEFAULT_HASH: 'sha256',
      GIT_SSL_NO_VERIFY: '1',
      GIT_REDIRECT_STDOUT: '/tmp/stdout',
      git_askpass: '/tmp/lowercase-askpass',
      git_config_key_1: 'core.sshCommand',
      git_config_value_1: '/tmp/ssh-command',
      EDITOR: 'vi',
      VISUAL: 'vim',
      GIT_EDITOR: 'vim',
      GIT_SEQUENCE_EDITOR: 'nano',
      PAGER: 'less',
      GIT_PAGER: 'cat',
      GIT_ALLOW_PROTOCOL: 'https:ssh:ext',
    });
    expect(env['PATH']).toBe('/usr/bin');
    expect(env['LC_ALL']).toBe('C');
    for (const key of [
      'GH_REPO',
      'GIT_DIR',
      'GIT_CONFIG_GLOBAL',
      'GIT_CONFIG_SYSTEM',
      'GIT_CONFIG_NOSYSTEM',
      'GIT_CONFIG_COUNT',
      'GIT_CONFIG_KEY_0',
      'GIT_CONFIG_VALUE_0',
      'GIT_CONFIG_PARAMETERS',
      'GIT_OBJECT_DIRECTORY',
      'GIT_ALTERNATE_OBJECT_DIRECTORIES',
      'GIT_ASKPASS',
      'SSH_ASKPASS',
      'GIT_SSH',
      'GIT_SSH_COMMAND',
      'GIT_EXEC_PATH',
      'GIT_TEMPLATE_DIR',
      'GIT_EXTERNAL_DIFF',
      'GIT_PROXY_COMMAND',
      'PREFIX',
      'GIT_CONFIG',
      'XDG_CONFIG_HOME',
      'GIT_TRACE2',
      'GIT_DEFAULT_HASH',
      'GIT_SSL_NO_VERIFY',
      'GIT_REDIRECT_STDOUT',
      'git_askpass',
      'git_config_key_1',
      'git_config_value_1',
      'EDITOR',
      'VISUAL',
      'GIT_EDITOR',
      'GIT_SEQUENCE_EDITOR',
      'PAGER',
      'GIT_PAGER',
    ]) {
      expect(env[key]).toBeUndefined();
    }
    // GIT_ALLOW_PROTOCOL is normalized, not deleted: the helper-executing
    // entries are stripped while a restrictive inherited list keeps its
    // deny-by-default force over config-file policy.
    expect(env['GIT_ALLOW_PROTOCOL']).toBe('https:ssh');
  });

  it('normalizes an inherited GIT_ALLOW_PROTOCOL instead of deleting it', () => {
    expect(
      gitEnv({ GIT_ALLOW_PROTOCOL: 'https:ssh' })['GIT_ALLOW_PROTOCOL'],
    ).toBe('https:ssh');
    // A helper-only list filters to empty, which stays SET: an empty list
    // is deny-all, while undefined would hand the decision to config.
    expect(gitEnv({ GIT_ALLOW_PROTOCOL: 'ext:fd' })['GIT_ALLOW_PROTOCOL']).toBe(
      '',
    );
    expect(gitEnv({})['GIT_ALLOW_PROTOCOL']).toBeUndefined();
  });

  it('keeps repository discovery on the cwd even with a hostile GIT_DIR', async () => {
    const dir = makeRepo();
    git(dir, 'branch', 'feature');
    const saved = process.env['GIT_DIR'];
    process.env['GIT_DIR'] = '/definitely/not/a/repo/.git';
    try {
      const { stdout } = await runGitCapture(dir, [
        'branch',
        '--format=%(refname:short)',
      ]);
      expect(stdout.split('\n')).toContain('feature');
    } finally {
      if (saved === undefined) delete process.env['GIT_DIR'];
      else process.env['GIT_DIR'] = saved;
    }
  });

  it('does not load inherited XDG git configuration', () => {
    const dir = makeRepo();
    const xdg = path.join(dir, 'evil-xdg');
    fs.mkdirSync(path.join(xdg, 'git'), { recursive: true });
    fs.writeFileSync(
      path.join(xdg, 'git', 'config'),
      '[probe]\n  marker = came-from-xdg\n',
    );
    const env = gitEnv({ ...hermeticEnv(), XDG_CONFIG_HOME: xdg });
    expect(() =>
      execFileSync('git', ['config', '--get', 'probe.marker'], {
        cwd: dir,
        env,
      }),
    ).toThrow();
  });
});
