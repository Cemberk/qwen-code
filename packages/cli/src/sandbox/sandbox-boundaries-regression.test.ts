/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { fileURLToPath } from 'node:url';
import { BUILTIN_SEATBELT_PROFILES, start_sandbox } from './sandbox.js';

let fixture: string | undefined;
afterEach(() => {
  if (fixture) fs.rmSync(fixture, { recursive: true, force: true });
});

describe('retired bwrap state grants', () => {
  it('rejects before creating or modifying host bootstrap files', async () => {
    fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'qwen-retired-bwrap-'));
    const marker = path.join(fixture, 'existing-config');
    fs.writeFileSync(marker, 'preserved');
    await expect(
      start_sandbox({ command: 'bwrap' }, [], undefined, [
        process.execPath,
        '/installed/cli.js',
      ]),
    ).rejects.toThrow('tools.executionSandbox');
    expect(fs.readFileSync(marker, 'utf8')).toBe('preserved');
    expect(fs.readdirSync(fixture)).toEqual(['existing-config']);
  });
});

describe('seatbelt profile write grants', () => {
  const profileDir = path.dirname(fileURLToPath(import.meta.url));

  function fileWriteAllowBlocks(profile: string): string[] {
    const source = fs.readFileSync(
      path.join(profileDir, `sandbox-macos-${profile}.sb`),
      'utf8',
    );
    const blocks: string[] = [];
    let start = source.indexOf('(allow file-write*');
    while (start !== -1) {
      let depth = 0;
      let end = start;
      for (; end < source.length; end++) {
        if (source[end] === '(') depth++;
        if (source[end] === ')' && --depth === 0) break;
      }
      blocks.push(source.slice(start, end + 1));
      start = source.indexOf('(allow file-write*', end);
    }
    return blocks;
  }

  it.each(BUILTIN_SEATBELT_PROFILES)(
    '%s never lets sandboxed commands write the global git config',
    (profile) => {
      const blocks = fileWriteAllowBlocks(profile);
      expect(blocks.length).toBeGreaterThan(0);
      for (const block of blocks) {
        expect(block).not.toContain('.gitconfig');
        expect(block).not.toContain('(param "HOME_DIR"))');
      }
    },
  );
});
