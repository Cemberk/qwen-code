/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

const GIT_TIMEOUT_MS = 30_000;

const GIT_ENV_VARS_TO_CLEAR = [
  'GH_REPO',
  'SSH_ASKPASS',
  'XDG_CONFIG_HOME',
  'PREFIX',
  'EDITOR',
  'VISUAL',
  'PAGER',
];

const NORMALIZED_GIT_ENV_VARS_TO_CLEAR = new Set(
  GIT_ENV_VARS_TO_CLEAR.map((key) => key.toLowerCase()),
);
const REMOTE_GIT_TRANSPORT_KEYS = new Set(
  ['GIT_SSH_COMMAND', 'GIT_SSH', 'GIT_ASKPASS', 'SSH_ASKPASS'].map((key) =>
    key.toLowerCase(),
  ),
);
const GIT_METADATA_KEYS = new Set(
  [
    'GIT_AUTHOR_NAME',
    'GIT_AUTHOR_EMAIL',
    'GIT_AUTHOR_DATE',
    'GIT_COMMITTER_NAME',
    'GIT_COMMITTER_EMAIL',
    'GIT_COMMITTER_DATE',
    'GIT_SSL_CAINFO',
    'GIT_SSL_CAPATH',
  ].map((key) => key.toLowerCase()),
);

// Transport names git ships helpers for: `ext` is deny-by-default but
// re-enableable from config files, `fd` is allowed by default and needs no
// installed binary. The open `git-remote-<name>` space is closed at the
// write gate (EXECUTING_HELPER_URL in git-remotes.ts), not here — an
// operator-listed helper name is a deliberate allow and is preserved.
const HELPER_PROTOCOLS = new Set(['ext', 'fd']);

export function gitEnv(
  base?: Readonly<Record<string, string | undefined>>,
): Record<string, string | undefined> {
  const source = base ?? process.env;
  const env = { ...source };
  for (const key of Object.keys(env)) {
    const normalizedKey = key.toLowerCase();
    if (
      // Survives the scrub so the normalization below can see it.
      normalizedKey !== 'git_allow_protocol' &&
      (NORMALIZED_GIT_ENV_VARS_TO_CLEAR.has(normalizedKey) ||
        normalizedKey.startsWith('git_'))
    ) {
      delete env[key];
    }
  }
  for (const [key, value] of Object.entries(source)) {
    if (GIT_METADATA_KEYS.has(key.toLowerCase())) env[key] = value;
  }
  // GIT_ALLOW_PROTOCOL is git's only protocol control that OVERRIDES
  // config-file policy, so deleting it outright would hand a
  // workspace-controlled `protocol.<name>.allow` the final say: a repo the
  // user did not author can pair `url = ext::…` with
  // `protocol.ext.allow = always`, and an operator's restrictive inherited
  // list is the deny that stops it. Keep an inherited list but strip the
  // helper-executing entries; a list that filters to empty stays set
  // (deny-all) rather than becoming undefined (config decides).
  const inheritedAllow = env['GIT_ALLOW_PROTOCOL'];
  if (inheritedAllow !== undefined) {
    env['GIT_ALLOW_PROTOCOL'] = inheritedAllow
      .split(':')
      .filter((p) => !HELPER_PROTOCOLS.has(p.trim().toLowerCase()))
      .join(':');
  }
  env['LC_ALL'] = 'C';
  env['LANG'] = 'C';
  return env;
}

export function gitRemoteEnv(
  base?: Readonly<Record<string, string | undefined>>,
): Record<string, string | undefined> {
  const source = base ?? process.env;
  const env = gitEnv(source);
  for (const [key, value] of Object.entries(source)) {
    if (REMOTE_GIT_TRANSPORT_KEYS.has(key.toLowerCase())) env[key] = value;
  }
  return env;
}

/**
 * Both streams, for the handful of subcommands that report on stderr.
 *
 * `git worktree prune -v` is one: everything it says it would remove goes to
 * stderr, so a caller reading only stdout is told nothing at all.
 */
export function runGitCapture(
  cwd: string,
  args: string[],
  env?: Readonly<Record<string, string | undefined>>,
): Promise<{ stdout: string; stderr: string }> {
  return execFileAsync('git', args, {
    cwd,
    timeout: GIT_TIMEOUT_MS,
    maxBuffer: 10 * 1024 * 1024,
    env: gitEnv(env),
  }).then(({ stdout, stderr }) => ({ stdout, stderr }));
}
