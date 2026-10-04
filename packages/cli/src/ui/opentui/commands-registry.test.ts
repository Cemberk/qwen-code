/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Verifies the OpenTUI slash-command registry against the ORIGINAL sources:
 * every dialog kind an original command can return is routed (the full
 * `OpenDialogActionReturn['dialog']` union), matching the ink actions.
 */

import { describe, it, expect } from 'vitest';
import type { OpenDialogActionReturn } from '../commands/types.js';
import {
  routeDialogToOpenTui,
  type InkDialogKind,
} from './commands-registry.js';

/** Every dialog kind from ui/commands/types.ts (checked exhaustively). */
const ALL_DIALOG_KINDS: readonly InkDialogKind[] = [
  'help',
  'arena_start',
  'arena_select',
  'arena_stop',
  'arena_status',
  'auth',
  'theme',
  'editor',
  'settings',
  'statusline',
  'memory',
  'model',
  'fast-model',
  'advisor-model',
  'vision-model',
  'compaction-model',
  'subagent_create',
  'subagent_list',
  'skills_manage',
  'trust',
  'permissions',
  'approval-mode',
  'effort',
  'output-style',
  'resume',
  'delete',
  'branch',
  'extensions_manage',
  'hooks',
  'mcp',
  'rewind',
  'diff',
  'stats',
];

describe('routeDialogToOpenTui (ink dialog-switch parity)', () => {
  it('routes every dialog kind; none falls through to the error case', () => {
    // 'branch' is the one exception: a host action both renderers intercept
    // before routing (asserted separately below).
    const routable = ALL_DIALOG_KINDS.filter((d) => d !== 'branch');
    expect(routable).toHaveLength(ALL_DIALOG_KINDS.length - 1);
    for (const dialog of routable) {
      const request = routeDialogToOpenTui({
        type: 'dialog',
        dialog,
      } as OpenDialogActionReturn);
      expect(request).toBeTruthy();
      expect(request.dialog).toBeTruthy();
    }
  });

  it("throws on 'branch' — a host action that must never route to a dialog", () => {
    // If commands-dispatch ever drops its handleBranch interception, this
    // loud failure replaces a silently unrenderable dialog request.
    expect(() =>
      routeDialogToOpenTui({
        type: 'dialog',
        dialog: 'branch',
        name: 'wip',
      } as OpenDialogActionReturn),
    ).toThrow(/host action/);
  });

  it('maps each dialog kind onto its exact OpenTUI target', () => {
    // Pins the mapping itself, not just its existence: mis-routing one
    // dialog onto another (e.g. theme → settings) must fail here.
    const targets: Array<[InkDialogKind, string, object?]> = [
      ['help', 'help'],
      ['theme', 'theme'],
      ['editor', 'editor'],
      ['settings', 'settings'],
      ['statusline', 'statusline'],
      ['memory', 'memory'],
      // A command-opened auth dialog records its result; the boot auth-error
      // open does not (ink useAuth's openedViaCommandRef).
      ['auth', 'auth', { openedViaCommand: true }],
      ['trust', 'trust'],
      ['permissions', 'permissions'],
      ['approval-mode', 'approval-mode'],
      ['effort', 'effort'],
      ['output-style', 'output-style'],
      ['delete', 'delete'],
      ['resume', 'resume'],
      ['extensions_manage', 'extensions_manage'],
      ['hooks', 'hooks'],
      ['mcp', 'mcp'],
      ['rewind', 'rewind'],
      ['diff', 'diff'],
      ['stats', 'stats'],
    ];
    for (const [dialog, target, extras] of targets) {
      expect(
        routeDialogToOpenTui({
          type: 'dialog',
          dialog,
        } as OpenDialogActionReturn),
      ).toEqual({ dialog: target, ...extras });
    }
  });

  it('maps the model family onto the model dialog with the ink mode', () => {
    const cases: Array<[InkDialogKind, string]> = [
      ['model', 'primary'],
      ['fast-model', 'fast'],
      ['advisor-model', 'advisor'],
      ['vision-model', 'vision'],
      ['compaction-model', 'compaction'],
    ];
    for (const [dialog, mode] of cases) {
      const request = routeDialogToOpenTui({
        type: 'dialog',
        dialog,
      } as OpenDialogActionReturn);
      expect(request).toEqual({ dialog: 'model', mode });
    }
  });

  it('carries persistScope for the model dialogs like openModelDialog', () => {
    expect(
      routeDialogToOpenTui({
        type: 'dialog',
        dialog: 'model',
        persistScope: 'workspace',
      } as OpenDialogActionReturn),
    ).toEqual({ dialog: 'model', mode: 'primary', persistScope: 'workspace' });
  });

  it('maps the arena dialogs onto the arena dialog modes', () => {
    expect(
      routeDialogToOpenTui({
        type: 'dialog',
        dialog: 'arena_start',
      } as OpenDialogActionReturn),
    ).toEqual({ dialog: 'arena', mode: 'start' });
    expect(
      routeDialogToOpenTui({
        type: 'dialog',
        dialog: 'arena_select',
      } as OpenDialogActionReturn),
    ).toEqual({ dialog: 'arena', mode: 'select' });
    expect(
      routeDialogToOpenTui({
        type: 'dialog',
        dialog: 'arena_stop',
      } as OpenDialogActionReturn),
    ).toEqual({ dialog: 'arena', mode: 'stop' });
    expect(
      routeDialogToOpenTui({
        type: 'dialog',
        dialog: 'arena_status',
      } as OpenDialogActionReturn),
    ).toEqual({ dialog: 'arena', mode: 'status' });
  });

  it('keeps resume matchedSessions payloads', () => {
    expect(
      routeDialogToOpenTui({
        type: 'dialog',
        dialog: 'resume',
      } as OpenDialogActionReturn),
    ).toEqual({ dialog: 'resume' });
    expect(
      routeDialogToOpenTui({
        type: 'dialog',
        dialog: 'resume',
        matchedSessions: [],
      } as OpenDialogActionReturn),
    ).toEqual({ dialog: 'resume', matchedSessions: [] });
  });
});
