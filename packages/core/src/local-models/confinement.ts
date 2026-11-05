/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { spawnSync } from 'node:child_process';
import { findExecutable } from './executables.js';

/**
 * How the engine is kept off the network on Linux: in an empty network
 * namespace of its own, made by bubblewrap or by util-linux's unshare, where
 * only a Unix socket reaches it. `none` when neither works on this machine.
 */
export type Confinement =
  | { kind: 'bwrap'; tool: string }
  | { kind: 'unshare'; tool: string }
  | { kind: 'none' };

/** Runs `tool args`; whether it exited with 0. */
export type ProbeRunner = (tool: string, args: readonly string[]) => boolean;

const runProbe: ProbeRunner = (tool, args) => {
  const result = spawnSync(tool, args, {
    stdio: 'ignore',
    timeout: 10_000,
    env: { PATH: process.env['PATH'] ?? '/usr/bin:/bin' },
  });
  return result.status === 0;
};

/**
 * The arguments that run `binary args` without network access. bwrap keeps
 * the whole file system and the devices (the GPU) and ends the engine with
 * qwen; unshare maps the user to root in a new user namespace, which an
 * unprivileged user needs to make a network namespace.
 */
export function confinedCommand(
  confinement: Confinement,
  binary: string,
  args: readonly string[],
): { command: string; args: string[] } {
  switch (confinement.kind) {
    case 'bwrap':
      return {
        command: confinement.tool,
        args: [
          '--dev-bind',
          '/',
          '/',
          '--unshare-net',
          '--die-with-parent',
          '--',
          binary,
          ...args,
        ],
      };
    case 'unshare':
      return {
        command: confinement.tool,
        args: ['--user', '--map-root-user', '--net', '--', binary, ...args],
      };
    default:
      return { command: binary, args: [...args] };
  }
}

/**
 * The first confinement that works here: some distributions forbid
 * unprivileged user namespaces, which both tools need, so each is tried by
 * running `true` in it.
 */
export function detectConfinement(
  platform: NodeJS.Platform = process.platform,
  findTool: (name: string) => string | undefined = (name) =>
    findExecutable(name, process.env['PATH'] ?? '', platform),
  run: ProbeRunner = runProbe,
): Confinement {
  if (platform !== 'linux') return { kind: 'none' };
  for (const kind of ['bwrap', 'unshare'] as const) {
    const tool = findTool(kind);
    if (!tool) continue;
    const probe = confinedCommand({ kind, tool }, 'true', []);
    if (run(probe.command, probe.args)) return { kind, tool };
  }
  return { kind: 'none' };
}

let cached: Confinement | undefined;

/** This machine's confinement, probed once per process. */
export function getConfinement(): Confinement {
  cached ??= detectConfinement();
  return cached;
}

/** For tests: forget the cached confinement, or replace it. */
export function setConfinementForTesting(
  confinement: Confinement | undefined,
): void {
  cached = confinement;
}
