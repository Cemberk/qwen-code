/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import React from 'react';
import { Box, Text } from 'ink';
import { theme } from '../semantic-colors.js';
import { MaxSizedBox } from '../components/shared/MaxSizedBox.js';
import { renderMermaidVisual } from './mermaidVisualRenderer.js';

interface MermaidDiagramProps {
  source: string;
  sourceCopyCommand: string;
  contentWidth: number;
  availableTerminalHeight?: number;
}

const MERMAID_PADDING = 1;

const MermaidDiagramInternal: React.FC<MermaidDiagramProps> = ({
  source,
  sourceCopyCommand,
  contentWidth,
  availableTerminalHeight,
}) => {
  const innerWidth = Math.max(8, contentWidth - MERMAID_PADDING);
  const visual = React.useMemo(
    () => renderMermaidVisual(source, innerWidth),
    [source, innerWidth],
  );

  return (
    <Box
      paddingLeft={MERMAID_PADDING}
      flexDirection="column"
      width={contentWidth}
      flexShrink={0}
    >
      <Text bold color={theme.text.accent}>
        {`${visual.title} · source: ${sourceCopyCommand}`}
      </Text>
      <MaxSizedBox
        maxHeight={availableTerminalHeight}
        maxWidth={innerWidth}
        overflowDirection="bottom"
      >
        {visual.lines.map((line, index) => (
          <Box key={index}>
            <Text color={theme.text.primary}>{line || ' '}</Text>
          </Box>
        ))}
      </MaxSizedBox>
      {visual.warning && (
        <Text color={theme.text.secondary} wrap="wrap">
          {visual.warning}
        </Text>
      )}
    </Box>
  );
};

export const MermaidDiagram = React.memo(MermaidDiagramInternal);
