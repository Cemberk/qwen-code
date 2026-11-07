/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import { SlotTable } from './slots.js';

describe('SlotTable', () => {
  it('keeps a conversation in its slot between turns', () => {
    const table = new SlotTable(2, 1);
    expect(table.conversation('a')).toEqual({ slot: 0, restore: true });
    expect(table.conversation('b')).toEqual({ slot: 1, restore: true });
    expect(table.conversation('a')).toEqual({ slot: 0, restore: false });
    expect(table.conversation('b')).toEqual({ slot: 1, restore: false });
  });

  it('gives up the slot idle the longest, never a busy one', () => {
    const table = new SlotTable(2, 1);
    table.conversation('a');
    table.conversation('b');
    table.conversation('a'); // b is now idle the longest
    expect(table.conversation('c')).toEqual({
      slot: 1,
      restore: true,
      evicted: 'b',
    });
    expect(table.slotOf('b')).toBeUndefined();
    // a and c both run: d waits.
    table.begin(0);
    table.begin(1);
    expect(table.conversation('d')).toBeUndefined();
    table.end(0);
    expect(table.conversation('d')).toEqual({
      slot: 0,
      restore: true,
      evicted: 'a',
    });
  });

  it('runs side queries in the side slots, the least busy first', () => {
    const table = new SlotTable(1, 2);
    const first = table.side();
    table.begin(first);
    const second = table.side();
    expect([first, second].sort()).toEqual([1, 2]);
    table.begin(second);
    table.end(first);
    expect(table.side()).toBe(first);
  });

  it('reuses a forgotten conversation slot before any other', () => {
    const table = new SlotTable(2, 1);
    table.conversation('a');
    table.conversation('b');
    table.forget('b');
    expect(table.conversations()).toEqual([
      { conversation: 'a', slot: 0, busy: false },
    ]);
    expect(table.conversation('c')).toEqual({ slot: 1, restore: true });
  });

  it('counts the requests running', () => {
    const table = new SlotTable(1, 1);
    table.begin(0);
    table.begin(1);
    table.begin(1);
    expect(table.busy).toBe(3);
    expect(table.isBusy(1)).toBe(true);
    table.end(1);
    table.end(1);
    expect(table.isBusy(1)).toBe(false);
  });
});
