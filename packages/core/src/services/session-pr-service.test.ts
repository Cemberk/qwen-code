/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { existsSync } from 'node:fs';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import lockfile from 'proper-lockfile';
import {
  SESSION_PR_LIST_LIMIT,
  SESSION_PR_URL_MAX_LENGTH,
  mergeSessionPrLists,
  moveSessionPrSidecar,
  readSessionPrs,
  replaceSessionPrs,
  updateSessionPrStates,
  upsertSessionPr,
  writeSessionPrs,
  type SessionPr,
  type SessionPrState,
} from './session-pr-service.js';

const fsMocks = vi.hoisted(() => ({
  readFile: vi.fn<typeof import('node:fs/promises').readFile>(),
}));

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  fsMocks.readFile.mockImplementation(actual.readFile);
  return { ...actual, readFile: fsMocks.readFile };
});

const entry = (number: number): SessionPr => ({
  number,
  url: `https://github.com/owner/repo/pull/${number}`,
  createdAt: '2026-08-20T00:00:00.000Z',
});

let tmpDir: string;
let filePath: string;

beforeEach(async () => {
  fsMocks.readFile.mockClear();
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'session-pr-test-'));
  filePath = path.join(tmpDir, 'test.pr.json');
});

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

describe('writeSessionPrs / readSessionPrs', () => {
  it('round-trips a PR list', async () => {
    const prs = [entry(9517), entry(9519)];
    await writeSessionPrs(filePath, prs);
    expect(await readSessionPrs(filePath)).toEqual(prs);
  });

  it('creates missing parent directories on write', async () => {
    const nested = path.join(tmpDir, 'a', 'b', 'test.pr.json');
    await writeSessionPrs(nested, [entry(1)]);
    expect(await readSessionPrs(nested)).toEqual([entry(1)]);
  });
});

describe('readSessionPrs', () => {
  it('returns null when the file does not exist', async () => {
    expect(await readSessionPrs(filePath)).toBeNull();
  });

  it('returns null for invalid JSON', async () => {
    await fs.writeFile(filePath, '{not json', 'utf-8');
    expect(await readSessionPrs(filePath)).toBeNull();
  });

  it.each([
    ['bare object (legacy single shape)', entry(1)],
    ['empty list', { prs: [] }],
    ['entry missing url', { prs: [{ number: 1, createdAt: 'x' }] }],
    ['entry non-integer number', { prs: [{ ...entry(1), number: 1.5 }] }],
    ['entry non-positive number', { prs: [entry(0)] }],
    [
      'entry non-http url',
      { prs: [{ ...entry(1), url: 'javascript:alert(1)' }] },
    ],
    [
      'entry url with a control character',
      { prs: [{ ...entry(1), url: 'https://github.com/o/r/pull/1\nforged' }] },
    ],
    [
      'entry url over 2048 characters',
      { prs: [{ ...entry(1), url: `https://github.com/${'a'.repeat(2048)}` }] },
    ],
    ['entry missing createdAt', { prs: [{ number: 1, url: entry(1).url }] }],
  ])('returns null for a malformed sidecar: %s', async (_label, value) => {
    await fs.writeFile(filePath, JSON.stringify(value), 'utf-8');
    expect(await readSessionPrs(filePath)).toBeNull();
  });

  it('propagates the caller abort reason', async () => {
    const controller = new AbortController();
    const reason = new Error('pr sidecar read cancelled');
    controller.abort(reason);

    await expect(
      readSessionPrs(filePath, { signal: controller.signal }),
    ).rejects.toBe(reason);
  });
});

