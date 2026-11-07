/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { createHash, randomBytes } from 'node:crypto';
import {
  chmodSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * Where the local model pool of this user keeps its files: the lock, the key
 * clients authenticate with, and the daemon's log. Private to the user.
 */
export function poolDir(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
  home: string = os.homedir(),
): string {
  const base =
    platform === 'darwin'
      ? path.join(home, 'Library', 'Caches')
      : platform === 'win32'
        ? env['LOCALAPPDATA'] || path.join(home, 'AppData', 'Local')
        : env['XDG_CACHE_HOME'] || path.join(home, '.cache');
  return path.join(base, 'qwen-code', 'pool');
}

/**
 * The address the daemon listens on: a named pipe on Windows, a Unix socket
 * elsewhere. One per user and pool folder, so tests with their own folder
 * never meet the user's daemon.
 */
export function poolAddress(
  dir: string = poolDir(),
  platform: NodeJS.Platform = process.platform,
  user: string = safeUserName(),
): string {
  const id = createHash('sha256').update(dir).digest('hex').slice(0, 12);
  if (platform === 'win32') return `\\\\.\\pipe\\qwen-pool-${user}-${id}`;
  // A socket path must stay under about 100 bytes: the folder may be long.
  const socket = path.join(dir, 'pool.sock');
  return socket.length <= 100
    ? socket
    : path.join(
        os.tmpdir().length > 60 ? '/tmp' : os.tmpdir(),
        `qwen-pool-${id}.sock`,
      );
}

function safeUserName(): string {
  try {
    return os.userInfo().username.replace(/[^A-Za-z0-9_-]/g, '_') || 'user';
  } catch {
    return 'user';
  }
}

/** Create the pool folder, readable by this user only. */
export function ensurePoolDir(dir: string = poolDir()): string {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  return dir;
}

/**
 * The key every request to the daemon carries, made once per pool folder.
 * Only this user can read the folder, so only this user's programs can talk
 * to the daemon, even where the pipe itself is visible to others.
 */
export function poolKey(dir: string = poolDir()): string {
  const file = path.join(ensurePoolDir(dir), 'key');
  try {
    const key = readFileSync(file, 'utf8').trim();
    if (/^[0-9a-f]{48}$/.test(key)) return key;
  } catch {
    // Make one.
  }
  const key = randomBytes(24).toString('hex');
  const temp = `${file}.${process.pid}`;
  writeFileSync(temp, key, { mode: 0o600 });
  try {
    chmodSync(temp, 0o600);
  } catch {
    // Windows: the folder's permissions apply.
  }
  // Two first clients at once: the last rename wins, so read it back.
  renameSync(temp, file);
  return readFileSync(file, 'utf8').trim();
}

/** The lock file: the running daemon's pid and start time. */
export function poolLockFile(dir: string = poolDir()): string {
  return path.join(dir, 'daemon.lock');
}

/** The daemon's log, rewritten at each start. */
export function poolLogFile(dir: string = poolDir()): string {
  return path.join(dir, 'daemon.log');
}
