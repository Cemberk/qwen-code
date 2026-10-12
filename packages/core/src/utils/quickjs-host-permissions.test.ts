/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { spawnSync } from 'node:child_process';
import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  quickjsHostPermissionArgs,
  quickjsHostReadRoot,
  quickjsHostSpawnArgs,
} from './quickjs-host-permissions.js';

// What a process started with `flags` may do, as Node's permission model
// reports it.
function grantedTo(flags: string[], readable: string): Record<string, boolean> {
  const outside = path.join(path.parse(readable).root, 'outside-the-grant');
  const probe = `
    const p = process.permission;
    console.log(JSON.stringify({
      enabled: !!p,
      read: !!p && p.has('fs.read', ${JSON.stringify(readable)}),
      readOutside: !!p && p.has('fs.read', ${JSON.stringify(outside)}),
      write: !!p && p.has('fs.write'),
      child: !!p && p.has('child'),
      worker: !!p && p.has('worker'),
    }));`;
  const result = spawnSync(process.execPath, [...flags, '-e', probe], {
    encoding: 'utf8',
  });
  expect({ status: result.status, stderr: result.stderr }).toMatchObject({
    status: 0,
  });
  return JSON.parse(result.stdout) as Record<string, boolean>;
}

describe('quickjsHostPermissionArgs', () => {
  it('uses the stable flag when Node has it, else the experimental one', () => {
    expect(quickjsHostPermissionArgs(undefined, true)).toEqual([
      '--permission',
    ]);
    expect(quickjsHostPermissionArgs(undefined, false)).toEqual([
      '--experimental-permission',
    ]);
    expect(quickjsHostPermissionArgs('/install/root', true)).toEqual([
      '--permission',
      '--allow-fs-read=/install/root',
    ]);
  });

  it('grants a bundled host no file, process or worker access', () => {
    expect(
      grantedTo(quickjsHostPermissionArgs(), fileURLToPath(import.meta.url)),
    ).toEqual({
      enabled: true,
      read: false,
      readOutside: false,
      write: false,
      child: false,
      worker: false,
    });
  });

  it('grants an unbundled host reads below its install root only', () => {
    const root = quickjsHostReadRoot(import.meta.url);
    expect(
      grantedTo(quickjsHostPermissionArgs(root), path.join(root, 'x')),
    ).toEqual({
      enabled: true,
      read: true,
      readOutside: false,
      write: false,
      child: false,
      worker: false,
    });
  });
});

describe('quickjsHostReadRoot', () => {
  it('covers both the caller and the QuickJS package it loads', () => {
    const root = quickjsHostReadRoot(import.meta.url);
    const quickjs = createRequire(import.meta.url).resolve(
      '@jitl/quickjs-singlefile-mjs-release-sync/package.json',
    );
    for (const file of [fileURLToPath(import.meta.url), quickjs]) {
      expect(path.relative(root, file).startsWith('..')).toBe(false);
    }
    expect(quickjs.startsWith(path.join(root, 'node_modules') + path.sep)).toBe(
      true,
    );
  });
});

describe('quickjsHostSpawnArgs', () => {
  it('starts the host by its real path', () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'quickjs-host-entry-'));
    try {
      mkdirSync(path.join(dir, 'real'));
      writeFileSync(path.join(dir, 'real', 'host.js'), '');
      symlinkSync(path.join(dir, 'real'), path.join(dir, 'link'));
      const args = quickjsHostSpawnArgs(path.join(dir, 'link', 'host.js'));
      expect(args.at(-1)).toBe(realpathSync(path.join(dir, 'real', 'host.js')));
      expect(args.slice(0, -1)).toEqual(quickjsHostPermissionArgs());
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