describe('upsertSessionPr', () => {
  it('appends bindings in binding order', async () => {
    await upsertSessionPr(filePath, { number: 100, url: entry(100).url });
    const prs = await upsertSessionPr(filePath, {
      number: 101,
      url: entry(101).url,
    });
    expect(prs.map((p) => p.number)).toEqual([100, 101]);
  });

  it('re-binding the same PR refreshes it and moves it to latest', async () => {
    await writeSessionPrs(filePath, [entry(100), entry(101)]);
    const prs = await upsertSessionPr(filePath, {
      number: 100,
      url: 'https://github.com/owner/repo/pull/100?updated=1',
    });
    // A query-string variant names the same PR: state carries over, but
    // the re-bind is a fresh binding event (latest slot, new createdAt) —
    // the backfill cap planner relies on the fresh createdAt to tell a
    // concurrent re-bind from an untouched snapshot entry.
    expect(prs.map((p) => p.number)).toEqual([101, 100]);
    expect(prs[1]?.url).toContain('updated=1');
    expect(prs[1]?.createdAt).not.toBe(entry(100).createdAt);
  });

  it('re-binding the same number to another repo moves it to latest', async () => {
    await upsertSessionPr(filePath, { number: 100, url: entry(100).url });
    await upsertSessionPr(filePath, { number: 101, url: entry(101).url });
    const prs = await upsertSessionPr(filePath, {
      number: 100,
      url: 'https://github.com/other/repo/pull/100',
    });
    expect(prs.map((p) => p.number)).toEqual([101, 100]);
  });

  it('caps the list at SESSION_PR_LIST_LIMIT, dropping the oldest', async () => {
    for (let i = 1; i <= SESSION_PR_LIST_LIMIT + 2; i++) {
      await upsertSessionPr(filePath, {
        number: i,
        url: `https://github.com/owner/repo/pull/${i}`,
      });
    }
    const prs = await readSessionPrs(filePath);
    expect(prs).toHaveLength(SESSION_PR_LIST_LIMIT);
    expect(prs?.[0]?.number).toBe(3);
    expect(prs?.[SESSION_PR_LIST_LIMIT - 1]?.number).toBe(
      SESSION_PR_LIST_LIMIT + 2,
    );
  });

  it('stamps the candidate source on a different-URL re-bind', async () => {
    // The same number in another repository is another PR: no known entry
    // matches, so an explicit `review` must persist as such instead of
    // losing to the absent entry's higher pre-provenance rank.
    await writeSessionPrs(filePath, [
      {
        ...entry(5),
        url: 'https://github.com/repo-a/r/pull/5',
        source: 'create',
      },
    ]);
    const prs = await upsertSessionPr(filePath, {
      number: 5,
      url: 'https://github.com/repo-b/r/pull/5',
      source: 'review',
    });
    expect(prs).toHaveLength(1);
    expect(prs[0]).toMatchObject({
      url: 'https://github.com/repo-b/r/pull/5',
      source: 'review',
    });
  });

  it('caps by provenance authority like the batch writer', async () => {
    // Every writer caps the same way: a GitDialog create landing on a
    // full list must evict the oldest REVIEWED entry, never the created
    // binding at the head.
    const seeded: SessionPr[] = [
      { ...entry(1), source: 'create' },
      ...Array.from({ length: SESSION_PR_LIST_LIMIT - 1 }, (_, i) => ({
        ...entry(i + 2),
        source: 'review' as const,
      })),
    ];
    await writeSessionPrs(filePath, seeded);
    const prs = await upsertSessionPr(filePath, {
      number: 11,
      url: entry(11).url,
      source: 'create',
    });
    expect(prs.map((p) => p.number)).toEqual([1, 3, 4, 5, 6, 7, 8, 9, 10, 11]);
    expect(prs[0]).toEqual(seeded[0]);
    expect(await readSessionPrs(filePath)).toEqual(prs);
  });

  it('waits for a foreign file-lock holder before mutating', async () => {
    // The lock must reach ACROSS processes: another writer holding the
    // sidecar's proper-lockfile lock (the daemon sweep while the session
    // child binds, or vice versa) delays the mutation until release
    // instead of interleaving with it.
    await upsertSessionPr(filePath, { number: 41, url: entry(41).url });
    const release = await lockfile.lock(filePath, { retries: 0 });
    let resolved = false;
    const pending = upsertSessionPr(filePath, {
      number: 42,
      url: entry(42).url,
    }).then((prs) => {
      resolved = true;
      return prs;
    });
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(resolved).toBe(false);
    await release();
    const prs = await pending;
    expect(prs.map((p) => p.number)).toEqual([41, 42]);
  });

  it('persists a binding when a foreign holder unlinks the sidecar before releasing', async () => {
    // A cross-process holder whose mutation writes nothing used to unlink
    // the empty file the lock had materialized; an acquisition that
    // resolved the file's realpath before retrying then failed ENOENT and
    // the queued binding was lost. The lock is path-based now: the file
    // need not exist when the lock lands.
    await upsertSessionPr(filePath, { number: 41, url: entry(41).url });
    const release = await lockfile.lock(filePath, { retries: 0 });
    const pending = upsertSessionPr(filePath, {
      number: 42,
      url: entry(42).url,
    });
    await new Promise((resolve) => setTimeout(resolve, 30));
    await fs.unlink(filePath);
    await release();
    const prs = await pending;
    expect(prs.map((p) => p.number)).toEqual([42]);
    expect(await readSessionPrs(filePath)).toEqual(prs);
  });

  it('locks an absent sidecar without materializing it', async () => {
    // The foreign holder locks the canonical path (a realpath-resolving
    // holder's lock lands there too); while the mutation waits, no empty
    // file may appear — a session that never binds a PR must not
    // accumulate stray sidecars, and a concurrent reader must see "no
    // bindings", not a materialized empty file.
    const canonical = path.join(
      await fs.realpath(tmpDir),
      path.basename(filePath),
    );
    const release = await lockfile.lock(canonical, {
      realpath: false,
      retries: 0,
    });
    let resolved = false;
    const pending = upsertSessionPr(filePath, {
      number: 42,
      url: entry(42).url,
    }).then((prs) => {
      resolved = true;
      return prs;
    });
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(resolved).toBe(false);
    expect(existsSync(filePath)).toBe(false);
    await release();
    const prs = await pending;
    expect(prs.map((p) => p.number)).toEqual([42]);
  });

  it('serializes concurrent upserts so no binding is dropped', async () => {
    // Without the per-path queue, interleaved read-modify-write cycles would
    // let a later writer overwrite an earlier binding (read [] → read [] →
    // write [A] → write [B]).
    await Promise.all([
      upsertSessionPr(filePath, { number: 100, url: entry(100).url }),
      upsertSessionPr(filePath, { number: 101, url: entry(101).url }),
      upsertSessionPr(filePath, { number: 102, url: entry(102).url }),
    ]);
    const prs = await readSessionPrs(filePath);
    expect(prs?.map((p) => p.number)).toEqual([100, 101, 102]);
  });

  it('rejects an over-long URL at the write boundary', async () => {
    // The read side rejects the WHOLE list when one entry is invalid, so a
    // poisoned write would erase every earlier binding from the badge and
    // the refresh sweep. The write boundary must decline it instead.
    await upsertSessionPr(filePath, { number: 41, url: entry(41).url });
    const poisoned = await upsertSessionPr(filePath, {
      number: 42,
      url: `https://github.com/owner/repo/pull/${'9'.repeat(
        SESSION_PR_URL_MAX_LENGTH,
      )}`,
    });
    expect(poisoned.map((p) => p.number)).toEqual([41]);
    await upsertSessionPr(filePath, { number: 43, url: entry(43).url });
    const prs = await readSessionPrs(filePath);
    expect(prs?.map((p) => p.number)).toEqual([41, 43]);
  });

  it('rejects a control-character URL at the write boundary', async () => {
    await upsertSessionPr(filePath, { number: 51, url: entry(51).url });
    const poisoned = await upsertSessionPr(filePath, {
      number: 52,
      url: 'https://github.com/owner/repo/pull/52\u001b[forged',
    });
    expect(poisoned.map((p) => p.number)).toEqual([51]);
    expect(await readSessionPrs(filePath)).not.toBeNull();
  });

  it('lets an explicitly supplied source win over the persisted one', async () => {
    // Backfill binds transcript-mentioned PRs as reviews (authority 0); a
    // later explicit bind of the same number must upgrade the provenance —
    // the persisted source survives only a re-bind that does not name one.
    await writeSessionPrs(filePath, [{ ...entry(10), source: 'review' }]);
    const prs = await upsertSessionPr(filePath, {
      number: 10,
      url: entry(10).url,
      state: 'open',
      source: 'create',
    });
    expect(prs[0]?.source).toBe('create');
    expect((await readSessionPrs(filePath))?.[0]?.source).toBe('create');
  });

  it('never downgrades the persisted provenance on a weaker explicit source', async () => {
    // The worktree convention binding names the PR the session exists for;
    // a client-driven metadata re-bind stamping 'create' must not drop it
    // into the rank the tail cap evicts first.
    await writeSessionPrs(filePath, [{ ...entry(42), source: 'worktree' }]);
    const prs = await upsertSessionPr(filePath, {
      number: 42,
      url: entry(42).url,
      state: 'open',
      source: 'create',
    });
    expect(prs[0]?.source).toBe('worktree');
    expect((await readSessionPrs(filePath))?.[0]?.source).toBe('worktree');
  });

  it('re-bind of the same PR moves it to latest with a fresh createdAt', async () => {
    // A re-bind is a fresh binding event (latest slot, new createdAt) —
    // the backfill cap planner relies on the fresh createdAt to tell a
    // concurrent re-bind from an untouched snapshot entry. State-only
    // refreshes go through updateSessionPrStates, which preserves order.
    await writeSessionPrs(filePath, [
      { ...entry(100), state: 'open' },
      entry(101),
    ]);
    const prs = await upsertSessionPr(filePath, {
      number: 100,
      url: entry(100).url,
      state: 'merged',
    });
    expect(prs.map((p) => p.number)).toEqual([101, 100]);
    expect(prs[1]?.state).toBe('merged');
    expect(prs[1]?.createdAt).not.toBe(entry(100).createdAt);
    expect(await readSessionPrs(filePath)).toEqual(prs);
  });
});

