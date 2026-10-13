/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { useState, useMemo } from 'react';
import { Box, Text } from 'ink';
import { theme } from '../../../semantic-colors.js';
import { useKeypress } from '../../../hooks/useKeypress.js';
import { keyMatchers, Command } from '../../../keyMatchers.js';
import { t } from '../../../../i18n/index.js';
import type {
  ResourceListStepProps,
  MCPResourceDisplayInfo,
} from '../types.js';
import { VISIBLE_RESOURCES_COUNT } from '../constants.js';

/** Friendly label for a resource (title preferred, then name), only when it
 * adds information beyond the URI that is already shown. */
const getResourceLabel = (
  resource: MCPResourceDisplayInfo,
): string | undefined => {
  const label = resource.title || resource.name;
  if (!label || label === resource.uri) return undefined;
  return label;
};

export const ResourceListStep: React.FC<ResourceListStepProps> = ({
  resources,
  onSelect,
  onBack,
  isActive = true,
}) => {
  const [selectedIndex, setSelectedIndex] = useState(0);

  // Compute the URI column width from actual content. The URI is what users
  // actually type, so give it a wider column (min 30, max 60).
  const uriWidth = useMemo(() => {
    if (resources.length === 0) return 30;
    const maxLength = Math.max(...resources.map((r) => r.uri.length));
    return Math.min(Math.max(maxLength + 2, 30), 60);
  }, [resources]);

  // Compute the start index of the visible area (scroll window)
  const scrollOffset = useMemo(() => {
    if (resources.length <= VISIBLE_RESOURCES_COUNT) {
      return 0;
    }
    // Keep the selected item in the visible area
    if (selectedIndex < VISIBLE_RESOURCES_COUNT - 1) {
      return 0;
    }
    return Math.min(
      selectedIndex - VISIBLE_RESOURCES_COUNT + 1,
      resources.length - VISIBLE_RESOURCES_COUNT,
    );
  }, [selectedIndex, resources.length]);

  // Currently visible resources
  const displayResources = useMemo(
    () => resources.slice(scrollOffset, scrollOffset + VISIBLE_RESOURCES_COUNT),
    [resources, scrollOffset],
  );

  useKeypress(
    (key) => {
      if (key.name === 'escape') {
        onBack();
      } else if (keyMatchers[Command.SELECTION_UP](key)) {
        setSelectedIndex((prev) => Math.max(0, prev - 1));
      } else if (keyMatchers[Command.SELECTION_DOWN](key)) {
        setSelectedIndex((prev) => Math.min(resources.length - 1, prev + 1));
      } else if (key.name === 'return') {
        if (resources[selectedIndex]) {
          onSelect(resources[selectedIndex]);
        }
      }
    },
    { isActive },
  );

  if (resources.length === 0) {
    return (
      <Box flexDirection="column">
        <Text color={theme.text.secondary}>
          {t('No resources available for this server.')}
        </Text>
      </Box>
    );
  }

  return (
    <Box flexDirection="column">
      {/* Resource list */}
      <Box flexDirection="column">
        {displayResources.map((resource, index) => {
          const actualIndex = scrollOffset + index;
          const isSelected = actualIndex === selectedIndex;
          const label = getResourceLabel(resource);

          return (
            <Box key={resource.uri}>
              {/* Selector */}
              <Box minWidth={2}>
                <Text
                  color={isSelected ? theme.text.accent : theme.text.primary}
                >
                  {isSelected ? '❯' : ' '}
                </Text>
              </Box>
              {/* Resource URI - fixed width */}
              <Box width={uriWidth}>
                <Text
                  color={isSelected ? theme.text.accent : theme.text.primary}
                  wrap="truncate"
                >
                  {resource.uri}
                </Text>
              </Box>
              {/* Friendly name (if different from URI) */}
              {label && (
                <Text color={theme.text.secondary} wrap="truncate">
                  {label}
                </Text>
              )}
            </Box>
          );
        })}
      </Box>

      {/* Scroll hint */}
      {resources.length > VISIBLE_RESOURCES_COUNT && (
        <Box marginTop={1}>
          <Text color={theme.text.secondary}>
            {scrollOffset > 0 ? '↑ ' : '  '}
            {t('{{current}}/{{total}}', {
              current: (selectedIndex + 1).toString(),
              total: resources.length.toString(),
            })}
            {scrollOffset + VISIBLE_RESOURCES_COUNT < resources.length
              ? ' ↓'
              : ''}
          </Text>
        </Box>
      )}
    </Box>
  );
};
