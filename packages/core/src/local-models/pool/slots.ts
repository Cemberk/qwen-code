/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Which engine slot (`id_slot`) each conversation uses.
 *
 * The engine has `conversationSlots + sideSlots` slots sharing one context
 * cache. A conversation keeps its slot between turns, so its processed
 * prompt stays there. When more conversations than slots are active, the
 * one idle the longest gives its slot up; its prompt was saved at the end of
 * its last turn, and is restored when it comes back. Side queries (memory,
 * summaries, subagent prompts) run in the side slots, never in a
 * conversation's.
 */
export interface SlotGrant {
  slot: number;
  /** The slot held another conversation, or none since the engine started: restore this one's saved prompt. */
  restore: boolean;
  /** The conversation that gave the slot up. */
  evicted?: string;
}

interface SlotState {
  /** The conversation that owns the slot, if any. */
  owner?: string;
  /** Requests running in the slot. */
  busy: number;
  /** When the slot was last used, for choosing which to give up. */
  usedAt: number;
}

export class SlotTable {
  private readonly slots: SlotState[];
  private readonly owned = new Map<string, number>();
  private clock = 0;
  private nextSide = 0;

  constructor(
    readonly conversationSlots: number,
    readonly sideSlots: number,
  ) {
    if (conversationSlots < 1 || sideSlots < 1) {
      throw new Error('An engine needs at least one slot of each kind.');
    }
    this.slots = Array.from({ length: conversationSlots + sideSlots }, () => ({
      busy: 0,
      usedAt: 0,
    }));
  }

  get size(): number {
    return this.slots.length;
  }

  /**
   * The slot for a turn of `conversation`, or undefined when every
   * conversation slot is running a request: wait for one to end.
   */
  conversation(conversation: string): SlotGrant | undefined {
    const own = this.owned.get(conversation);
    if (own !== undefined) {
      this.touch(own);
      return { slot: own, restore: false };
    }
    let pick: number | undefined;
    for (let slot = 0; slot < this.conversationSlots; slot++) {
      const state = this.slots[slot];
      if (state.busy > 0) continue;
      // An empty slot first, else the one used longest ago.
      if (
        pick === undefined ||
        (state.owner === undefined && this.slots[pick].owner !== undefined) ||
        ((state.owner === undefined) ===
          (this.slots[pick].owner === undefined) &&
          state.usedAt < this.slots[pick].usedAt)
      ) {
        pick = slot;
      }
    }
    if (pick === undefined) return undefined;
    const evicted = this.slots[pick].owner;
    if (evicted !== undefined) this.owned.delete(evicted);
    this.slots[pick].owner = conversation;
    this.owned.set(conversation, pick);
    this.touch(pick);
    return { slot: pick, restore: true, ...(evicted ? { evicted } : {}) };
  }

  /** A side slot: the least busy, taking turns between equals. */
  side(): number {
    let pick = this.conversationSlots + this.nextSide;
    for (let i = 0; i < this.sideSlots; i++) {
      const slot =
        this.conversationSlots + ((this.nextSide + i) % this.sideSlots);
      if (this.slots[slot].busy < this.slots[pick].busy) pick = slot;
    }
    this.nextSide = (pick - this.conversationSlots + 1) % this.sideSlots;
    this.touch(pick);
    return pick;
  }

  /** The slot `conversation` holds, if any. */
  slotOf(conversation: string): number | undefined {
    return this.owned.get(conversation);
  }

  begin(slot: number): void {
    this.slots[slot].busy++;
    this.touch(slot);
  }

  end(slot: number): void {
    this.slots[slot].busy = Math.max(0, this.slots[slot].busy - 1);
    this.touch(slot);
  }

  isBusy(slot: number): boolean {
    return this.slots[slot].busy > 0;
  }

  /** Requests running in any slot. */
  get busy(): number {
    return this.slots.reduce((sum, state) => sum + state.busy, 0);
  }

  /**
   * Forget `conversation` (its client went away): its slot stays filled but
   * is the first to be given up.
   */
  forget(conversation: string): void {
    const slot = this.owned.get(conversation);
    if (slot === undefined) return;
    this.owned.delete(conversation);
    this.slots[slot].owner = undefined;
    this.slots[slot].usedAt = 0;
  }

  /** Conversations holding a slot, for status. */
  conversations(): Array<{
    conversation: string;
    slot: number;
    busy: boolean;
  }> {
    return [...this.owned].map(([conversation, slot]) => ({
      conversation,
      slot,
      busy: this.slots[slot].busy > 0,
    }));
  }

  private touch(slot: number): void {
    this.slots[slot].usedAt = ++this.clock;
  }
}
