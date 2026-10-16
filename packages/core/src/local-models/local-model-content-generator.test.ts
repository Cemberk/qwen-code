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

function setup(
  baseUrls: string[],
  chunks: GenerateContentResponse[] = [
    { text: 'a' } as unknown as GenerateContentResponse,
    { text: 'b' } as unknown as GenerateContentResponse,
  ],
  pinSlots = false,
) {
  const released: string[] = [];
  const saves: boolean[] = [];
  const acquired: string[] = [];
  const server = {
    acquire: vi.fn(async (modelId: string) => {
      acquired.push(modelId);
      const baseUrl = baseUrls[acquired.length - 1];
      return {
        baseUrl,
        apiKey: 'real-key',
        pinSlots,
        release: (options?: { saveState?: boolean }) => {
          released.push(modelId);
          saves.push(options?.saveState === true);
        },
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
          yield* chunks;
        })();
      },
    } satisfies ContentGenerator;
  };
  const generator = new LocalModelContentGenerator(config, server, create);
  return {
    generator,
    acquired,
    released,
    saves,
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

  describe('end of a conversation turn', () => {
    const drain = async (stream: AsyncGenerator<GenerateContentResponse>) => {
      for await (const _chunk of stream) {
        // consume
      }
    };
    const toolCall = {
      candidates: [
        { content: { parts: [{ functionCall: { name: 'read_file' } }] } },
      ],
    } as unknown as GenerateContentResponse;

    it('asks for the prompt to be saved after a main-session answer', async () => {
      const t = setup(['http://127.0.0.1:5000/v1']);
      await drain(
        await t.generator.generateContentStream(request(), 's1########3'),
      );
      expect(t.saves).toEqual([true]);
    });

    it('does not after a tool call, a side query or an interrupted stream', async () => {
      const t = setup(Array(3).fill('http://127.0.0.1:5000/v1'), [toolCall]);
      await drain(
        await t.generator.generateContentStream(request(), 's1########4'),
      );
      const side = setup(['http://127.0.0.1:5000/v1']);
      await drain(
        await side.generator.generateContentStream(
          request(),
          's1#managed-auto-memory-extractor-1#0',
        ),
      );
      const cut = setup(['http://127.0.0.1:5000/v1']);
      const stream = await cut.generator.generateContentStream(
        request(),
        's1########5',
      );
      await stream.next();
      await stream.return(undefined);
      expect([...t.saves, ...side.saves, ...cut.saves]).toEqual([
        false,
        false,
        false,
      ]);
    });
  });

  it('runs conversation turns in slot 0 and side queries in slot 1 when the engine caches prompts', async () => {
    const url = 'http://127.0.0.1:5000/v1';
    const t = setup([url, url, url], undefined, true);
    await t.generator.generateContent(request(), 's1########1');
    await t.generator.generateContent(request(), 's1#memory#0');
    await t.generator.generateContent(request(), 's1########2');
    expect(t.created.map((c) => c.extra_body)).toEqual([
      { id_slot: 0 },
      { id_slot: 1 },
    ]);
    const plain = setup([url]);
    await plain.generator.generateContent(request(), 's1########1');
    expect(plain.created[0].extra_body).toBeUndefined();
  });
});
