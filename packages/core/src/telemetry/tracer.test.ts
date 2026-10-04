/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { TraceFlags } from '@opentelemetry/api';
import { createSessionRootContext } from './tracer.js';
import { deriveTraceId } from './trace-id-utils.js';

const mockState = vi.hoisted(() => ({
  getSpanReturn: undefined as unknown,
  lastParentCtx: undefined as unknown,
  activeContext: {} as unknown,
  throwOnSetStatus: false,
  throwOnEnd: false,
  nonWritableSetStatus: false,
}));
const debugWarnCalls = vi.hoisted((): unknown[][] => []);

vi.mock('../utils/debugLogger.js', () => ({
  createDebugLogger: () => ({
    debug: () => {},
    info: () => {},
    warn: (...args: unknown[]) => {
      debugWarnCalls.push(args);
    },
    error: () => {},
  }),
}));

// Collect span operations for assertions
interface SpanRecord {
  name: string;
  attributes: Record<string, string | number | boolean>;
  statuses: Array<{ code: number; message?: string }>;
  ended: boolean;
}

const spans: SpanRecord[] = [];

// Mock @opentelemetry/api to capture span behavior
vi.mock('@opentelemetry/api', async () => {
  const actual =
    await vi.importActual<typeof import('@opentelemetry/api')>(
      '@opentelemetry/api',
    );

  function createMockSpan(
    name: string,
    attributes: Record<string, string | number | boolean>,
  ) {
    const record: SpanRecord = { name, attributes, statuses: [], ended: false };
    spans.push(record);
    const span = {
      ...record,
      spanContext: () => ({
        traceId: 'a'.repeat(32),
        spanId: 'b'.repeat(16),
        traceFlags: TraceFlags.SAMPLED,
      }),
      setStatus(status: object) {
        if (mockState.throwOnSetStatus) {
          throw new Error('setStatus failed');
        }
        record.statuses.push(status as { code: number; message?: string });
      },
      setAttribute() {},
      end() {
        if (mockState.throwOnEnd) {
          throw new Error('end failed');
        }
        record.ended = true;
      },
    };
    if (mockState.nonWritableSetStatus) {
      Object.defineProperty(span, 'setStatus', { writable: false });
    }
    return span;
  }

  const mockTracer = {
    startActiveSpan(
      name: string,
      options: { attributes?: Record<string, string | number | boolean> },
      ctx: unknown,
      fn: (span: ReturnType<typeof createMockSpan>) => unknown,
    ) {
      mockState.lastParentCtx = ctx;
      const span = createMockSpan(name, options.attributes ?? {});
      return fn(span);
    },
    startSpan(
      name: string,
      options: { attributes?: Record<string, string | number | boolean> },
      ctx?: unknown,
    ) {
      mockState.lastParentCtx = ctx;
      return createMockSpan(name, options.attributes ?? {});
    },
  };

  return {
    ...actual,
    SpanStatusCode: actual.SpanStatusCode,
    TraceFlags: actual.TraceFlags,
    trace: {
      getTracer: () => mockTracer,
      getSpan: () => mockState.getSpanReturn,
      setSpan: (_ctx: unknown, span: unknown) => span,
      wrapSpanContext: (ctx: unknown) => ctx,
    },
    context: {
      active: () => mockState.activeContext,
      with: (_ctx: unknown, fn: () => unknown) => fn(),
    },
  };
});

beforeEach(() => {
  spans.length = 0;
  mockState.getSpanReturn = undefined;
  mockState.lastParentCtx = undefined;
  mockState.activeContext = {};
  mockState.throwOnSetStatus = false;
  mockState.throwOnEnd = false;
  mockState.nonWritableSetStatus = false;
  debugWarnCalls.length = 0;
});

