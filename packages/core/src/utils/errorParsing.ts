/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { isApiError, isStructuredError } from './quotaErrorDetection.js';
import { getErrorMessage } from './errors.js';

const RATE_LIMIT_MESSAGE =
  '\nPossible quota limitations in place or slow response times detected. Please wait and try again later.';

const API_ERROR_PREFIX = '[API Error: ';

/**
 * Returns true when `value` is already in final user-facing form and must not
 * be re-wrapped by parseAndFormatApiError.
 *
 * Accepts:
 * 1) base format: "[API Error: ...]"
 * 2) 429 format: "[API Error: ...]" followed by the quota guidance suffix.
 *
 * Used as an idempotency guard: when an upstream caller has already passed an
 * Error through parseAndFormatApiError, stuffed the formatted string into
 * Error.message, and the message reaches us a second time, we should return it
 * unchanged rather than producing "[API Error: [API Error: ...]]".
 */
function isAlreadyFormatted(value: string): boolean {
  const trimmed = value.trimEnd();

  if (!trimmed.startsWith(API_ERROR_PREFIX)) {
    return false;
  }

  if (trimmed.endsWith(']')) {
    return true;
  }

  return trimmed.includes(`]${RATE_LIMIT_MESSAGE}`);
}

export function parseAndFormatApiError(error: unknown): string {
  if (isStructuredError(error)) {
    // If a previous pass through this function already wrapped this message
    // and stuffed it into Error.message, return it unchanged. Avoids the
    // "[API Error: [API Error: ...]]" double-wrap reported in non-interactive
    // mode when a 4xx flows through both the stream handler and handleError.
    if (isAlreadyFormatted(error.message)) {
      return error.message;
    }

    const message =
      error instanceof Error ? getErrorMessage(error) : error.message;
    let text = `[API Error: ${message}]`;
    if (error.status === 429) {
      text += RATE_LIMIT_MESSAGE;
    }
    return text;
  }

  // The error message might be a string containing a JSON object.
  if (typeof error === 'string') {
    // Same idempotency guard for the plain-string path.
    if (isAlreadyFormatted(error)) {
      return error;
    }

    const jsonStart = error.indexOf('{');
    if (jsonStart === -1) {
      return `[API Error: ${error}]`; // Not a JSON error, return as is.
    }

    const jsonString = error.substring(jsonStart);

    try {
      const parsedError = JSON.parse(jsonString) as unknown;
      if (isApiError(parsedError)) {
        let finalMessage = parsedError.error.message;
        try {
          // See if the message is a stringified JSON with another error
          const nestedError = JSON.parse(finalMessage) as unknown;
          if (isApiError(nestedError)) {
            finalMessage = nestedError.error.message;
          }
        } catch (_e) {
          // It's not a nested JSON error, so we just use the message as is.
        }
        const statusText = parsedError.error.status
          ? ` (Status: ${parsedError.error.status})`
          : '';
        let text = `[API Error: ${finalMessage}${statusText}]`;
        if (parsedError.error.code === 429) {
          text += RATE_LIMIT_MESSAGE;
        }
        return text;
      }
    } catch (_e) {
      // Not a valid JSON, fall through and return the original message.
    }
    return `[API Error: ${error}]`;
  }

  return '[API Error: An unknown error occurred.]';
}
