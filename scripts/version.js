/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { execSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { keepManifestLayout } from './keep-manifest-layout.js';
import { getWorkspacePackageJsonPaths } from './workspaces.js';

// A script to handle versioning and ensure all related changes are in a single, atomic commit.

function run(command) {
  console.log(`> ${command}`);
  execSync(command, { stdio: 'inherit' });
}

function readJson(filePath) {
  return JSON.parse(readFileSync(filePath, 'utf-8'));
}

function writeJson(filePath, data) {
  writeFileSync(filePath, JSON.stringify(data, null, 2) + '\n');
}

// 1. Get the version from the command line arguments.
const versionType = process.argv[2];
if (!versionType) {
  console.error('Error: No version specified.');
  console.error(
    'Usage: npm run version <version> (e.g., 1.2.3 or patch|minor|major|prerelease)',
  );
  process.exit(1);
}

// `pnpm version` re-sorts every manifest it rewrites; snapshot them so the
// bump below can be reduced to a version change (see keep-manifest-layout.js).
// Enumerate with the workspace globs rather than `git ls-files`: like the
// `--no-git-checks` flags below, this script must not require a git work tree.
const { workspaces } = readJson('package.json');
const snapshotPaths = [
  'package.json',
  ...getWorkspacePackageJsonPaths(process.cwd(), workspaces),
];
const originalManifests = new Map(
  snapshotPaths.map((file) => [file, readFileSync(file, 'utf-8')]),
);

// Resolve patch/minor/etc. once, then align all release workspaces to it.
run(
  `corepack pnpm version ${versionType} --no-git-tag-version --allow-same-version --no-git-checks`,
);
const rootPackageJsonPath = resolve(process.cwd(), 'package.json');
const newVersion = readJson(rootPackageJsonPath).version;
run(
  `corepack pnpm -r version ${newVersion} --no-git-tag-version --allow-same-version --no-git-checks`,
);

for (const [file, original] of originalManifests) {
  const updated = readFileSync(file, 'utf-8');
  if (updated !== original) {
    writeFileSync(file, keepManifestLayout(original, updated));
  }
}

// 6. Update the sandboxImageUri in the root package.json
const rootPackageJson = readJson(rootPackageJsonPath);
if (rootPackageJson.config?.sandboxImageUri) {
  rootPackageJson.config.sandboxImageUri =
    rootPackageJson.config.sandboxImageUri.replace(/:.*$/, `:${newVersion}`);
  console.log(`Updated sandboxImageUri in root to use version ${newVersion}`);
  writeJson(rootPackageJsonPath, rootPackageJson);
}

// 7. Update the sandboxImageUri in the cli package.json
const cliPackageJsonPath = resolve(process.cwd(), 'packages/cli/package.json');
const cliPackageJson = readJson(cliPackageJsonPath);
if (cliPackageJson.config?.sandboxImageUri) {
  cliPackageJson.config.sandboxImageUri =
    cliPackageJson.config.sandboxImageUri.replace(/:.*$/, `:${newVersion}`);
  console.log(
    `Updated sandboxImageUri in cli package to use version ${newVersion}`,
  );
  writeJson(cliPackageJsonPath, cliPackageJson);
}

console.log(`Successfully bumped versions to v${newVersion}.`);