describe('upsertSessionPr failure handling', () => {
  it('surfaces the failure to the caller without leaking an unhandled rejection', async () => {
    // The queue cleanup chain derives from the upsert promise; a derived
    // finally/catch would reject unhandled on every sidecar I/O failure even
    // though callers await the returned promise.
    const unhandled: unknown[] = [];
    const onUnhandledRejection = (reason: unknown): void => {
      unhandled.push(reason);
    };
    process.on('unhandledRejection', onUnhandledRejection);
    try {
      // filePath does not exist and its would-be parent path component is a
      // regular file once created below, so both the read (ENOTDIR) and any
      // mkdir/write fail.
      await fs.writeFile(filePath, 'blocker', 'utf-8');
      const blockedPath = path.join(filePath, 'nested.pr.json');
      await expect(
        upsertSessionPr(blockedPath, { number: 1, url: entry(1).url }),
      ).rejects.toThrow();
      // Give the rejection a turn to be reported as unhandled if the
      // cleanup chain does not absorb it.
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(unhandled).toHaveLength(0);
      // A failed predecessor must not wedge the queue entry: the same path
      // can be retried (still failing here — the path is still blocked —
      // but with its own rejection, not hung behind the dead predecessor),
      // and other paths keep working.
      await expect(
        upsertSessionPr(blockedPath, { number: 2, url: entry(2).url }),
      ).rejects.toThrow();
      const recovered = path.join(tmpDir, 'recovered.pr.json');
      await expect(
        upsertSessionPr(recovered, { number: 3, url: entry(3).url }),
      ).resolves.toHaveLength(1);
    } finally {
      process.off('unhandledRejection', onUnhandledRejection);
    }
  });
});

