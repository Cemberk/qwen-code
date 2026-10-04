/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  CommandKind,
  type CommandContext,
  type SlashCommand,
  type SlashCommandActionReturn,
} from './types.js';
import { MessageType } from '../types.js';
import { t } from '../../i18n/index.js';

export const skillsCommand: SlashCommand = {
  name: 'skills',
  get description() {
    return t('Open the skills panel (browse, search, toggle, pick).');
  },
  kind: CommandKind.BUILT_IN,
  supportedModes: ['interactive'] as const,
  // Accepting `/skills` from the auto-completion popup (e.g. typing
  // `/skil<Enter>`) submits immediately rather than inserting `/skills `
  // and forcing a second Enter — `/skills` has no required arg, the bare
  // action just opens the dialog. See `SlashCommand.submitOnAccept`.
  submitOnAccept: true,
  action: async (
    context: CommandContext,
  ): Promise<void | SlashCommandActionReturn> => {
    // `/skills` is dialog-only. Any trailing args are ignored — the dialog
    // is the single entry for browsing, search, toggle, and skill launch.
    const skillManager = context.services.config?.getSkillManager();
    if (!skillManager) {
      context.ui.addItem(
        {
          type: MessageType.ERROR,
          text: t('Could not retrieve skill manager.'),
        },
        Date.now(),
      );
      return;
    }

    return { type: 'dialog', dialog: 'skills_manage' };
  },
};
