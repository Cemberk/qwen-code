/**
 * @license
 * Copyright 2025 Qwen Code
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Integration tests for SessionService corruption-recovery paths.
 *
 * Lives in its own file (no module-level `vi.mock`) because both
 * `countSessionMessagesFromPath` and `readLastRecordUuid` walk real bytes
 * from disk via `fs.createReadStream` / `fs.readSync`, and need the real
 * `jsonl.parseLineTolerant` to exercise the `}{`-glued recovery path
 * introduced for #3606. The unit-test file (sessionService.test.ts) mocks
 * jsonl-utils wholesale, so corruption shapes can't be exercised there.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';
import { SessionService, SessionStorageEntryError } from './sessionService.js';
import { SessionTranscriptIdentityUnavailableError } from './session-writer-errors.js';
import type { ChatRecord } from './chatRecordingService.js';
import type { HistoryGap } from '../utils/conversation-chain.js';
import { expectWithinLatencyBudget } from '../test-utils/latency-budget.js';

let tmpRoot: string;

beforeAll(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'session-svc-corruption-'));
});

afterAll(() => {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

function recordFor(
  uuid: string,
  type: 'user' | 'assistant',
  parentUuid: string | null,
): ChatRecord {
  return {
    uuid,
    parentUuid,
    sessionId: '550e8400-e29b-41d4-a716-446655440000',
    timestamp: '2024-01-01T00:00:00Z',
    type,
    message: {
      role: type === 'user' ? 'user' : 'model',
      parts: [{ text: 'x' }],
    },
    cwd: '/tmp/x',
    version: '1.0.0',
    gitBranch: 'main',
  };
}

function writeJsonl(name: string, content: string): string {
  const p = path.join(tmpRoot, name);
  fs.writeFileSync(p, content, 'utf8');
  return p;
}

describe('SessionService.readLastRecordUuid (corruption recovery)', () => {
  type Privates = {
    readLastRecordUuid: (filePath: string) => string | null;
  };
  let svc: Privates;

  beforeEach(() => {
    svc = new SessionService('/tmp/x') as unknown as Privates;
  });

  it('returns the latest record uuid from a `}{`-glued tail line', () => {
    // Critical case: renameSession passes this uuid as the parentUuid of the
    // synthetic title record. If the tail line is glued and we silently drop
    // it (old behaviour), parentUuid points at an earlier record and
    // reconstructHistory truncates the chain on resume.
    const r1 = JSON.stringify(recordFor('u1', 'user', null));
    const r2 = JSON.stringify(recordFor('u2', 'assistant', 'u1'));
    const file = writeJsonl('glued-tail.jsonl', `${r1}${r2}\n`);

    expect(svc.readLastRecordUuid(file)).toBe('u2');
  });

  it('walks past a malformed tail line and returns the previous valid uuid', () => {
    const r1 = JSON.stringify(recordFor('u1', 'user', null));
    const file = writeJsonl('garbage-tail.jsonl', `${r1}\nnot-json-at-all\n`);

    expect(svc.readLastRecordUuid(file)).toBe('u1');
  });

  it('returns null for a file with no recoverable records', () => {
    const file = writeJsonl('no-records.jsonl', 'not-json\nstill-not-json\n');
    expect(svc.readLastRecordUuid(file)).toBeNull();
  });

  it('returns null for a missing file', () => {
    expect(svc.readLastRecordUuid(path.join(tmpRoot, 'nope.jsonl'))).toBeNull();
  });

  it('does not extract a uuid from a payload object inside a partial-tail fragment', () => {
    // When the last record exceeds TAIL_READ_SIZE (64 KiB), the tail buffer
    // starts mid-record. Without the boundary guard, _recoverObjectsFromLine
    // walks the partial fragment with depth starting at 0, finds a balanced
    // inner `{ "uuid": "fake" }` object inside the record's payload, and
    // surfaces "fake" as if it were the last top-level uuid. renameSession
    // would then anchor custom_title.parentUuid at payload data and
    // reconstructHistory would truncate the chain on resume.
    //
    // Filler is a long array of zeros (no quote characters) so the parser's
    // inString state stays aligned even when entering mid-fragment, ensuring
    // the trojan is reachable. ~80k entries → ~160 KB, comfortably above
    // TAIL_READ_SIZE.
    const filler = new Array(80000).fill(0).join(',');
    const giantLine =
      `{"uuid":"real-last","filler":[${filler}],` +
      `"trojan":{"uuid":"fake-from-payload"}}`;
    const file = writeJsonl('big-tail.jsonl', `${giantLine}\n`);

    // We cannot recover "real-last" — it lies before the tail window. The
    // critical assertion is the absence of the false-positive recovery: the
    // function must not surface the payload's nested uuid.
    expect(svc.readLastRecordUuid(file)).not.toBe('fake-from-payload');
  });

  it('returns the final complete record uuid when a giant partial precedes it in the tail', () => {
    // Positive twin of the partial-tail test above: after a giant line
    // whose head is past the tail window, append one normal complete
    // record. The partial first segment must be discarded, but the
    // complete record after the in-window `\n` must be recovered. Pins
    // the desired behaviour — the bare-negative assertion above would
    // still pass if the function silently skipped every line in the
    // window and returned `null`.
    const filler = new Array(80000).fill(0).join(',');
    const giantLine =
      `{"uuid":"too-early-to-see","filler":[${filler}],` +
      `"trojan":{"uuid":"fake-from-payload"}}`;
    const finalRecord = JSON.stringify(recordFor('actual-last', 'user', null));
    const file = writeJsonl(
      'big-tail-then-final.jsonl',
      `${giantLine}\n${finalRecord}\n`,
    );

    expect(svc.readLastRecordUuid(file)).toBe('actual-last');
  });

  it('returns the only record when the tail window starts exactly on a newline boundary', () => {
    // Boundary case: file is `prev\n<final>\n` where `final\n` is
    // exactly TAIL_READ_SIZE bytes, so the tail read covers `final\n`
    // and `readStart - 1` lands on the separating `\n`. The first
    // split segment is a complete record — not a partial fragment.
    // An unconditional `lines.shift()` drops the only readable uuid
    // and `renameSession` writes `custom_title.parentUuid` as `null`,
    // truncating history on resume. The fix peeks the byte before
    // `readStart` to distinguish boundary-aligned from mid-line reads.
    const TAIL_READ_SIZE = 64 * 1024;
    // Build `final` so that `final + '\n'` is exactly TAIL_READ_SIZE.
    // `recordFor` produces a stable JSON shape; pad it via an extra
    // `filler` field tuned so the stringified record + 1 (for the
    // trailing newline we'll join with) hits the target length.
    const baseFinal = recordFor('boundary-final', 'user', null);
    const baseFinalLen = Buffer.byteLength(JSON.stringify(baseFinal), 'utf8');
    // The added field looks like `,"filler":"x...x"` — fixed overhead
    // (everything except the x-run) is 12 bytes: ` , " f i l l e r " : " " ` .
    const fillerLen = TAIL_READ_SIZE - 1 - baseFinalLen - 12;
    expect(fillerLen).toBeGreaterThan(0);
    const finalRecord = JSON.stringify({
      ...baseFinal,
      filler: 'x'.repeat(fillerLen),
    });
    expect(Buffer.byteLength(finalRecord + '\n', 'utf8')).toBe(TAIL_READ_SIZE);

    const prevRecord = JSON.stringify(recordFor('older', 'user', null));
    const file = writeJsonl(
      'tail-aligned.jsonl',
      `${prevRecord}\n${finalRecord}\n`,
    );

    expect(svc.readLastRecordUuid(file)).toBe('boundary-final');
  });
});

describe('SessionService lifecycle maintenance', () => {
  type Privates = {
    getSessionFilePath: (id: string, state: 'active' | 'archived') => string;
    getPromptLedgerPathForState: (
      id: string,
      state: 'active' | 'archived',
    ) => string;
    getWorktreeSessionPathForState: (
      id: string,
      state: 'active' | 'archived',
    ) => string;
    sessionBelongsToCurrentProject: (
      sessionId: string,
      cwd: string,
    ) => Promise<boolean>;
  };

  // Archive, unarchive and delete all resolve the session's maintainable
  // location first; exercise that step directly.
  function maintainableLocation(service: SessionService, sessionId: string) {
    return (
      service as unknown as {
        resolveMaintainableSessionSnapshot: (
          sessionId: string,
          captureIdentity: boolean,
        ) => Promise<{ location: string | undefined }>;
      }
    )
      .resolveMaintainableSessionSnapshot(sessionId, false)
      .then((snapshot) => snapshot.location);
  }

  function createHarness(content: string, state: 'active' | 'archived') {
    const runtimeBaseDir = fs.mkdtempSync(path.join(tmpRoot, 'lifecycle-'));
    const cwd = path.join(runtimeBaseDir, 'workspace');
    fs.mkdirSync(cwd, { recursive: true });
    const service = new SessionService(cwd, { runtimeBaseDir });
    const sessionId = randomUUID();
    const paths = {
      active: (service as unknown as Privates).getSessionFilePath(
        sessionId,
        'active',
      ),
      archived: (service as unknown as Privates).getSessionFilePath(
        sessionId,
        'archived',
      ),
    };
    fs.mkdirSync(path.dirname(paths[state]), { recursive: true });
    fs.writeFileSync(paths[state], content);
    return { service, sessionId, paths, content, cwd };
  }

  const unreadableShapes = [
    { name: 'empty', content: '' },
    { name: 'damaged', content: '{"uuid":"torn-head"' },
  ];

  for (const shape of unreadableShapes) {
    it(`deletes an owned ${shape.name} transcript`, async () => {
      const { service, sessionId, paths } = createHarness(
        shape.content,
        'active',
      );

      await expect(service.removeSession(sessionId)).resolves.toBe(true);
      expect(fs.existsSync(paths.active)).toBe(false);
    });
  }

  it('maintains an owned legacy child whose parent no longer exists', async () => {
    const orphanContent = (sessionId: string, cwd: string) =>
      `${JSON.stringify({
        ...recordFor('u1', 'user', null),
        sessionId,
        cwd,
      })}\n${JSON.stringify({
        ...recordFor('u2', 'assistant', 'u1'),
        sessionId,
        cwd,
        type: 'system',
        subtype: 'parent_session',
        systemPayload: { parentSessionId: randomUUID() },
      })}\n`;

    const removal = createHarness('', 'active');
    fs.writeFileSync(
      removal.paths.active,
      orphanContent(removal.sessionId, removal.cwd),
    );
    await expect(
      removal.service.removeSession(removal.sessionId),
    ).resolves.toBe(true);
  });

  it('does not delete a readable archived transcript replaced after validation', async () => {
    const { service, sessionId, paths, cwd } = createHarness('', 'archived');
    fs.writeFileSync(
      paths.archived,
      `${JSON.stringify({
        ...recordFor('u1', 'user', null),
        sessionId,
        cwd,
      })}\n`,
    );
    const replacement = 'replacement';
    const assertStorageUnchanged = async () => {
      fs.renameSync(paths.archived, `${paths.archived}.original`);
      fs.writeFileSync(paths.archived, replacement);
    };

    await expect(
      service.removeSession(sessionId, { assertStorageUnchanged }),
    ).rejects.toThrow('changed outside its active writer');

    expect(fs.readFileSync(paths.archived, 'utf8')).toBe(replacement);
    expect(fs.existsSync(paths.active)).toBe(false);
  });

  it('does not delete a transcript that disappears and reappears during classification', async () => {
    const state = 'archived';
    const { service, sessionId, paths, cwd } = createHarness('', state);
    const sourcePath = paths[state];
    const originalContent = `${JSON.stringify({
      ...recordFor('u1', 'user', null),
      sessionId,
      cwd,
    })}\n`;
    fs.writeFileSync(sourcePath, originalContent);
    const replacement = 'replacement';

    const internals = service as unknown as {
      resolveMaintainableSessionSnapshot: (id: string) => Promise<unknown>;
    };
    const resolveSnapshot =
      internals.resolveMaintainableSessionSnapshot.bind(service);
    vi.spyOn(
      internals,
      'resolveMaintainableSessionSnapshot',
    ).mockImplementationOnce(async (id) => {
      fs.renameSync(sourcePath, `${sourcePath}.original`);
      const snapshot = await resolveSnapshot(id);
      fs.writeFileSync(sourcePath, replacement);
      return snapshot;
    });

    await expect(service.removeSession(sessionId)).resolves.toBe(false);

    expect(fs.readFileSync(sourcePath, 'utf8')).toBe(replacement);
    expect(fs.readFileSync(`${sourcePath}.original`, 'utf8')).toBe(
      originalContent,
    );
    expect(fs.existsSync(paths.active)).toBe(false);
  });

  it('does not delete a readable transcript whose record identifies another session', async () => {
    const state = 'active';
    const { service, sessionId, paths, cwd } = createHarness('', state);
    const sourcePath = paths[state];
    const content = `${JSON.stringify({
      ...recordFor('u1', 'user', null),
      sessionId: randomUUID(),
      cwd,
    })}\n`;
    fs.writeFileSync(sourcePath, content);

    await expect(service.removeSession(sessionId)).resolves.toBe(false);

    expect(fs.readFileSync(sourcePath, 'utf8')).toBe(content);
    expect(fs.existsSync(paths.archived)).toBe(false);
  });

  it.each([
    ['missing cwd', undefined],
    ['non-string cwd', 42],
  ] as const)('fails closed on a record with %s', async (_name, cwdValue) => {
    const state = 'active';
    const { service, sessionId, paths } = createHarness('', state);
    const sourcePath = paths[state];
    const record = {
      ...recordFor('u1', 'user', null),
      sessionId,
    } as Record<string, unknown>;
    if (cwdValue === undefined) {
      delete record['cwd'];
    } else {
      record['cwd'] = cwdValue;
    }
    fs.writeFileSync(sourcePath, `${JSON.stringify(record)}\n`);

    await expect(service.removeSession(sessionId)).rejects.toMatchObject({
      reason: 'unknown_project',
    });
    expect(fs.existsSync(sourcePath)).toBe(true);
  });

  it.each([
    ['missing session id', undefined],
    ['non-string session id', 42],
  ] as const)(
    'fails closed on a foreign record with %s',
    async (_name, sessionIdValue) => {
      const { service, sessionId, paths } = createHarness('', 'active');
      const foreignCwd = fs.mkdtempSync(path.join(tmpRoot, 'foreign-'));
      const record = {
        ...recordFor('u1', 'user', null),
        cwd: foreignCwd,
      } as Record<string, unknown>;
      if (sessionIdValue === undefined) {
        delete record['sessionId'];
      } else {
        record['sessionId'] = sessionIdValue;
      }
      const content = `${JSON.stringify(record)}\n`;
      fs.writeFileSync(paths.active, content);

      await expect(service.removeSession(sessionId)).rejects.toMatchObject({
        reason: 'unknown_project',
      });
      expect(fs.readFileSync(paths.active, 'utf8')).toBe(content);
    },
  );

  it('fails closed on mixed foreign and local storage during delete', async () => {
    const { service, sessionId, paths, cwd } = createHarness('', 'active');
    const foreignCwd = fs.mkdtempSync(path.join(tmpRoot, 'foreign-'));
    const activeContent = `${JSON.stringify({
      ...recordFor('u1', 'user', null),
      sessionId,
      cwd: foreignCwd,
    })}\n`;
    const archivedContent = `${JSON.stringify({
      ...recordFor('u2', 'user', null),
      sessionId,
      cwd,
    })}\n`;
    fs.writeFileSync(paths.active, activeContent);
    fs.mkdirSync(path.dirname(paths.archived), { recursive: true });
    fs.writeFileSync(paths.archived, archivedContent);

    await expect(service.removeSession(sessionId)).rejects.toMatchObject({
      reason: 'ambiguous_project',
    });
    expect(fs.readFileSync(paths.active, 'utf8')).toBe(activeContent);
    expect(fs.readFileSync(paths.archived, 'utf8')).toBe(archivedContent);
  });

  it('fails closed when delete sees another session id without cwd ownership', async () => {
    const state = 'active';
    const { service, sessionId, paths } = createHarness('', state);
    const sourcePath = paths[state];
    const record = {
      ...recordFor('u1', 'user', null),
      sessionId: randomUUID(),
    } as Record<string, unknown>;
    delete record['cwd'];
    const content = `${JSON.stringify(record)}\n`;
    fs.writeFileSync(sourcePath, content);

    await expect(service.removeSession(sessionId)).rejects.toMatchObject({
      reason: 'unknown_project',
    });
    expect(fs.readFileSync(sourcePath, 'utf8')).toBe(content);
  });

  it('maintains an oversized first physical record without buffering the whole file', async () => {
    const { service, sessionId, paths } = createHarness('', 'active');
    const content = 'x'.repeat(1024 * 1024 + 1);
    fs.writeFileSync(paths.active, content);

    await expect(maintainableLocation(service, sessionId)).resolves.toBe(
      'active',
    );
    expect(fs.readFileSync(paths.active, 'utf8')).toBe(content);
  });

  it('does not delete a just-over-limit readable transcript from another workspace', async () => {
    const state = 'active';
    const { service, sessionId, paths } = createHarness('', state);
    const sourcePath = paths[state];
    const foreignCwd = fs.mkdtempSync(path.join(tmpRoot, 'foreign-'));
    const content = `${JSON.stringify({
      ...recordFor('u1', 'user', null),
      sessionId,
      cwd: foreignCwd,
      filler: 'x'.repeat(1024 * 1024),
    })}\n`;
    expect(Buffer.byteLength(content)).toBeGreaterThan(1024 * 1024);
    expect(Buffer.byteLength(content)).toBeLessThan(1024 * 1024 + 64 * 1024);
    fs.writeFileSync(sourcePath, content);

    await expect(service.removeSession(sessionId)).resolves.toBe(false);
    expect(fs.readFileSync(sourcePath, 'utf8')).toBe(content);
    expect(fs.existsSync(paths.archived)).toBe(false);
  });

  it('fails closed on a readable transcript whose first record exceeds the bounded read window', async () => {
    const { service, sessionId, paths } = createHarness('', 'active');
    const foreignCwd = fs.mkdtempSync(path.join(tmpRoot, 'foreign-'));
    const content = `${JSON.stringify({
      ...recordFor('u1', 'user', null),
      sessionId,
      cwd: foreignCwd,
      filler: 'x'.repeat(2 * 1024 * 1024),
    })}\n`;
    fs.writeFileSync(paths.active, content);

    await expect(
      maintainableLocation(service, sessionId),
    ).rejects.toBeInstanceOf(SessionTranscriptIdentityUnavailableError);
    expect(fs.readFileSync(paths.active, 'utf8')).toBe(content);
  });

  it('rejects an in-place rewrite during ownership classification', async () => {
    const { service, sessionId, paths, cwd } = createHarness('', 'active');
    fs.writeFileSync(
      paths.active,
      `${JSON.stringify({
        ...recordFor('u1', 'user', null),
        sessionId,
        cwd,
      })}\n`,
    );
    const inode = fs.statSync(paths.active).ino;
    vi.spyOn(
      service as unknown as Privates,
      'sessionBelongsToCurrentProject',
    ).mockImplementation(async () => {
      fs.writeFileSync(paths.active, 'replacement');
      return true;
    });

    await expect(maintainableLocation(service, sessionId)).rejects.toThrow(
      'changed outside its active writer',
    );
    expect(fs.statSync(paths.active).ino).toBe(inode);
    expect(fs.readFileSync(paths.active, 'utf8')).toBe('replacement');
  });

  it('does not delete a readable transcript symlink', async () => {
    const state = 'active';
    const { service, sessionId, paths, cwd } = createHarness('', state);
    const sourcePath = paths[state];
    const targetPath = `${sourcePath}.target`;
    const targetContent = `${JSON.stringify({
      ...recordFor('u1', 'user', null),
      sessionId,
      cwd,
    })}\n`;
    fs.unlinkSync(sourcePath);
    fs.writeFileSync(targetPath, targetContent);
    fs.symlinkSync(targetPath, sourcePath);

    await expect(service.removeSession(sessionId)).rejects.toBeInstanceOf(
      SessionStorageEntryError,
    );

    expect(fs.lstatSync(sourcePath).isSymbolicLink()).toBe(true);
    expect(fs.readFileSync(targetPath, 'utf8')).toBe(targetContent);
  });

  it.runIf(process.platform !== 'win32')(
    'rejects a transcript FIFO without waiting for a writer',
    async () => {
      const { service, sessionId, paths } = createHarness('', 'active');
      fs.unlinkSync(paths.active);
      execFileSync('mkfifo', [paths.active]);
      let writer: number | undefined;
      const unblock = setTimeout(() => {
        writer = fs.openSync(
          paths.active,
          fs.constants.O_WRONLY | (fs.constants.O_NONBLOCK ?? 0),
        );
      }, 500);
      const startedAt = Date.now();

      try {
        await expect(
          maintainableLocation(service, sessionId),
        ).rejects.toBeInstanceOf(SessionStorageEntryError);
        expectWithinLatencyBudget(Date.now() - startedAt, 400);
      } finally {
        clearTimeout(unblock);
        if (writer !== undefined) fs.closeSync(writer);
      }
    },
  );

  it('does not delete a damaged transcript replaced after validation', async () => {
    const state = 'active';
    const { service, sessionId, paths } = createHarness(
      '{"uuid":"torn-head"',
      state,
    );
    const sourcePath = paths[state];
    const replacement = 'replacement';
    const assertStorageUnchanged = async () => {
      fs.renameSync(sourcePath, `${sourcePath}.original`);
      fs.writeFileSync(sourcePath, replacement);
    };

    await expect(
      service.removeSession(sessionId, { assertStorageUnchanged }),
    ).rejects.toThrow('changed outside its active writer');

    expect(fs.readFileSync(sourcePath, 'utf8')).toBe(replacement);
    expect(fs.existsSync(paths.active)).toBe(true);
  });
});

describe('SessionService.reconstructHistory (history-gap detection)', () => {
  // reconstructHistory is private; cast to reach it directly, matching the
  // pattern above. Integration point under test: the sessionService delegate
  // to buildOrderedUuidChain + aggregateRecords, plus the returned gaps.
  type Privates = {
    reconstructHistory: (
      records: ChatRecord[],
      opts?: { leafUuid?: string; detectGaps?: boolean },
    ) => { messages: ChatRecord[]; gaps: HistoryGap[] };
  };
  let svc: Privates;

  beforeEach(() => {
    svc = new SessionService('/tmp/x') as unknown as Privates;
  });

  // Two disconnected islands, the 965867 shape: island A (older) is a clean
  // root chain; island B (newer) begins with a record whose parentUuid points
  // at a record that is not in the file at all.
  const twoIslands: ChatRecord[] = [
    recordFor('a1', 'user', null),
    recordFor('a2', 'assistant', 'a1'),
    recordFor('b1', 'user', 'missing-parent-uuid'),
    recordFor('b2', 'assistant', 'b1'),
  ];

  it('reports the gap but does NOT reconstruct the earlier island (detectGaps on)', () => {
    const { messages, gaps } = svc.reconstructHistory(twoIslands, {
      detectGaps: true,
    });
    // Only the reachable tail island — the earlier island is not stitched back.
    expect(messages.map((m) => m.uuid)).toEqual(['b1', 'b2']);
    expect(gaps).toEqual([
      { childUuid: 'b1', missingParentUuid: 'missing-parent-uuid' },
    ]);
    // The gap child's parentUuid is left as-is (not rewritten to a guess).
    const child = messages.find((m) => m.uuid === 'b1');
    expect(child?.parentUuid).toBe('missing-parent-uuid');
  });

  it('preserves today truncation behavior when detectGaps is off', () => {
    const { messages, gaps } = svc.reconstructHistory(twoIslands);
    expect(messages.map((m) => m.uuid)).toEqual(['b1', 'b2']);
    expect(gaps).toEqual([]);
  });
});
