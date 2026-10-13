/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type {
  GenerateContentParameters,
  GenerateContentResponse,
} from '@google/genai';
import { describe, expect, it, vi } from 'vitest';
import type {
  ContentGenerator,
  ContentGeneratorConfig,
} from '../core/contentGenerator.js';
import { LocalModelContentGenerator } from './local-model-content-generator.js';
import type { LocalModelServer } from './local-model-server.js';
import { LOCAL_MODEL_BASE_URL } from './local-models.js';

const config = {
  model: 'q-main',
  baseUrl: LOCAL_MODEL_BASE_URL,
  apiKey: 'local',
} as ContentGeneratorConfig;

function setup(baseUrls: string[]) {
  const released: string[] = [];
  const acquired: string[] = [];
  const server = {
    acquire: vi.fn(async (modelId: string) => {
      acquired.push(modelId);
      const baseUrl = baseUrls[acquired.length - 1];
      return {
        baseUrl,
        apiKey: 'real-key',
        release: () => released.push(modelId),
      };
    }),
  } as unknown as LocalModelServer;
  const created: ContentGeneratorConfig[] = [];
  let failNext = false;
  const create = (generatorConfig: ContentGeneratorConfig) => {
    created.push(generatorConfig);
    return {
      async generateContent() {
        if (failNext) throw new Error('engine said no');
        return { text: 'ok' } as unknown as GenerateContentResponse;
      },
      async generateContentStream() {
        return (async function* () {
          yield { text: 'a' } as unknown as GenerateContentResponse;
          yield { text: 'b' } as unknown as GenerateContentResponse;
        })();
      },
    } satisfies ContentGenerator;
  };
  const generator = new LocalModelContentGenerator(config, server, create);
  return {
    generator,
    acquired,
    released,
    created,
    failNext: () => (failNext = true),
  };
}

const request = (model?: string) =>
  ({ model, contents: [] }) as unknown as GenerateContentParameters;

describe('LocalModelContentGenerator', () => {
  it('sends the request to the engine address with the engine key, then releases its lease', async () => {
    const t = setup(['http://127.0.0.1:5000/v1']);
    await t.generator.generateContent(request(), 'p');
    expect(t.acquired).toEqual(['q-main']);
    expect(t.created).toEqual([
      { ...config, baseUrl: 'http://127.0.0.1:5000/v1', apiKey: 'real-key' },
    ]);
    expect(t.released).toEqual(['q-main']);
  });

  it('leases the model the request names', async () => {
    const t = setup(['http://127.0.0.1:5000/v1']);
    await t.generator.generateContent(request('q-side'), 'p');
    expect(t.acquired).toEqual(['q-side']);
  });

  it('holds the lease until the stream ends', async () => {
    const t = setup(['http://127.0.0.1:5000/v1']);
    const stream = await t.generator.generateContentStream(request(), 'p');
    expect(t.released).toEqual([]);
    const texts: unknown[] = [];
    for await (const chunk of stream) texts.push(chunk.text);
    expect(texts).toEqual(['a', 'b']);
    expect(t.released).toEqual(['q-main']);
  });

  it('releases the lease when the request fails', async () => {
    const t = setup(['http://127.0.0.1:5000/v1']);
    t.failNext();
    await expect(t.generator.generateContent(request(), 'p')).rejects.toThrow(
      'engine said no',
    );
    expect(t.released).toEqual(['q-main']);
  });

  it('reuses the client until the engine moves to another port', async () => {
    const t = setup([
      'http://127.0.0.1:5000/v1',
      'http://127.0.0.1:5000/v1',
      'http://127.0.0.1:6000/v1',
    ]);
    for (let i = 0; i < 3; i++) {
      await t.generator.generateContent(request(), 'p');
    }
    expect(t.created.map((c) => c.baseUrl)).toEqual([
      'http://127.0.0.1:5000/v1',
      'http://127.0.0.1:6000/v1',
    ]);
  });
});
