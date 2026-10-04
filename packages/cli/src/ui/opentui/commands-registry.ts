/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Slash-command dialog routing for the OpenTUI renderer (PR1 slice 5).
 *
 * `routeDialogToOpenTui` maps every dialog kind the original commands can
 * return (`OpenDialogActionReturn['dialog']`, ui/commands/types.ts) onto the
 * OpenTUI dialog family, mirroring the `actions.open*` switch in
 * ui/hooks/slashCommandProcessor.ts. The model-family dialogs all land on
 * OpenTuiModelDialog (dialogs-model.tsx) with the mode the ink ModelDialog
 * receives; `/resume <id>` and `/branch` are host actions (handleResume /
 * handleBranch), never dialogs.
 */

import type { SessionListItem } from '@qwen-code/qwen-code-core';
import type { OpenDialogActionReturn } from '../commands/types.js';
import type { ModelDialogMode } from './dialogs-model.js';

/** Every dialog kind an original slash command can request. */
export type InkDialogKind = OpenDialogActionReturn['dialog'];

/** The OpenTUI dialog a routed dialog request opens. */
export type OpenTuiDialogRequest =
  | { dialog: 'help' }
  | { dialog: 'theme' }
  | { dialog: 'editor' }
  | { dialog: 'settings' }
  | { dialog: 'statusline' }
  | { dialog: 'memory' }
  | { dialog: 'auth'; initialError?: string; openedViaCommand?: boolean }
  | { dialog: 'trust' }
  | { dialog: 'permissions' }
  | { dialog: 'approval-mode' }
  | { dialog: 'effort' }
  | { dialog: 'output-style' }
  | { dialog: 'delete' }
  | { dialog: 'resume'; matchedSessions?: SessionListItem[] }
  | { dialog: 'extensions_manage' }
  | { dialog: 'hooks' }
  | { dialog: 'mcp' }
  | { dialog: 'rewind' }
  | { dialog: 'diff' }
  | { dialog: 'stats' }
  | { dialog: 'arena'; mode: 'start' | 'select' | 'stop' | 'status' }
  | { dialog: 'subagent_create' }
  | { dialog: 'subagent_list' }
  | { dialog: 'skills_manage' }
  | {
      dialog: 'model';
      mode: ModelDialogMode;
      persistScope?: 'workspace' | 'user';
    };

/**
 * Parity of the `case 'dialog'` switch in ui/hooks/slashCommandProcessor.ts:
 * every dialog kind maps to exactly the dialog (and mode) the ink actions
 * open. Exhaustive — a new dialog kind fails the `never` check at compile
 * time.
 */
export function routeDialogToOpenTui(
  result: OpenDialogActionReturn,
): OpenTuiDialogRequest {
  const dialog = result.dialog;
  switch (dialog) {
    case 'help':
      return { dialog: 'help' };
    case 'theme':
      return { dialog: 'theme' };
    case 'editor':
      return { dialog: 'editor' };
    case 'settings':
      return { dialog: 'settings' };
    case 'statusline':
      return { dialog: 'statusline' };
    case 'memory':
      return { dialog: 'memory' };
    case 'auth':
      // ink records the /auth result only when the command opened the dialog
      // (useAuth's openedViaCommandRef), never for the boot auth-error open.
      return { dialog: 'auth', openedViaCommand: true };
    case 'trust':
      return { dialog: 'trust' };
    case 'permissions':
      return { dialog: 'permissions' };
    case 'approval-mode':
      return { dialog: 'approval-mode' };
    case 'effort':
      return { dialog: 'effort' };
    case 'output-style':
      return { dialog: 'output-style' };
    case 'delete':
      return { dialog: 'delete' };
    case 'resume':
      return result.matchedSessions
        ? { dialog: 'resume', matchedSessions: result.matchedSessions }
        : { dialog: 'resume' };
    case 'branch':
      // Never reached: commands-dispatch intercepts dialog-branch as a host
      // action (handleBranch) before routing. A compile-time exclusion is
      // not expressible — OpenDialogActionReturn is one interface with a
      // union dialog field — so fail loudly if a refactor ever drops the
      // interception instead of returning a request nothing can render.
      throw new Error(
        "'/branch' is a host action (handleBranch) and must not route to a dialog",
      );
    case 'extensions_manage':
      return { dialog: 'extensions_manage' };
    case 'hooks':
      return { dialog: 'hooks' };
    case 'mcp':
      return { dialog: 'mcp' };
    case 'rewind':
      return { dialog: 'rewind' };
    case 'diff':
      return { dialog: 'diff' };
    case 'stats':
      return { dialog: 'stats' };
    case 'arena_start':
      return { dialog: 'arena', mode: 'start' };
    case 'arena_select':
      return { dialog: 'arena', mode: 'select' };
    case 'arena_stop':
      return { dialog: 'arena', mode: 'stop' };
    case 'arena_status':
      return { dialog: 'arena', mode: 'status' };
    case 'subagent_create':
      return { dialog: 'subagent_create' };
    case 'subagent_list':
      return { dialog: 'subagent_list' };
    case 'skills_manage':
      return { dialog: 'skills_manage' };
    case 'model':
      return {
        dialog: 'model',
        mode: 'primary',
        ...(result.persistScope ? { persistScope: result.persistScope } : {}),
      };
    case 'advisor-model':
      return { dialog: 'model', mode: 'advisor' };
    case 'fast-model':
      return {
        dialog: 'model',
        mode: 'fast',
        ...(result.persistScope ? { persistScope: result.persistScope } : {}),
      };
    case 'vision-model':
      return {
        dialog: 'model',
        mode: 'vision',
        ...(result.persistScope ? { persistScope: result.persistScope } : {}),
      };
    case 'compaction-model':
      return {
        dialog: 'model',
        mode: 'compaction',
        ...(result.persistScope ? { persistScope: result.persistScope } : {}),
      };
    default: {
      const unhandled: never = dialog;
      throw new Error(`Unhandled slash command dialog: ${unhandled}`);
    }
  }
}
