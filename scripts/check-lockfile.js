/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import fs from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { parse as parseYaml } from 'yaml';

const __dirname = dirname(fileURLToPath(import.meta.url));
// Tests point the gate at a fixture root; the default stays the repository.
// Truthiness, not `??`: an exported-but-empty variable would otherwise make
// every path below cwd-relative, and the gate would report on whatever
// lockfiles happen to sit in that directory as if they were the repository's.
const envRoot = process.env.CHECK_LOCKFILE_ROOT?.trim();
const root = envRoot ? envRoot : join(__dirname, '..');

// pnpm enforces build approvals itself: strictDepBuilds (on by default in
// pnpm 11) fails any install in which a dependency's install script has no
// decision in pnpm-workspace.yaml's allowBuilds, and every CI install is a
// --frozen-lockfile one, which also rejects a lockfile that no longer matches
// the manifests. This gate covers what an install does not check.
console.log('Checking pnpm lockfile...');

const pnpmLockfilePath = join(root, 'pnpm-lock.yaml');
let pnpmLockfile;
try {
  pnpmLockfile = parseYaml(fs.readFileSync(pnpmLockfilePath, 'utf-8'));
} catch (error) {
  console.error(`Error reading or parsing ${pnpmLockfilePath}:`, error);
  process.exit(1);
}

const pnpmPackages = pnpmLockfile?.packages ?? {};
if (Object.keys(pnpmPackages).length === 0) {
  console.error(
    '\nError: pnpm-lock.yaml has no packages section; regenerate it with `corepack pnpm install`.',
  );
  process.exit(1);
}

const invalidPnpmPackages = [];
for (const [key, details] of Object.entries(pnpmPackages)) {
  const resolution = details?.resolution ?? {};
  // Registry packages carry a sha512 integrity hash; git and tarball
  // resolutions identify their source directly.
  const hasIntegrity =
    typeof resolution.integrity === 'string' &&
    resolution.integrity.startsWith('sha512-');
  const isGitOrTarball =
    resolution.type === 'git' || typeof resolution.tarball === 'string';
  if (!hasIntegrity && !isGitOrTarball) {
    invalidPnpmPackages.push(key);
  }
}

if (invalidPnpmPackages.length > 0) {
  console.error(
    '\nError: The following dependencies in pnpm-lock.yaml are missing "resolution.integrity":',
  );
  invalidPnpmPackages.forEach((pkg) => console.error(`- ${pkg}`));
  process.exitCode = 1;
} else {
  console.log('pnpm lockfile check passed.');
}
