/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { createHash, randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  deleteArtifactSnapshot,
  retainArtifactSnapshot,
} from './artifact-snapshots.js';
import { PUBLISHED_CONTENT_SHA256_METADATA_KEY } from '../../services/session-artifact-persistence.js';
import type { ToolArtifact } from '../tools.js';

describe('saved Artifact versions', () => {
  let runtime: string;
  beforeEach(async () => {
    runtime = await fs.mkdtemp(path.join(os.tmpdir(), 'qwen-snapshot-'));
    vi.stubEnv('QWEN_RUNTIME_DIR', runtime);
  });
  afterEach(async () => {
    vi.unstubAllEnvs();
    await fs.rm(runtime, { recursive: true, force: true });
  });

  // Saved webpage versions are no longer written, but session cleanup still
  // reclaims the ones older transcripts reference. This writes that on-disk
  // layout: `<runtime>/artifacts/snapshots/<id>/{index.html,references/<owner>}`.
  async function writeSnapshotFixture(
    html: string,
    sessionId: string,
  ): Promise<ToolArtifact> {
    const id = randomUUID();
    const dir = path.join(runtime, 'artifacts', 'snapshots', id);
    await fs.mkdir(path.join(dir, 'references'), { recursive: true });
    await fs.writeFile(
      path.join(
        dir,
        'references',
        createHash('sha256').update(sessionId).digest('hex'),
      ),
      '',
    );
    const file = path.join(dir, 'index.html');
    await fs.writeFile(file, html);
    return {
      kind: 'html',
      storage: 'published',
      title: 'Page',
      url: pathToFileURL(file).href,
      managedId: `preview-${id}`,
      mimeType: 'text/html',
      sizeBytes: Buffer.byteLength(html, 'utf8'),
      metadata: {
        artifactType: 'web_preview_snapshot',
        'qwen.snapshot.references': 1,
        publishedUrl: 'https://example.com',
        [PUBLISHED_CONTENT_SHA256_METADATA_KEY]: createHash('sha256')
          .update(html)
          .digest('hex'),
      },
    };
  }

  const readSnapshot = (snapshot: ToolArtifact) =>
    fs.readFile(fileURLToPath(snapshot.url!), 'utf8');

  it('reclaims an evicted snapshot while retained versions stay readable', async () => {
    const first = await writeSnapshotFixture('<h1>v1</h1>', 'owner');
    const second = await writeSnapshotFixture('<h1>v2</h1>', 'owner');
    await deleteArtifactSnapshot(first, runtime, 'owner');
    await expect(readSnapshot(first)).rejects.toThrow();
    await expect(readSnapshot(second)).resolves.toBe('<h1>v2</h1>');
    // Reclaiming an already-reclaimed snapshot is a quiet no-op.
    await expect(
      deleteArtifactSnapshot(first, runtime, 'owner'),
    ).resolves.toBeUndefined();
  });

  it('preserves unloaded fork ownership and removes bytes only for the final owner', async () => {
    const snapshot = await writeSnapshotFixture('shared', 'owner');
    await retainArtifactSnapshot(snapshot, runtime, 'fork', 'committed-fork');
    await retainArtifactSnapshot(snapshot, runtime, 'fork', 'failed-fork');
    await deleteArtifactSnapshot(snapshot, runtime, 'fork', 'failed-fork');
    await deleteArtifactSnapshot(snapshot, runtime, 'owner');
    await expect(readSnapshot(snapshot)).resolves.toBe('shared');
    await deleteArtifactSnapshot(snapshot, runtime, 'fork');
    await expect(
      fs.stat(path.dirname(fileURLToPath(snapshot.url!))),
    ).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('uses the captured runtime and never collects an untracked legacy snapshot', async () => {
    const snapshot = await writeSnapshotFixture('history', 'owner');
    vi.stubEnv('QWEN_RUNTIME_DIR', path.join(runtime, 'other'));
    await deleteArtifactSnapshot(
      snapshot,
      path.join(runtime, 'other'),
      'owner',
    );
    await expect(readSnapshot(snapshot)).resolves.toBe('history');
    const legacy = { ...snapshot, metadata: { ...snapshot.metadata } };
    delete legacy.metadata['qwen.snapshot.references'];
    await deleteArtifactSnapshot(legacy, runtime, 'owner');
    await expect(readSnapshot(snapshot)).resolves.toBe('history');
    await deleteArtifactSnapshot(snapshot, runtime, 'owner');
    await expect(readSnapshot(snapshot)).rejects.toThrow();
  });

  it('fails a retain after reclamation claims the reference directory', async () => {
    const snapshot = await writeSnapshotFixture('history', 'owner');
    await fs.rm(
      path.join(path.dirname(fileURLToPath(snapshot.url!)), 'references'),
      { recursive: true },
    );
    await expect(
      retainArtifactSnapshot(snapshot, runtime, 'fork', 'operation'),
    ).rejects.toMatchObject({ code: 'ENOENT' });
    await fs.rm(path.dirname(fileURLToPath(snapshot.url!)), {
      recursive: true,
    });
    await expect(
      retainArtifactSnapshot(snapshot, runtime, 'fork', 'operation'),
    ).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('rechecks deletion ownership after asynchronous reference lookup', async () => {
    const snapshot = await writeSnapshotFixture('history', 'owner');
    let lost = false;
    const readdir = fs.readdir.bind(fs);
    const spy = vi.spyOn(fs, 'readdir').mockImplementation(async (...args) => {
      const result = await readdir(...args);
      lost = true;
      return result;
    });
    try {
      await expect(
        deleteArtifactSnapshot(snapshot, runtime, 'owner', undefined, () => {
          if (lost) throw new Error('lease lost');
        }),
      ).rejects.toThrow('lease lost');
    } finally {
      spy.mockRestore();
    }
    await expect(readSnapshot(snapshot)).resolves.toBe('history');
  });

  it('never deletes outside the exact file the descriptor points at', async () => {
    const snapshot = await writeSnapshotFixture('original', 'owner');
    const id = snapshot.managedId!.slice('preview-'.length);
    for (const override of [
      // Classifier rejects: wrong suffix, wrong metadata, wrong source.
      { url: 'file:///tmp/elsewhere.html' },
      { managedId: '../outside' },
      { metadata: { artifactType: 'web_preview_snapshot' } },
      { source: 'client' as const },
      // Classifier passes, but the url root is another runtime's tree:
      // reclamation must not follow it anywhere.
      {
        url: pathToFileURL(
          path.join(
            runtime,
            'foreign',
            'artifacts',
            'snapshots',
            id,
            'index.html',
          ),
        ).href,
      },
    ]) {
      await deleteArtifactSnapshot(
        { ...snapshot, ...override },
        runtime,
        'owner',
      );
      await expect(readSnapshot(snapshot)).resolves.toBe('original');
    }
  });
});
