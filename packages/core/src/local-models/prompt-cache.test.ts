/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  existsSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  engineStateKey,
  pickPromptState,
  promptCacheDir,
  promptStateFile,
  prunePromptStates,
} from './prompt-cache.js';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), 'prompt-cache-'));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function write(name: string, bytes: number, ageSeconds: number) {
  const file = path.join(dir, name);
  writeFileSync(file, Buffer.alloc(bytes));
  const when = Date.now() / 1000 - ageSeconds;
  utimesSync(file, when, when);
}

describe('promptCacheDir', () => {
  it('uses the user cache folder, not ~/.qwen', () => {
    expect(promptCacheDir({}, 'darwin', '/Users/u')).toBe(
      '/Users/u/Library/Caches/qwen-code/prompt-cache',
    );
    expect(promptCacheDir({}, 'linux', '/home/u')).toBe(
      '/home/u/.cache/qwen-code/prompt-cache',
    );
    expect(promptCacheDir({ XDG_CACHE_HOME: '/c' }, 'linux', '/home/u')).toBe(
      '/c/qwen-code/prompt-cache',
    );
  });
});

describe('promptStateFile', () => {
  it('is a plain file name that hides the project path', () => {
    const name = promptStateFile('/work/app', engineStateKey(['m']), 'a/b c');
    expect(name).toMatch(/^[0-9a-f]{16}-[0-9a-f]{16}-a_b_c\.bin$/);
    expect(name).not.toContain('work');
  });

  it('differs per project, engine and session', () => {
    const key = engineStateKey(['m', '65536']);
    const names = new Set([
      promptStateFile('/a', key, 's'),
      promptStateFile('/b', key, 's'),
      promptStateFile('/a', engineStateKey(['m', '32768']), 's'),
      promptStateFile('/a', key, 't'),
    ]);
    expect(names.size).toBe(4);
  });
});

describe('pickPromptState', () => {
  const key = engineStateKey(['model']);
  const other = engineStateKey(['other model']);

  it("prefers the session's own state", () => {
    write(promptStateFile('/p', key, 'old'), 1, 10);
    write(promptStateFile('/p', key, 'mine'), 1, 100);
    expect(pickPromptState(dir, '/p', key, 'mine')).toBe(
      promptStateFile('/p', key, 'mine'),
    );
  });

  it("else takes the project's newest state for the same engine", () => {
    write(promptStateFile('/p', key, 'older'), 1, 100);
    write(promptStateFile('/p', key, 'newer'), 1, 10);
    write(promptStateFile('/p', other, 'newest'), 1, 1);
    write(promptStateFile('/elsewhere', key, 'x'), 1, 1);
    expect(pickPromptState(dir, '/p', key, 'new session')).toBe(
      promptStateFile('/p', key, 'newer'),
    );
  });

  it('finds nothing in an empty or missing folder', () => {
    expect(pickPromptState(dir, '/p', key, 's')).toBeUndefined();
    expect(
      pickPromptState(path.join(dir, 'missing'), '/p', key, 's'),
    ).toBeUndefined();
  });
});

describe('prunePromptStates', () => {
  it('deletes the oldest states beyond the size limit', () => {
    write('a.bin', 400, 30);
    write('b.bin', 400, 20);
    write('c.bin', 400, 10);
    writeFileSync(path.join(dir, 'notes.txt'), 'kept');
    prunePromptStates(dir, 900);
    expect(readdirSync(dir).sort()).toEqual(['b.bin', 'c.bin', 'notes.txt']);
  });

  it('keeps everything under the limit', () => {
    write('a.bin', 10, 1);
    prunePromptStates(dir, 100);
    expect(existsSync(path.join(dir, 'a.bin'))).toBe(true);
  });
});
