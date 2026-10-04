/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  getTestCiWorkspacePackageJsonPaths,
  getWorkspacePackageJsonPaths,
} from '../workspaces.js';

describe('workspace helpers', () => {
  const tempDirs = [];

  afterEach(() => {
    for (const tempDir of tempDirs.splice(0)) {
      rmSync(tempDir, { force: true, recursive: true });
    }
  });

  it('honors negated workspace patterns', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'qwen-workspaces-'));
    tempDirs.push(root);

    for (const packagePath of [
      'packages/cli/package.json',
      'packages/core/package.json',
      'packages/excluded/package.json',
      'packages/apps/base/package.json',
    ]) {
      writeFile(root, packagePath, '{}\n');
    }

    expect(
      getWorkspacePackageJsonPaths(root, [
        'packages/*',
        'packages/apps/base',
        '!packages/excluded',
      ]),
    ).toEqual([
      'packages/apps/base/package.json',
      'packages/cli/package.json',
      'packages/core/package.json',
    ]);
  });

  it('normalizes Windows-style workspace patterns', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'qwen-workspaces-'));
    tempDirs.push(root);

    for (const packagePath of [
      'packages/cli/package.json',
      'packages/core/package.json',
      'packages/excluded/package.json',
      'packages/apps/base/package.json',
    ]) {
      writeFile(root, packagePath, '{}\n');
    }

    expect(
      getWorkspacePackageJsonPaths(root, [
        'packages\\*',
        'packages\\apps\\base',
        '!packages\\excluded',
      ]),
    ).toEqual([
      'packages/apps/base/package.json',
      'packages/cli/package.json',
      'packages/core/package.json',
    ]);
  });

  it('returns exactly the package.json paths of workspaces with a test:ci script', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'qwen-workspaces-'));
    tempDirs.push(root);

    writeFile(
      root,
      'package.json',
      '{"workspaces": ["integrations/*", "packages/*", ' +
        '"packages/apps/nested-ci", "packages/apps/nested-no-ci"]}\n',
    );
    // Both repo layouts are witness-bearing: the flat integrations/* layout
    // and the nested packages/apps/* layout. The nested members need
    // explicit root-list entries because packages/* does not match nested
    // directories — exactly why a filter mutation that drops the subtree
    // (say `!path.startsWith('packages/apps/')`) would stay invisible
    // to every consumer that derives its set from the selector. This
    // exact-set pin is what catches it.
    writeFile(
      root,
      'integrations/with-ci/package.json',
      '{"scripts": {"test:ci": "vitest run"}}\n',
    );
    writeFile(
      root,
      'packages/without-ci/package.json',
      '{"scripts": {"test": "vitest run"}}\n',
    );
    writeFile(
      root,
      'packages/apps/nested-ci/package.json',
      '{"scripts": {"test:ci": "vitest run"}}\n',
    );
    writeFile(
      root,
      'packages/apps/nested-no-ci/package.json',
      '{"scripts": {"test": "vitest run"}}\n',
    );

    expect(getTestCiWorkspacePackageJsonPaths(root)).toEqual([
      'integrations/with-ci/package.json',
      'packages/apps/nested-ci/package.json',
    ]);
  });

  function writeFile(root, relativePath, content) {
    const filePath = path.join(root, relativePath);
    mkdirSync(path.dirname(filePath), { recursive: true });
    writeFileSync(filePath, content);
  }
});
