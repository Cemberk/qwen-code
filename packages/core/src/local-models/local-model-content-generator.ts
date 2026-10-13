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

/**
 * Sends each request to the engine serving its model. Every call holds a
 * lease for its whole duration (until a stream ends), so the server never
 * swaps the model under a running request.
 */
export class LocalModelContentGenerator implements ContentGenerator {
  private current?: { key: string; generator: ContentGenerator };

  constructor(
    private readonly generatorConfig: ContentGeneratorConfig,
    private readonly server: LocalModelServer,
    private readonly create: (
      config: ContentGeneratorConfig,
    ) => ContentGenerator,
  ) {}

  private generatorFor(lease: LocalModelLease): ContentGenerator {
    const { baseUrl, apiKey } = lease;
    const key = `${baseUrl}\0${apiKey}`;
    if (this.current?.key !== key) {
      this.current = {
        key,
        generator: this.create({ ...this.generatorConfig, baseUrl, apiKey }),
      };
    }
    return this.current.generator;
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
      return await this.generatorFor(lease).generateContent(
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
      stream = await this.generatorFor(lease).generateContentStream(
        request,
        userPromptId,
      );
    } catch (error) {
      lease.release();
      throw error;
    }
    return (async function* () {
      try {
        yield* stream;
      } finally {
        lease.release();
      }
    })();
  }
}
