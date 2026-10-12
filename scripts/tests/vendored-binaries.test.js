/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const vendorDir = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../packages/core/vendor',
);

// The record itself and its notes are not part of what it records.
const RECORD_FILES = new Set(['SHA256SUMS', 'README.md']);

function listFiles(dir, prefix = '') {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      return listFiles(path.join(dir, entry.name), relative);
    }
    return entry.name === '.DS_Store' ? [] : [relative];
  });
}

const recorded = new Map(
  readFileSync(path.join(vendorDir, 'SHA256SUMS'), 'utf8')
    .trim()
    .split('\n')
    .map((line) => {
      const match = line.match(/^([0-9a-f]{64}) {2}(\S.*)$/);
      if (!match) throw new Error(`Malformed SHA256SUMS line: ${line}`);
      return [match[2], match[1]];
    }),
);

describe('vendored binaries', () => {
  it('records every vendored file and nothing else', () => {
    const files = listFiles(vendorDir).filter(
      (file) => !RECORD_FILES.has(file),
    );
    expect(files.sort()).toEqual([...recorded.keys()].sort());
  });

  it.each([...recorded])('%s matches its recorded sha256', (file, sha) => {
    const actual = createHash('sha256')
      .update(readFileSync(path.join(vendorDir, file)))
      .digest('hex');
    expect(actual).toBe(sha);
  });
});
