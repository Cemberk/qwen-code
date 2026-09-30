import type { GenerateContentConfig } from '@google/genai';
import type OpenAI from 'openai';
import type { OpenAIResponseParsingOptions } from '../responseParsingOptions.js';

export interface OpenAICompatibleProvider {
  buildHeaders(): Record<string, string | undefined>;
  buildClient(): OpenAI;
  buildRequest(
    request: OpenAI.Chat.ChatCompletionCreateParams,
    userPromptId: string,
  ): OpenAI.Chat.ChatCompletionCreateParams;
  getDefaultGenerationConfig(): GenerateContentConfig;
  getResponseParsingOptions?(model?: string): OpenAIResponseParsingOptions;
}
