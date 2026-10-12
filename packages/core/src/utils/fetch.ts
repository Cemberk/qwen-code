/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { getErrorMessage } from './errors.js';
import { getLocalBaseUrlError } from './local-base-url.js';
import { delay } from './retry.js';

export class FetchError extends Error {
  constructor(
    message: string,
    public code?: string,
  ) {
    super(message);
    this.name = 'FetchError';
  }
}

export interface FetchPolicyOptions {
  /** Budget for the entire transfer — headers AND body. */
  timeoutMs: number;
  /** Reject responses larger than this, before or during body read. */
  maxBytes: number;
  headers?: Record<string, string>;
  /** Caller cancellation (e.g. the tool's abort signal). */
  signal?: AbortSignal;
}

export interface FetchPolicyResponse {
  status: number;
  statusText: string;
  contentType: string;
  /** Content-Disposition header, if any — carries the server's filename. */
  contentDisposition: string;
  body: Buffer;
}

// One retry, narrow triggers: transient blocks/rate limits and connection
// resets. Not 404s (deterministic), not timeouts (budget already spent).
const RETRYABLE_STATUSES = new Set([403, 429]);
// UND_ERR_SOCKET is undici's representation of a peer-closed/reset socket —
// the same class as ECONNRESET (see stream-transport-retry.ts).
const RETRYABLE_ERROR_CODES = new Set([
  'ECONNRESET',
  'EAI_AGAIN',
  'UND_ERR_SOCKET',
]);
const RETRY_DELAY_MS = 500;

/**
 * Fetch with a full-transfer timeout, a byte cap enforced while streaming,
 * caller-abort wiring, and a single retry on transient failures (403/429
 * statuses, connection resets). Only http(s) URLs on 127.0.0.1, ::1 or
 * localhost are fetched. Redirects are never followed: a 3xx response fails
 * the request. The timeout budget spans both attempts.
 */
export async function fetchWithPolicy(
  url: string,
  options: FetchPolicyOptions,
): Promise<FetchPolicyResponse> {
  if (getLocalBaseUrlError(url)) {
    throw new FetchError(
      `Refusing to fetch ${url}: only http(s) URLs on 127.0.0.1, ::1 or localhost are allowed.`,
      'ERR_NOT_LOOPBACK',
    );
  }
  const timeoutSignal = AbortSignal.timeout(options.timeoutMs);
  const signal = options.signal
    ? AbortSignal.any([options.signal, timeoutSignal])
    : timeoutSignal;

  // Maps an abort observed during the retry window to the caller's
  // cancellation or the timeout error; undefined when not aborted.
  const abortError = (): Error | undefined => {
    if (options.signal?.aborted) {
      return options.signal.reason instanceof Error
        ? options.signal.reason
        : new FetchError('Request aborted', 'ABORT_ERR');
    }
    if (timeoutSignal.aborted) {
      return new FetchError(
        `Request timed out after ${options.timeoutMs}ms`,
        'ETIMEDOUT',
      );
    }
    return undefined;
  };

  let first: FetchPolicyResponse;
  try {
    first = await fetchPolicyAttempt(url, options, signal, timeoutSignal);
  } catch (error) {
    if (
      error instanceof FetchError &&
      error.code !== undefined &&
      RETRYABLE_ERROR_CODES.has(error.code) &&
      !signal.aborted
    ) {
      try {
        await delay(RETRY_DELAY_MS, signal);
      } catch {
        throw abortError() ?? error;
      }
      return fetchPolicyAttempt(url, options, signal, timeoutSignal);
    }
    throw error;
  }

  if (RETRYABLE_STATUSES.has(first.status) && !signal.aborted) {
    try {
      await delay(RETRY_DELAY_MS, signal);
      return await fetchPolicyAttempt(url, options, signal, timeoutSignal);
    } catch {
      // Cancellation/timeout must win over "return the original response" —
      // the tool must report the abort, not a stale 403.
      const aborted = abortError();
      if (aborted) throw aborted;
      // The retry failed outright — the original response is still the most
      // informative outcome we have.
      return first;
    }
  }
  return first;
}

async function fetchPolicyAttempt(
  url: string,
  options: FetchPolicyOptions,
  signal: AbortSignal,
  timeoutSignal: AbortSignal,
): Promise<FetchPolicyResponse> {
  const wrapAbort = (error: unknown): never => {
    if (options.signal?.aborted) {
      throw options.signal.reason instanceof Error
        ? options.signal.reason
        : new FetchError('Request aborted', 'ABORT_ERR');
    }
    if (timeoutSignal.aborted) {
      throw new FetchError(
        `Request timed out after ${options.timeoutMs}ms`,
        'ETIMEDOUT',
      );
    }
    if (error instanceof FetchError) throw error;
    const code =
      getErrorCode(error) ??
      (error instanceof Error
        ? getErrorCode((error as Error & { cause?: unknown }).cause)
        : undefined);
    throw new FetchError(getErrorMessage(error), code);
  };

  let response: Response;
  try {
    response = await fetch(url, {
      signal,
      headers: options.headers,
      redirect: 'error',
    });
  } catch (error) {
    return wrapAbort(error);
  }

  // The sole caller discards the body of every non-2xx response (only the
  // status/statusText feed its failure message, and the 403/429 retry path
  // inspects the status alone). Cancel the body without buffering it:
  // otherwise an oversized error page reports EMSGSIZE instead of its real
  // status, and a slow-trickling error body can burn the whole timeout for
  // bytes that are never read.
  if (response.status < 200 || response.status >= 300) {
    await response.body?.cancel().catch(() => {});
    return {
      status: response.status,
      statusText: response.statusText,
      contentType: response.headers.get('content-type') ?? '',
      contentDisposition: response.headers.get('content-disposition') ?? '',
      body: Buffer.alloc(0),
    };
  }

  const contentLength = Number(response.headers.get('content-length'));
  if (Number.isFinite(contentLength) && contentLength > options.maxBytes) {
    await response.body?.cancel().catch(() => {});
    throw new FetchError(
      `Response too large: ${contentLength} bytes exceeds the ${options.maxBytes}-byte limit`,
      'EMSGSIZE',
    );
  }

  // Chunks are retained as-is (undici yields a fresh Uint8Array per read);
  // Buffer.concat below performs the single necessary copy.
  const chunks: Uint8Array[] = [];
  let total = 0;
  if (response.body) {
    const reader = response.body.getReader();
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        total += value.byteLength;
        if (total > options.maxBytes) {
          throw new FetchError(
            `Response too large: exceeded the ${options.maxBytes}-byte limit while streaming`,
            'EMSGSIZE',
          );
        }
        chunks.push(value);
      }
    } catch (error) {
      await reader.cancel().catch(() => {});
      if (error instanceof FetchError) throw error;
      return wrapAbort(error);
    } finally {
      reader.releaseLock();
    }
  }

  return {
    status: response.status,
    statusText: response.statusText,
    contentType: response.headers.get('content-type') ?? '',
    contentDisposition: response.headers.get('content-disposition') ?? '',
    body: Buffer.concat(chunks, total),
  };
}

function getErrorCode(error: unknown): string | undefined {
  if (!error || typeof error !== 'object') {
    return undefined;
  }

  if (
    'code' in error &&
    typeof (error as Record<string, unknown>)['code'] === 'string'
  ) {
    return (error as Record<string, string>)['code'];
  }

  return undefined;
}
