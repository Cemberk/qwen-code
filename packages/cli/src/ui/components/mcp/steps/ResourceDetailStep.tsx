/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { Box, Text } from 'ink';
import { theme } from '../../../semantic-colors.js';
import { useKeypress } from '../../../hooks/useKeypress.js';
import { t } from '../../../../i18n/index.js';
import { buildMcpResourceRef } from '../../../hooks/mcpResourceRef.js';
import type { ResourceDetailStepProps } from '../types.js';

const LABEL_WIDTH = 15;

export const ResourceDetailStep: React.FC<ResourceDetailStepProps> = ({
  resource,
  onBack,
  isActive = true,
}) => {
  useKeypress(
    (key) => {
      if (key.name === 'escape') {
        onBack();
      }
    },
    { isActive },
  );

  if (!resource) {
    return (
      <Box>
        <Text color={theme.status.error}>{t('No resource selected')}</Text>
      </Box>
    );
  }

  // Show the friendly name only if it differs from the URI (no repetition).
  const friendlyName = resource.title || resource.name;
  const showName = friendlyName && friendlyName !== resource.uri;

  return (
    <Box flexDirection="column" gap={1}>
      {/* Resource metadata */}
      <Box flexDirection="column">
        <Box>
          <Box width={LABEL_WIDTH}>
            <Text color={theme.text.primary}>{t('URI:')}</Text>
          </Box>
          <Box>
            <Text wrap="wrap">{resource.uri}</Text>
          </Box>
        </Box>

        {showName && (
          <Box>
            <Box width={LABEL_WIDTH}>
              <Text color={theme.text.primary}>{t('Name:')}</Text>
            </Box>
            <Box>
              <Text wrap="wrap">{friendlyName}</Text>
            </Box>
          </Box>
        )}

        {resource.mimeType && (
          <Box>
            <Box width={LABEL_WIDTH}>
              <Text color={theme.text.primary}>{t('MIME Type:')}</Text>
            </Box>
            <Box>
              <Text wrap="truncate">{resource.mimeType}</Text>
            </Box>
          </Box>
        )}

        {typeof resource.size === 'number' && (
          <Box>
            <Box width={LABEL_WIDTH}>
              <Text color={theme.text.primary}>{t('Size:')}</Text>
            </Box>
            <Box>
              <Text>
                {t('{{count}} bytes', { count: String(resource.size) })}
              </Text>
            </Box>
          </Box>
        )}
      </Box>

      {/* Resource description */}
      {resource.description && (
        <Box flexDirection="column">
          <Text color={theme.text.primary} bold>
            {t('Description')}:
          </Text>
          <Text wrap="wrap">{resource.description}</Text>
        </Box>
      )}

      {/* How to reference: typing @server:uri in chat injects the content */}
      <Box flexDirection="column">
        <Text color={theme.text.primary} bold>
          {t('Reference in chat')}:
        </Text>
        <Text color={theme.text.accent}>
          @{buildMcpResourceRef(resource.serverName, resource.uri)}
        </Text>
      </Box>
    </Box>
  );
};