describe('upsertSessionPr state', () => {
  it('persists an explicit state', async () => {
    const prs = await upsertSessionPr(filePath, {
      number: 100,
      url: entry(100).url,
      state: 'open',
    });
    expect(prs[0]?.state).toBe('open');
    expect(await readSessionPrs(filePath)).toEqual(prs);
  });

  it('preserves the known state on a stateless re-bind', async () => {
    await upsertSessionPr(filePath, {
      number: 100,
      url: entry(100).url,
      state: 'merged',
    });
    const prs = await upsertSessionPr(filePath, {
      number: 100,
      url: entry(100).url,
    });
    expect(prs).toHaveLength(1);
    expect(prs[0]?.state).toBe('merged');
  });

  it('does not inherit state across a URL change', async () => {
    // The same number in another repository is another PR: inheriting the
    // previous entry's terminal 'merged' would poison the new binding
    // permanently — the sweep never re-queries merged entries.
    await writeSessionPrs(filePath, [{ ...entry(5), state: 'merged' }]);
    const prs = await upsertSessionPr(filePath, {
      number: 5,
      url: 'https://github.com/other/repo/pull/5',
    });
    expect(prs).toHaveLength(1);
    expect(prs[0]?.url).toBe('https://github.com/other/repo/pull/5');
    expect(prs[0]?.state).toBeUndefined();
    expect((await readSessionPrs(filePath))?.[0]?.state).toBeUndefined();
  });
});

