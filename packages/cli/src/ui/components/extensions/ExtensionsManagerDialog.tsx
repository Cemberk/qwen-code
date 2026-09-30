/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { useState, useCallback } from 'react';
import { Box, Text } from 'ink';
import { theme } from '../../semantic-colors.js';
import { useKeypress } from '../../hooks/useKeypress.js';
import { useUIState } from '../../contexts/UIStateContext.js';
import { useTerminalSize } from '../../hooks/useTerminalSize.js';
import { t } from '../../../i18n/index.js';
import type { ExtensionUpdateState } from '../../state/extensions.js';
import type { ExtensionsManagerDialogProps } from './types.js';
import { InstalledTab } from './tabs/InstalledTab.js';
import { ConsentPrompt } from '../ConsentPrompt.js';
import { SettingInputPrompt } from '../SettingInputPrompt.js';
import { PluginChoicePrompt } from '../PluginChoicePrompt.js';

export interface StatusMessage {
  type: 'info' | 'success' | 'warning' | 'error';
  text: string;
}

export function ExtensionsManagerDialog({
  onClose,
  config,
}: ExtensionsManagerDialogProps) {
  const {
    extensionsUpdateState,
    confirmUpdateExtensionRequests,
    settingInputRequests,
    pluginChoiceRequests,
    commandContext,
  } = useUIState();
  const { columns } = useTerminalSize();
  // Cap the width to the app's main content area (AppContainer caps it at 100).
  // Without this the dialog grows to the full terminal width on wide terminals
  // and overflows its container, clipping the right-aligned status column.
  const boxWidth = Math.min(columns - 4, 100);

  // Install and update flows raise interactive requests (consent, setting
  // input, plugin choice). They are rendered here, inside the dialog, so the
  // dialog stays mounted and keeps its list state; DialogManager skips them
  // while this dialog is open.
  const consentRequest = confirmUpdateExtensionRequests?.[0];
  const settingRequest = settingInputRequests?.[0];
  const pluginChoiceRequest = pluginChoiceRequests?.[0];
  const hasPendingRequest =
    !!consentRequest || !!settingRequest || !!pluginChoiceRequest;

  const [tabLocked, setTabLocked] = useState(false);
  const [status, setStatus] = useState<StatusMessage | null>(null);

  // Keeps the app's update-state map honest after an in-dialog update: the
  // extension is current again, so a stale "update available" entry must not
  // come back when the detail view is re-entered.
  const handleUpdateStateChange = useCallback(
    (name: string, state: ExtensionUpdateState) => {
      commandContext.ui.dispatchExtensionStateUpdate({
        type: 'SET_STATE',
        payload: { name, state },
      });
    },
    [commandContext],
  );

  const handleLockChange = useCallback((locked: boolean) => {
    setTabLocked(locked);
  }, []);

  // Close. Inactive while the list owns a sub-view (locked).
  useKeypress(
    (key) => {
      if (key.name === 'escape') {
        onClose();
      }
    },
    { isActive: !tabLocked && !hasPendingRequest },
  );

  if (!config) {
    return (
      <Box flexDirection="column" width={boxWidth}>
        <Box
          borderStyle="single"
          borderColor={theme.border.default}
          padding={1}
          width={boxWidth}
        >
          <Text color={theme.status.error}>
            {t('Extensions are not available in this environment.')}
          </Text>
        </Box>
      </Box>
    );
  }

  return (
    <Box flexDirection="column" width={boxWidth}>
      {consentRequest ? (
        <ConsentPrompt
          prompt={consentRequest.prompt}
          onConfirm={consentRequest.onConfirm}
          terminalWidth={boxWidth}
        />
      ) : settingRequest ? (
        <SettingInputPrompt
          key={settingRequest.settingName}
          settingName={settingRequest.settingName}
          settingDescription={settingRequest.settingDescription}
          sensitive={settingRequest.sensitive}
          onSubmit={settingRequest.onSubmit}
          onCancel={settingRequest.onCancel}
          terminalWidth={boxWidth}
        />
      ) : pluginChoiceRequest ? (
        <PluginChoicePrompt
          key={pluginChoiceRequest.marketplaceName}
          marketplaceName={pluginChoiceRequest.marketplaceName}
          plugins={pluginChoiceRequest.plugins}
          onSelect={pluginChoiceRequest.onSelect}
          onCancel={pluginChoiceRequest.onCancel}
          terminalWidth={boxWidth}
        />
      ) : null}
      <Box
        display={hasPendingRequest ? 'none' : 'flex'}
        borderStyle="single"
        borderColor={theme.border.default}
        flexDirection="column"
        paddingLeft={1}
        paddingRight={1}
        width={boxWidth}
        gap={1}
      >
        <Box flexDirection="column">
          <InstalledTab
            config={config}
            isActive={!hasPendingRequest}
            onLockChange={handleLockChange}
            onStatus={setStatus}
            extensionsUpdateState={extensionsUpdateState}
            onUpdateStateChange={handleUpdateStateChange}
          />
        </Box>

        {status && (
          <Text
            color={
              status.type === 'error'
                ? theme.status.error
                : status.type === 'warning'
                  ? theme.status.warning
                  : status.type === 'success'
                    ? theme.status.success
                    : theme.text.secondary
            }
          >
            {status.text}
          </Text>
        )}

        <Text color={theme.text.secondary}>
          {tabLocked
            ? t('Enter to select · Esc to go back')
            : t(
                '↑↓ navigate · Space enable/disable · f favorite · Enter details · Esc close',
              )}
        </Text>
      </Box>
    </Box>
  );
}
