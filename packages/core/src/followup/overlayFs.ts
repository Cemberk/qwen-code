/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 *
 * Copy-on-Write Overlay Filesystem
 *
 * Provides file isolation for speculative execution. Writes go to a temporary
 * overlay directory while reads resolve to overlay (if previously written)
 * or the real filesystem.
 */

import {
  mkdir,
  mkdtemp,
  copyFile,
  rm,
  lstat,
  readFile,
} from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, dirname, relative, isAbsolute, sep } from 'node:path';
import { tmpdir } from 'node:os';
import { atomicWriteFile } from '../utils/atomicFileWrite.js';

/**
 * Copy-on-write overlay filesystem for speculation safety.
 */
export class OverlayFs {
  // Created on first write as a fresh owner-only directory: the overlay holds
  // copies of workspace files, and the shared temp directory may be readable
  // or writable by other users.
  private overlayDir?: Promise<string>;
  private readonly writtenFiles = new Map<string, string>(); // relPath -> overlayPath

  constructor(private readonly realCwd: string) {}

  /**
   * Resolve a read path: return overlay path if the file was previously written,
   * otherwise return the real path.
   */
  resolveReadPath(realPath: string): string {
    const rel = this.toRelative(realPath);
    if (rel && this.writtenFiles.has(rel)) {
      return this.writtenFiles.get(rel)!;
    }
    return realPath;
  }

  /**
   * Redirect a write to the overlay. On first write to a file, copies the
   * original to the overlay (if it exists). Returns the overlay path to write to.
   */
  async redirectWrite(realPath: string): Promise<string> {
    const rel = this.toRelative(realPath);
    if (!rel) {
      throw new Error(`Cannot redirect write outside cwd: ${realPath}`);
    }

    // Already in overlay
    if (this.writtenFiles.has(rel)) {
      return this.writtenFiles.get(rel)!;
    }

    this.overlayDir ??= mkdtemp(join(tmpdir(), 'qwen-speculation-'));
    const overlayPath = join(await this.overlayDir, rel);
    await mkdir(dirname(overlayPath), { recursive: true });

    // Copy-on-write: copy original to overlay if it exists
    const originalPath = join(this.realCwd, rel);
    if (existsSync(originalPath)) {
      try {
        await copyFile(originalPath, overlayPath);
      } catch {
        // Original may be a directory or unreadable — proceed without copy
      }
    }
    // For new files: the overlay path is created but empty — the tool will write to it

    this.writtenFiles.set(rel, overlayPath);
    return overlayPath;
  }

  /**
   * Copy all overlay files back to the real filesystem.
   * Returns the list of real paths that were updated.
   */
  async applyToReal(): Promise<string[]> {
    const applied: string[] = [];

    for (const [rel, overlayPath] of this.writtenFiles) {
      const realPath = join(this.realCwd, rel);
      try {
        // A symlink anywhere below cwd (planted while speculating, or
        // already in the repo) would carry the copy outside the workspace.
        if (await this.hasSymlinkComponent(rel)) continue;
        await mkdir(dirname(realPath), { recursive: true });
        if (await this.hasSymlinkComponent(rel)) continue;
        await atomicWriteFile(realPath, await readFile(overlayPath), {
          noFollow: true,
        });
        applied.push(realPath);
      } catch {
        // Best-effort — ignore errors and continue
      }
    }

    return applied;
  }

  private async hasSymlinkComponent(rel: string): Promise<boolean> {
    let current = this.realCwd;
    for (const part of rel.split(sep)) {
      current = join(current, part);
      try {
        if ((await lstat(current)).isSymbolicLink()) return true;
      } catch {
        return false; // the rest of the path does not exist yet
      }
    }
    return false;
  }

  /**
   * Clean up the overlay directory.
   */
  async cleanup(): Promise<void> {
    if (!this.overlayDir) return;
    try {
      await rm(await this.overlayDir, { recursive: true, force: true });
    } catch {
      // Best-effort cleanup
    }
  }

  /**
   * Convert an absolute path to a relative path within cwd.
   * Returns null if the path is outside cwd.
   */
  private toRelative(inputPath: string): string | null {
    // Resolve relative paths against realCwd (not process.cwd())
    const abs = isAbsolute(inputPath)
      ? inputPath
      : join(this.realCwd, inputPath);
    const rel = relative(this.realCwd, abs);
    if (isAbsolute(rel) || rel.startsWith('..')) {
      return null;
    }
    return rel;
  }
}
