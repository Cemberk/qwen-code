/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { Dispatcher } from 'undici';

type UndiciModule = typeof import('undici');

let undiciModule: UndiciModule | undefined;
let undiciModulePromise: Promise<UndiciModule> | undefined;

/**
 * Load undici behind a dynamic import so it stays out of the eager startup
 * closure (issue #7264). esbuild compiles the CJS undici package into a
 * default-only dynamic chunk (no named exports), while Node and vitest
 * expose named exports directly — unwrap only the default-only shape.
 */
export async function loadUndici(): Promise<UndiciModule> {
  undiciModulePromise ??= import('undici').then((mod) => {
    const keys = Object.keys(mod);
    if (keys.length === 1 && keys[0] === 'default') {
      return (mod as unknown as { default: UndiciModule }).default;
    }
    return mod;
  });
  return undiciModulePromise;
}

/**
 * Async entry points that lead to the synchronous dispatcher builders below
 * (content generator creation, preconnect) must await this before calling
 * them.
 */
export async function preloadRuntimeFetchModule(): Promise<void> {
  if (undiciModule) return;
  undiciModule = await loadUndici();
}

function requireUndici(): UndiciModule {
  if (!undiciModule) {
    throw new Error(
      'undici is not loaded yet; await preloadRuntimeFetchModule() before ' +
        'building runtime fetch options or dispatchers',
    );
  }
  return undiciModule;
}

/**
 * JavaScript runtime type
 */
export type Runtime = 'node' | 'bun' | 'unknown';

/**
 * Detect the current JavaScript runtime
 */
export function detectRuntime(): Runtime {
  if (typeof process !== 'undefined' && process.versions?.['bun']) {
    return 'bun';
  }
  if (typeof process !== 'undefined' && process.versions?.node) {
    return 'node';
  }
  return 'unknown';
}

/**
 * Runtime fetch options for the OpenAI SDK.
 */
export type OpenAIRuntimeFetchOptions = {
  fetchOptions?: {
    dispatcher?: Dispatcher;
    timeout?: false;
  };
  // Pinned so the dispatcher and fetch share a single undici version — Node's
  // built-in fetch (newer undici) rejects a dispatcher from the bundled undici
  // with errors such as `invalid onError method`. The wrapper also forces
  // `redirect: 'error'`: the model client never follows a redirect.
  fetch: typeof globalThis.fetch;
};

/**
 * Wrap a fetch implementation so every request fails on a redirect instead of
 * following it, whatever `redirect` mode the caller passed.
 */
function withRedirectError<F extends (...args: never[]) => unknown>(
  fetchImpl: F,
  extraInit: Record<string, unknown> = {},
): typeof globalThis.fetch {
  return ((input: RequestInfo | URL, init?: RequestInit) =>
    (fetchImpl as unknown as typeof globalThis.fetch)(input, {
      ...init,
      ...extraInit,
      redirect: 'error',
    } as RequestInit)) as typeof globalThis.fetch;
}

let sharedDispatcher: Dispatcher | undefined;

/**
 * Build runtime-specific fetch options for the OpenAI SDK.
 *
 * Node: a cached undici Agent with disabled header/body timeouts, so the SDK
 * `timeout` controls the total request time and undici's 300s default
 * bodyTimeout never aborts a long-running request to a local server.
 * Bun: its built-in fetch with the 300s timeout disabled.
 */
export function buildRuntimeFetchOptions(): OpenAIRuntimeFetchOptions {
  if (detectRuntime() === 'bun') {
    return {
      fetchOptions: { timeout: false },
      fetch: withRedirectError(globalThis.fetch, { timeout: false }),
    };
  }

  const { Agent, fetch: undiciFetch } = requireUndici();
  sharedDispatcher ??= new Agent({
    headersTimeout: 0,
    bodyTimeout: 0,
    keepAliveTimeout: 60_000,
  });
  return {
    fetchOptions: { dispatcher: sharedDispatcher },
    fetch: withRedirectError(undiciFetch),
  };
}

/**
 * Reset the cached dispatcher (for testing only)
 * @internal
 */
export function resetDispatcherCache(): void {
  sharedDispatcher = undefined;
}
