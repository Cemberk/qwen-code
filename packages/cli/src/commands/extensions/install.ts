/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type { CommandModule } from 'yargs';

import {
  ExtensionManager,
  isExtensionCommittedWithWarningsError,
  parseInstallSource,
  type ExtensionScope,
} from '@qwen-code/qwen-code-core';
import { getErrorMessage } from '../../utils/errors.js';
import { writeStdoutLine, writeStderrLine } from '../../utils/stdioHelpers.js';
import { isWorkspaceTrusted } from '../../config/trustedFolders.js';
import { loadSettings } from '../../config/settings.js';
import {
  requestConsentOrFail,
  requestConsentNonInteractive,
  requestChoicePluginNonInteractive,
} from './consent.js';
import { t, getCurrentLanguage } from '../../i18n/index.js';

interface InstallArgs {
  source: string;
  consent?: boolean;
  scope?: string;
}

// "workspace" is accepted as an alias of "project" to match enable/disable.
function normalizeScope(scope: string | undefined): ExtensionScope {
  return scope === 'project' || scope === 'workspace' ? 'project' : 'user';
}

export async function handleInstall(args: InstallArgs) {
  const scope = normalizeScope(args.scope);
  let extensionManager: ExtensionManager | undefined;
  try {
    const installMetadata = await parseInstallSource(args.source);

    const requestConsent = args.consent
      ? () => Promise.resolve()
      : requestConsentOrFail.bind(null, requestConsentNonInteractive);
    const workspaceDir = process.cwd();
    extensionManager = new ExtensionManager({
      workspaceDir,
      locale: getCurrentLanguage(),
      isWorkspaceTrusted:
        isWorkspaceTrusted(loadSettings(workspaceDir).merged).isTrusted ?? true,
      requestConsent,
      requestChoicePlugin: requestChoicePluginNonInteractive,
    });
    await extensionManager.refreshCache();

    const extension = await extensionManager.installExtension(
      installMetadata,
      requestConsent,
      undefined,
      workspaceDir,
      undefined,
      scope === 'project'
        ? { scope: 'workspace', workspacePath: workspaceDir }
        : { scope: 'user' },
    );
    if (args.scope) {
      try {
        extensionManager.setExtensionScope(extension.name, scope);
      } catch (scopeError) {
        writeStderrLine(
          `Warning: Extension installed, but failed to save scope preference: ${getErrorMessage(scopeError)}`,
        );
      }
    }
    writeStdoutLine(
      scope === 'project'
        ? t(
            'Extension "{{name}}" installed successfully and enabled for the current workspace.',
            { name: extension.name },
          )
        : t('Extension "{{name}}" installed successfully and enabled.', {
            name: extension.name,
          }),
    );
  } catch (error) {
    if (isExtensionCommittedWithWarningsError(error)) {
      if (args.scope && extensionManager) {
        try {
          extensionManager.setExtensionScope(error.identity.name, scope);
        } catch (scopeError) {
          writeStderrLine(
            `Warning: Extension installed, but failed to save scope preference: ${getErrorMessage(scopeError)}`,
          );
        }
      }
      writeStderrLine(`Warning: ${getErrorMessage(error)}`);
      return;
    }
    writeStderrLine(getErrorMessage(error));
    process.exit(1);
  }
}

export const installCommand: CommandModule = {
  command: 'install <source>',
  describe: t(
    'Installs an extension from a local path or archive, or a plugin from a local claude marketplace (marketplace-path:plugin-name).',
  ),
  builder: (yargs) =>
    yargs
      .positional('source', {
        describe: t(
          'The local path or archive, or local marketplace source (marketplace-path:plugin-name) of the extension to install.',
        ),
        type: 'string',
        demandOption: true,
      })
      .option('consent', {
        describe: t(
          'Acknowledge the security risks of installing an extension and skip the confirmation prompt.',
        ),
        type: 'boolean',
        default: false,
      })
      .option('scope', {
        describe: t(
          'The scope to install the extension in: "user" (global, default) or "project" (current workspace only).',
        ),
        type: 'string',
        choices: ['user', 'project', 'workspace'],
      })
      .check((argv) => {
        if (!argv.source) {
          throw new Error(t('The source argument must be provided.'));
        }
        return true;
      }),
  handler: async (argv) => {
    await handleInstall({
      source: argv['source'] as string,
      consent: argv['consent'] as boolean | undefined,
      scope: argv['scope'] as string | undefined,
    });
  },
};
