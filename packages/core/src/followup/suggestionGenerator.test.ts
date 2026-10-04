/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { Content } from '@google/genai';
import { beforeEach, describe, it, expect, vi } from 'vitest';
import type { Config } from '../config/config.js';

const {
  mockGetCacheSafeParams,
  mockGetCacheSafeParamsSessionId,
  mockRunForkedAgent,
  mockRunSideQuery,
} = vi.hoisted(() => ({
  mockGetCacheSafeParams: vi.fn(),
  mockGetCacheSafeParamsSessionId: vi.fn(),
  mockRunForkedAgent: vi.fn(),
  mockRunSideQuery: vi.fn(),
}));

vi.mock('../utils/sideQuery.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../utils/sideQuery.js')>();
  return {
    ...actual,
    runSideQuery: mockRunSideQuery,
  };
});

vi.mock('../agents/forkedAgent.js', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('../agents/forkedAgent.js')>();
  return {
    ...actual,
    getCacheSafeParams: mockGetCacheSafeParams,
    getCacheSafeParamsSessionId: mockGetCacheSafeParamsSessionId,
    runForkedAgent: mockRunForkedAgent,
  };
});

import { generatePromptSuggestion } from './suggestionGenerator.js';

const conversationHistory: Content[] = [
  { role: 'user', parts: [{ text: 'fix this' }] },
  { role: 'model', parts: [{ text: 'I fixed it.' }] },
  { role: 'user', parts: [{ text: 'anything else?' }] },
  { role: 'model', parts: [{ text: 'You could run tests.' }] },
];

