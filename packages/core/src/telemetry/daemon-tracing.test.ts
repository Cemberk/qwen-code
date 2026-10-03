/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  context as otelContext,
  trace,
  TraceFlags,
  type Span,
  type Tracer,
} from '@opentelemetry/api';
import { W3CTraceContextPropagator } from '@opentelemetry/core';

vi.mock('./sdk.js', () => ({
  isTelemetrySdkInitialized: () => true,
}));
import {
  DAEMON_TRACEPARENT_META_KEY,
  DAEMON_TRACESTATE_META_KEY,
  addDaemonRequestAttribute,
  extractDaemonTraceContext,
  setDaemonFallbackPropagator,
  withDaemonSpan,
} from './daemon-tracing.js';
import { getSessionIdFromContext } from './session-context.js';

// Mirror the post-init state: `sdk-impl.ts` injects the W3C fallback
// propagator once the lazy SDK chunk assembles successfully (this suite
// mocks `isTelemetrySdkInitialized` as true above, so the holder must be
// populated the same way the real SDK would).
setDaemonFallbackPropagator(new W3CTraceContextPropagator());

describe('daemon-tracing', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  it('extracts daemon trace context from reserved prompt metadata keys', () => {
    const traceId = '1'.repeat(32);
    const spanId = '2'.repeat(16);
    const extracted = extractDaemonTraceContext({
      _meta: {
        [DAEMON_TRACEPARENT_META_KEY]: `00-${traceId}-${spanId}-01`,
        [DAEMON_TRACESTATE_META_KEY]: 'vendor=value',
      },
    });

    expect(extracted).toBeDefined();
    expect(trace.getSpanContext(extracted!)?.traceId).toBe(traceId);
    expect(trace.getSpanContext(extracted!)?.spanId).toBe(spanId);
    expect(trace.getSpanContext(extracted!)?.traceState?.get('vendor')).toBe(
      'value',
    );
  });

  it('forces the sampled flag on _meta parents under the default sampler', () => {
    vi.stubEnv('OTEL_TRACES_SAMPLER', '');
    const extracted = extractDaemonTraceContext({
      _meta: {
        [DAEMON_TRACEPARENT_META_KEY]: `00-${'1'.repeat(32)}-${'2'.repeat(16)}-00`,
      },
    });
    expect(
      (trace.getSpanContext(extracted!)?.traceFlags ?? 0) & TraceFlags.SAMPLED,
    ).toBe(TraceFlags.SAMPLED);
  });

  it('keeps the caller flags on the _meta path when the sampler opts out', () => {
    vi.stubEnv('OTEL_TRACES_SAMPLER', 'parentbased_always_off');
    const extracted = extractDaemonTraceContext({
      _meta: {
        [DAEMON_TRACEPARENT_META_KEY]: `00-${'1'.repeat(32)}-${'2'.repeat(16)}-00`,
      },
    });
    expect(trace.getSpanContext(extracted!)?.traceFlags).toBe(0);
  });

  it('starts a daemon span under an explicit remote parent context', async () => {
    const parentContext = extractDaemonTraceContext({
      _meta: {
        [DAEMON_TRACEPARENT_META_KEY]: `00-${'1'.repeat(32)}-${'2'.repeat(16)}-01`,
      },
    });
    const span = {
      setStatus: vi.fn(),
      end: vi.fn(),
      setAttribute: vi.fn(),
      setAttributes: vi.fn(),
      recordException: vi.fn(),
    } as unknown as Span;
    const startActiveSpan = vi.fn(
      async (
        _name: string,
        _options: unknown,
        _parent: unknown,
        fn: (span: Span) => Promise<string>,
      ) => await fn(span),
    );
    vi.spyOn(trace, 'getTracer').mockReturnValue({
      startActiveSpan,
    } as unknown as Tracer);

    await expect(
      withDaemonSpan('child', {}, async () => 'ok', {
        parentContext: parentContext!,
      }),
    ).resolves.toBe('ok');

    expect(startActiveSpan).toHaveBeenCalledWith(
      'child',
      expect.objectContaining({ kind: expect.any(Number) }),
      parentContext!,
      expect.any(Function),
    );
    expect(span.end).toHaveBeenCalledOnce();
  });

  it('binds an explicit daemon session to the callback context', async () => {
    const span = {
      setStatus: vi.fn(),
      end: vi.fn(),
    } as unknown as Span;
    vi.spyOn(trace, 'getTracer').mockReturnValue({
      startActiveSpan: vi.fn(
        async (
          _name: string,
          _options: unknown,
          fn: (span: Span) => Promise<string>,
        ) => await fn(span),
      ),
    } as unknown as Tracer);
    let scopedSessionId: string | undefined;
    vi.spyOn(otelContext, 'with').mockImplementation(
      (ctx, fn: () => Promise<string>) => {
        scopedSessionId = getSessionIdFromContext(ctx);
        return fn();
      },
    );

    await withDaemonSpan(
      'daemon-session',
      { 'session.id': 'daemon-session-B' },
      async () => 'ok',
    );

    expect(scopedSessionId).toBe('daemon-session-B');
  });

  it('addDaemonRequestAttribute sets attribute on the active span', () => {
    const setAttribute = vi.fn();
    vi.spyOn(trace, 'getSpan').mockReturnValue({
      setAttribute,
    } as unknown as Span);

    addDaemonRequestAttribute('qwen-code.prompt_id', 'test-prompt-id');

    expect(setAttribute).toHaveBeenCalledWith(
      'qwen-code.prompt_id',
      'test-prompt-id',
    );
  });

  it('addDaemonRequestAttribute is a no-op without an active span', () => {
    vi.spyOn(trace, 'getSpan').mockReturnValue(undefined);
    expect(() =>
      addDaemonRequestAttribute('qwen-code.prompt_id', 'orphan'),
    ).not.toThrow();
  });
});
