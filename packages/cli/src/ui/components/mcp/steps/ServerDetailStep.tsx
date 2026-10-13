/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { useMemo } from 'react';
import { Box, Text } from 'ink';
import { theme } from '../../../semantic-colors.js';
import { useKeypress } from '../../../hooks/useKeypress.js';
import { RadioButtonSelect } from '../../shared/RadioButtonSelect.js';
import { t } from '../../../../i18n/index.js';
import type { ServerDetailStepProps } from '../types.js';
import {
  getStatusColor,
  getStatusIcon,
  formatServerCommand,
} from '../utils.js';

// Label column width
const LABEL_WIDTH = 15;

type ServerAction =
  | 'view-tools'
  | 'view-resources'
  | 'approve'
  | 'reconnect'
  | 'toggle-disable';

export const ServerDetailStep: React.FC<ServerDetailStepProps> = ({
  server,
  onViewTools,
  onViewResources,
  onApprove,
  onReconnect,
  onDisable,
  onBack,
  isActive = true,
}) => {
  // Gated (#4615) but unapproved servers are skipped by discovery and never
  // connect, so the approval reason takes precedence.
  const awaitingApproval =
    !!server && !server.isDisabled && !!server.approvalState;
  const statusColor = server
    ? server.isDisabled || awaitingApproval
      ? 'yellow'
      : getStatusColor(server.status)
    : 'gray';

  // Build the available actions from the server state
  const actions = useMemo(() => {
    const result: Array<{
      key: string;
      label: string;
      value: ServerAction;
    }> = [];

    if (!server) {
      return result;
    }

    // Show "View tools" only when the server is enabled and has tools
    if (!server.isDisabled && (server.toolCount ?? 0) > 0) {
      result.push({
        key: 'view-tools',
        label: t('View tools'),
        value: 'view-tools',
      });
    }

    // Show "View resources" only when the caller wired onViewResources and the
    // server is enabled and has resources. onViewResources is optional: callers
    // that reuse ServerDetailStep, like the extension manager
    // (McpServerActionsView), must not get a dead action without that subview.
    if (
      onViewResources &&
      !server.isDisabled &&
      (server.resourceCount ?? 0) > 0
    ) {
      result.push({
        key: 'view-resources',
        label: t('View resources'),
        value: 'view-resources',
      });
    }

    // Show "Reconnect" only when the server is enabled and disconnected.
    // Gated but unapproved servers are skipped by discovery, so reconnecting
    // cannot progress (still pending/rejected); hide it to match the status.
    if (
      !server.isDisabled &&
      !awaitingApproval &&
      server.status === 'disconnected'
    ) {
      result.push({
        key: 'reconnect',
        label: t('Reconnect'),
        value: 'reconnect',
      });
    }

    // Gated but unapproved servers get an "Approve" action so users can approve
    // directly in /mcp instead of waiting for the startup prompt.
    if (awaitingApproval && onApprove) {
      result.push({
        key: 'approve',
        label: t('Approve'),
        value: 'approve',
      });
    }

    // Always show enable/disable (extension servers use extension-level
    // disable records)
    result.push({
      key: 'toggle-disable',
      label: server.isDisabled ? t('Enable') : t('Disable'),
      value: 'toggle-disable',
    });

    return result;
  }, [server, onViewResources, onApprove, awaitingApproval]);

  useKeypress(
    (key) => {
      if (key.name === 'escape') {
        onBack();
      }
    },
    { isActive },
  );

  if (!server) {
    return (
      <Box>
        <Text color={theme.status.error}>{t('No server selected')}</Text>
      </Box>
    );
  }

  return (
    <Box flexDirection="column" gap={1}>
      {/* Server details */}
      <Box flexDirection="column">
        <Box>
          <Box width={LABEL_WIDTH}>
            <Text color={theme.text.primary}>{t('Status:')}</Text>
          </Box>
          <Box>
            <Text
              color={
                statusColor === 'green'
                  ? theme.status.success
                  : statusColor === 'yellow'
                    ? theme.status.warning
                    : theme.status.error
              }
            >
              {getStatusIcon(server.status)}{' '}
              {server.isDisabled
                ? t('disabled')
                : awaitingApproval
                  ? server.approvalState === 'rejected'
                    ? t('rejected — edit config to re-approve')
                    : t('needs approval')
                  : t(server.status)}
            </Text>
          </Box>
        </Box>

        <Box>
          <Box width={LABEL_WIDTH}>
            <Text color={theme.text.primary}>{t('Source:')}</Text>
          </Box>
          <Box>
            <Text color={theme.text.primary}>
              {server.source === 'user'
                ? t('User Settings')
                : server.source === 'project'
                  ? '.mcp.json'
                  : server.source === 'workspace'
                    ? t('Workspace Settings')
                    : server.source === 'system'
                      ? t('System Settings')
                      : t('Extension')}
            </Text>
          </Box>
        </Box>

        <Box>
          <Box width={LABEL_WIDTH}>
            <Text color={theme.text.primary}>{t('Command:')}</Text>
          </Box>
          <Box>
            <Text wrap="truncate">{formatServerCommand(server)}</Text>
          </Box>
        </Box>

        {server.config.cwd && (
          <Box>
            <Box width={LABEL_WIDTH}>
              <Text color={theme.text.primary}>{t('Working Directory:')}</Text>
            </Box>
            <Box>
              <Text wrap="truncate">{server.config.cwd}</Text>
            </Box>
          </Box>
        )}

        {!server.isDisabled && (
          <Box>
            <Box width={LABEL_WIDTH}>
              <Text color={theme.text.primary}>{t('Tools:')}</Text>
            </Box>
            <Box>
              <Text>
                {server.toolCount}{' '}
                {server.toolCount === 1 ? t('tool') : t('tools')}
                {!!server.invalidToolCount && server.invalidToolCount > 0 && (
                  <Text color={theme.status.warning}>
                    {' '}
                    ({server.invalidToolCount}{' '}
                    {server.invalidToolCount === 1
                      ? t('invalid')
                      : t('invalid')}
                    )
                  </Text>
                )}
              </Text>
            </Box>
          </Box>
        )}

        {!server.isDisabled && server.promptCount > 0 && (
          <Box>
            <Box width={LABEL_WIDTH}>
              <Text color={theme.text.primary}>{t('Prompts:')}</Text>
            </Box>
            <Box>
              <Text>{server.promptCount}</Text>
            </Box>
          </Box>
        )}

        {!server.isDisabled && server.resourceCount > 0 && (
          <Box>
            <Box width={LABEL_WIDTH}>
              <Text color={theme.text.primary}>{t('Resources:')}</Text>
            </Box>
            <Box>
              <Text>{server.resourceCount}</Text>
            </Box>
          </Box>
        )}

        {server.errorMessage && (
          <Box>
            <Box width={LABEL_WIDTH}>
              <Text color={theme.status.error}>{t('Error:')}</Text>
            </Box>
            <Box>
              <Text color={theme.status.error} wrap="wrap">
                {server.errorMessage}
              </Text>
            </Box>
          </Box>
        )}
      </Box>

      {/* Action list */}
      <Box>
        <RadioButtonSelect<ServerAction>
          items={actions}
          isFocused={isActive}
          showNumbers={false}
          onSelect={(value: ServerAction) => {
            switch (value) {
              case 'view-tools':
                onViewTools();
                break;
              case 'view-resources':
                onViewResources?.();
                break;
              case 'approve':
                onApprove?.();
                break;
              case 'reconnect':
                onReconnect?.();
                break;
              case 'toggle-disable':
                onDisable?.();
                break;
              default:
                break;
            }
          }}
        />
      </Box>
    </Box>
  );
};
