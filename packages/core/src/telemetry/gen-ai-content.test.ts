/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { Ajv } from 'ajv';
import {
  extractOpenAiContent,
  GenAiOutputAccumulator,
  stringifyGenAiJson,
} from './gen-ai-content.js';

function fixture(name: string): object {
  return JSON.parse(
    readFileSync(
      new URL(`./test-fixtures/gen-ai/${name}`, import.meta.url),
      'utf8',
    ),
  ) as object;
}

describe('GenAI content conversion', () => {
  it('converts final OpenAI messages and tool definitions', () => {
    const content = extractOpenAiContent({
      messages: [
        { role: 'system', content: 'be helpful' },
        { role: 'user', content: [{ type: 'text', text: 'read a' }] },
        {
          role: 'assistant',
          content: 'calling',
          reasoning_content: 'reasoning',
          refusal: 'refused detail',
          tool_calls: [
            {
              id: 'call-1',
              type: 'function',
              function: { name: 'read', arguments: '{"path":"a"}' },
            },
          ],
        },
        {
          role: 'tool',
          tool_call_id: 'call-1',
          content: '{"output":"ok"}',
        },
      ],
      tools: [
        {
          type: 'function',
          function: {
            name: 'read',
            description: 'Read a file',
            parameters: {
              type: 'object',
              properties: { path: { type: 'string' } },
            },
          },
        },
      ],
    });

    expect(content.inputMessages).toEqual([
      {
        role: 'system',
        parts: [{ type: 'text', content: 'be helpful' }],
      },
      {
        role: 'user',
        parts: [{ type: 'text', content: 'read a' }],
      },
      {
        role: 'assistant',
        parts: [
          { type: 'reasoning', content: 'reasoning' },
          { type: 'text', content: 'calling' },
          { type: 'refusal', content: 'refused detail' },
          {
            type: 'tool_call',
            id: 'call-1',
            name: 'read',
            arguments: { path: 'a' },
          },
        ],
      },
      {
        role: 'tool',
        parts: [
          {
            type: 'tool_call_response',
            id: 'call-1',
            response: '{"output":"ok"}',
          },
        ],
      },
    ]);
    expect(content.toolDefinitions).toEqual([
      {
        type: 'function',
        name: 'read',
        description: 'Read a file',
        parameters: {
          type: 'object',
          properties: { path: { type: 'string' } },
        },
      },
    ]);
  });

  it('converts OpenAI-compatible media from the final adapter request', () => {
    const content = extractOpenAiContent({
      messages: [
        {
          role: 'user',
          content: [
            {
              type: 'file',
              file: {
                filename: 'document.pdf',
                file_data: 'DATA:application/pdf;base64,cGRm',
              },
            },
            {
              type: 'file',
              file: {
                filename: 'remote.pdf',
                file_data: 'https://example.com/document.pdf',
              },
            },
            {
              type: 'input_audio',
              input_audio: {
                data: 'data:audio/wav;base64,YXVkaW8=',
                format: 'wav',
              },
            },
          ],
        },
      ],
    });

    expect(content.inputMessages).toEqual([
      {
        role: 'user',
        parts: [
          {
            type: 'blob',
            mime_type: 'application/pdf',
            modality: 'document',
            content: 'cGRm',
          },
          {
            type: 'uri',
            mime_type: null,
            modality: 'document',
            uri: 'https://example.com/document.pdf',
          },
          {
            type: 'blob',
            mime_type: 'audio/wav',
            modality: 'audio',
            content: 'YXVkaW8=',
          },
        ],
      },
    ]);
  });

  it('rejects incomplete message snapshots and preserves generic parts', () => {
    expect(
      extractOpenAiContent({
        messages: [
          { role: 'user', content: 'ok' },
          { content: 'missing role' },
        ],
      }).inputMessages,
    ).toBeUndefined();
    expect(
      extractOpenAiContent({
        messages: [
          {
            role: 'user',
            content: [{ type: 'provider_extension', value: 1 }],
          },
        ],
      }).inputMessages,
    ).toEqual([
      {
        role: 'user',
        parts: [{ type: 'provider_extension', value: 1 }],
      },
    ]);
    expect(
      extractOpenAiContent({
        messages: [{ role: 'assistant', content: null }],
      }).inputMessages,
    ).toEqual([{ role: 'assistant', parts: [] }]);
    expect(
      extractOpenAiContent({
        messages: [{ role: 'user', content: [null] }],
      }).inputMessages,
    ).toBeUndefined();
  });
});

