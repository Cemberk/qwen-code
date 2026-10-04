/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { setMaxListeners } from 'node:events';

/**
 * Default per-signal listener cap. Sized generously so OpenAI SDK retries +
 * internal stream/fetch wrappers + per-tool listeners can coexist on a single
 * short-lived per-request signal without warning.
 */
const DEFAULT_MAX_LISTENERS = 50;

/**
 * Create an AbortController with its signal pre-configured to allow a sane
 * number of listeners. Use this in place of `new AbortController()` everywhere
 * in production code.
 */
export function createAbortController(
  maxListeners: number = DEFAULT_MAX_LISTENERS,
): AbortController {
  const controller = new AbortController();
  setMaxListeners(maxListeners, controller.signal);
  return controller;
}

function asSignal(
  parent: AbortController | AbortSignal | undefined,
): AbortSignal | undefined {
  if (!parent) return undefined;
  return parent instanceof AbortController ? parent.signal : parent;
}

/**
 * Create a child AbortController that aborts when its parent aborts.
 * Aborting the child does NOT abort the parent.
 *
 * Three invariants keep listener accumulation bounded on long-lived parents
 * even when many short-lived children come and go:
 *  - The parent's abort listener is registered with `{once: true}` so it
 *    removes itself when the parent fires.
 *  - When the child aborts (from any source — parent propagation, manual
 *    abort, etc.), the listener it registered on the parent is actively
 *    removed. This is the key to preventing dead-listener accumulation on
 *    long-lived parents.
 *  - The parent is held via `WeakRef` from the child's reverse-cleanup
 *    closure, so a child being kept alive does not pin its parent.
 *
 * Lifetime contract: the child controller is held strongly by the parent's
 * listener closure until either the parent fires (closure released by
 * `{once: true}` self-removal) or the child aborts (closure released by
 * reverse-cleanup). This means callers can safely pass `child.signal` into
 * async APIs and drop the controller object — the controller will stay
 * alive long enough for parent abort to propagate to the signal.
 *
 * Accepts an `AbortController`, an `AbortSignal`, or `undefined`. Undefined
 * returns a fresh controller with no parent propagation.
 */
export function createChildAbortController(
  parent: AbortController | AbortSignal | undefined,
  maxListeners?: number,
): AbortController {
  const child = createAbortController(maxListeners);
  const parentSignal = asSignal(parent);

  if (!parentSignal) return child;

  // Fast path: parent already aborted, no listener setup needed.
  if (parentSignal.aborted) {
    child.abort(parentSignal.reason);
    return child;
  }

  // WeakRef on the parent only — the handler closure strongly retains the
  // child so that propagation works even if the caller passes child.signal
  // to an async API and drops the controller object. See the contract
  // docstring above.
  const weakParent = new WeakRef(parentSignal);
  const handler = (): void => {
    child.abort(weakParent.deref()?.reason);
  };

  parentSignal.addEventListener('abort', handler, { once: true });

  child.signal.addEventListener(
    'abort',
    () => {
      // `{once: true}` on the parent listener already self-removes when
      // parent fires; this branch covers the child-aborts-first case so
      // we don't leave a dead listener on a long-lived parent.
      weakParent.deref()?.removeEventListener('abort', handler);
    },
    { once: true },
  );

  return child;
}
