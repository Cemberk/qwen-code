/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Env vars that carry Qwen-internal credentials. These must never be inherited by a child process the agent
 * launches on the user's behalf — shell commands, the monitor tool, or a stdio
 * MCP server — because no legitimate user command needs them and leaking them
 * to arbitrary agent-run commands is a credential-exposure gap (issue #6601).
 *
 * `QWEN_SERVER_TOKEN` is the serve-daemon bearer token and `QWEN_DAEMON_TOKEN`
 * is the channel-daemon worker token.
 *
 * The same list gates `$VAR` substitution in settings, extension and hook
 * configuration (`isInternalSecretEnvVar`): those files can come from a
 * repository, and a substituted value is baked into a hook command, URL or
 * header before any child-env sanitization applies.
 *
 * This denylist is intentionally NARROW: it strips only Qwen-internal secrets,
 * NOT third-party credentials such as `GH_TOKEN`, `AWS_*`, or `NPM_TOKEN`.
 * Real shell workflows legitimately depend on inheriting those (`gh`, the AWS
 * CLI, `npm publish`, …), so stripping them here would break user commands.
 * Broader third-party-credential stripping stays scoped to the sandbox / MCP
 * infrastructure paths where it already lives.
 */
export const INTERNAL_SECRET_ENV_VARS: readonly string[] = [
  'QWEN_SERVER_TOKEN',
  'QWEN_DAEMON_TOKEN',
];

const INTERNAL_SECRET_ENV_VAR_NAMES = new Set(
  INTERNAL_SECRET_ENV_VARS.map((name) => name.toUpperCase()),
);

/**
 * Whether `name` refers to a Qwen-internal secret. The comparison is
 * case-insensitive because `process.env` is case-insensitive on Windows, so
 * `qwen_server_token` reads the same value as `QWEN_SERVER_TOKEN` there.
 */
export function isInternalSecretEnvVar(name: string): boolean {
  return INTERNAL_SECRET_ENV_VAR_NAMES.has(name.toUpperCase());
}

/**
 * Return a shallow copy of `env` with Qwen-internal secrets removed, so it is
 * safe to pass to a child process spawned on the user's behalf. Does not
 * mutate the input.
 *
 * @param env The source environment (defaults to `process.env`).
 */
export function sanitizeChildEnv(
  env: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  // Spread + delete rather than rebuilding by assignment: assignment routes
  // an own `__proto__` key through the prototype setter and drops it, while
  // spread copies it as a plain own property like every other variable.
  const sanitized: NodeJS.ProcessEnv = { ...env };
  for (const key of Object.keys(sanitized)) {
    if (isInternalSecretEnvVar(key)) {
      delete sanitized[key];
    }
  }
  return sanitized;
}