describe('updateSessionPrStates', () => {
  const stamp = (number: number, state: 'open' | 'merged' | 'closed') => ({
    url: entry(number).url,
    state,
  });
  const fetched = (
    number: number,
    state: SessionPrState,
    url: string = entry(number).url,
  ): ReadonlyMap<number, { state: SessionPrState; url: string }> =>
    new Map([[number, { state, url }]]);

  it('rewrites states in place without touching order or createdAt', async () => {
    await writeSessionPrs(filePath, [
      { ...entry(100), state: 'open' },
      { ...entry(101), state: 'open' },
    ]);
    const changed = await updateSessionPrStates(
      filePath,
      new Map([
        [100, stamp(100, 'merged')],
        [101, stamp(101, 'open')],
      ]),
    );
    // Only the entry whose state actually differs counts as rewritten.
    expect(changed).toBe(1);
    const persisted = await readSessionPrs(filePath);
    expect(persisted?.map((p) => p.number)).toEqual([100, 101]);
    expect(persisted?.[0]?.state).toBe('merged');
    expect(persisted?.[0]?.createdAt).toBe(entry(100).createdAt);
    expect(persisted?.[1]?.state).toBe('open');
  });

  it('returns 0 without writing when nothing changes', async () => {
    await writeSessionPrs(filePath, [{ ...entry(100), state: 'merged' }]);
    const before = await fs.readFile(filePath, 'utf-8');
    expect(
      await updateSessionPrStates(
        filePath,
        new Map([[100, stamp(100, 'merged')]]),
      ),
    ).toBe(0);
    expect(await fs.readFile(filePath, 'utf-8')).toBe(before);
  });

  it('returns 0 when the sidecar is absent', async () => {
    expect(
      await updateSessionPrStates(
        filePath,
        new Map([[100, stamp(100, 'merged')]]),
      ),
    ).toBe(0);
  });

  it('skips an entry re-bound to another URL between the sweep read and the stamp', async () => {
    // The sweep reads sidecars before its gh round-trip and writes after
    // it. A concurrent re-bind of the same number to another repository
    // during that window must not receive the stale repo's state — a
    // wrong 'merged' stamp is terminal: merged entries are never queried
    // again, so the badge stays wrong permanently.
    await writeSessionPrs(filePath, [{ ...entry(5), state: 'open' }]);
    await upsertSessionPr(filePath, {
      number: 5,
      url: 'https://github.com/other/repo/pull/5',
      state: 'open',
      source: 'create',
    });
    const changed = await updateSessionPrStates(
      filePath,
      new Map([[5, stamp(5, 'merged')]]),
    );
    expect(changed).toBe(0);
    const persisted = await readSessionPrs(filePath);
    expect(persisted?.[0]?.url).toBe('https://github.com/other/repo/pull/5');
    expect(persisted?.[0]?.state).toBe('open');
  });

  it('serializes against a concurrent upsert on the same sidecar', async () => {
    await writeSessionPrs(filePath, [{ ...entry(100), state: 'open' }]);
    const [changed, prs] = await Promise.all([
      updateSessionPrStates(filePath, new Map([[100, stamp(100, 'merged')]])),
      upsertSessionPr(filePath, { number: 101, url: entry(101).url }),
    ]);
    expect(changed).toBe(1);
    expect(prs?.map((p) => p.number)).toEqual([100, 101]);
    // Whichever ran second read the first's write — nothing was clobbered.
    const persisted = await readSessionPrs(filePath);
    expect(persisted?.find((p) => p.number === 100)?.state).toBe('merged');
    expect(persisted?.find((p) => p.number === 101)).toBeDefined();
  });

  it('applies a fetched state only when its url matches the entry', async () => {
    // The map is keyed by number, but the metadata route accepts any
    // http(s) url: a binding that points at another repository must never
    // pick up this repo's same-numbered PR state (and a wrong terminal
    // state would be permanent — merged entries leave the sweep).
    await writeSessionPrs(filePath, [{ ...entry(100), state: 'open' }]);
    const updated = await updateSessionPrStates(
      filePath,
      fetched(
        100,
        'merged',
        'https://github.com/other-org/other-repo/pull/100',
      ),
    );
    expect(updated).toBe(0);
    const persisted = await readSessionPrs(filePath);
    expect(persisted?.[0]?.state).toBe('open');
  });

  it('refreshes a binding whose url is canonical-equivalent to the fetched one', async () => {
    // Binding urls preserve the user's remote casing (backfill's remote
    // fallback) or carry dialog spelling variants, while gh returns the
    // server-canonical spelling; GitHub repo paths are case-insensitive,
    // so a byte-unequal comparison skips the entry on every sweep — it
    // can never reach the terminal merged state.
    await writeSessionPrs(filePath, [
      {
        ...entry(100),
        url: 'https://github.com/OWNER/REPO/pull/100/?v=2',
        state: 'open',
      },
    ]);
    const updated = await updateSessionPrStates(
      filePath,
      fetched(100, 'merged'),
    );
    expect(updated).toBe(1);
    const persisted = await readSessionPrs(filePath);
    expect(persisted?.[0]?.state).toBe('merged');
  });

  it('does not resurrect a sidecar deleted between the queued read and the write commit', async () => {
    // Deletion and archive moves unlink the sidecar outside the mutation
    // queue. Force the race deterministically: the queued read captures the
    // contents, the deletion lands the moment the read resolves, and only
    // the commit-step guard can still stop the stale write.
    await writeSessionPrs(filePath, [{ ...entry(100), state: 'open' }]);
    const raw = await fs.readFile(filePath, 'utf-8');
    fsMocks.readFile.mockImplementationOnce(async () => {
      await fs.unlink(filePath);
      return raw;
    });
    await expect(
      updateSessionPrStates(filePath, fetched(100, 'merged'), {
        assertCanCommit: () => {
          if (!existsSync(filePath)) {
            throw new Error('sidecar vanished during refresh');
          }
        },
      }),
    ).rejects.toThrow('sidecar vanished during refresh');
    expect(existsSync(filePath)).toBe(false);
    // The rejected write must not wedge the queue for later mutations.
    const recovered = await upsertSessionPr(filePath, {
      number: 101,
      url: entry(101).url,
    });
    expect(recovered.map((p) => p.number)).toEqual([101]);
  });
});