describe('GenAI JSON writer', () => {
  it('preserves empty arrays and objects at the exact limit', () => {
    expect(stringifyGenAiJson([], 2)).toBe('[]');
    expect(stringifyGenAiJson({}, 2, true)).toBe('{}');
  });

  it('omits oversized, invalid-root, and cyclic values', () => {
    expect(stringifyGenAiJson({ value: 1 }, 3)).toBeUndefined();
    expect(stringifyGenAiJson([], 100, true)).toBeUndefined();
    const cyclic: Record<string, unknown> = {};
    cyclic['self'] = cyclic;
    expect(stringifyGenAiJson(cyclic, 100)).toBeUndefined();
  });

  it('preserves JSON keys that overlap object prototype accessors', () => {
    const value = JSON.parse(
      '{"__proto__":{"polluted":true},"constructor":"value"}',
    ) as unknown;

    expect(stringifyGenAiJson(value, 1_000)).toBe(
      '{"__proto__":{"polluted":true},"constructor":"value"}',
    );
    expect(
      (Object.prototype as unknown as Record<string, unknown>)['polluted'],
    ).toBeUndefined();
  });

  it('uses nested toJSON values instead of fabricating empty objects', () => {
    expect(
      stringifyGenAiJson(
        {
          timestamp: new Date('2026-07-24T00:00:00.000Z'),
          custom: { toJSON: () => ({ value: 1 }) },
        },
        1_000,
      ),
    ).toBe('{"timestamp":"2026-07-24T00:00:00.000Z","custom":{"value":1}}');
  });
});

describe('GenAI output accumulation', () => {
  it('collects all non-streaming OpenAI choices in index order', () => {
    const output = new GenAiOutputAccumulator(true, 10_000);
    output.recordOpenAiResponse({
      choices: [
        {
          index: 1,
          message: { role: 'assistant', content: 'B' },
          finish_reason: 'length',
        },
        {
          index: 0,
          message: { role: 'assistant', content: 'A' },
          finish_reason: 'stop',
        },
      ],
    });

    expect(JSON.parse(output.finalize(true)!)).toEqual([
      {
        role: 'assistant',
        parts: [{ type: 'text', content: 'A' }],
        finish_reason: 'stop',
      },
      {
        role: 'assistant',
        parts: [{ type: 'text', content: 'B' }],
        finish_reason: 'length',
      },
    ]);
  });

  it('collects all OpenAI choices in index order', () => {
    const output = new GenAiOutputAccumulator(true, 10_000);
    output.recordOpenAiChunk({
      choices: [
        { index: 1, delta: { content: 'B' }, finish_reason: null },
        {
          index: 0,
          delta: { reasoning_content: 'R', content: 'A' },
          finish_reason: null,
        },
      ],
    });
    output.recordOpenAiChunk({
      choices: [
        { index: 1, delta: {}, finish_reason: 'length' },
        { index: 0, delta: {}, finish_reason: 'stop' },
      ],
    });

    expect(output.finishReasons).toEqual(['stop', 'length']);
    expect(JSON.parse(output.finalize(true)!)).toEqual([
      {
        role: 'assistant',
        parts: [
          { type: 'reasoning', content: 'R' },
          { type: 'text', content: 'A' },
        ],
        finish_reason: 'stop',
      },
      {
        role: 'assistant',
        parts: [{ type: 'text', content: 'B' }],
        finish_reason: 'length',
      },
    ]);
  });

  it('merges fragmented tool-call arguments', () => {
    const output = new GenAiOutputAccumulator(true, 10_000);
    output.recordOpenAiChunk({
      choices: [
        {
          index: 0,
          delta: {
            tool_calls: [
              {
                index: 0,
                id: 'call-1',
                function: { name: 'read', arguments: '{"path":' },
              },
            ],
          },
        },
      ],
    });
    output.recordOpenAiChunk({
      choices: [
        {
          index: 0,
          delta: {
            tool_calls: [{ index: 0, function: { arguments: '"a"}' } }],
          },
          finish_reason: 'tool_calls',
        },
      ],
    });
    expect(JSON.parse(output.finalize(true)!)[0].parts).toEqual([
      {
        type: 'tool_call',
        id: 'call-1',
        name: 'read',
        arguments: { path: 'a' },
      },
    ]);
  });

  it('does not invent missing tool-call arguments', () => {
    const output = new GenAiOutputAccumulator(true, 10_000);
    output.recordOpenAiResponse({
      choices: [
        {
          index: 0,
          message: {
            role: 'assistant',
            tool_calls: [
              {
                id: 'call-1',
                type: 'function',
                function: { name: 'read' },
              },
            ],
          },
          finish_reason: 'tool_calls',
        },
      ],
    });

    expect(JSON.parse(output.finalize(true)!)[0].parts).toEqual([
      {
        type: 'tool_call',
        id: 'call-1',
        name: 'read',
      },
    ]);
  });

  it('uses error for unfinished candidates only on failure', () => {
    const failed = new GenAiOutputAccumulator(true, 10_000);
    failed.recordOpenAiResponse({
      choices: [{ index: 0, message: { role: 'assistant', content: 'a' } }],
    });
    expect(JSON.parse(failed.finalize(false)!)[0].finish_reason).toBe('error');
    expect(failed.finishReasons).toEqual(['error']);

    const successful = new GenAiOutputAccumulator(true, 10_000);
    successful.recordOpenAiResponse({
      choices: [{ index: 0, message: { role: 'assistant', content: 'a' } }],
    });
    expect(successful.finalize(true)).toBeUndefined();
  });

  it('tracks non-streaming candidate failures when content capture is off', () => {
    const responses: Array<
      [GenAiOutputAccumulator, (accumulator: GenAiOutputAccumulator) => void]
    > = [
      [
        new GenAiOutputAccumulator(false, 10_000),
        (accumulator) =>
          accumulator.recordOpenAiResponse({
            choices: [
              { index: 0, message: { role: 'assistant', content: '' } },
            ],
          }),
      ],
    ];

    for (const [accumulator, recordResponse] of responses) {
      recordResponse(accumulator);
      expect(accumulator.finalize(false)).toBeUndefined();
      expect(accumulator.finishReasons).toEqual(['error']);
    }
  });

  it('preserves explicit zero candidates and drops overflowed content', () => {
    const empty = new GenAiOutputAccumulator(true, 10);
    empty.recordOpenAiResponse({ choices: [] });
    expect(empty.finalize(true)).toBe('[]');

    const tooSmallForEmpty = new GenAiOutputAccumulator(true, 1);
    tooSmallForEmpty.recordOpenAiResponse({ choices: [] });
    expect(tooSmallForEmpty.finalize(true)).toBeUndefined();

    const overflow = new GenAiOutputAccumulator(true, 20);
    overflow.recordOpenAiChunk({
      choices: [
        {
          index: 0,
          delta: { content: 'too much content' },
          finish_reason: 'stop',
        },
      ],
    });
    expect(overflow.finishReasons).toEqual(['stop']);
    expect(overflow.finalize(true)).toBeUndefined();
  });

  it('omits an incomplete full snapshot instead of dropping invalid choices', () => {
    const output = new GenAiOutputAccumulator(true, 10_000);
    output.recordOpenAiResponse({
      choices: [
        {
          index: 0,
          message: { role: 'assistant', content: 'valid' },
          finish_reason: 'stop',
        },
        null,
      ],
    });
    expect(output.finalize(true)).toBeUndefined();

    const missing = new GenAiOutputAccumulator(true, 10_000);
    missing.recordOpenAiResponse({});
    expect(missing.finalize(false)).toBeUndefined();
  });

  it('budgets many small fragments by final content rather than chunk count', () => {
    const expected = new GenAiOutputAccumulator(true, 10_000);
    for (let index = 0; index < 100; index++) {
      expected.recordOpenAiChunk({
        choices: [{ index: 0, delta: { content: 'a' } }],
      });
    }
    expected.recordOpenAiChunk({
      choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
    });
    const serialized = expected.finalize(true)!;

    const exact = new GenAiOutputAccumulator(true, serialized.length);
    const oversized = new GenAiOutputAccumulator(true, serialized.length - 1);
    for (let index = 0; index < 100; index++) {
      const chunk = { choices: [{ index: 0, delta: { content: 'a' } }] };
      exact.recordOpenAiChunk(chunk);
      oversized.recordOpenAiChunk(chunk);
    }
    const finish = {
      choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
    };
    exact.recordOpenAiChunk(finish);
    oversized.recordOpenAiChunk(finish);

    expect(exact.finalize(true)).toBe(serialized);
    expect(oversized.finalize(true)).toBeUndefined();
  });
});

