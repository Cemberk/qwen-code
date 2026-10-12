/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import { render } from 'ink-testing-library';
import { MermaidDiagram } from './MermaidDiagram.js';

describe('MermaidDiagram', () => {
  it('renders the text wireframe with the source hint', () => {
    const { lastFrame } = render(
      <MermaidDiagram
        source={'flowchart TD\nA[Start] --> B[End]'}
        sourceCopyCommand="/copy mermaid 1"
        contentWidth={80}
        availableTerminalHeight={20}
      />,
    );

    const frame = lastFrame() ?? '';
    expect(frame).toContain('Mermaid flowchart (TD) · source: /copy mermaid 1');
    expect(frame).toContain('Start');
    expect(frame).toContain('End');
  });
});
