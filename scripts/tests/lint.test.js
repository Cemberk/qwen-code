/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// The --write to --check flip in runPrettier() is the whole point of the
// Prettier lane: --write reformats in place and exits 0 whether or not
// anything changed, so the lane reported a pass on unformatted code for as
// long as it was there (#11109). Nothing else pins the flag, so a refactor or
// a well-meant "make lint auto-fix again" could restore the silent pass with
// every suite green.
describe('prettier lane', () => {
  const repoRoot = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    '..',
    '..',
  );
  const lintSource = readFileSync(
    path.join(repoRoot, 'scripts', 'lint.js'),
    'utf8',
  );

  it('checks formatting rather than rewriting it', () => {
    expect(lintSource).toContain('prettier --experimental-cli --check .');
    expect(lintSource).not.toMatch(/prettier[^\n'"]*--write/);
  });

  // The gate and the remedy it points people at must resolve the same file
  // set. The classic CLI reads only the repo-root .gitignore while the
  // experimental one also honours nested ones, and this repo has 23 of those,
  // so a mismatch lets the lane go red on files `npm run format` cannot reach.
  it('uses the same Prettier CLI as npm run format', () => {
    const pkg = JSON.parse(
      readFileSync(path.join(repoRoot, 'package.json'), 'utf8'),
    );
    const formatIsExperimental =
      pkg.scripts.format.includes('--experimental-cli');
    const gateIsExperimental = lintSource.includes(
      'prettier --experimental-cli --check',
    );
    expect(gateIsExperimental).toBe(formatIsExperimental);
  });
});