describe('replaceSessionPrs', () => {
  it('runs the planner against the freshest list inside the queue', async () => {
    // The planner must see the result of mutations queued ahead of it —
    // planning from a stale outer read would clobber a binding that lands
    // between the caller's read and write.
    await writeSessionPrs(filePath, [entry(100)]);
    const seen: number[][] = [];
    const upsert = upsertSessionPr(filePath, {
      number: 101,
      url: entry(101).url,
    });
    const replace = replaceSessionPrs(filePath, (existing) => {
      seen.push(existing.map((p) => p.number));
      return [...existing, entry(102)];
    });
    await Promise.all([upsert, replace]);
    expect(seen).toEqual([[100, 101]]);
    expect((await readSessionPrs(filePath))?.map((p) => p.number)).toEqual([
      100, 101, 102,
    ]);
  });

  it('leaves the file untouched when the planner returns null', async () => {
    await writeSessionPrs(filePath, [entry(100)]);
    const before = await fs.readFile(filePath, 'utf-8');
    expect(await replaceSessionPrs(filePath, () => null)).toBeNull();
    expect(await fs.readFile(filePath, 'utf-8')).toBe(before);
  });

  it('persists the planner result and returns it', async () => {
    await writeSessionPrs(filePath, [entry(100)]);
    const persisted = await replaceSessionPrs(filePath, (existing) =>
      existing.filter((p) => p.number !== 100),
    );
    expect(persisted).toEqual([]);
    // An empty list reads back as null (isValidSessionPrList rejects it).
    expect(await readSessionPrs(filePath)).toBeNull();
  });

  it('declines entries the reader would reject instead of poisoning the list', async () => {
    // The reader fails the WHOLE list closed on one invalid entry, so a
    // planner that lets a transcript-sourced url through unchecked would
    // erase every other binding on the next read.
    await writeSessionPrs(filePath, [entry(100)]);
    const persisted = await replaceSessionPrs(filePath, (existing) => [
      ...existing,
      {
        ...entry(101),
        url: `https://github.com/o/r/pull/${'1'.repeat(SESSION_PR_URL_MAX_LENGTH)}`,
      },
      { ...entry(102), url: 'https://github.com/o/r/pull/102\u0007' },
      entry(103),
    ]);
    expect(persisted?.map((p) => p.number)).toEqual([100, 103]);
    expect(await readSessionPrs(filePath)).toEqual(persisted);
    // A plan made only of declined entries leaves the file untouched.
    const before = await fs.readFile(filePath, 'utf-8');
    expect(
      await replaceSessionPrs(filePath, () => [
        { ...entry(104), url: 'ftp://x' },
      ]),
    ).toBeNull();
    expect(await fs.readFile(filePath, 'utf-8')).toBe(before);
  });
});

describe('mergeSessionPrLists', () => {
  it('keeps the stronger source across a same-PR split-pair merge', () => {
    // The live shell binder stamped `create` on one half of a split pair;
    // a later `/review` backfill of the other half re-bound the number as
    // `review` with a fresh createdAt. The freshest entry survives (the
    // badge renders recency) but the provenance must not downgrade — the
    // authority cap would evict the session's own created binding first.
    const created: SessionPr = {
      number: 5,
      url: 'https://github.com/o/r/pull/5',
      createdAt: '2026-08-01T00:00:00.000Z',
      source: 'create',
    };
    const reviewed: SessionPr = {
      number: 5,
      url: 'https://github.com/o/r/pull/5',
      createdAt: '2026-08-02T00:00:00.000Z',
      source: 'review',
    };
    for (const [base, incoming] of [
      [[created], [reviewed]],
      [[reviewed], [created]],
    ] as const) {
      const merged = mergeSessionPrLists([...base], [...incoming]);
      expect(merged).toEqual([{ ...reviewed, source: 'create' }]);
    }
    // A same-numbered PR of another repository is another PR: nothing
    // carries across the URL change.
    const foreign: SessionPr = {
      ...reviewed,
      url: 'https://github.com/other/r/pull/5',
    };
    expect(mergeSessionPrLists([created], [foreign])).toEqual([foreign]);
  });

  it('keeps a split-pair created binding through the authority cap', () => {
    const created: SessionPr = {
      number: 100,
      url: 'https://github.com/o/r/pull/100',
      createdAt: '2026-08-01T00:00:00.000Z',
      source: 'create',
    };
    const reviews: SessionPr[] = Array.from(
      { length: SESSION_PR_LIST_LIMIT },
      (_, i) => ({
        number: i + 1,
        url: `https://github.com/o/r/pull/${i + 1}`,
        createdAt: `2026-08-03T00:00:0${i}.000Z`.slice(0, 24),
        source: 'review' as const,
      }),
    );
    const rebound: SessionPr = {
      ...created,
      createdAt: '2026-08-02T00:00:00.000Z',
      source: 'review',
    };
    const merged = mergeSessionPrLists([created, ...reviews], [rebound]);
    expect(merged).toHaveLength(SESSION_PR_LIST_LIMIT);
    expect(merged.find((p) => p.number === 100)).toMatchObject({
      source: 'create',
      createdAt: rebound.createdAt,
    });
  });

  const at = (number: number, createdAt: string, url?: string): SessionPr => ({
    number,
    url: url ?? `https://github.com/owner/repo/pull/${number}`,
    createdAt,
  });

  it('unions disjoint lists in binding-time order', () => {
    const merged = mergeSessionPrLists(
      [at(100, '2026-08-20T00:00:00.000Z')],
      [at(101, '2026-08-20T01:00:00.000Z')],
    );
    expect(merged.map((p) => p.number)).toEqual([100, 101]);
  });

  it('dedupes by number, keeping the freshest entry', () => {
    const merged = mergeSessionPrLists(
      [at(100, '2026-08-20T00:00:00.000Z', 'https://old.example/100')],
      [at(100, '2026-08-20T01:00:00.000Z', 'https://new.example/100')],
    );
    expect(merged).toEqual([
      at(100, '2026-08-20T01:00:00.000Z', 'https://new.example/100'),
    ]);
  });

  it('orders by binding time regardless of which side an entry came from', () => {
    const merged = mergeSessionPrLists(
      [at(102, '2026-08-20T02:00:00.000Z')],
      [at(101, '2026-08-20T01:00:00.000Z')],
    );
    expect(merged.map((p) => p.number)).toEqual([101, 102]);
  });

  it('caps the merged list, dropping the oldest', () => {
    const base = Array.from({ length: SESSION_PR_LIST_LIMIT }, (_, i) =>
      at(i + 1, `2026-08-20T00:00:${String(i).padStart(2, '0')}.000Z`),
    );
    const incoming = [
      at(SESSION_PR_LIST_LIMIT + 1, '2026-08-20T01:00:00.000Z'),
    ];
    const merged = mergeSessionPrLists(base, incoming);
    expect(merged).toHaveLength(SESSION_PR_LIST_LIMIT);
    expect(merged[0]?.number).toBe(2);
    expect(merged[merged.length - 1]?.number).toBe(SESSION_PR_LIST_LIMIT + 1);
  });
});

