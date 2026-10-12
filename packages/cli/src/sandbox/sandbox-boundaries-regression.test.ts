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

  // Seatbelt applies the last matching rule, so the deny must come after the
  // write grant for QWEN_DIR.
  it.each(BUILTIN_SEATBELT_PROFILES)(
    '%s keeps the config the CLI loads read-only inside the sandbox',
    (profile) => {
      const source = readProfile(profile);
      const grant = source.lastIndexOf('(subpath (param "QWEN_DIR"))');
      const deny = source.indexOf('(deny file-write*', grant);
      expect(grant).toBeGreaterThan(0);
      expect(deny).toBeGreaterThan(grant);
      const block = source.slice(deny, source.indexOf('\n)', deny));
      for (const file of [
        'settings.json',
        '.env',
        'trustedFolders.json',
        'mcpApprovals.json',
        'extension-secrets-v1.json',
      ]) {
        expect(block).toContain(
          `(literal (string-append (param "QWEN_DIR") "/${file}"))`,
        );
      }
      for (const dir of [
        'extensions',
        'skills',
        'agents',
        'commands',
        'workflows',
        'rules',
        'output-styles',
      ]) {
        expect(block).toContain(
          `(subpath (string-append (param "QWEN_DIR") "/${dir}"))`,
        );
      }
    },
  );
});

function readProfile(profile: string): string {
  return fs.readFileSync(
    path.join(
      path.dirname(fileURLToPath(import.meta.url)),
      `sandbox-macos-${profile}.sb`,
    ),
    'utf8',
  );
}

describe('seatbelt profile network rules', () => {
  function networkRules(profile: string): string[] {
    return readProfile(profile)
      .split('\n')
      .filter((line) => /^\((?:allow|deny) network/.test(line));
  }

  it.each(BUILTIN_SEATBELT_PROFILES)(
    '%s reaches nothing but this machine',
    (profile) => {
      const source = readProfile(profile);
      const rules = networkRules(profile);
      // Placed after any `(allow default)`, so it is the rule that applies.
      expect(source.indexOf('(deny network*)')).toBeGreaterThan(
        source.indexOf('(allow default)'),
      );
      expect(rules[0]).toBe('(deny network*)');
      expect(rules).toContain(
        '(allow network-outbound (remote ip "localhost:*"))',
      );
      for (const rule of rules.slice(1)) {
        expect(rule).toMatch(/\((?:local|remote) ip "localhost:[*0-9]+"\)\)$/);
      }
    },
  );

  it.each(BUILTIN_SEATBELT_PROFILES.filter((p) => p.endsWith('-closed')))(
    '%s listens on nothing but the debugger port',
    (profile) => {
      expect(
        networkRules(profile).filter((rule) =>
          /network-(?:bind|inbound)/.test(rule),
        ),
      ).toEqual([
        '(allow network-bind (local ip "localhost:9229"))',
        '(allow network-inbound (local ip "localhost:9229"))',
      ]);
    },
  );
});
