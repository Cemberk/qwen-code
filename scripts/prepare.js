/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { spawnSync } from 'node:child_process';

// An install never builds or bundles; those are explicit `npm run build` and
// `npm run bundle` steps. Callers that must not install git hooks set this
// (setup-worktree.js installs them itself after checking repository ownership).
const skipHusky = ['1', 'true'].includes(
  (process.env.QWEN_SKIP_PREPARE ?? '').toLowerCase(),
);

if (skipHusky) {
  console.log('Skipping Husky because QWEN_SKIP_PREPARE is set.');
} else {
  run('husky');
}
// git-commit.ts (gitignored, imported by e.g. cli's systemInfo) is required to
// typecheck or build the packages that import it.
run('npm', ['run', 'generate']);

function run(command, args = []) {
  const result = spawnSync(command, args, {
    shell: process.platform === 'win32',
    stdio: 'inherit',
  });

  const label = args.length ? `${command} ${args.join(' ')}` : command;

  if (result.error) {
    console.error(`prepare: ${label} failed: ${result.error.message}`);
    process.exit(1);
  }

  if (result.signal) {
    console.error(`prepare: ${label} killed by signal ${result.signal}`);
    process.exit(1);
  }

  if (result.status !== 0) {
    console.error(`prepare: ${label} exited with status ${result.status}`);
    process.exit(result.status ?? 1);
  }
}