describe('pinned OpenTelemetry JSON Schemas', () => {
  it('accepts the canonical values emitted by the converters', () => {
    const ajv = new Ajv({ strict: false });
    const input = extractOpenAiContent({
      messages: [{ role: 'user', content: 'hello' }],
    }).inputMessages;
    const tools = extractOpenAiContent({
      tools: [
        {
          type: 'function',
          function: {
            name: 'read',
            parameters: { type: 'object' },
          },
        },
      ],
    }).toolDefinitions;
    const accumulator = new GenAiOutputAccumulator(true, 10_000);
    accumulator.recordOpenAiResponse({
      choices: [
        {
          index: 0,
          message: { role: 'assistant', content: 'answer' },
          finish_reason: 'stop',
        },
      ],
    });
    const output = JSON.parse(accumulator.finalize(true)!);

    const cases: Array<[string, unknown]> = [
      ['gen-ai-input-messages.json', input],
      ['gen-ai-output-messages.json', output],
      ['gen-ai-tool-definitions.json', tools],
      ['gen-ai-tool-call-arguments.json', { path: 'a' }],
      ['gen-ai-tool-call-result.json', { output: 'ok' }],
    ];
    for (const [name, value] of cases) {
      const validate = ajv.compile(fixture(name));
      const valid = validate(value);
      if (!valid) {
        throw new Error(`${name}: ${JSON.stringify(validate.errors)}`);
      }
      expect(valid).toBe(true);
    }
  });
});