describe('moveSessionPrSidecar', () => {
  let sourcePath: string;
  let destinationPath: string;

  beforeEach(() => {
    sourcePath = path.join(tmpDir, 'active', 's.pr.json');
    destinationPath = path.join(tmpDir, 'archived', 's.pr.json');
  });

  it('renames the sidecar when the destination is free', async () => {
    await writeSessionPrs(sourcePath, [entry(1)]);
    await moveSessionPrSidecar(sourcePath, destinationPath);
    expect(await readSessionPrs(destinationPath)).toEqual([entry(1)]);
    await expect(fs.stat(sourcePath)).rejects.toThrow();
  });

  it('merges a split pair instead of clobbering either half', async () => {
    await writeSessionPrs(sourcePath, [entry(1)]);
    await writeSessionPrs(destinationPath, [entry(2)]);
    await moveSessionPrSidecar(sourcePath, destinationPath);
    expect(
      (await readSessionPrs(destinationPath))?.map((p) => p.number),
    ).toEqual([2, 1]);
    await expect(fs.stat(sourcePath)).rejects.toThrow();
  });

  it('does nothing when the source is absent', async () => {
    await moveSessionPrSidecar(sourcePath, destinationPath);
    expect(await readSessionPrs(destinationPath)).toBeNull();
    // Neither endpoint may appear: a no-op move must not materialize a
    // stray empty sidecar (every archive/restore of a session that never
    // bound a PR runs one).
    expect(existsSync(destinationPath)).toBe(false);
    expect(existsSync(sourcePath)).toBe(false);
  });

  it('waits for a lock held on the destination before moving', async () => {
    // The move must serialize against pending mutations on BOTH endpoints:
    // a binder write landing on the destination mid-transition must not be
    // clobbered by the merge write.
    await writeSessionPrs(sourcePath, [entry(1)]);
    await fs.mkdir(path.dirname(destinationPath), { recursive: true });
    await fs.writeFile(destinationPath, '', 'utf-8');
    const release = await lockfile.lock(destinationPath);
    const movePromise = moveSessionPrSidecar(sourcePath, destinationPath);
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(await readSessionPrs(sourcePath)).toEqual([entry(1)]);
    expect(await readSessionPrs(destinationPath)).toBeNull();
    await release();
    await movePromise;
    expect(await readSessionPrs(destinationPath)).toEqual([entry(1)]);
    await expect(fs.stat(sourcePath)).rejects.toThrow();
  });

  it('waits for a held sidecar lock before moving', async () => {
    // The move runs under the cross-process lock: while another holder
    // keeps the source locked, no binding may be relocated — an unlocked
    // move would merge and unlink the source immediately.
    await writeSessionPrs(sourcePath, [entry(1)]);
    const release = await lockfile.lock(sourcePath);
    const movePromise = moveSessionPrSidecar(sourcePath, destinationPath);
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(await readSessionPrs(sourcePath)).toEqual([entry(1)]);
    expect(await readSessionPrs(destinationPath)).toBeNull();
    await release();
    await movePromise;
    expect(await readSessionPrs(destinationPath)).toEqual([entry(1)]);
    await expect(fs.stat(sourcePath)).rejects.toThrow();
  });
});