describe('generatePromptSuggestion', () => {
  beforeEach(() => {
    mockGetCacheSafeParams.mockReset();
    mockGetCacheSafeParamsSessionId.mockReset();
    mockGetCacheSafeParamsSessionId.mockReturnValue('test-session');
    mockRunForkedAgent.mockReset();
    mockRunSideQuery.mockReset();
  });

  it('passes cache-safe model in cache mode when no explicit or fast model exists', async () => {
    mockGetCacheSafeParams.mockReturnValue({
      generationConfig: {},
      history: conversationHistory,
      model: 'main-model',
      version: 1,
      sessionId: 'test-session',
    });
    mockRunForkedAgent.mockResolvedValue({
      text: null,
      jsonResult: { suggestion: 'run tests' },
      usage: { inputTokens: 10, outputTokens: 3, cacheHitTokens: 5 },
    });
    const config = {
      getFastModel: vi.fn(() => undefined),
      getModel: vi.fn(() => 'main-model'),
      getSessionId: vi.fn(() => 'test-session'),
    } as unknown as Config;

    const signal = new AbortController().signal;
    await generatePromptSuggestion(config, conversationHistory, signal, {
      enableCacheSharing: true,
    });

    expect(mockGetCacheSafeParams).toHaveBeenCalledWith('test-session');
    expect(mockRunForkedAgent).toHaveBeenCalledWith(
      expect.objectContaining({ model: 'main-model', abortSignal: signal }),
    );
  });

  it('passes the fast model in cache mode when one is configured', async () => {
    mockGetCacheSafeParams.mockReturnValue({
      generationConfig: {},
      history: conversationHistory,
      model: 'main-model',
      version: 1,
      sessionId: 'test-session',
    });
    mockRunForkedAgent.mockResolvedValue({
      text: null,
      jsonResult: { suggestion: 'run tests' },
      usage: { inputTokens: 10, outputTokens: 3, cacheHitTokens: 5 },
    });
    const config = {
      getFastModel: vi.fn(() => 'openai:fast-model'),
      getModel: vi.fn(() => 'main-model'),
      getSessionId: vi.fn(() => 'test-session'),
    } as unknown as Config;

    await generatePromptSuggestion(
      config,
      conversationHistory,
      new AbortController().signal,
      { enableCacheSharing: true },
    );

    expect(mockRunForkedAgent).toHaveBeenCalledWith(
      expect.objectContaining({ model: 'openai:fast-model' }),
    );
  });
  it('passes preserveTools: true for Anthropic prompt-cache sharing', async () => {
    mockGetCacheSafeParams.mockReturnValue({
      generationConfig: {},
      history: conversationHistory,
      model: 'main-model',
      version: 1,
      sessionId: 'test-session',
    });
    mockRunForkedAgent.mockResolvedValue({
      text: null,
      jsonResult: { suggestion: 'run tests' },
      usage: { inputTokens: 10, outputTokens: 3, cacheHitTokens: 5 },
    });
    const config = {
      getFastModel: vi.fn(() => undefined),
      getModel: vi.fn(() => 'main-model'),
      getSessionId: vi.fn(() => 'test-session'),
    } as unknown as Config;

    await generatePromptSuggestion(
      config,
      conversationHistory,
      new AbortController().signal,
      { enableCacheSharing: true },
    );

    expect(mockRunForkedAgent).toHaveBeenCalledWith(
      expect.objectContaining({ preserveTools: true }),
    );
  });

  it('falls back to the base LLM when the cache-safe slot belongs to another session', async () => {
    // The cache-safe slot is a process-global: in a multi-session daemon it
    // can hold ANOTHER session's transcript + systemInstruction. The
    // suggestion must NOT fork from a foreign session's params (cross-session
    // content leak) — it falls back to the session-safe base-LLM path
    // (#9233).
    mockGetCacheSafeParamsSessionId.mockReturnValue('session-B');
    mockRunSideQuery.mockResolvedValue({
      text: '{"suggestion":"from base llm"}',
      usage: { inputTokens: 1, outputTokens: 1 },
    });
    const config = {
      getFastModel: vi.fn(() => undefined),
      getModel: vi.fn(() => 'main-model'),
      getSessionId: vi.fn(() => 'session-A'), // this session is different
    } as unknown as Config;

    const result = await generatePromptSuggestion(
      config,
      conversationHistory,
      new AbortController().signal,
      { enableCacheSharing: true },
    );

    // The cache API rejects the foreign slot before cloning its payload.
    expect(mockGetCacheSafeParams).toHaveBeenCalledWith('session-A');
    // The fork must NOT be used for a foreign session's params.
    expect(mockRunForkedAgent).not.toHaveBeenCalled();
    // The session-safe base-LLM path is used instead.
    expect(mockRunSideQuery).toHaveBeenCalled();
    expect(result.suggestion).toBe('from base llm');
  });

  it('does not use the cache-safe fork when cache sharing is disabled', async () => {
    mockGetCacheSafeParams.mockReturnValue({
      generationConfig: {},
      history: conversationHistory,
      model: 'main-model',
      version: 1,
      sessionId: 'test-session',
    });
    mockRunSideQuery.mockResolvedValue({
      text: '{"suggestion":"from base llm"}',
      usage: { inputTokens: 1, outputTokens: 1 },
    });
    const config = {
      getFastModel: vi.fn(() => undefined),
      getModel: vi.fn(() => 'main-model'),
      getSessionId: vi.fn(() => 'test-session'),
    } as unknown as Config;

    const result = await generatePromptSuggestion(
      config,
      conversationHistory,
      new AbortController().signal,
      { enableCacheSharing: false },
    );

    expect(mockGetCacheSafeParamsSessionId).not.toHaveBeenCalled();
    expect(mockGetCacheSafeParams).not.toHaveBeenCalled();
    expect(mockRunForkedAgent).not.toHaveBeenCalled();
    expect(mockRunSideQuery).toHaveBeenCalled();
    expect(result.suggestion).toBe('from base llm');
  });

  it('passes preserveTools: false when fast model differs from cache-safe model', async () => {
    mockGetCacheSafeParams.mockReturnValue({
      generationConfig: {},
      history: conversationHistory,
      model: 'main-model',
      version: 1,
      sessionId: 'test-session',
    });
    mockRunForkedAgent.mockResolvedValue({
      text: null,
      jsonResult: { suggestion: 'run tests' },
      usage: { inputTokens: 10, outputTokens: 3, cacheHitTokens: 5 },
    });
    const config = {
      getFastModel: vi.fn(() => 'different-fast-model'),
      getModel: vi.fn(() => 'main-model'),
      getSessionId: vi.fn(() => 'test-session'),
    } as unknown as Config;

    await generatePromptSuggestion(
      config,
      conversationHistory,
      new AbortController().signal,
      { enableCacheSharing: true },
    );

    expect(mockRunForkedAgent).toHaveBeenCalledWith(
      expect.objectContaining({ preserveTools: false }),
    );
  });
});
