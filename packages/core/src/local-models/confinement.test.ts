/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import { confinedCommand, detectConfinement } from './confinement.js';

const tools: Record<string, string> = {
  bwrap: '/usr/bin/bwrap',
  unshare: '/usr/bin/unshare',
};

describe('detectConfinement', () => {
  it('prefers bwrap when it can make a network namespace', () => {
    const runs: string[] = [];
    const confinement = detectConfinement(
      'linux',
      (name) => tools[name],
      (tool, args) => {
        runs.push([tool, ...args].join(' '));
        return true;
      },
    );
    expect(confinement).toEqual({ kind: 'bwrap', tool: '/usr/bin/bwrap' });
    expect(runs).toEqual([
      '/usr/bin/bwrap --dev-bind / / --unshare-net --die-with-parent -- true',
    ]);
  });

  it('falls back to unshare when bwrap is missing or refused', () => {
    expect(
      detectConfinement(
        'linux',
        (name) => tools[name],
        (tool) => tool === '/usr/bin/unshare',
      ),
    ).toEqual({ kind: 'unshare', tool: '/usr/bin/unshare' });
    expect(
      detectConfinement(
        'linux',
        (name) => (name === 'unshare' ? tools[name] : undefined),
        () => true,
      ),
    ).toEqual({ kind: 'unshare', tool: '/usr/bin/unshare' });
  });

  it('is none when unprivileged namespaces are forbidden, or off Linux', () => {
    expect(
      detectConfinement(
        'linux',
        (name) => tools[name],
        () => false,
      ),
    ).toEqual({ kind: 'none' });
    expect(
      detectConfinement(
        'win32',
        () => 'x',
        () => true,
      ),
    ).toEqual({ kind: 'none' });
  });
});

describe('confinedCommand', () => {
  it('wraps the engine in a new user and network namespace with unshare', () => {
    expect(
      confinedCommand({ kind: 'unshare', tool: '/usr/bin/unshare' }, '/e', [
        '--a',
      ]),
    ).toEqual({
      command: '/usr/bin/unshare',
      args: ['--user', '--map-root-user', '--net', '--', '/e', '--a'],
    });
  });

  it('runs the engine as it is without confinement', () => {
    expect(confinedCommand({ kind: 'none' }, '/e', ['--a'])).toEqual({
      command: '/e',
      args: ['--a'],
    });
  });
});
