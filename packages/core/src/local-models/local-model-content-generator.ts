/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type {
  GenerateContentParameters,
  GenerateContentResponse,
} from '@google/genai';
import type {
  ContentGenerator,
  ContentGeneratorConfig,
} from '../core/contentGenerator.js';
import type {
  LocalModelLease,
  LocalModelServer,
} from './local-model-server.js';
import { CONVERSATION_SLOT, SIDE_QUERY_SLOT } from './engine.js';

/** Main-session prompt ids are `<session>########<n>`; side queries differ. */
const isMainTurn = (userPromptId: string) => userPromptId.includes('########');

/**
 * Sends each request to the engine serving its model. Every call holds a
 * lease for its whole duration (until a stream ends), so the server never
 * swaps the model under a running request.
 *
 * A main-session stream that ends with an answer rather than a tool call
 * ends the conversation turn; its lease asks the server to save the prompt.
 */
export class LocalModelContentGenerator implements ContentGenerator {
  private readonly generators = new Map<string, ContentGenerator>();

  constructor(
    private readonly generatorConfig: ContentGeneratorConfig,
    private readonly server: LocalModelServer,
    private readonly create: (
      config: ContentGeneratorConfig,
    ) => ContentGenerator,
  ) {}

  /** One generator per engine and slot; a new engine replaces them all. */
  private generatorFor(
    lease: LocalModelLease,
    userPromptId: string,
  ): ContentGenerator {
    const { baseUrl, apiKey } = lease;
    const slot = lease.pinSlots
      ? isMainTurn(userPromptId)
        ? CONVERSATION_SLOT
        : SIDE_QUERY_SLOT
      : undefined;
    const engineKey = `${baseUrl}\0${apiKey}`;
    const key = `${engineKey}\0${slot ?? ''}`;
    let generator = this.generators.get(key);
    if (!generator) {
      for (const existing of this.generators.keys()) {
        if (!existing.startsWith(engineKey + '\0'))
          this.generators.delete(existing);
      }
      generator = this.create({
        ...this.generatorConfig,
        baseUrl,
        apiKey,
        ...(slot === undefined
          ? {}
          : {
              extra_body: { ...this.generatorConfig.extra_body, id_slot: slot },
            }),
      });
      this.generators.set(key, generator);
    }
    return generator;
  }

  private acquire(request: GenerateContentParameters) {
    return this.server.acquire(
      request.model || this.generatorConfig.model,
      request.config?.abortSignal,
    );
  }

  async generateContent(
    request: GenerateContentParameters,
    userPromptId: string,
  ): Promise<GenerateContentResponse> {
    const lease = await this.acquire(request);
    try {
      return await this.generatorFor(lease, userPromptId).generateContent(
        request,
        userPromptId,
      );
    } finally {
      lease.release();
    }
  }

  async generateContentStream(
    request: GenerateContentParameters,
    userPromptId: string,
  ): Promise<AsyncGenerator<GenerateContentResponse>> {
    const lease = await this.acquire(request);
    let stream: AsyncGenerator<GenerateContentResponse>;
    try {
      stream = await this.generatorFor(
        lease,
        userPromptId,
      ).generateContentStream(request, userPromptId);
    } catch (error) {
      lease.release();
      throw error;
    }
    const mainTurn = isMainTurn(userPromptId);
    return (async function* () {
      let completed = false;
      let calledTool = false;
      try {
        for await (const chunk of stream) {
          if (
            chunk.candidates?.some((candidate) =>
              candidate.content?.parts?.some((part) => part.functionCall),
            )
          ) {
            calledTool = true;
          }
          yield chunk;
        }
        completed = true;
      } finally {
        lease.release({ saveState: mainTurn && completed && !calledTool });
      }
    })();
  }
}
