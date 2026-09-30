/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { execFile } from 'node:child_process';
import * as path from 'node:path';
import { findGitRoot } from './gitUtils.js';
import { gitEnv, gitRemoteEnv } from './git-branches.js';
import type { SessionPrState } from '../services/session-pr-service.js';

const GH_TIMEOUT_MS = 10_000;
const GH_MAX_BUFFER = 16 * 1024 * 1024;
// gh shells out to git for remote operations (the push inside
// `gh pr create`, remote resolution elsewhere), so it needs the
// remote-transport keys gitRemoteEnv restores — a plain gitEnv scrub would
// strip the operator's SSH/askpass configuration from those children.
function ghEnv(
  base?: Readonly<Record<string, string | undefined>>,
): Record<string, string | undefined> {
  const source = base ?? process.env;
  const env = gitRemoteEnv(source);
  if (env['GH_CONFIG_DIR'] === undefined && source['XDG_CONFIG_HOME']) {
    env['GH_CONFIG_DIR'] = path.join(source['XDG_CONFIG_HOME'], 'gh');
  }
  for (const key of ['GIT_SSL_CAINFO', 'GIT_SSL_CAPATH']) {
    if (source[key] !== undefined) env[key] = source[key];
  }
  return env;
}

// ── Git remote → repository identity ─────────────────────────────

const GIT_REMOTE_TIMEOUT_MS = 5_000;

/**
 * Repository identity key (`host/owner/repo`, lowercased) for a GitHub web
 * or PR URL. Used to verify a bound PR URL belongs to the workspace's own
 * repository before persisting or refreshing it.
 */
