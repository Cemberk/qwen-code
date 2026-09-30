/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import {
  createModelContent as createSdkModelContent,
  createUserContent as createSdkUserContent,
  FinishReason as SdkFinishReason,
  FunctionCallingConfigMode as SdkFunctionCallingConfigMode,
  GenerateContentResponse as SdkGenerateContentResponse,
  type Part,
} from '@google/genai';
import {
  createModelContent,
  createUserContent,
  FinishReason,
  FunctionCallingConfigMode,
  GenerateContentResponse,
} from './genai-compat.js';

describe('genai compatibility values', () => {
  it('matches the SDK values used by core orchestration', () => {
    expect(FinishReason).toEqual({
      FINISH_REASON_UNSPECIFIED: SdkFinishReason.FINISH_REASON_UNSPECIFIED,
      STOP: SdkFinishReason.STOP,
      MAX_TOKENS: SdkFinishReason.MAX_TOKENS,
      NO_IMAGE: SdkFinishReason.NO_IMAGE,
      // Content-filter family the quiet-completion gate keeps fatal.
      SAFETY: SdkFinishReason.SAFETY,
      RECITATION: SdkFinishReason.RECITATION,
      BLOCKLIST: SdkFinishReason.BLOCKLIST,
      PROHIBITED_CONTENT: SdkFinishReason.PROHIBITED_CONTENT,
      SPII: SdkFinishReason.SPII,
      IMAGE_SAFETY: SdkFinishReason.IMAGE_SAFETY,
      IMAGE_RECITATION: SdkFinishReason.IMAGE_RECITATION,
      IMAGE_PROHIBITED_CONTENT: SdkFinishReason.IMAGE_PROHIBITED_CONTENT,
      IMAGE_OTHER: SdkFinishReason.IMAGE_OTHER,
    });
    expect(FunctionCallingConfigMode).toEqual({
      ANY: SdkFunctionCallingConfigMode.ANY,
    });
  });

  it.each([
    'hello',
    { text: 'hello' },
    ['hello', { inlineData: { mimeType: 'text/plain', data: 'aGVsbG8=' } }],
  ])('matches SDK content conversion for %j', (value) => {
    expect(createUserContent(value)).toEqual(createSdkUserContent(value));
    expect(createModelContent(value)).toEqual(createSdkModelContent(value));
  });

  it.each([
    [[], 'partOrString cannot be an empty array'],
    [{ role: 'user', parts: [] }, 'partOrString must be a Part object'],
    [[{ invalid: true }], 'element in PartUnion must be a Part object'],
  ])('matches SDK validation for %j', (value, message) => {
    expect(() => createUserContent(value as never)).toThrow(message);
    expect(() => createSdkUserContent(value as never)).toThrow(message);
  });

  it.each<Part[] | undefined>([
    undefined,
    [],
    [{ text: 'a' }, { text: 'hidden', thought: true }, { text: 'b' }],
    [
      { functionCall: { name: 'first', args: { x: 1 } } },
      { text: 'between' },
      { functionCall: { name: 'second' } },
    ],
    [
      { inlineData: { mimeType: 'text/plain', data: 'aGVs' } },
      { inlineData: { mimeType: 'text/plain', data: 'bG8=' } },
    ],
    [
      { executableCode: { code: 'print(1)' } },
      { codeExecutionResult: { output: '1' } },
    ],
  ])('matches SDK response getters for parts %j', (parts) => {
    const local = new GenerateContentResponse();
    const sdk = new SdkGenerateContentResponse();
    if (parts) {
      local.candidates = [{ content: { role: 'model', parts } }];
      sdk.candidates = [{ content: { role: 'model', parts } }];
    }
    expect(local.text).toEqual(sdk.text);
    expect(local.data).toEqual(sdk.data);
    expect(local.functionCalls).toEqual(sdk.functionCalls);
    expect(local.executableCode).toEqual(sdk.executableCode);
    expect(local.codeExecutionResult).toEqual(sdk.codeExecutionResult);
  });
});
