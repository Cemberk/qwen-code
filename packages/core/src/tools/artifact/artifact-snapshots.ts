/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { getWebPreviewSnapshotId } from '../../services/session-artifact-persistence.js';
import type { ToolArtifact } from '../tools.js';

const SNAPSHOT_REFERENCES_METADATA_KEY = 'qwen.snapshot.references';

function snapshotReference(sessionId: string, operationId?: string): string {
  const owner = createHash('sha256').update(sessionId).digest('hex');
  return operationId
    ? `${owner}-${createHash('sha256').update(operationId).digest('hex')}`
    : owner;
}

async function syncSnapshotDirectory(directory: string): Promise<void> {
  try {
    const handle = await fs.open(directory, 'r');
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
  } catch (error) {
    if (process.platform !== 'win32') throw error;
  }
}

async function snapshotDirectory(
  artifact: ToolArtifact,
  runtimeBaseDir: string,
): Promise<string | undefined> {
  const id = getWebPreviewSnapshotId(artifact);
  if (!id) return undefined;
  const root = path.join(runtimeBaseDir, 'artifacts', 'snapshots');
  const dir = path.join(root, id);
  if (artifact.url !== pathToFileURL(path.join(dir, 'index.html')).href) {
    return undefined;
  }
  // Untracked snapshots predate reference-based reclamation and stay intact.
  if (artifact.metadata?.[SNAPSHOT_REFERENCES_METADATA_KEY] !== 1)
    return undefined;
  const realRoot = await fs.realpath(root);
  if ((await fs.realpath(dir)) !== path.join(realRoot, id)) return undefined;
  if (
    (await fs.realpath(path.join(dir, 'index.html'))) !==
    path.join(realRoot, id, 'index.html')
  )
    return undefined;
  if (
    (await fs.realpath(path.join(dir, 'references'))) !==
    path.join(realRoot, id, 'references')
  ) {
    return undefined;
  }
  return dir;
}

export async function retainArtifactSnapshot(
  artifact: ToolArtifact,
  runtimeBaseDir: string,
  sessionId: string,
  operationId?: string,
): Promise<void> {
  try {
    const dir = await snapshotDirectory(artifact, runtimeBaseDir);
    if (!dir) return;
    const references = path.join(dir, 'references');
    const owner = snapshotReference(sessionId);
    const entries = await fs.readdir(references);
    if (
      !operationId &&
      entries.some((entry) => entry === owner || entry.startsWith(`${owner}-`))
    )
      return;
    await fs.writeFile(
      path.join(references, snapshotReference(sessionId, operationId)),
      '',
      { flag: 'wx', mode: 0o600, flush: true },
    );
    await syncSnapshotDirectory(references);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    // A fork must acquire ownership before committing. An ordinary restore can
    // still show an unavailable historical descriptor when its file is missing.
    if (code !== 'EEXIST' && !(code === 'ENOENT' && !operationId)) throw error;
  }
}

export async function deleteArtifactSnapshot(
  artifact: ToolArtifact,
  runtimeBaseDir: string,
  sessionId: string,
  operationId?: string,
  assertCleanupOwned?: () => void,
): Promise<void> {
  try {
    const dir = await snapshotDirectory(artifact, runtimeBaseDir);
    if (!dir) return;
    await releaseSnapshotDirectory(
      dir,
      sessionId,
      operationId,
      assertCleanupOwned,
    );
  } catch {
    assertCleanupOwned?.();
    // Reclamation must never break record removal.
  }
}

async function releaseSnapshotDirectory(
  dir: string,
  sessionId: string,
  operationId?: string,
  assertCleanupOwned?: () => void,
): Promise<void> {
  const references = path.join(dir, 'references');
  const owner = snapshotReference(sessionId, operationId);
  let released = false;
  for (const reference of await fs.readdir(references)) {
    if (
      reference === owner ||
      (!operationId && reference.startsWith(`${owner}-`))
    ) {
      assertCleanupOwned?.();
      await fs.unlink(path.join(references, reference));
      released = true;
    }
  }
  if (!released) return;
  // rmdir is the atomic last-owner claim. A concurrent retain either prevents
  // it or fails before the new fork can commit its transcript.
  try {
    assertCleanupOwned?.();
    await fs.rmdir(references);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOTEMPTY') return;
    throw error;
  }
  const file = path.join(dir, 'index.html');
  assertCleanupOwned?.();
  await fs.unlink(file);
  assertCleanupOwned?.();
  await fs.rmdir(dir);
}