export function repoKeyFromWebUrl(webUrl: string): string | undefined {
  let url: URL;
  try {
    url = new URL(webUrl);
  } catch {
    return undefined;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return undefined;
  const segments = url.pathname.split('/').filter(Boolean);
  if (segments.length < 2) return undefined;
  // Enterprise remotes can carry a `www.` prefix while gh's own URLs never
  // do; the key must canonicalize it or the two never match.
  const hostname = url.hostname.replace(/^www\./, '');
  return `${hostname}/${segments[0]}/${segments[1]}`.toLowerCase();
}

/**
 * The branch's current PR as seen by gh, for `gh pr create` attribution.
 * `none` is a PROVED absence (gh answered for this branch); `error` means
 * gh could not answer (timeout, rate limit, unavailable, unparseable). A
 * caller gating on the pre-run state must decline attribution on `error`
 * rather than read it as "no prior PR", or a branch whose fetch flaked
 * would bind its existing PR as this session's creation.
 */
export type BranchPullRequestSnapshot =
  | { status: 'none' }
  | { status: 'error' }
  | {
      status: 'pr';
      number: number;
      url: string;
      state: SessionPrState;
      /** The PR's head branch; lets the caller pin branch identity. */
      headRefName?: string;
    };

/**
 * Resolves the PR gh associates with the current branch of the repo
 * containing `cwd` (`gh pr view` with no argument names one). Used to
 * attribute a `gh pr create` run to the PR it created — command/output
 * text alone cannot prove which printed URL gh itself produced. The state
 * lets the caller decline an already-merged/closed PR a retry merely
 * resolved.
 */
export function fetchCurrentBranchPullRequest(
  cwd: string,
  env?: Readonly<Record<string, string | undefined>>,
): Promise<BranchPullRequestSnapshot> {
  const gitRoot = findGitRoot(cwd);
  // No repo proves nothing about a branch's PR — the command may CREATE
  // the repo (clone into the working dir) — so this is an unproven
  // pre-state, not a proved absence; callers decline on `error`.
  if (!gitRoot) return Promise.resolve({ status: 'error' });
  return new Promise((resolve) => {
    execFile(
      'gh',
      ['pr', 'view', '--json', 'number,url,state,headRefName'],
      {
        cwd: gitRoot,
        timeout: GH_TIMEOUT_MS,
        maxBuffer: GH_MAX_BUFFER,
        windowsHide: true,
        encoding: 'utf8',
        env: ghEnv(env),
      },
      (error, stdout, stderr) => {
        if (error) {
          // gh exits non-zero both when the branch has no PR and on real
          // failures (timeout, rate limit, auth); only the no-PR message
          // is a proved absence — anything else fails closed as `error`.
          resolve(
            /no pull requests found/i.test(stderr)
              ? { status: 'none' }
              : { status: 'error' },
          );
          return;
        }
        try {
          const parsed = JSON.parse(stdout) as {
            number?: number;
            url?: string;
            state?: string;
            headRefName?: string;
          };
          // gh reports OPEN/MERGED/CLOSED; anything else fails closed.
          const state = parsed.state?.toLowerCase();
          resolve(
            typeof parsed.number === 'number' &&
              typeof parsed.url === 'string' &&
              (state === 'open' || state === 'merged' || state === 'closed')
              ? {
                  status: 'pr',
                  number: parsed.number,
                  url: parsed.url,
                  state,
                  ...(typeof parsed.headRefName === 'string'
                    ? { headRefName: parsed.headRefName }
                    : {}),
                }
              : { status: 'error' },
          );
        } catch {
          resolve({ status: 'error' });
        }
      },
    );
  });
}

/**
 * The checked-out branch name of the repo containing `cwd` (undefined
 * outside a repo, on a detached HEAD, or when git fails). Pins branch
 * identity across the `gh pr create` attribution window: the post-run gh
 * resolution must name this same branch, or a command that switched
 * branches mid-run would bind the new branch's existing PR as this run's
 * creation.
 */
export function fetchCurrentBranchName(
  cwd: string,
): Promise<string | undefined> {
  const gitRoot = findGitRoot(cwd);
  if (!gitRoot) return Promise.resolve(undefined);
  return new Promise((resolve) => {
    execFile(
      'git',
      ['branch', '--show-current'],
      {
        cwd: gitRoot,
        timeout: GIT_REMOTE_TIMEOUT_MS,
        encoding: 'utf8',
        windowsHide: true,
        env: gitEnv(),
      },
      (error, stdout) => {
        const name = stdout.trim();
        resolve(error || name === '' ? undefined : name);
      },
    );
  });
}

export interface AttributionRepoKeys {
  /** Repo key gh resolves for this checkout; undefined when unresolvable. */
  resolved?: string;
  /** The resolved repo's fork-parent key, when it is a fork. */
  parent?: string;
}

/**
 * The repo identities gh attributes PR operations to from `cwd`: the repo
 * gh resolves for this checkout plus, when it is a fork, its parent — from
 * a fork checkout `gh pr view`/`gh pr create` resolve the PARENT repo
 * (forks host no PRs), so a create legitimately made in that layout carries
 * the parent's key. Both keys are empty when gh cannot answer (no repo, gh
 * unavailable, unparseable); callers pinning repo identity across the
 * attribution window must decline on that state, or an origin retarget
 * inside the window (`git remote set-url`, `gh repo set-default`) would
 * bind a stranger's pre-existing PR.
 */
export function fetchAttributionRepoKeys(
  cwd: string,
  env?: Readonly<Record<string, string | undefined>>,
): Promise<AttributionRepoKeys> {
  const gitRoot = findGitRoot(cwd);
  if (!gitRoot) return Promise.resolve({});
  return new Promise((resolve) => {
    execFile(
      'gh',
      ['repo', 'view', '--json', 'url,parent'],
      {
        cwd: gitRoot,
        timeout: GH_TIMEOUT_MS,
        maxBuffer: GH_MAX_BUFFER,
        windowsHide: true,
        encoding: 'utf8',
        env: ghEnv(env),
      },
      (error, stdout) => {
        if (error) {
          resolve({});
          return;
        }
        try {
          const parsed = JSON.parse(stdout) as {
            url?: unknown;
            parent?: { url?: unknown } | null;
          };
          const resolved =
            typeof parsed.url === 'string'
              ? repoKeyFromWebUrl(parsed.url)
              : undefined;
          const parentUrl = parsed.parent?.url;
          const parent =
            typeof parentUrl === 'string'
              ? repoKeyFromWebUrl(parentUrl)
              : undefined;
          resolve({
            ...(resolved ? { resolved } : {}),
            ...(parent ? { parent } : {}),
          });
        } catch {
          resolve({});
        }
      },
    );
  });
}
