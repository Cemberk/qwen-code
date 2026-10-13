/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { useState, useMemo } from 'react';
import { Box, Text } from 'ink';
import { theme } from '../../../semantic-colors.js';
import { ICON } from '../../../constants.js';
import { useKeypress } from '../../../hooks/useKeypress.js';
import { keyMatchers, Command } from '../../../keyMatchers.js';
import { t } from '../../../../i18n/index.js';
import type { ServerListStepProps, MCPServerDisplayInfo } from '../types.js';
import {
  groupServersBySource,
  getStatusIcon,
  getStatusColor,
} from '../utils.js';

export const ServerListStep: React.FC<ServerListStepProps> = ({
  servers,
  onSelect,
}) => {
  const [selectedIndex, setSelectedIndex] = useState(0);

  const groupedServers = useMemo(
    () => groupServersBySource(servers),
    [servers],
  );

  const serverNameWidth = useMemo(() => {
    if (servers.length === 0) return 20;
    const maxLength = Math.max(...servers.map((s) => s.name.length));
    // Min 20, max 35, with some padding
    return Math.min(Math.max(maxLength + 2, 20), 35);
  }, [servers]);

  const flatServers = useMemo(() => {
    const result: MCPServerDisplayInfo[] = [];
    for (const group of groupedServers) {
      result.push(...group.servers);
    }
    return result;
  }, [groupedServers]);

  useKeypress(
    (key) => {
      if (keyMatchers[Command.SELECTION_UP](key)) {
        setSelectedIndex((prev) => Math.max(0, prev - 1));
      } else if (keyMatchers[Command.SELECTION_DOWN](key)) {
        setSelectedIndex((prev) => Math.min(flatServers.length - 1, prev + 1));
      } else if (key.name === 'return') {
        onSelect(selectedIndex);
      }
    },
    { isActive: true },
  );

  if (servers.length === 0) {
    return (
      <Box flexDirection="column">
        <Text color={theme.text.secondary}>
          {t('No MCP servers configured.')}
        </Text>
        <Text color={theme.text.secondary}>
          {t('Add MCP servers to your settings to get started.')}
        </Text>
      </Box>
    );
  }

  const getSelectionPosition = (globalIndex: number) => {
    let currentIndex = 0;
    for (const group of groupedServers) {
      if (globalIndex < currentIndex + group.servers.length) {
        return {
          groupIndex: groupedServers.indexOf(group),
          itemIndex: globalIndex - currentIndex,
        };
      }
      currentIndex += group.servers.length;
    }
    return { groupIndex: 0, itemIndex: 0 };
  };

  const currentPosition = getSelectionPosition(selectedIndex);

  return (
    <Box flexDirection="column">
      {/* Grouped server list */}
      {groupedServers.map((group, groupIndex) => (
        <Box
          key={group.source}
          flexDirection="column"
          marginBottom={groupIndex === groupedServers.length - 1 ? 0 : 1}
        >
          <Text bold color={theme.text.primary}>
            {`  ${group.displayName}`}
            {group.servers[0]?.configPath && (
              <Text color={theme.text.secondary}>
                {' '}
                ({group.servers[0].configPath})
              </Text>
            )}
          </Text>
          <Box flexDirection="column">
            {group.servers.map((server, itemIndex) => {
              const isSelected =
                groupIndex === currentPosition.groupIndex &&
                itemIndex === currentPosition.itemIndex;
              // Gated (#4615) but unapproved servers are skipped by discovery
              // and never connect, so the approval reason takes precedence.
              const awaitingApproval =
                !server.isDisabled && !!server.approvalState;
              const statusColor =
                server.isDisabled || awaitingApproval
                  ? 'yellow'
                  : getStatusColor(server.status);

              return (
                <Box key={server.name}>
                  <Box minWidth={2}>
                    <Text
                      color={
                        isSelected ? theme.text.accent : theme.text.primary
                      }
                    >
                      {isSelected ? '❯' : ' '}
                    </Text>
                  </Box>
                  {/* Server name - fixed width */}
                  <Box width={serverNameWidth}>
                    <Text
                      color={
                        isSelected ? theme.text.accent : theme.text.primary
                      }
                      wrap="truncate"
                    >
                      {server.name}
                    </Text>
                  </Box>
                  <Text color={theme.text.secondary}> · </Text>
                  {/* Status icon and text */}
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
                  {/* Invalid tool warning */}
                  {!!server.invalidToolCount && server.invalidToolCount > 0 && (
                    <Text color={theme.status.warning}>
                      {' '}
                      {t('{{count}} invalid tools', {
                        count: String(server.invalidToolCount),
                      })}
                    </Text>
                  )}
                </Box>
              );
            })}
          </Box>
        </Box>
      ))}

      {/* Hint only for servers that truly failed to connect; a gated skip
          (awaiting approval) is not an error, so no "check logs" hint */}
      {servers.some(
        (s) => s.status === 'disconnected' && !s.isDisabled && !s.approvalState,
      ) && (
        <Box marginTop={1}>
          <Text color={theme.status.warning}>
            {ICON.REFERENCE} {t('Run qwen --debug to see error logs')}
          </Text>
        </Box>
      )}
    </Box>
  );
};
