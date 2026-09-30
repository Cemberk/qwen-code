/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type {
  Candidate,
  Content,
  FinishReason as GenAiFinishReason,
  FunctionCall,
  FunctionCallingConfigMode as GenAiFunctionCallingConfigMode,
  GenerateContentResponse as GenAiGenerateContentResponse,
  Part,
  PartListUnion,
} from '@google/genai';

export type FinishReason = GenAiFinishReason;
// Local runtime values keep the @google/genai SDK type-only.
export const FinishReason = {
  FINISH_REASON_UNSPECIFIED: 'FINISH_REASON_UNSPECIFIED' as GenAiFinishReason,
  STOP: 'STOP' as GenAiFinishReason,
  MAX_TOKENS: 'MAX_TOKENS' as GenAiFinishReason,
  NO_IMAGE: 'NO_IMAGE' as GenAiFinishReason,
  // Content-filter family (mirrors mapLlmFinishReasonToOpenAI's
  // 'content_filter' grouping) — the quiet-completion gate in llmChat
  // must keep all of these fatal.
  SAFETY: 'SAFETY' as GenAiFinishReason,
  RECITATION: 'RECITATION' as GenAiFinishReason,
  BLOCKLIST: 'BLOCKLIST' as GenAiFinishReason,
  PROHIBITED_CONTENT: 'PROHIBITED_CONTENT' as GenAiFinishReason,
  SPII: 'SPII' as GenAiFinishReason,
  IMAGE_SAFETY: 'IMAGE_SAFETY' as GenAiFinishReason,
  IMAGE_RECITATION: 'IMAGE_RECITATION' as GenAiFinishReason,
  IMAGE_PROHIBITED_CONTENT: 'IMAGE_PROHIBITED_CONTENT' as GenAiFinishReason,
  IMAGE_OTHER: 'IMAGE_OTHER' as GenAiFinishReason,
} as const;

export type FunctionCallingConfigMode = GenAiFunctionCallingConfigMode;
export const FunctionCallingConfigMode = {
  ANY: 'ANY' as GenAiFunctionCallingConfigMode,
} as const;

// Stands in for the SDK's response class so the SDK stays type-only. The
// getters follow @google/genai 2.6.0 without its console warnings.
export class GenerateContentResponse implements GenAiGenerateContentResponse {
  declare sdkHttpResponse?: GenAiGenerateContentResponse['sdkHttpResponse'];
  declare candidates?: Candidate[];
  declare createTime?: string;
  declare automaticFunctionCallingHistory?: Content[];
  declare modelVersion?: string;
  declare promptFeedback?: GenAiGenerateContentResponse['promptFeedback'];
  declare responseId?: string;
  declare usageMetadata?: GenAiGenerateContentResponse['usageMetadata'];
  declare modelStatus?: GenAiGenerateContentResponse['modelStatus'];

  get text(): string | undefined {
    let text: string | undefined;
    for (const part of this.candidates?.[0]?.content?.parts ?? []) {
      if (typeof part.text === 'string' && part.thought !== true) {
        text = (text ?? '') + part.text;
      }
    }
    return text;
  }

  get data(): string | undefined {
    let data = '';
    for (const part of this.candidates?.[0]?.content?.parts ?? []) {
      if (typeof part.inlineData?.data === 'string') {
        data += atob(part.inlineData.data);
      }
    }
    return data.length > 0 ? btoa(data) : undefined;
  }

  get functionCalls(): FunctionCall[] | undefined {
    const functionCalls = (this.candidates?.[0]?.content?.parts ?? []).flatMap(
      (part) => (part.functionCall ? [part.functionCall] : []),
    );
    return functionCalls.length > 0 ? functionCalls : undefined;
  }

  get executableCode(): string | undefined {
    return this.candidates?.[0]?.content?.parts?.find(
      (part) => part.executableCode,
    )?.executableCode?.code;
  }

  get codeExecutionResult(): string | undefined {
    return this.candidates?.[0]?.content?.parts?.find(
      (part) => part.codeExecutionResult,
    )?.codeExecutionResult?.output;
  }
}

// Content conversion is adapted from @google/genai 2.6.0's `_isPart` and
// `_toParts` helpers (Copyright 2025 Google LLC, Apache-2.0); re-check parity
// on SDK upgrades.
function isPart(value: unknown): value is Part {
  return (
    typeof value === 'object' &&
    value !== null &&
    ('fileData' in value ||
      'text' in value ||
      'functionCall' in value ||
      'functionResponse' in value ||
      'inlineData' in value ||
      'videoMetadata' in value ||
      'codeExecutionResult' in value ||
      'executableCode' in value)
  );
}

function toParts(partOrString: PartListUnion): Part[] {
  if (typeof partOrString === 'string') {
    return [{ text: partOrString }];
  }

  if (isPart(partOrString)) {
    return [partOrString];
  }

  if (!Array.isArray(partOrString)) {
    throw new Error('partOrString must be a Part object, string, or array');
  }

  if (partOrString.length === 0) {
    throw new Error('partOrString cannot be an empty array');
  }

  return partOrString.map((part) => {
    if (typeof part === 'string') {
      return { text: part };
    }
    if (isPart(part)) {
      return part;
    }
    throw new Error('element in PartUnion must be a Part object or string');
  });
}

function createContent(role: 'user' | 'model', value: PartListUnion): Content {
  return { role, parts: toParts(value) };
}

export function createUserContent(value: PartListUnion): Content {
  return createContent('user', value);
}

export function createModelContent(value: PartListUnion): Content {
  return createContent('model', value);
}
