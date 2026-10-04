/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ToolResultBoundaryObservation } from '@qwen-code/qwen-code-core';
import type { CLIUserMessage } from './types.js';

const { mockObserveBoundary } = vi.hoisted(() => ({
  mockObserveBoundary: vi.fn(
    (_observation: ToolResultBoundaryObservation) => true,
  ),
}));

vi.mock('@qwen-code/qwen-code-core', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@qwen-code/qwen-code-core')>()),
  observeToolResultBoundary: mockObserveBoundary,
}));

import {
  observeHeadlessJsonToolResultWire,
  observeHeadlessToolResultProjection,
  observeHeadlessToolResultWire,
} from './tool-result-boundary-diagnostics.js';

function headlessMessage(
  content: string,
  toolCallId = 'call-secret',
): CLIUserMessage {
  return {
    type: 'user',
    session_id: 'session-secret',
    parent_tool_use_id: null,
    message: {
      role: 'user',
      content: [
        {
          type: 'tool_result',
          tool_use_id: toolCallId,
          content,
        },
      ],
    },
  };
}

describe('CLI tool-result boundary diagnostics', () => {
  beforeEach(() => {
    mockObserveBoundary.mockReset().mockReturnValue(true);
  });

  it('correlates Headless projection with its writer frame', () => {
    const message = headlessMessage('projected');
    observeHeadlessToolResultProjection(
      message,
      'original',
      'projected',
      'call-secret',
      { state: 'reusable', kinds: ['file'] },
    );
    const frame = '汉😀';
    observeHeadlessToolResultWire(message, frame);

    expect(mockObserveBoundary).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        stage: 'headless_projection_input',
        mutated: true,
        artifacts: [{ state: 'reusable', kinds: ['file'] }],
        values: [{ representation: 'headless_content', value: 'original' }],
      }),
    );
    expect(mockObserveBoundary).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        stage: 'headless_projection_output',
        mutated: true,
        artifacts: [{ state: 'reusable', kinds: ['file'] }],
        values: [{ representation: 'headless_content', value: 'projected' }],
      }),
    );
    expect(mockObserveBoundary).toHaveBeenLastCalledWith(
      expect.objectContaining({
        stage: 'headless_wire',
        sessionId: 'session-secret',
        toolCallId: 'call-secret',
        mutated: true,
        wireUtf8Bytes: Buffer.byteLength(frame, 'utf8'),
        artifacts: [{ state: 'reusable', kinds: ['file'] }],
        values: [{ representation: 'headless_content', value: 'projected' }],
      }),
    );
  });

  it('logs one exact wire event for a batch JSON frame', () => {
    const first = headlessMessage('first-projected', 'first-call');
    const second = headlessMessage('second-projected', 'second-call');
    observeHeadlessToolResultProjection(
      first,
      'first-original',
      'first-projected',
      'first-call',
      { state: 'reusable', kinds: ['file'] },
    );
    observeHeadlessToolResultProjection(
      second,
      'second-original',
      'second-projected',
      'second-call',
      { state: 'none', kinds: ['image'] },
    );

    observeHeadlessJsonToolResultWire(
      [headlessMessage('uncorrelated'), first, second],
      'x'.repeat(999),
    );

    expect(mockObserveBoundary).toHaveBeenLastCalledWith(
      expect.objectContaining({
        stage: 'headless_wire',
        toolCallId: undefined,
        toolCallIds: ['first-call', 'second-call'],
        wireUtf8Bytes: 999,
        artifacts: [
          { state: 'reusable', kinds: ['file'] },
          { state: 'none', kinds: ['image'] },
        ],
        values: [
          {
            representation: 'headless_content',
            value: 'first-projected',
          },
          {
            representation: 'headless_content',
            value: 'second-projected',
          },
        ],
      }),
    );
  });

  it('does not retain objects when neither projection event is eligible', () => {
    mockObserveBoundary.mockReturnValue(false);
    const message = headlessMessage('small');
    observeHeadlessToolResultProjection(
      message,
      'small',
      'small',
      'call-secret',
      { state: 'undecided', kinds: [] },
    );
    expect(mockObserveBoundary).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ mutated: false }),
    );
    expect(mockObserveBoundary).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ mutated: false }),
    );
    mockObserveBoundary.mockClear();

    observeHeadlessToolResultWire(message, 'frame');

    expect(mockObserveBoundary).not.toHaveBeenCalled();
  });

  it('swallows observer failures at projection boundaries', () => {
    mockObserveBoundary.mockImplementation(() => {
      throw new Error('diagnostic failure');
    });
    const message = headlessMessage('projected');

    expect(() =>
      observeHeadlessToolResultProjection(
        message,
        'original',
        'projected',
        'call-secret',
        { state: 'undecided', kinds: [] },
      ),
    ).not.toThrow();
  });

  it('swallows observer failures at writer boundaries', () => {
    const headless = headlessMessage('projected');
    observeHeadlessToolResultProjection(
      headless,
      'original',
      'projected',
      'call-secret',
      { state: 'undecided', kinds: [] },
    );
    mockObserveBoundary.mockImplementation(() => {
      throw new Error('diagnostic failure');
    });

    expect(() =>
      observeHeadlessToolResultWire(headless, 'frame'),
    ).not.toThrow();
    expect(() =>
      observeHeadlessJsonToolResultWire([headless], 'frame'),
    ).not.toThrow();
  });
});
