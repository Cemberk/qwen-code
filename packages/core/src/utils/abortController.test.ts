/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import { getEventListeners, getMaxListeners } from 'node:events';
import {
  createAbortController,
  createChildAbortController,
} from './abortController.js';

describe('createAbortController', () => {
  it('sets a default max-listener cap of 50 on the signal', () => {
    const controller = createAbortController();
    expect(getMaxListeners(controller.signal)).toBe(50);
  });

  it('honors a custom max-listener cap', () => {
    const controller = createAbortController(200);
    expect(getMaxListeners(controller.signal)).toBe(200);
  });

  it('produces a working, abortable controller', () => {
    const controller = createAbortController();
    expect(controller.signal.aborted).toBe(false);
    controller.abort('done');
    expect(controller.signal.aborted).toBe(true);
    expect(controller.signal.reason).toBe('done');
  });
});

describe('createChildAbortController', () => {
  it('aborts when the parent aborts and propagates the reason', () => {
    const parent = createAbortController();
    const child = createChildAbortController(parent);
    parent.abort('parent-reason');
    expect(child.signal.aborted).toBe(true);
    expect(child.signal.reason).toBe('parent-reason');
  });

  it('does not abort the parent when the child aborts', () => {
    const parent = createAbortController();
    const child = createChildAbortController(parent);
    child.abort('child-reason');
    expect(child.signal.aborted).toBe(true);
    expect(parent.signal.aborted).toBe(false);
  });

  it('aborts synchronously when the parent is already aborted (fast path)', () => {
    const parent = createAbortController();
    parent.abort('pre-aborted');
    const child = createChildAbortController(parent);
    expect(child.signal.aborted).toBe(true);
    expect(child.signal.reason).toBe('pre-aborted');
    // No listener should have been registered on the parent in the fast path.
    expect(getEventListeners(parent.signal, 'abort').length).toBe(0);
  });

  it('removes its parent listener once the child has aborted (reverse cleanup)', () => {
    const parent = createAbortController();
    const child = createChildAbortController(parent);
    expect(getEventListeners(parent.signal, 'abort').length).toBe(1);
    child.abort();
    expect(getEventListeners(parent.signal, 'abort').length).toBe(0);
  });

  it('removes its parent listener after parent abort fires (once: true)', () => {
    const parent = createAbortController();
    createChildAbortController(parent);
    expect(getEventListeners(parent.signal, 'abort').length).toBe(1);
    parent.abort();
    // The {once: true} listener should self-remove after firing.
    expect(getEventListeners(parent.signal, 'abort').length).toBe(0);
  });

  it('does not accumulate listeners on a long-lived parent across many short-lived children', () => {
    const parent = createAbortController();
    for (let i = 0; i < 1000; i++) {
      const child = createChildAbortController(parent);
      child.abort();
    }
    expect(getEventListeners(parent.signal, 'abort').length).toBe(0);
  });

  it('accepts an AbortSignal directly as the parent', () => {
    const parent = createAbortController();
    const child = createChildAbortController(parent.signal);
    parent.abort();
    expect(child.signal.aborted).toBe(true);
  });

  it('returns a plain controller when the parent is undefined', () => {
    const child = createChildAbortController(undefined);
    expect(child.signal.aborted).toBe(false);
    child.abort('manual');
    expect(child.signal.aborted).toBe(true);
  });

  it('forwards a custom maxListeners through to the child signal', () => {
    const parent = createAbortController();
    const child = createChildAbortController(parent, 123);
    expect(getMaxListeners(child.signal)).toBe(123);
  });
});

describe('lifetime contract', () => {
  it('parent abort propagates to a signal whose controller the caller has dropped', () => {
    // Real-world pattern: caller pipes child.signal into an async API and
    // does not hold the controller object itself. The parent listener
    // closure keeps the controller alive long enough for parent abort to
    // reach the signal — verified WITHOUT --expose-gc because we don't
    // depend on GC behavior at all, only on the strong reference inside
    // the listener closure.
    const parent = createAbortController();
    let signal: AbortSignal;
    (() => {
      const child = createChildAbortController(parent);
      signal = child.signal;
    })();
    expect(signal!.aborted).toBe(false);
    parent.abort('parent-reason');
    expect(signal!.aborted).toBe(true);
    expect(signal!.reason).toBe('parent-reason');
  });
});

describe('GC safety (best-effort, requires --expose-gc)', () => {
  const maybeGc = (globalThis as { gc?: () => void }).gc;
  const itGc = maybeGc ? it : it.skip;

  itGc('controller becomes GC-eligible after the child aborts', async () => {
    // After child.abort(), the reverse-cleanup listener removes the
    // parent's handler closure — which was the strong holder of the
    // controller. With no other refs, the controller is collectable.
    const parent = createAbortController();
    let weakChild: WeakRef<AbortController>;
    (() => {
      const child = createChildAbortController(parent);
      weakChild = new WeakRef(child);
      child.abort();
    })();
    await new Promise((r) => setTimeout(r, 0));
    maybeGc!();
    await new Promise((r) => setTimeout(r, 0));
    maybeGc!();
    expect(weakChild!.deref()).toBeUndefined();
  });
});
