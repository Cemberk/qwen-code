/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Hosts a model base URL may point at. Model traffic only ever goes to a
 * server on this machine's loopback interface.
 */
const LOOPBACK_HOSTS: ReadonlySet<string> = new Set([
  '127.0.0.1',
  '[::1]',
  'localhost',
]);

/**
 * Validate a model server base URL. It is required (there is no default) and
 * must be an http(s) URL whose host is exactly `127.0.0.1`, `::1` or
 * `localhost`.
 *
 * @param baseUrl - The configured base URL.
 * @param source - Where the value came from, used in the error message
 *   (e.g. `settings.security.auth.baseUrl`).
 * @returns An error message, or `null` when the URL is acceptable.
 */
export function getLocalBaseUrlError(
  baseUrl: string | undefined | null,
  source?: string,
): string | null {
  const from = source ? ` (from ${source})` : '';
  const value = baseUrl?.trim();
  if (!value) {
    return (
      `No model server base URL is configured${from}. ` +
      'Set the base URL of a local OpenAI-compatible server, for example http://127.0.0.1:11434/v1.'
    );
  }
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return `Model server base URL "${value}"${from} is not a valid URL.`;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return `Model server base URL "${value}"${from} must use http or https.`;
  }
  if (!LOOPBACK_HOSTS.has(url.hostname)) {
    return (
      `Model server base URL "${value}"${from} is not allowed: ` +
      'the host must be 127.0.0.1, ::1 or localhost.'
    );
  }
  return null;
}

/** Throw when {@link getLocalBaseUrlError} rejects `baseUrl`. */
export function assertLocalBaseUrl(
  baseUrl: string | undefined | null,
  source?: string,
): string {
  const error = getLocalBaseUrlError(baseUrl, source);
  if (error) {
    throw new Error(error);
  }
  return baseUrl!.trim();
}
