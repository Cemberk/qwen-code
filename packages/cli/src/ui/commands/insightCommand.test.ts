/**
 * @license
 * Copyright 2025 Qwen Code
 * SPDX-License-Identifier: Apache-2.0
 */

import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import path from 'path';
import { pathToFileURL } from 'node:url';
import { Storage } from '@qwen-code/qwen-code-core';
import { insightCommand } from './insightCommand.js';
import type { CommandContext } from './types.js';
import { createMockCommandContext } from '../../test-utils/mockCommandContext.js';

const mockGenerateStaticInsight = vi.fn();
const mockOpenBrowserSecurely = vi.hoisted(() => vi.fn());

vi.mock('@qwen-code/qwen-code-core', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('@qwen-code/qwen-code-core')>();
  return {
    ...actual,
    openBrowserSecurely: mockOpenBrowserSecurely,
  };
});

vi.mock('../../services/insight/generators/StaticInsightGenerator.js', () => ({
  StaticInsightGenerator: vi.fn(() => ({
    generateStaticInsight: mockGenerateStaticInsight,
  })),
}));

describe('insightCommand', () => {
  let mockContext: CommandContext;

  beforeEach(() => {
    Storage.setRuntimeBaseDir(path.resolve('runtime-output'));
    mockGenerateStaticInsight.mockResolvedValue(
      path.resolve('runtime-output', 'insights', 'insight-2026-03-05.html'),
    );
    mockOpenBrowserSecurely.mockClear();
    mockOpenBrowserSecurely.mockResolvedValue(undefined);

    mockContext = createMockCommandContext({
      services: {
        config: {} as CommandContext['services']['config'],
      },
      ui: {
        addItem: vi.fn(),
        setPendingItem: vi.fn(),
        setDebugMessage: vi.fn(),
      },
    } as unknown as CommandContext);
  });

  afterEach(() => {
    Storage.setRuntimeBaseDir(null);
    vi.restoreAllMocks();
  });

  it('uses runtime base dir to locate projects directory', async () => {
    if (!insightCommand.action) {
      throw new Error('insight command must have action');
    }

    await insightCommand.action(mockContext, '');

    expect(mockGenerateStaticInsight).toHaveBeenCalledWith(
      path.join(Storage.getRuntimeBaseDir(), 'projects'),
      expect.any(Function),
    );
    expect(mockOpenBrowserSecurely).toHaveBeenCalledWith(
      pathToFileURL(
        path.resolve('runtime-output', 'insights', 'insight-2026-03-05.html'),
      ).href,
      {
        allowFile: true,
        allowedFilePaths: [
          path.resolve('runtime-output', 'insights', 'insight-2026-03-05.html'),
        ],
      },
    );
  });

  it('shows the generated file path before attempting to open the browser', async () => {
    if (!insightCommand.action) {
      throw new Error('insight command must have action');
    }

    await insightCommand.action(mockContext, '');

    const messages = vi
      .mocked(mockContext.ui.addItem)
      .mock.calls.map(([item]) =>
        'text' in item && typeof item.text === 'string' ? item.text : '',
      );
    expect(messages).toContain(
      `Insights generated at: ${path.resolve(
        'runtime-output',
        'insights',
        'insight-2026-03-05.html',
      )}. If the browser does not open automatically, open this file manually.`,
    );
    expect(
      messages.some((message) => message.includes('Opening insights')),
    ).toBe(false);
  });

  it('non_interactive: returns message with output path and does not open browser', async () => {
    const nonInteractiveContext = createMockCommandContext({
      executionMode: 'non_interactive',
      services: {
        config: {} as CommandContext['services']['config'],
      },
      ui: {
        addItem: vi.fn(),
        setPendingItem: vi.fn(),
        setDebugMessage: vi.fn(),
      },
    } as unknown as CommandContext);

    if (!insightCommand.action) {
      throw new Error('insight command must have action');
    }

    const result = await insightCommand.action(nonInteractiveContext, '');

    expect(result).toMatchObject({
      type: 'message',
      messageType: 'info',
    });
    expect((result as { content: string }).content).toContain(
      path.resolve('runtime-output', 'insights', 'insight-2026-03-05.html'),
    );
    expect(mockOpenBrowserSecurely).not.toHaveBeenCalled();
  });

  it('non_interactive: returns error message when generation fails', async () => {
    mockGenerateStaticInsight.mockRejectedValue(new Error('disk full'));

    const nonInteractiveContext = createMockCommandContext({
      executionMode: 'non_interactive',
      services: {
        config: {} as CommandContext['services']['config'],
      },
      ui: {
        addItem: vi.fn(),
        setPendingItem: vi.fn(),
        setDebugMessage: vi.fn(),
      },
    } as unknown as CommandContext);

    if (!insightCommand.action) {
      throw new Error('insight command must have action');
    }

    const result = await insightCommand.action(nonInteractiveContext, '');

    expect(result).toMatchObject({
      type: 'message',
      messageType: 'error',
    });
    expect((result as { content: string }).content).toContain('disk full');
    expect(mockOpenBrowserSecurely).not.toHaveBeenCalled();
  });
});