describe('issue snapshot', () => {
  const issue = (number: number) => ({
    number,
    url: `https://github.com/owner/repo/issues/${number}`,
    state: 'open' as const,
  });

  it('round-trips issues on an entry', async () => {
    const prs = [{ ...entry(100), issues: [issue(7)] }];
    await writeSessionPrs(filePath, prs);
    expect(await readSessionPrs(filePath)).toEqual(prs);
  });

  it('voids the sidecar on a malformed or oversized issue list', async () => {
    // The issue url is rendered as a link target exactly like the PR url.
    await fs.writeFile(
      filePath,
      JSON.stringify({
        prs: [{ ...entry(100), issues: [{ number: 7, url: 'javascript:x' }] }],
      }),
    );
    expect(await readSessionPrs(filePath)).toBeNull();
    await fs.writeFile(
      filePath,
      JSON.stringify({
        prs: [{ ...entry(100), issues: [{ ...issue(7), state: 'merged' }] }],
      }),
    );
    expect(await readSessionPrs(filePath)).toBeNull();
    await fs.writeFile(
      filePath,
      JSON.stringify({
        prs: [
          {
            ...entry(100),
            issues: Array.from({ length: 11 }, (_, index) => issue(index + 1)),
          },
        ],
      }),
    );
    expect(await readSessionPrs(filePath)).toBeNull();
  });

  it('keeps the snapshot on a re-bind of the same PR only', async () => {
    await writeSessionPrs(filePath, [
      { ...entry(100), state: 'open', issues: [issue(7)] },
    ]);
    const same = await upsertSessionPr(filePath, {
      number: 100,
      url: entry(100).url,
    });
    expect(same[0]?.issues).toEqual([issue(7)]);
    const other = await upsertSessionPr(filePath, {
      number: 100,
      url: 'https://github.com/other/repo/pull/100',
    });
    expect(other[0]?.issues).toBeUndefined();
  });

  it('updateSessionPrStates writes issues with or without a state', async () => {
    await writeSessionPrs(filePath, [
      { ...entry(100), state: 'open' },
      { ...entry(101), state: 'merged' },
    ]);
    const updated = await updateSessionPrStates(
      filePath,
      new Map([
        [
          100,
          { state: 'merged' as const, url: entry(100).url, issues: [issue(7)] },
        ],
        [101, { url: entry(101).url, issues: [] }],
      ]),
    );
    expect(updated).toBe(2);
    const persisted = await readSessionPrs(filePath);
    expect(persisted?.[0]).toMatchObject({
      state: 'merged',
      issues: [issue(7)],
      createdAt: entry(100).createdAt,
    });
    // An empty snapshot is still a snapshot ("fetched, none").
    expect(persisted?.[1]).toMatchObject({ state: 'merged', issues: [] });
  });

  it('updateSessionPrStates leaves issues alone when unchanged or omitted', async () => {
    await writeSessionPrs(filePath, [
      { ...entry(100), state: 'open', issues: [issue(7)] },
    ]);
    const before = await fs.readFile(filePath, 'utf-8');
    expect(
      await updateSessionPrStates(
        filePath,
        new Map([[100, { url: entry(100).url, issues: [issue(7)] }]]),
      ),
    ).toBe(0);
    expect(await fs.readFile(filePath, 'utf-8')).toBe(before);
    expect(
      await updateSessionPrStates(
        filePath,
        new Map([[100, { state: 'closed' as const, url: entry(100).url }]]),
      ),
    ).toBe(1);
    expect((await readSessionPrs(filePath))?.[0]).toMatchObject({
      state: 'closed',
      issues: [issue(7)],
    });
  });

  it('updateSessionPrStates rewrites a changed issue state', async () => {
    await writeSessionPrs(filePath, [
      { ...entry(100), state: 'merged', issues: [issue(7)] },
    ]);
    expect(
      await updateSessionPrStates(
        filePath,
        new Map([
          [
            100,
            {
              url: entry(100).url,
              issues: [{ ...issue(7), state: 'completed' as const }],
            },
          ],
        ]),
      ),
    ).toBe(1);
    expect((await readSessionPrs(filePath))?.[0]?.issues?.[0]?.state).toBe(
      'completed',
    );
  });
});
