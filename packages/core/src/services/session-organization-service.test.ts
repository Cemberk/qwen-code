/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SessionOrganizationService } from './session-organization-service.js';

describe('SessionOrganizationService', () => {
  let previousRuntimeDir: string | undefined;
  let runtimeDir: string;
  let service: SessionOrganizationService;
  let warnings: string[];

  const cwd = '/workspace/project';
  const sessionIdA = '550e8400-e29b-41d4-a716-446655440000';
  const sessionIdB = '6ba7b810-9dad-11d1-80b4-00c04fd430c8';

  beforeEach(async () => {
    previousRuntimeDir = process.env['QWEN_RUNTIME_DIR'];
    runtimeDir = await fs.mkdtemp(path.join(os.tmpdir(), 'qwen-org-'));
    process.env['QWEN_RUNTIME_DIR'] = runtimeDir;
    warnings = [];
    service = new SessionOrganizationService(cwd, (warning) => {
      warnings.push(warning);
    });
  });

  afterEach(async () => {
    if (previousRuntimeDir === undefined) {
      delete process.env['QWEN_RUNTIME_DIR'];
    } else {
      process.env['QWEN_RUNTIME_DIR'] = previousRuntimeDir;
    }
    await fs.rm(runtimeDir, { recursive: true, force: true });
  });

  // Groups and pins are only read back from sidecars written by earlier
  // releases; seed the store file directly.
  async function writeStore(store: unknown): Promise<void> {
    await fs.mkdir(path.dirname(service.getStorePath()), { recursive: true });
    await fs.writeFile(service.getStorePath(), JSON.stringify(store), 'utf8');
  }

  const pinned = (groupId: string | null = null) => ({
    groupId,
    pinnedAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  });

  const cleanupGroup = {
    id: 'group-cleanup',
    name: 'Cleanup',
    color: 'purple',
    order: 0,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  };

  it('keeps groups with unsupported stored colors by falling back and warning once', async () => {
    await fs.mkdir(path.dirname(service.getStorePath()), { recursive: true });
    await fs.writeFile(
      service.getStorePath(),
      JSON.stringify({
        schemaVersion: 1,
        groups: [
          {
            id: 'group-future',
            name: 'Future',
            color: 'teal',
            order: 0,
            createdAt: '2026-01-01T00:00:00.000Z',
            updatedAt: '2026-01-01T00:00:00.000Z',
          },
        ],
        sessions: {
          [sessionIdA]: {
            groupId: 'group-future',
            updatedAt: '2026-01-01T00:00:00.000Z',
          },
        },
      }),
      'utf8',
    );

    expect((await service.readSnapshot()).groups).toEqual([
      expect.objectContaining({
        id: 'group-future',
        name: 'Future',
        color: 'blue',
      }),
    ]);
    const snapshot = await service.readSnapshot();
    expect(snapshot.sessions.get(sessionIdA)).toEqual(
      expect.objectContaining({
        groupId: 'group-future',
      }),
    );
    await new SessionOrganizationService(cwd, (warning) => {
      warnings.push(warning);
    }).readSnapshot();

    expect(warnings).toEqual([
      'Session group "Future" (id: group-future) uses unsupported color "teal"; using "blue"',
    ]);
  });

  it('warns when dropping duplicate group names from the sidecar', async () => {
    await fs.mkdir(path.dirname(service.getStorePath()), { recursive: true });
    await fs.writeFile(
      service.getStorePath(),
      JSON.stringify({
        schemaVersion: 1,
        groups: [
          {
            id: 'group-a',
            name: 'Work',
            color: 'red',
            order: 0,
            createdAt: '2026-01-01T00:00:00.000Z',
            updatedAt: '2026-01-01T00:00:00.000Z',
          },
          {
            id: 'group-b',
            name: 'work',
            color: 'blue',
            order: 1,
            createdAt: '2026-01-01T00:00:00.000Z',
            updatedAt: '2026-01-01T00:00:00.000Z',
          },
        ],
        sessions: {},
      }),
      'utf8',
    );

    expect((await service.readSnapshot()).groups).toEqual([
      expect.objectContaining({
        id: 'group-a',
        name: 'Work',
      }),
    ]);
    expect(warnings).toEqual([
      'Dropped duplicate session group by name: "work" (id: group-b)',
    ]);
  });

  it('normalizes unknown stored session colors to null', async () => {
    await fs.mkdir(path.dirname(service.getStorePath()), { recursive: true });
    await fs.writeFile(
      service.getStorePath(),
      JSON.stringify({
        schemaVersion: 1,
        groups: [],
        sessions: {
          [sessionIdA]: {
            groupId: null,
            color: 'teal',
            updatedAt: '2026-01-01T00:00:00.000Z',
          },
        },
      }),
      'utf8',
    );

    const snapshot = await service.readSnapshot();
    expect(snapshot.sessions.get(sessionIdA)).toEqual(
      expect.objectContaining({ color: null }),
    );
  });

  it('warns once when reading orphaned group references', async () => {
    await fs.mkdir(path.dirname(service.getStorePath()), { recursive: true });
    await fs.writeFile(
      service.getStorePath(),
      JSON.stringify({
        schemaVersion: 1,
        groups: [],
        sessions: {
          [sessionIdA]: {
            groupId: 'missing-group',
            updatedAt: '2026-01-01T00:00:00.000Z',
          },
        },
      }),
      'utf8',
    );

    const snapshot = await service.readSnapshot();
    expect(snapshot.sessions.get(sessionIdA)).toEqual(
      expect.objectContaining({
        groupId: null,
        isPinned: false,
      }),
    );
    await service.readSnapshot();
    await new SessionOrganizationService(cwd, (warning) => {
      warnings.push(warning);
    }).readSnapshot();

    expect(warnings).toEqual([
      `Dropped orphaned session group reference: session ${sessionIdA} references missing group missing-group`,
    ]);
  });

  it('warns once when reading malformed session entries', async () => {
    await fs.mkdir(path.dirname(service.getStorePath()), { recursive: true });
    await fs.writeFile(
      service.getStorePath(),
      JSON.stringify({
        schemaVersion: 1,
        groups: [],
        sessions: {
          [sessionIdA]: 'bad-entry',
        },
      }),
      'utf8',
    );

    const snapshot = await service.readSnapshot();
    expect(snapshot.sessions.has(sessionIdA)).toBe(false);
    await new SessionOrganizationService(cwd, (warning) => {
      warnings.push(warning);
    }).readSnapshot();

    expect(warnings).toEqual([
      `Dropped malformed session organization entry: ${sessionIdA}`,
    ]);
  });

  it('treats a malformed sidecar as empty for reads and leaves it untouched on removal', async () => {
    await fs.mkdir(path.dirname(service.getStorePath()), { recursive: true });
    await fs.writeFile(service.getStorePath(), '{not-json', 'utf8');

    expect((await service.readSnapshot()).groups).toEqual([]);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('Failed to read session organization store');
    await service.readSnapshot();
    expect(warnings).toHaveLength(1);

    await service.removeSession(sessionIdA);

    await expect(fs.readFile(service.getStorePath(), 'utf8')).resolves.toBe(
      '{not-json',
    );
  });

  it('includes schema version details in unreadable store warnings', async () => {
    await fs.mkdir(path.dirname(service.getStorePath()), { recursive: true });
    await fs.writeFile(
      service.getStorePath(),
      JSON.stringify({
        schemaVersion: 2,
        groups: [],
        sessions: {},
      }),
      'utf8',
    );

    expect((await service.readSnapshot()).groups).toEqual([]);

    expect(warnings).toEqual([
      expect.stringContaining(
        'store schema is unsupported (found schemaVersion 2, expected 1)',
      ),
    ]);
  });

  it('removes a session organization entry from the sidecar', async () => {
    await writeStore({
      schemaVersion: 1,
      groups: [cleanupGroup],
      sessions: { [sessionIdA]: pinned(cleanupGroup.id) },
    });

    await service.removeSession(sessionIdA);

    const snapshot = await service.readSnapshot();
    expect(snapshot.sessions.has(sessionIdA)).toBe(false);
  });

  it('checks the runtime generation before removing an organization entry', async () => {
    await writeStore({
      schemaVersion: 1,
      groups: [],
      sessions: { [sessionIdA]: pinned() },
    });
    const generationClosed = new Error('generation closed');

    await expect(
      service.removeSession(sessionIdA, {
        assertCanCommit: () => {
          throw generationClosed;
        },
      }),
    ).rejects.toBe(generationClosed);
    expect((await service.readSnapshot()).sessions.has(sessionIdA)).toBe(true);
  });

  it('removes multiple session organization entries in one call', async () => {
    await writeStore({
      schemaVersion: 1,
      groups: [cleanupGroup],
      sessions: {
        [sessionIdA]: pinned(cleanupGroup.id),
        [sessionIdB]: pinned(cleanupGroup.id),
      },
    });

    await service.removeSessions([sessionIdA, sessionIdB, sessionIdA]);

    const snapshot = await service.readSnapshot();
    expect(snapshot.sessions.has(sessionIdA)).toBe(false);
    expect(snapshot.sessions.has(sessionIdB)).toBe(false);
  });
});