describe('createSessionRootContext', () => {
  it('derives a deterministic traceId from session ID (spanId is random)', () => {
    const ctx = createSessionRootContext('session-123') as unknown as {
      traceId: string;
      spanId: string;
      traceFlags: number;
      isRemote: boolean;
    };
    expect(ctx.traceId).toBe(deriveTraceId('session-123'));
  });

  it('uses TraceFlags.SAMPLED by default (no OTEL_TRACES_SAMPLER)', () => {
    const original = process.env['OTEL_TRACES_SAMPLER'];
    delete process.env['OTEL_TRACES_SAMPLER'];
    try {
      const ctx = createSessionRootContext('session-123') as unknown as {
        traceFlags: number;
      };
      expect(ctx.traceFlags).toBe(TraceFlags.SAMPLED);
    } finally {
      if (original !== undefined) process.env['OTEL_TRACES_SAMPLER'] = original;
      else delete process.env['OTEL_TRACES_SAMPLER'];
    }
  });

  it('uses TraceFlags.NONE when a custom sampler is configured', () => {
    const original = process.env['OTEL_TRACES_SAMPLER'];
    process.env['OTEL_TRACES_SAMPLER'] = 'traceidratio';
    try {
      const ctx = createSessionRootContext('session-456') as unknown as {
        traceFlags: number;
      };
      expect(ctx.traceFlags).toBe(TraceFlags.NONE);
    } finally {
      if (original !== undefined) process.env['OTEL_TRACES_SAMPLER'] = original;
      else delete process.env['OTEL_TRACES_SAMPLER'];
    }
  });

  it('uses TraceFlags.SAMPLED when OTEL_TRACES_SAMPLER=always_on', () => {
    const original = process.env['OTEL_TRACES_SAMPLER'];
    process.env['OTEL_TRACES_SAMPLER'] = 'always_on';
    try {
      const ctx = createSessionRootContext('session-ao') as unknown as {
        traceFlags: number;
      };
      expect(ctx.traceFlags).toBe(TraceFlags.SAMPLED);
    } finally {
      if (original !== undefined) process.env['OTEL_TRACES_SAMPLER'] = original;
      else delete process.env['OTEL_TRACES_SAMPLER'];
    }
  });

  it('uses TraceFlags.NONE when OTEL_TRACES_SAMPLER=always_off', () => {
    const original = process.env['OTEL_TRACES_SAMPLER'];
    process.env['OTEL_TRACES_SAMPLER'] = 'always_off';
    try {
      const ctx = createSessionRootContext('session-aoff') as unknown as {
        traceFlags: number;
      };
      expect(ctx.traceFlags).toBe(TraceFlags.NONE);
    } finally {
      if (original !== undefined) process.env['OTEL_TRACES_SAMPLER'] = original;
      else delete process.env['OTEL_TRACES_SAMPLER'];
    }
  });

  it('uses TraceFlags.SAMPLED when OTEL_TRACES_SAMPLER=parentbased_always_on', () => {
    const original = process.env['OTEL_TRACES_SAMPLER'];
    process.env['OTEL_TRACES_SAMPLER'] = 'parentbased_always_on';
    try {
      const ctx = createSessionRootContext('session-789') as unknown as {
        traceFlags: number;
      };
      expect(ctx.traceFlags).toBe(TraceFlags.SAMPLED);
    } finally {
      if (original !== undefined) process.env['OTEL_TRACES_SAMPLER'] = original;
      else delete process.env['OTEL_TRACES_SAMPLER'];
    }
  });

  it('uses TraceFlags.NONE when OTEL_TRACES_SAMPLER=parentbased_always_off', () => {
    const original = process.env['OTEL_TRACES_SAMPLER'];
    process.env['OTEL_TRACES_SAMPLER'] = 'parentbased_always_off';
    try {
      const ctx = createSessionRootContext('session-off') as unknown as {
        traceFlags: number;
      };
      expect(ctx.traceFlags).toBe(TraceFlags.NONE);
    } finally {
      if (original !== undefined) process.env['OTEL_TRACES_SAMPLER'] = original;
      else delete process.env['OTEL_TRACES_SAMPLER'];
    }
  });

  it('uses TraceFlags.SAMPLED for parentbased_traceidratio (parent flag gates children)', () => {
    const original = process.env['OTEL_TRACES_SAMPLER'];
    process.env['OTEL_TRACES_SAMPLER'] = 'parentbased_traceidratio';
    try {
      const ctx = createSessionRootContext('session-pb-ratio') as unknown as {
        traceFlags: number;
      };
      expect(ctx.traceFlags).toBe(TraceFlags.SAMPLED);
    } finally {
      if (original !== undefined) process.env['OTEL_TRACES_SAMPLER'] = original;
      else delete process.env['OTEL_TRACES_SAMPLER'];
    }
  });

  it('generates a valid 16-char hex spanId', () => {
    const ctx = createSessionRootContext('session-123') as unknown as {
      spanId: string;
    };
    expect(ctx.spanId).toMatch(/^[0-9a-f]{16}$/);
  });

  it('produces same traceId for same session ID', () => {
    const ctx1 = createSessionRootContext('session-abc') as unknown as {
      traceId: string;
    };
    const ctx2 = createSessionRootContext('session-abc') as unknown as {
      traceId: string;
    };
    expect(ctx1.traceId).toBe(ctx2.traceId);
  });

  it('produces different traceId for different session IDs', () => {
    const ctx1 = createSessionRootContext('session-abc') as unknown as {
      traceId: string;
    };
    const ctx2 = createSessionRootContext('session-xyz') as unknown as {
      traceId: string;
    };
    expect(ctx1.traceId).not.toBe(ctx2.traceId);
  });
});
