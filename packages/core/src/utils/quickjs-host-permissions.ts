/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { realpathSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';

const QUICKJS_VARIANT = '@jitl/quickjs-singlefile-mjs-release-sync';

/**
 * Node permission-model flags for a QuickJS host process (workflow scripts,
 * code mode). The host needs no file writes, child processes, worker threads
 * or native addons, so none are granted. Node always reads the entry script
 * and a bundled host embeds everything else; an unbundled host also loads
 * its modules from disk, which `readRoot` allows.
 */
export function quickjsHostPermissionArgs(
  readRoot?: string,
  hasStableFlag = process.allowedNodeEnvironmentFlags.has('--permission'),
): string[] {
  // Node before 22.13 only has the experimental spelling.
  const flag = hasStableFlag ? '--permission' : '--experimental-permission';
  return readRoot ? [flag, `--allow-fs-read=${readRoot}`] : [flag];
}

/**
 * The directory an unbundled host loads its modules from: the parent of the
 * outermost `node_modules` that provides QuickJS to `callerUrl`. Module
 * resolution reads `package.json` files all the way up to it, so a narrower
 * grant fails.
 */
export function quickjsHostReadRoot(callerUrl: string): string {
  const manifest = createRequire(callerUrl).resolve(
    `${QUICKJS_VARIANT}/package.json`,
  );
  const index = manifest.indexOf(`${path.sep}node_modules${path.sep}`);
  return index === -1 ? path.parse(manifest).root : manifest.slice(0, index);
}

/**
 * Node arguments that start the QuickJS host `entry` under the permission
 * model. The entry goes in as a real path: Node resolves any symlink in it
 * before loading, and that read is not granted.
 */
export function quickjsHostSpawnArgs(
  entry: string,
  readRoot?: string,
): string[] {
  let realEntry = entry;
  try {
    realEntry = realpathSync(entry);
  } catch {
    // A missing entry fails the spawn, which reports it.
  }
  return [...quickjsHostPermissionArgs(readRoot), realEntry];
}
