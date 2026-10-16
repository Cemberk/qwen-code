/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { createHash } from 'node:crypto';
import { mkdirSync, readdirSync, rmSync, statSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * The engine's processed prompt, saved per session like the session's
 * history file, so that resuming the session, or starting a new one in the
 * same project, does not read the whole prompt again.
 *
 * Files are named `<project>-<engine>-<session>.bin`: the project and engine
 * parts are hashes, so a state is only restored into the same model file,
 * context size and speculative decoding setup that wrote it.
 */

/** Saved states beyond this total are deleted, oldest first. */
export const PROMPT_CACHE_MAX_BYTES = 4 * 1024 ** 3;

/** Where the saved states live: the user's cache folder, not ~/.qwen. */
export function promptCacheDir(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
  home: string = os.homedir(),
): string {
  const base =
    platform === 'darwin'
      ? path.join(home, 'Library', 'Caches')
      : env['XDG_CACHE_HOME'] || path.join(home, '.cache');
  return path.join(base, 'qwen-code', 'prompt-cache');
}

const hash = (value: string) =>
  createHash('sha256').update(value).digest('hex').slice(0, 16);

/** Identifies what a saved state can be restored into. */
export function engineStateKey(parts: readonly string[]): string {
  return hash(parts.join('\0'));
}

/** The session part of a file name: llama-server accepts only plain names. */
function sessionPart(session: string): string {
  return session.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 100);
}

export function promptStateFile(
  project: string,
  engineKey: string,
  session: string,
): string {
  return `${hash(project)}-${engineKey}-${sessionPart(session)}.bin`;
}

/**
 * The state to restore when an engine starts: the session's own file, or
 * else the newest one from the same project and engine, which shares at
 * least the system prompt and tools.
 */
export function pickPromptState(
  dir: string,
  project: string,
  engineKey: string,
  session: string,
): string | undefined {
  const own = promptStateFile(project, engineKey, session);
  const prefix = `${hash(project)}-${engineKey}-`;
  let newest: { name: string; mtime: number } | undefined;
  for (const name of listStates(dir)) {
    if (name === own) return own;
    if (!name.startsWith(prefix)) continue;
    const mtime = statSync(path.join(dir, name)).mtimeMs;
    if (!newest || mtime > newest.mtime) newest = { name, mtime };
  }
  return newest?.name;
}

/** Delete the oldest saved states until the rest fit in `maxBytes`. */
export function prunePromptStates(
  dir: string,
  maxBytes: number = PROMPT_CACHE_MAX_BYTES,
): void {
  const files = listStates(dir)
    .map((name) => {
      const stat = statSync(path.join(dir, name));
      return { name, size: stat.size, mtime: stat.mtimeMs };
    })
    .sort((a, b) => b.mtime - a.mtime);
  let total = 0;
  for (const file of files) {
    total += file.size;
    if (total > maxBytes) {
      rmSync(path.join(dir, file.name), { force: true });
    }
  }
}

/** Create the folder, private to the user. */
export function ensurePromptCacheDir(dir: string): void {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
}

function listStates(dir: string): string[] {
  try {
    return readdirSync(dir).filter((name) => name.endsWith('.bin'));
  } catch {
    return [];
  }
}
