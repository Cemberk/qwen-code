#!/usr/bin/env node

/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { execSync } from 'node:child_process';
import { join } from 'node:path';

// Optional: each runs only when already installed on PATH.
const LINTERS = {
  actionlint: {
    check: 'command -v actionlint',
    run: `
      actionlint \
        -color \
        -pyflakes= \
        -shellcheck= \
        -ignore 'SC2002:' \
        -ignore 'SC2016:' \
        -ignore 'SC2129:' \
        -ignore 'unexpected key "deployment" for "environment" section' \
        -ignore 'label ".+" is unknown'
    `,
  },
  shellcheck: {
    check: 'command -v shellcheck',
    run: `
      git ls-files | grep -v '^integration-tests/terminal-bench/' | grep -E '^([^.]+|.*\\.(sh|zsh|bash))' | xargs file --mime-type \
        | grep "text/x-shellscript" | awk '{ print substr($1, 1, length($1)-1) }' \
        | xargs shellcheck \
          --check-sourced \
          --enable=all \
          --exclude=SC2002,SC2129,SC2310 \
          --severity=style \
          --format=gcc \
          --color=never | sed -e 's/note:/warning:/g' -e 's/style:/warning:/g'
    `,
  },
  yamllint: {
    check: 'command -v yamllint',
    run: "git ls-files | grep -E '\\.(yaml|yml)' | xargs yamllint --format github",
  },
};

function runCommand(command, stdio = 'inherit') {
  try {
    const env = { ...process.env };
    const nodeBin = join(process.cwd(), 'node_modules', '.bin');
    env.PATH = `${nodeBin}:${env.PATH}`;
    execSync(command, { stdio, env });
    return true;
  } catch (_e) {
    return false;
  }
}

function runOptionalLinter(name) {
  console.log(`\nRunning ${name}...`);
  if (!runCommand(LINTERS[name].check, 'ignore')) {
    console.log(`${name} not found on PATH; skipping.`);
    return;
  }
  if (!runCommand(LINTERS[name].run)) {
    process.exit(1);
  }
}

export function runESLint() {
  console.log('\nRunning ESLint...');
  if (!runCommand('npm run lint:ci')) {
    process.exit(1);
  }
}

export function runActionlint() {
  runOptionalLinter('actionlint');
}

export function runShellcheck() {
  runOptionalLinter('shellcheck');
}

export function runYamllint() {
  runOptionalLinter('yamllint');
}

// `--check`, not `--write`. `--write` reformats in place and exits 0
// whether or not anything changed, and no caller inspects the tree
// afterwards, so for the life of this script the Prettier lane reported a
// pass on unformatted code and CI discarded the rewrites when the job
// ended. ESLint does not cover the gap either: eslint.config.js loads
// eslint-config-prettier, which turns formatting rules off rather than
// enforcing them. `npm run format` remains the way to fix what this
// reports.
export function runPrettier() {
  console.log('\nRunning Prettier...');
  if (!runCommand('prettier --experimental-cli --check .')) {
    process.exit(1);
  }
}

function main() {
  const args = process.argv.slice(2);

  if (args.includes('--eslint')) {
    runESLint();
  }
  if (args.includes('--actionlint')) {
    runActionlint();
  }
  if (args.includes('--shellcheck')) {
    runShellcheck();
  }
  if (args.includes('--yamllint')) {
    runYamllint();
  }
  if (args.includes('--prettier')) {
    runPrettier();
  }

  if (args.length === 0) {
    runESLint();
    runActionlint();
    runShellcheck();
    runYamllint();
    runPrettier();
    console.log('\nAll linting checks passed!');
  }
}

main();
