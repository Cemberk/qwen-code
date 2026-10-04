/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  buildToolResultContentPrefix,
  ToolCallEmitter,
} from './tool-call-emitter.js';
import type { SessionContext, SessionEmitterContext } from '../types.js';
import {
  createTranscriptToolCallResultUpdate,
  type TranscriptToolCallResultOptions,
} from '../transcript-replay.js';
import type {
  Config,
  ToolRegistry,
  AnyDeclarativeTool,
  AnyToolInvocation,
} from '@qwen-code/qwen-code-core';
import { Kind, ToolNames } from '@qwen-code/qwen-code-core';
import type { Part } from '@google/genai';

// Helper to create mock message parts for tests
const createMockMessage = (text?: string): Part[] =>
  text
    ? [{ functionResponse: { name: 'test', response: { output: text } } }]
    : [];

describe('ToolCallEmitter', () => {
  let mockContext: SessionContext;
  let sendUpdateSpy: ReturnType<typeof vi.fn>;
  let mockToolRegistry: ToolRegistry;
  let emitter: ToolCallEmitter;

  // Helper to create mock tool
  const createMockTool = (
    overrides: Partial<AnyDeclarativeTool> = {},
  ): AnyDeclarativeTool =>
    ({
      name: 'test_tool',
      kind: Kind.Other,
      build: vi.fn().mockReturnValue({
        getDescription: () => 'Test tool description',
        toolLocations: () => [{ path: '/test/file.ts', line: 10 }],
      } as unknown as AnyToolInvocation),
      ...overrides,
    }) as unknown as AnyDeclarativeTool;

  beforeEach(() => {
    sendUpdateSpy = vi.fn().mockResolvedValue(undefined);
    mockToolRegistry = {
      getTool: vi.fn().mockReturnValue(null),
    } as unknown as ToolRegistry;

    mockContext = {
      sessionId: 'test-session-id',
      config: {
        getToolRegistry: () => mockToolRegistry,
      } as unknown as Config,
      sendUpdate: sendUpdateSpy,
    };

    emitter = new ToolCallEmitter(mockContext);
  });

  // Builds a tool result update the way history replay does: the
  // transcript-replay builder with this module's content prefix.
  const sendResult = ({
    error,
    ...params
  }: Omit<TranscriptToolCallResultOptions, 'errorMessage' | 'contentPrefix'> & {
    error?: Error;
  }) =>
    sendUpdateSpy(
      createTranscriptToolCallResultUpdate({
        ...params,
        errorMessage: error?.message,
        contentPrefix: buildToolResultContentPrefix(params.resultDisplay),
      }),
    );

  describe('tool result updates', () => {
    it('should emit tool_call_update with completed status on success', async () => {
      sendResult({
        toolName: 'test_tool',
        callId: 'call-123',
        success: true,
        message: createMockMessage('Tool completed successfully'),
        resultDisplay: 'Tool completed successfully',
      });

      expect(sendUpdateSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          sessionUpdate: 'tool_call_update',
          toolCallId: 'call-123',
          status: 'completed',
          rawOutput: 'Tool completed successfully',
          _meta: { toolName: 'test_tool', provenance: 'builtin' },
        }),
      );
    });

    it('places the vision bridge disclosure in ACP content on success', async () => {
      const resultDisplay = {
        type: 'vision_bridge_notice' as const,
        summary: 'Transcribed PDF pages 20-23; remaining pages 24-25',
        notice: 'Converted 4 images via qwen3-vl-plus (127.0.0.1:11434).',
      };

      sendResult({
        toolName: 'read_file',
        callId: 'call-pdf-success',
        success: true,
        message: createMockMessage('Page 20: transcribed content'),
        resultDisplay,
      });

      expect(sendUpdateSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          status: 'completed',
          content: [
            {
              type: 'content',
              content: {
                type: 'text',
                text: `${resultDisplay.summary}\n${resultDisplay.notice}`,
              },
            },
            {
              type: 'content',
              content: {
                type: 'text',
                text: 'Page 20: transcribed content',
              },
            },
          ],
          rawOutput: resultDisplay,
        }),
      );
    });

    it('sanitizes terminal controls in the ACP vision bridge disclosure', async () => {
      const resultDisplay = {
        type: 'vision_bridge_notice' as const,
        summary: 'Transcribed evil\x1b]52;c;ZXZpbA==\x07\u202E.pdf pages 20-23',
        notice: 'Converted via qwen3-vl-plus.',
      };

      sendResult({
        toolName: 'read_file',
        callId: 'call-pdf-unsafe-name',
        success: true,
        message: createMockMessage('Page 20: transcribed content'),
        resultDisplay,
      });

      const update = sendUpdateSpy.mock.calls[0][0] as {
        content: Array<{ content?: { text?: string } }>;
      };
      const disclosure = update.content[0].content?.text;
      expect(disclosure).toContain('evil');
      expect(disclosure).not.toContain('\x1b');
      expect(disclosure).not.toContain('\x07');
      expect(disclosure).not.toContain('\u202e');
    });

    it('keeps the vision bridge disclosure in ACP content on failure', async () => {
      const resultDisplay = {
        type: 'vision_bridge_notice' as const,
        summary: 'Failed to read PDF after rendering pages 20-23',
        notice:
          'Vision bridge (qwen3-vl-plus) failed after sending images to 127.0.0.1:11434.',
      };

      sendResult({
        toolName: 'read_file',
        callId: 'call-pdf-failure',
        success: false,
        message: createMockMessage('Cannot extract text from PDF'),
        resultDisplay,
        error: new Error('No extractable text layer.'),
      });

      expect(sendUpdateSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          status: 'failed',
          content: [
            {
              type: 'content',
              content: {
                type: 'text',
                text: `${resultDisplay.summary}\n${resultDisplay.notice}`,
              },
            },
            {
              type: 'content',
              content: {
                type: 'text',
                text: 'No extractable text layer.',
              },
            },
          ],
          rawOutput: resultDisplay,
        }),
      );
    });

    it('emits structured artifacts without a wire trust marker', async () => {
      sendResult({
        toolName: ToolNames.ARTIFACT,
        callId: 'call-artifact',
        success: true,
        message: createMockMessage('Published'),
        artifacts: [
          {
            kind: 'html',
            storage: 'published',
            title: 'Dashboard',
            url: 'file:///tmp/dashboard.html',
            managedId: 'managed-1',
          },
        ],
      });

      expect(sendUpdateSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          sessionUpdate: 'tool_call_update',
          toolCallId: 'call-artifact',
          status: 'completed',
          _meta: expect.objectContaining({
            toolName: ToolNames.ARTIFACT,
            artifacts: [
              expect.objectContaining({
                title: 'Dashboard',
                storage: 'published',
              }),
            ],
          }),
        }),
      );
      expect(
        (
          sendUpdateSpy.mock.calls[0]?.[0] as {
            _meta?: Record<string, unknown>;
          }
        )._meta,
      ).not.toHaveProperty('artifactsTrustedPublisher');
    });

    it('should emit tool_call_update with failed status on failure', async () => {
      sendResult({
        toolName: 'test_tool',
        callId: 'call-123',
        success: false,
        message: [],
        error: new Error('Something went wrong'),
      });

      expect(sendUpdateSpy).toHaveBeenCalledWith({
        sessionUpdate: 'tool_call_update',
        toolCallId: 'call-123',
        status: 'failed',
        content: [
          {
            type: 'content',
            content: { type: 'text', text: 'Something went wrong' },
          },
        ],
        _meta: { toolName: 'test_tool', provenance: 'builtin' },
      });
    });

    it('emits structured artifacts from failed tool results', async () => {
      sendResult({
        toolName: ToolNames.RECORD_ARTIFACT,
        callId: 'call-failed-artifact',
        success: false,
        message: [],
        error: new Error('record failed'),
        artifacts: [
          { title: 'Failure report', url: 'https://example.com/drop' },
        ],
      });

      expect(sendUpdateSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          sessionUpdate: 'tool_call_update',
          toolCallId: 'call-failed-artifact',
          status: 'failed',
          _meta: expect.objectContaining({
            artifacts: [
              expect.objectContaining({
                title: 'Failure report',
                url: 'https://example.com/drop',
              }),
            ],
          }),
        }),
      );
    });

    it('should handle diff display format', async () => {
      sendResult({
        toolName: 'edit_file',
        callId: 'call-edit',
        success: true,
        message: [],
        resultDisplay: {
          fileName: '/test/file.ts',
          originalContent: 'old content',
          newContent: 'new content',
        },
      });

      expect(sendUpdateSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          sessionUpdate: 'tool_call_update',
          toolCallId: 'call-edit',
          status: 'completed',
          content: [
            {
              type: 'diff',
              path: '/test/file.ts',
              oldText: 'old content',
              newText: 'new content',
            },
          ],
          _meta: { toolName: 'edit_file', provenance: 'builtin' },
        }),
      );
      expect(sendUpdateSpy.mock.calls[0][0].rawOutput).toEqual({
        fileName: '/test/file.ts',
        originalContent: 'old content',
        newContent: 'new content',
      });
    });

    it('should not replay truncated session previews as full diffs', async () => {
      sendResult({
        toolName: 'edit_file',
        callId: 'call-edit',
        success: true,
        message: [],
        resultDisplay: {
          fileName: '/test/file.ts',
          originalContent: 'old preview',
          newContent: 'new preview',
          truncatedForSession: true,
          fileDiffLength: 200000,
          fileDiffTruncated: true,
        },
      });

      expect(sendUpdateSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          sessionUpdate: 'tool_call_update',
          toolCallId: 'call-edit',
          status: 'completed',
          content: [
            {
              type: 'content',
              content: {
                type: 'text',
                text: 'Full diff omitted from saved session history for /test/file.ts. Original fileDiff length: 200000 chars.',
              },
            },
          ],
          _meta: { toolName: 'edit_file', provenance: 'builtin' },
        }),
      );
      expect(sendUpdateSpy.mock.calls[0][0].rawOutput).toBeUndefined();
    });

    it('should replay an intact saved patch without truncated file bodies', async () => {
      const fileDiff = '--- a/file.ts\n+++ b/file.ts\n@@ -1 +1 @@\n-old\n+new';

      sendResult({
        toolName: 'edit_file',
        callId: 'call-edit',
        success: true,
        message: [],
        resultDisplay: {
          fileName: '/test/file.ts',
          originalContent: 'old preview',
          newContent: 'new preview',
          fileDiff,
          truncatedForSession: true,
          fileDiffTruncated: false,
        },
      });

      expect(sendUpdateSpy.mock.calls[0][0].rawOutput).toEqual({
        fileName: '/test/file.ts',
        fileDiff,
      });
      expect(sendUpdateSpy.mock.calls[0][0].content).not.toContainEqual(
        expect.objectContaining({ type: 'diff' }),
      );
    });

    it('should transform message parts to content', async () => {
      sendResult({
        toolName: 'test_tool',
        callId: 'call-123',
        success: true,
        message: [{ text: 'Some text output' }],
        resultDisplay: 'raw output',
      });

      expect(sendUpdateSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          sessionUpdate: 'tool_call_update',
          toolCallId: 'call-123',
          status: 'completed',
          content: [
            {
              type: 'content',
              content: { type: 'text', text: 'Some text output' },
            },
          ],
          rawOutput: 'raw output',
          _meta: { toolName: 'test_tool', provenance: 'builtin' },
        }),
      );
    });

    it('should handle empty message parts', async () => {
      sendResult({
        toolName: 'test_tool',
        callId: 'call-empty',
        success: true,
        message: [],
      });

      expect(sendUpdateSpy).toHaveBeenCalledWith({
        sessionUpdate: 'tool_call_update',
        toolCallId: 'call-empty',
        status: 'completed',
        content: [],
        _meta: { toolName: 'test_tool', provenance: 'builtin' },
      });
    });
  });

  describe('mapToolKind', () => {
    it('should map all Kind values correctly', () => {
      expect(emitter.mapToolKind(Kind.Read)).toBe('read');
      expect(emitter.mapToolKind(Kind.Edit)).toBe('edit');
      expect(emitter.mapToolKind(Kind.Delete)).toBe('delete');
      expect(emitter.mapToolKind(Kind.Move)).toBe('move');
      expect(emitter.mapToolKind(Kind.Search)).toBe('search');
      expect(emitter.mapToolKind(Kind.Execute)).toBe('execute');
      expect(emitter.mapToolKind(Kind.Think)).toBe('think');
      expect(emitter.mapToolKind(Kind.Fetch)).toBe('fetch');
      // Kind.Agent maps to 'other': ACP has no 'agent' ToolKind.
      expect(emitter.mapToolKind(Kind.Agent)).toBe('other');
      expect(emitter.mapToolKind(Kind.Other)).toBe('other');
    });

    it('should map exit_plan_mode tool to switch_mode kind', () => {
      // exit_plan_mode uses Kind.Think internally, but should map to switch_mode per ACP spec
      expect(emitter.mapToolKind(Kind.Think, 'exit_plan_mode')).toBe(
        'switch_mode',
      );
    });

    it('should map enter_plan_mode tool to switch_mode kind', () => {
      expect(emitter.mapToolKind(Kind.Think, 'enter_plan_mode')).toBe(
        'switch_mode',
      );
    });

    it('should not affect other tools with Kind.Think', () => {
      // Other tools with Kind.Think should still map to think
      expect(emitter.mapToolKind(Kind.Think, 'todo_write')).toBe('think');
      expect(emitter.mapToolKind(Kind.Think, 'some_other_tool')).toBe('think');
    });
  });

  describe('isExitPlanModeTool', () => {
    it('should return true for exit_plan_mode tool name', () => {
      expect(emitter.isExitPlanModeTool('exit_plan_mode')).toBe(true);
    });

    it('should return false for other tool names', () => {
      expect(emitter.isExitPlanModeTool('read_file')).toBe(false);
      expect(emitter.isExitPlanModeTool('edit_file')).toBe(false);
      expect(emitter.isExitPlanModeTool('todo_write')).toBe(false);
      expect(emitter.isExitPlanModeTool('')).toBe(false);
    });
  });

  describe('resolveToolMetadata', () => {
    it('uses persisted metadata without a Config in direct replay', () => {
      const context: SessionEmitterContext = {
        sessionId: 'persisted-session',
        sendUpdate: vi.fn().mockResolvedValue(undefined),
      };
      const configless = new ToolCallEmitter(context);

      expect(
        configless.resolveToolMetadata('read_file', {
          description: 'Read the persisted file',
          path: '/untrusted/project/file.ts',
        }),
      ).toEqual({
        title: 'read_file: Read the persisted file',
        locations: [],
        kind: 'other',
      });
    });

    it('should return defaults when tool not found', () => {
      const metadata = emitter.resolveToolMetadata('unknown_tool', {
        arg: 'value',
      });

      expect(metadata).toEqual({
        title: 'unknown_tool',
        locations: [],
        kind: 'other',
      });
    });

    it('falls back to the tool name when the tool build fails', () => {
      const mockTool = createMockTool();
      vi.mocked(mockTool.build).mockImplementation(() => {
        throw new Error('Build failed');
      });
      vi.mocked(mockToolRegistry.getTool).mockReturnValue(mockTool);

      expect(
        emitter.resolveToolMetadata('failing_tool', { invalid: true }),
      ).toEqual({ title: 'failing_tool', locations: [], kind: 'other' });
    });

    it('should return tool metadata when tool found and built successfully', () => {
      const mockTool = createMockTool({ kind: Kind.Search });
      vi.mocked(mockToolRegistry.getTool).mockReturnValue(mockTool);

      const metadata = emitter.resolveToolMetadata('search_tool', {
        query: 'test',
      });

      expect(metadata).toEqual({
        title: 'search_tool: Test tool description',
        locations: [{ path: '/test/file.ts', line: 10 }],
        kind: 'search',
      });
    });
  });

  describe('fixes verification', () => {
    describe('Fix 2: functionResponse parts are stringified', () => {
      it('should stringify functionResponse parts in message', async () => {
        sendResult({
          toolName: 'test_tool',
          callId: 'call-func',
          success: true,
          message: [
            {
              functionResponse: {
                name: 'test',
                response: { output: 'test output' },
              },
            },
          ],
          resultDisplay: { unknownField: 'value', nested: { data: 123 } },
        });

        expect(sendUpdateSpy).toHaveBeenCalledWith(
          expect.objectContaining({
            sessionUpdate: 'tool_call_update',
            toolCallId: 'call-func',
            status: 'completed',
            content: [
              {
                type: 'content',
                content: {
                  type: 'text',
                  text: 'test output',
                },
              },
            ],
            rawOutput: { unknownField: 'value', nested: { data: 123 } },
            _meta: { toolName: 'test_tool', provenance: 'builtin' },
          }),
        );
      });
    });

    describe('Fix 3: rawOutput is included in tool results', () => {
      it('should include rawOutput when resultDisplay is provided', async () => {
        sendResult({
          toolName: 'test_tool',
          callId: 'call-extra',
          success: true,
          message: [{ text: 'Result text' }],
          resultDisplay: 'Result text',
        });

        expect(sendUpdateSpy).toHaveBeenCalledWith(
          expect.objectContaining({
            sessionUpdate: 'tool_call_update',
            toolCallId: 'call-extra',
            status: 'completed',
            rawOutput: 'Result text',
            _meta: { toolName: 'test_tool', provenance: 'builtin' },
          }),
        );
      });

      it('should not include rawOutput when resultDisplay is undefined', async () => {
        sendResult({
          toolName: 'test_tool',
          callId: 'call-null',
          success: true,
          message: [],
        });

        const call = sendUpdateSpy.mock.calls[0][0];
        expect(call.rawOutput).toBeUndefined();
        expect(call._meta).toEqual({
          toolName: 'test_tool',
          provenance: 'builtin',
        });
      });
    });

    describe('Fix 5: Line null mapping in resolveToolMetadata', () => {
      it('should map undefined line to null in locations', () => {
        const mockTool = createMockTool();
        // Override toolLocations to return undefined line
        vi.mocked(mockTool.build).mockReturnValue({
          getDescription: () => 'Description',
          toolLocations: () => [
            { path: '/file1.ts', line: 10 },
            { path: '/file2.ts', line: undefined },
            { path: '/file3.ts' }, // no line property
          ],
        } as unknown as AnyToolInvocation);
        vi.mocked(mockToolRegistry.getTool).mockReturnValue(mockTool);

        const metadata = emitter.resolveToolMetadata('test_tool', {
          arg: 'value',
        });

        expect(metadata.locations).toEqual([
          { path: '/file1.ts', line: 10 },
          { path: '/file2.ts', line: null },
          { path: '/file3.ts', line: null },
        ]);
      });
    });

    describe('Message transformation', () => {
      it('should transform text parts from message', async () => {
        sendResult({
          toolName: 'test_tool',
          callId: 'call-text',
          success: true,
          message: [{ text: 'Text content from message' }],
        });

        expect(sendUpdateSpy).toHaveBeenCalledWith({
          sessionUpdate: 'tool_call_update',
          toolCallId: 'call-text',
          status: 'completed',
          content: [
            {
              type: 'content',
              content: { type: 'text', text: 'Text content from message' },
            },
          ],
          _meta: { toolName: 'test_tool', provenance: 'builtin' },
        });
      });

      it('should transform functionResponse parts from message', async () => {
        sendResult({
          toolName: 'test_tool',
          callId: 'call-func-resp',
          success: true,
          message: [
            {
              functionResponse: {
                name: 'test_tool',
                response: { output: 'Function output' },
              },
            },
          ],
          resultDisplay: 'raw result',
        });

        expect(sendUpdateSpy).toHaveBeenCalledWith(
          expect.objectContaining({
            sessionUpdate: 'tool_call_update',
            toolCallId: 'call-func-resp',
            status: 'completed',
            content: [
              {
                type: 'content',
                content: { type: 'text', text: 'Function output' },
              },
            ],
            rawOutput: 'raw result',
            _meta: { toolName: 'test_tool', provenance: 'builtin' },
          }),
        );
      });
    });
  });
});
