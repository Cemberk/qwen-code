/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { SettingScope } from '../../config/settings.js';
import { t } from '../../i18n/index.js';
import {
  CommandKind,
  type CommandContext,
  type MessageActionReturn,
  type SlashCommand,
} from './types.js';

const ON =
  'Web access is on: the model can read web pages with web_fetch, and asks you before every fetch. Turn it off with /web off.';
const OFF =
  'Web access is off: the model cannot fetch web pages. Turn it on with /web on.';

const message = (
  messageType: 'info' | 'error',
  content: string,
): MessageActionReturn => ({ type: 'message', messageType, content });

/** Save `tools.webFetch` in the user settings and apply it to this session. */
async function setWebAccess(
  context: CommandContext,
  enabled: boolean,
): Promise<MessageActionReturn> {
  const { config, settings } = context.services;
  if (!config) {
    return message('error', 'Web access cannot be changed right now.');
  }
  settings.setValue(SettingScope.User, 'tools.webFetch', enabled);
  const applied = settings.merged.tools?.webFetch === true;
  await config.setWebFetchEnabled(applied);
  if (applied !== enabled) {
    return message(
      'error',
      `Your system settings set tools.webFetch, so web access stays ${applied ? 'on' : 'off'}.`,
    );
  }
  if (enabled && !config.isWebFetchEnabled()) {
    return message(
      'error',
      'Web access is saved as on, but this session runs in safe or bare mode, which has no web access.',
    );
  }
  return message('info', enabled ? ON : OFF);
}

export const webCommand: SlashCommand = {
  name: 'web',
  get description() {
    return t('Turn web access on or off: /web on, /web off');
  },
  kind: CommandKind.BUILT_IN,
  supportedModes: ['interactive'] as const,
  subCommands: [
    {
      name: 'on',
      get description() {
        return t('Let the model fetch web pages, asking you before each fetch');
      },
      kind: CommandKind.BUILT_IN,
      supportedModes: ['interactive'] as const,
      action: (context: CommandContext) => setWebAccess(context, true),
    },
    {
      name: 'off',
      get description() {
        return t('Remove web access: the model cannot fetch web pages');
      },
      kind: CommandKind.BUILT_IN,
      supportedModes: ['interactive'] as const,
      action: (context: CommandContext) => setWebAccess(context, false),
    },
  ],
  action: (context: CommandContext, args: string): MessageActionReturn => {
    if (args.trim()) {
      return message('error', 'Usage: /web, /web on or /web off');
    }
    return message(
      'info',
      context.services.config?.isWebFetchEnabled() ? ON : OFF,
    );
  },
};
