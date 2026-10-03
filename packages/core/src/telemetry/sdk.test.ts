/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { diag, ROOT_CONTEXT, trace } from '@opentelemetry/api';
import type { Config } from '../config/config.js';
import {
  initializeTelemetry,
  isTelemetrySdkInitialized,
  shutdownTelemetry,
  refreshSessionContext,
} from './sdk.js';
import { NodeSDK } from '@opentelemetry/sdk-node';

import { promises as fs } from 'node:fs';
import {
  resetDebugLoggingState,
  setDebugLogSession,
} from '../utils/debugLogger.js';

const mockEndAllInteractionSpans = vi.hoisted(() => vi.fn());
const TELEMETRY_OUTFILE = '/tmp/qwen-telemetry-test.log';

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function expectOtelDebugLogLine(
  level: 'ERROR' | 'WARN',
  message: string,
): ReturnType<typeof expect.stringMatching> {
  return expect.stringMatching(
    new RegExp(
      `\\[${level}\\] \\[OTEL\\]( \\[trace_id=[0-9a-f]{32} span_id=[0-9a-f]{16}\\])? ${escapeRegExp(message)}`,
    ),
  );
}

vi.mock('@opentelemetry/sdk-node');
vi.mock('@opentelemetry/instrumentation-http');
vi.mock('@opentelemetry/instrumentation-undici');
vi.mock('./file-exporters.js');
vi.mock('./session-events.js', () => ({
  emitSessionEnd: vi.fn(),
  emitSessionStart: vi.fn(),
}));
vi.mock('./session-context.js');
vi.mock('./trace-context.js');
vi.mock('./session-tracing.js', () => ({
  endAllInteractionSpans: mockEndAllInteractionSpans,
}));
vi.mock('./tracer.js', () => ({
  createSessionRootContext: vi.fn((id: string) => ({ __sessionId: id })),
  shouldForceSampled: vi.fn((): boolean => true),
}));

import {
  FileLogExporter,
  FileMetricExporter,
  FileSpanExporter,
} from './file-exporters.js';
import {
  getCurrentSessionId,
  getSessionIdFromContext,
  setSessionContext,
} from './session-context.js';
import { createSessionRootContext } from './tracer.js';
import { emitSessionEnd, emitSessionStart } from './session-events.js';
import {
  DAEMON_TRACEPARENT_META_KEY,
  extractDaemonTraceContext,
} from './daemon-tracing.js';
import { HttpInstrumentation } from '@opentelemetry/instrumentation-http';
import { UndiciInstrumentation } from '@opentelemetry/instrumentation-undici';
import { sessionIdContext } from '../utils/sessionIdContext.js';

describe('Telemetry SDK', () => {
  let mockConfig: Config;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getCurrentSessionId).mockReturnValue(undefined);
    vi.mocked(getSessionIdFromContext).mockReturnValue(undefined);
    mockConfig = {
      getTelemetryEnabled: () => true,
      getTelemetryOutfile: () => TELEMETRY_OUTFILE,
      getTelemetryResourceAttributes: () => ({}),
      getTelemetryMetricsIncludeSessionId: () => false,
      getTelemetryResourceAttributeWarnings: () => [],
      getDebugMode: () => false,
      getSessionId: () => 'test-session',
      getCliVersion: () => '1.0.0-test',
    } as unknown as Config;
  });

  afterEach(async () => {
    vi.mocked(getCurrentSessionId).mockReturnValue(undefined);
    await shutdownTelemetry();
  });

  async function getSessionIdSpanProcessor() {
    await initializeTelemetry(mockConfig);
    const constructorCall = vi.mocked(NodeSDK).mock.calls[0]![0]! as {
      spanProcessors?: Array<{
        onStart: (span: unknown, parentContext: unknown) => void;
      }>;
    };
    return constructorCall.spanProcessors![0]!;
  }

  function createSessionSpan(attributes: Record<string, unknown> = {}) {
    return {
      attributes,
      setAttribute: vi.fn((key: string, value: unknown) => {
        attributes[key] = value;
      }),
    };
  }

  it('stamps automatic spans from scoped context before the global session', async () => {
    vi.mocked(getSessionIdFromContext).mockReturnValue('scoped-session');
    vi.mocked(getCurrentSessionId).mockReturnValue('stale-session');
    const processor = await getSessionIdSpanProcessor();
    const span = createSessionSpan();

    processor.onStart(span, ROOT_CONTEXT);

    expect(span.setAttribute).toHaveBeenCalledWith(
      'session.id',
      'scoped-session',
    );
  });

  it('does not overwrite an explicit automatic-span session', async () => {
    vi.mocked(getSessionIdFromContext).mockReturnValue('scoped-session');
    const processor = await getSessionIdSpanProcessor();
    const span = createSessionSpan({ 'session.id': 'explicit-session' });

    processor.onStart(span, ROOT_CONTEXT);

    expect(span.setAttribute).not.toHaveBeenCalled();
  });

  it('uses the per-request session before the global session', async () => {
    vi.mocked(getSessionIdFromContext).mockReturnValue(undefined);
    vi.mocked(getCurrentSessionId).mockReturnValue('stale-session');
    const processor = await getSessionIdSpanProcessor();
    const span = createSessionSpan();

    sessionIdContext.run('request-session', () =>
      processor.onStart(span, ROOT_CONTEXT),
    );

    expect(span.setAttribute).toHaveBeenCalledWith(
      'session.id',
      'request-session',
    );
  });

  it('writes every signal to the telemetry outfile', async () => {
    await initializeTelemetry(mockConfig);

    expect(FileSpanExporter).toHaveBeenCalledWith(TELEMETRY_OUTFILE);
    expect(FileLogExporter).toHaveBeenCalledWith(TELEMETRY_OUTFILE);
    expect(FileMetricExporter).toHaveBeenCalledWith(TELEMETRY_OUTFILE);
    expect(NodeSDK.prototype.start).toHaveBeenCalled();
    expect(NodeSDK).toHaveBeenCalledWith(
      expect.objectContaining({ autoDetectResources: false }),
    );
  });

  it('does not start the SDK without a telemetry outfile', async () => {
    vi.spyOn(mockConfig, 'getTelemetryOutfile').mockReturnValue(undefined);

    await initializeTelemetry(mockConfig);

    expect(NodeSDK).not.toHaveBeenCalled();
    expect(isTelemetrySdkInitialized()).toBe(false);
  });

  it.each([
    ['unset limits', undefined, undefined, Infinity],
    ['span-specific priority', '256', '512', 256],
    ['invalid span-specific fallback', 'invalid', '384', 384],
    ['zero span-specific value', '0', '256', 0],
    ['negative span-specific value', '-1', '256', -1],
  ])(
    'pins the %s OTel attribute limit in the SDK',
    async (_name, spanLimit, generalLimit, expected) => {
      const previousSpanLimit =
        process.env['OTEL_SPAN_ATTRIBUTE_VALUE_LENGTH_LIMIT'];
      const previousGeneralLimit =
        process.env['OTEL_ATTRIBUTE_VALUE_LENGTH_LIMIT'];
      if (spanLimit === undefined) {
        delete process.env['OTEL_SPAN_ATTRIBUTE_VALUE_LENGTH_LIMIT'];
      } else {
        process.env['OTEL_SPAN_ATTRIBUTE_VALUE_LENGTH_LIMIT'] = spanLimit;
      }
      if (generalLimit === undefined) {
        delete process.env['OTEL_ATTRIBUTE_VALUE_LENGTH_LIMIT'];
      } else {
        process.env['OTEL_ATTRIBUTE_VALUE_LENGTH_LIMIT'] = generalLimit;
      }

      try {
        await initializeTelemetry(mockConfig);

        expect(NodeSDK).toHaveBeenCalledWith(
          expect.objectContaining({
            spanLimits: { attributeValueLengthLimit: expected },
          }),
        );
      } finally {
        if (previousSpanLimit === undefined) {
          delete process.env['OTEL_SPAN_ATTRIBUTE_VALUE_LENGTH_LIMIT'];
        } else {
          process.env['OTEL_SPAN_ATTRIBUTE_VALUE_LENGTH_LIMIT'] =
            previousSpanLimit;
        }
        if (previousGeneralLimit === undefined) {
          delete process.env['OTEL_ATTRIBUTE_VALUE_LENGTH_LIMIT'];
        } else {
          process.env['OTEL_ATTRIBUTE_VALUE_LENGTH_LIMIT'] =
            previousGeneralLimit;
        }
      }
    },
  );

  describe('lazy init lifecycle', () => {
    it('shares a single in-flight init across concurrent callers', async () => {
      await Promise.all([
        initializeTelemetry(mockConfig),
        initializeTelemetry(mockConfig),
      ]);

      expect(NodeSDK).toHaveBeenCalledTimes(1);
      expect(NodeSDK.prototype.start).toHaveBeenCalledTimes(1);
      // One shared init means one settle-time catch-up, even with concurrent
      // callers.
      expect(emitSessionStart).toHaveBeenCalledTimes(1);
      expect(emitSessionStart).toHaveBeenCalledWith('test-session');
    });

    it('emits the initial session start after the SDK settles', async () => {
      await initializeTelemetry(mockConfig);

      expect(emitSessionStart).toHaveBeenCalledWith('test-session');
      expect(
        vi.mocked(emitSessionStart).mock.invocationCallOrder[0],
      ).toBeGreaterThan(
        vi.mocked(NodeSDK.prototype.start).mock.invocationCallOrder[0],
      );
    });

    it('installs the daemon fallback propagator when the SDK initializes', async () => {
      // The pre-init state (fresh registry, empty fallback holder → no
      // parent context) is covered by daemon-tracing.test.ts; this test
      // proves the other half of the wiring: after initializeTelemetry the
      // sdk-impl chunk has injected the W3C fallback, so inbound _meta
      // extraction resolves a remote parent even though the global
      // propagator stays a no-op (NodeSDK is mocked, nothing registers one).
      await initializeTelemetry(mockConfig);

      const extracted = extractDaemonTraceContext({
        _meta: {
          [DAEMON_TRACEPARENT_META_KEY]: `00-${'3'.repeat(32)}-${'4'.repeat(16)}-01`,
        },
      });
      expect(trace.getSpanContext(extracted!)?.traceId).toBe('3'.repeat(32));
      expect(trace.getSpanContext(extracted!)?.isRemote).toBe(true);
    });

    it('ignores external exporter selectors while starting explicit exporters', async () => {
      const exporterEnv = {
        OTEL_TRACES_EXPORTER: 'console',
        OTEL_LOGS_EXPORTER: 'none',
        OTEL_METRICS_EXPORTER: 'otlp',
      } as const;
      const previousValues = Object.fromEntries(
        Object.keys(exporterEnv).map((name) => [name, process.env[name]]),
      );
      Object.assign(process.env, exporterEnv);
      expect(isTelemetrySdkInitialized()).toBe(false);
      let startCalled = false;
      const observedDuringStart: Record<string, string | undefined> = {};

      vi.mocked(NodeSDK.prototype.start).mockImplementationOnce(() => {
        startCalled = true;
        for (const name of Object.keys(exporterEnv)) {
          observedDuringStart[name] = process.env[name];
        }
      });

      try {
        await initializeTelemetry(mockConfig);
        expect(startCalled).toBe(true);
        // Assert here, not inside the mocked start(): initializeTelemetry
        // catches start() failures, so an assertion thrown there would be
        // swallowed as an init failure and the test would still pass.
        for (const name of Object.keys(exporterEnv)) {
          expect(observedDuringStart[name]).toBeUndefined();
          expect(process.env[name]).toBe(
            exporterEnv[name as keyof typeof exporterEnv],
          );
        }
      } finally {
        for (const name of Object.keys(exporterEnv)) {
          const previousValue = previousValues[name];
          if (previousValue === undefined) {
            delete process.env[name];
          } else {
            process.env[name] = previousValue;
          }
        }
      }
    });

    it('restores external exporter selectors when sdk.start() throws', async () => {
      const exporterEnv = {
        OTEL_TRACES_EXPORTER: 'console',
        OTEL_LOGS_EXPORTER: 'none',
        OTEL_METRICS_EXPORTER: 'otlp',
      } as const;
      const previousValues = Object.fromEntries(
        Object.keys(exporterEnv).map((name) => [name, process.env[name]]),
      );
      Object.assign(process.env, exporterEnv);

      vi.mocked(NodeSDK.prototype.start).mockImplementationOnce(() => {
        throw new Error('start failed');
      });

      try {
        await initializeTelemetry(mockConfig);
        expect(isTelemetrySdkInitialized()).toBe(false);
        for (const name of Object.keys(exporterEnv)) {
          expect(process.env[name]).toBe(
            exporterEnv[name as keyof typeof exporterEnv],
          );
        }
      } finally {
        for (const name of Object.keys(exporterEnv)) {
          const previousValue = previousValues[name];
          if (previousValue === undefined) {
            delete process.env[name];
          } else {
            process.env[name] = previousValue;
          }
        }
      }
    });

    it('clears the in-flight promise so a failed init can be retried', async () => {
      vi.mocked(NodeSDK.prototype.start).mockImplementationOnce(() => {
        throw new Error('start failed');
      });

      // A failed init must resolve (never reject) and leave telemetry off so a
      // later call can retry rather than reusing a poisoned single-flight promise.
      await expect(initializeTelemetry(mockConfig)).resolves.toBeUndefined();
      expect(isTelemetrySdkInitialized()).toBe(false);

      // The retry succeeds: reaching `initialized === true` requires the
      // continuation to have run `sdk.start()` again on a fresh SDK.
      await initializeTelemetry(mockConfig);
      expect(isTelemetrySdkInitialized()).toBe(true);
    });

    it('waits for an in-flight init before shutting down', async () => {
      // Regression guard for the shutdown/init race: shutdown must not no-op
      // past a not-yet-set `telemetryInitialized` and leak a started SDK whose
      // buffered spans/logs never flush.
      const initPromise = initializeTelemetry(mockConfig);
      const shutdownPromise = shutdownTelemetry();

      await Promise.all([initPromise, shutdownPromise]);

      expect(NodeSDK.prototype.start).toHaveBeenCalledTimes(1);
      expect(NodeSDK.prototype.shutdown).toHaveBeenCalledTimes(1);
      expect(isTelemetrySdkInitialized()).toBe(false);
    });

    it('clears the shutdown promise when it races an init that fails to start', async () => {
      vi.mocked(NodeSDK.prototype.start).mockImplementationOnce(() => {
        throw new Error('start failed');
      });

      const initPromise = initializeTelemetry(mockConfig);
      const shutdownPromise = shutdownTelemetry();
      await Promise.all([initPromise, shutdownPromise]);
      expect(isTelemetrySdkInitialized()).toBe(false);

      // The no-op shutdown above resolved without an SDK; it must not leave a
      // stale shutdown promise that short-circuits a later real teardown.
      await initializeTelemetry(mockConfig);
      await shutdownTelemetry();
      expect(NodeSDK.prototype.shutdown).toHaveBeenCalledTimes(1);
      expect(isTelemetrySdkInitialized()).toBe(false);
    });

    it('ends the active session before the SDK shuts down', async () => {
      vi.mocked(getCurrentSessionId).mockReturnValueOnce('active-session');
      await initializeTelemetry(mockConfig);

      await shutdownTelemetry();

      expect(mockEndAllInteractionSpans).toHaveBeenCalledWith('cancelled');
      expect(emitSessionEnd).toHaveBeenCalledWith('active-session');
      expect(
        mockEndAllInteractionSpans.mock.invocationCallOrder[0],
      ).toBeLessThan(
        vi.mocked(NodeSDK.prototype.shutdown).mock.invocationCallOrder[0],
      );
      expect(
        vi.mocked(emitSessionEnd).mock.invocationCallOrder[0],
      ).toBeLessThan(
        vi.mocked(NodeSDK.prototype.shutdown).mock.invocationCallOrder[0],
      );
    });

    it('does not end a session at shutdown when no session context exists', async () => {
      await initializeTelemetry(mockConfig);

      await shutdownTelemetry();

      expect(emitSessionEnd).not.toHaveBeenCalled();
    });
  });

  it('should route OpenTelemetry diagnostics to debug log instead of console output', async () => {
    const consoleErrorSpy = vi
      .spyOn(console, 'error')
      .mockImplementation(() => {});
    const consoleWarnSpy = vi
      .spyOn(console, 'warn')
      .mockImplementation(() => {});
    const mkdirSpy = vi.spyOn(fs, 'mkdir').mockResolvedValue(undefined);
    const appendFileSpy = vi
      .spyOn(fs, 'appendFile')
      .mockResolvedValue(undefined);
    const unlinkSpy = vi.spyOn(fs, 'unlink').mockResolvedValue(undefined);
    const symlinkSpy = vi.spyOn(fs, 'symlink').mockResolvedValue(undefined);
    const previousDebugLogFileEnv = process.env['QWEN_DEBUG_LOG_FILE'];
    try {
      process.env['QWEN_DEBUG_LOG_FILE'] = '1';
      setDebugLogSession({
        getSessionId: () => '11111111-2222-4333-8444-555555555555',
      });

      diag.error(
        JSON.stringify({
          message:
            'Error: PeriodicExportingMetricReader: metrics export failed (error Error: connect ECONNREFUSED)',
        }),
      );

      diag.error('A different OpenTelemetry diagnostic');
      diag.warn('An OpenTelemetry warning');

      await vi.waitFor(() => {
        expect(appendFileSpy).toHaveBeenCalledTimes(3);
      });

      expect(consoleErrorSpy).not.toHaveBeenCalled();
      expect(consoleWarnSpy).not.toHaveBeenCalled();
      expect(mkdirSpy).toHaveBeenCalled();
      expect(appendFileSpy).toHaveBeenCalledWith(
        expect.stringContaining('11111111-2222-4333-8444-555555555555'),
        expectOtelDebugLogLine(
          'ERROR',
          '{"message":"Error: PeriodicExportingMetricReader: metrics export failed (error Error: connect ECONNREFUSED)"}',
        ),
        { encoding: 'utf8', mode: 0o600 },
      );
      expect(appendFileSpy).toHaveBeenCalledWith(
        expect.stringContaining('11111111-2222-4333-8444-555555555555'),
        expectOtelDebugLogLine('ERROR', 'A different OpenTelemetry diagnostic'),
        { encoding: 'utf8', mode: 0o600 },
      );
      expect(appendFileSpy).toHaveBeenCalledWith(
        expect.stringContaining('11111111-2222-4333-8444-555555555555'),
        expectOtelDebugLogLine('WARN', 'An OpenTelemetry warning'),
        { encoding: 'utf8', mode: 0o600 },
      );
    } finally {
      consoleErrorSpy.mockRestore();
      consoleWarnSpy.mockRestore();
      mkdirSpy.mockRestore();
      appendFileSpy.mockRestore();
      unlinkSpy.mockRestore();
      symlinkSpy.mockRestore();
      setDebugLogSession(null);
      resetDebugLoggingState();
      if (previousDebugLogFileEnv === undefined) {
        delete process.env['QWEN_DEBUG_LOG_FILE'];
      } else {
        process.env['QWEN_DEBUG_LOG_FILE'] = previousDebugLogFileEnv;
      }
    }
  });

  it('should not register async process shutdown handlers', async () => {
    const processOnSpy = vi.spyOn(process, 'on');
    try {
      await initializeTelemetry(mockConfig);

      expect(processOnSpy).not.toHaveBeenCalledWith(
        'SIGTERM',
        expect.any(Function),
      );
      expect(processOnSpy).not.toHaveBeenCalledWith(
        'SIGINT',
        expect.any(Function),
      );
      expect(processOnSpy).not.toHaveBeenCalledWith(
        'exit',
        expect.any(Function),
      );
    } finally {
      processOnSpy.mockRestore();
    }
  });

  it('should mark telemetry uninitialized after shutdown', async () => {
    await initializeTelemetry(mockConfig);

    await shutdownTelemetry();

    expect(isTelemetrySdkInitialized()).toBe(false);
  });

  it('should set service.version to the application version, not Node.js version', async () => {
    await initializeTelemetry(mockConfig);

    const constructorCall = vi.mocked(NodeSDK).mock.calls[0]![0]!;
    const resource = constructorCall.resource as {
      attributes: Record<string, string>;
    };
    expect(resource.attributes['service.version']).toBe('1.0.0-test');
    expect(resource.attributes['service.version']).not.toBe(process.version);
  });

  it('should complete shutdown within timeout when SDK shutdown hangs', async () => {
    vi.useFakeTimers();
    const shutdownSpy = vi
      .spyOn(NodeSDK.prototype, 'shutdown')
      .mockReturnValue(new Promise<void>(() => {}));
    const diagWarnSpy = vi.spyOn(diag, 'warn').mockImplementation(() => {});
    try {
      await initializeTelemetry(mockConfig);

      const shutdownPromise = shutdownTelemetry();

      // Advance past the 10s timeout
      await vi.advanceTimersByTimeAsync(10_000);

      await shutdownPromise;

      expect(isTelemetrySdkInitialized()).toBe(false);
      expect(diagWarnSpy).toHaveBeenCalledWith(
        expect.stringContaining('Telemetry shutdown timed out'),
      );
    } finally {
      shutdownSpy.mockRestore();
      diagWarnSpy.mockRestore();
      vi.useRealTimers();
    }
  });

  it('should complete shutdown normally when SDK resolves before timeout', async () => {
    const shutdownSpy = vi
      .spyOn(NodeSDK.prototype, 'shutdown')
      .mockResolvedValue();
    try {
      await initializeTelemetry(mockConfig);

      await shutdownTelemetry();

      expect(isTelemetrySdkInitialized()).toBe(false);
    } finally {
      shutdownSpy.mockRestore();
    }
  });

  it('should log error when sdk.shutdown() rejects', async () => {
    const shutdownSpy = vi
      .spyOn(NodeSDK.prototype, 'shutdown')
      .mockReturnValue(Promise.reject(new Error('shutdown failed')));
    const diagErrorSpy = vi.spyOn(diag, 'error').mockImplementation(() => {});
    try {
      await initializeTelemetry(mockConfig);

      await shutdownTelemetry();

      expect(isTelemetrySdkInitialized()).toBe(false);
      expect(diagErrorSpy).toHaveBeenCalledWith(
        'Error shutting down SDK:',
        expect.any(Error),
      );
    } finally {
      shutdownSpy.mockRestore();
      diagErrorSpy.mockRestore();
    }
  });

  it('should fall back to "unknown" when getCliVersion returns undefined', async () => {
    vi.spyOn(mockConfig, 'getCliVersion').mockImplementation(() => undefined);
    await initializeTelemetry(mockConfig);

    const constructorCall = vi.mocked(NodeSDK).mock.calls[0]![0]!;
    const resource = constructorCall.resource as {
      attributes: Record<string, string>;
    };
    expect(resource.attributes['service.version']).toBe('unknown');
  });

  describe('Resource attributes', () => {
    function getResourceAttributes(): Record<string, string> {
      const constructorCall = vi.mocked(NodeSDK).mock.calls[0]![0]!;
      return (
        constructorCall.resource as { attributes: Record<string, string> }
      ).attributes;
    }

    it('does not place session.id on the Resource', async () => {
      await initializeTelemetry(mockConfig);
      expect(getResourceAttributes()['session.id']).toBeUndefined();
    });

    it('always sets service.name and service.version from runtime', async () => {
      await initializeTelemetry(mockConfig);
      const attrs = getResourceAttributes();
      expect(attrs['service.name']).toBe('qwen-code');
      expect(attrs['service.version']).toBe('1.0.0-test');
    });

    it('attaches user-provided resource attributes', async () => {
      vi.spyOn(mockConfig, 'getTelemetryResourceAttributes').mockReturnValue({
        team: 'platform',
        env: 'prod',
      });
      await initializeTelemetry(mockConfig);
      const attrs = getResourceAttributes();
      expect(attrs['team']).toBe('platform');
      expect(attrs['env']).toBe('prod');
    });

    it('user-provided service.name wins over default', async () => {
      vi.spyOn(mockConfig, 'getTelemetryResourceAttributes').mockReturnValue({
        'service.name': 'qwen-code-ci',
      });
      await initializeTelemetry(mockConfig);
      expect(getResourceAttributes()['service.name']).toBe('qwen-code-ci');
    });

    it('user-provided service.version is ignored (runtime value wins)', async () => {
      vi.spyOn(mockConfig, 'getTelemetryResourceAttributes').mockReturnValue({
        'service.version': '99.0.0-fake',
      });
      await initializeTelemetry(mockConfig);
      expect(getResourceAttributes()['service.version']).toBe('1.0.0-test');
    });

    it('empty-string service.name from settings falls back to default', async () => {
      // Reviewer caught: `??` would let "" pass; `||` correctly falls back
      // so backends never see a blank service name.
      vi.spyOn(mockConfig, 'getTelemetryResourceAttributes').mockReturnValue({
        'service.name': '',
      });
      await initializeTelemetry(mockConfig);
      expect(getResourceAttributes()['service.name']).toBe('qwen-code');
    });

    it('whitespace-only service.name from settings falls back to default', async () => {
      // Reviewer caught: plain `||` lets `" "` through (truthy). The
      // `.trim() || SERVICE_NAME` fallback covers both empty and
      // whitespace-only values (env path can produce these via `%20`).
      vi.spyOn(mockConfig, 'getTelemetryResourceAttributes').mockReturnValue({
        'service.name': '   ',
      });
      await initializeTelemetry(mockConfig);
      expect(getResourceAttributes()['service.name']).toBe('qwen-code');
    });

    it('emits a console summary when resource-attribute warnings are present', async () => {
      const consoleWarnSpy = vi
        .spyOn(console, 'warn')
        .mockImplementation(() => {});
      try {
        vi.spyOn(
          mockConfig,
          'getTelemetryResourceAttributeWarnings',
        ).mockReturnValue([
          'OTEL_RESOURCE_ATTRIBUTES cannot override reserved key "service.version"; ignoring',
          'Skipping malformed OTEL_RESOURCE_ATTRIBUTES entry: "bogus"',
        ]);
        await initializeTelemetry(mockConfig);
        const header = consoleWarnSpy.mock.calls[0]?.[0] ?? '';
        expect(header).toContain('2 resource attribute issue');
        expect(
          consoleWarnSpy.mock.calls.some((c) =>
            String(c[0]).includes('reserved key'),
          ),
        ).toBe(true);
      } finally {
        consoleWarnSpy.mockRestore();
      }
    });

    it('no console output when warnings list is empty', async () => {
      const consoleWarnSpy = vi
        .spyOn(console, 'warn')
        .mockImplementation(() => {});
      try {
        await initializeTelemetry(mockConfig);
        expect(consoleWarnSpy).not.toHaveBeenCalled();
      } finally {
        consoleWarnSpy.mockRestore();
      }
    });

    it('user-provided session.id is stripped (defense-in-depth)', async () => {
      // Simulates a caller that bypasses resolveTelemetrySettings() and feeds
      // raw user input straight into Config. Resource must still not carry
      // session.id, otherwise it would leak onto every metric data point.
      vi.spyOn(mockConfig, 'getTelemetryResourceAttributes').mockReturnValue({
        'session.id': 'spoofed',
        team: 'x',
      });
      await initializeTelemetry(mockConfig);
      const attrs = getResourceAttributes();
      expect(attrs['session.id']).toBeUndefined();
      expect(attrs['team']).toBe('x');
    });
  });

  describe('Outbound trace-context propagation', () => {
    function getTextMapPropagator(): unknown {
      const constructorCall = vi.mocked(NodeSDK).mock.calls[0]![0]!;
      return (constructorCall as { textMapPropagator?: unknown })
        .textMapPropagator;
    }

    it('installs a no-op TextMapPropagator', async () => {
      // traceparent is never written onto the outbound wire. The
      // propagator's inject() must be a no-op so UndiciInstrumentation's
      // `propagation.inject(carrier)` call writes nothing into the outgoing
      // request's headers.
      await initializeTelemetry(mockConfig);
      const propagator = getTextMapPropagator() as
        | { inject: (...args: unknown[]) => void; fields: () => string[] }
        | undefined;
      expect(propagator).toBeDefined();
      expect(typeof propagator!.inject).toBe('function');
      // Sanity: fields() returns empty array → instrumentation knows there
      // are no headers to clear / no propagator state.
      expect(propagator!.fields()).toEqual([]);
      // inject is a no-op — does not throw, does not mutate the carrier.
      const carrier: Record<string, string> = { existing: 'h' };
      expect(() =>
        propagator!.inject({} as never, carrier, {} as never),
      ).not.toThrow();
      expect(carrier).toEqual({ existing: 'h' });
    });
  });

  describe('Instrumentations', () => {
    function getInstrumentations(): unknown[] {
      const constructorCall = vi.mocked(NodeSDK).mock.calls[0]![0]!;
      return (constructorCall.instrumentations ?? []) as unknown[];
    }

    it('registers both HttpInstrumentation and UndiciInstrumentation', async () => {
      await initializeTelemetry(mockConfig);
      const instrumentations = getInstrumentations();
      // The mocks make HttpInstrumentation / UndiciInstrumentation auto-mocked
      // classes; instance-of checks against the mocked class still work.
      expect(
        instrumentations.some((i) => i instanceof HttpInstrumentation),
      ).toBe(true);
      expect(
        instrumentations.some((i) => i instanceof UndiciInstrumentation),
      ).toBe(true);
    });

    it('constructs the instrumentations without request-ignore hooks', async () => {
      await initializeTelemetry(mockConfig);

      expect(HttpInstrumentation).toHaveBeenCalledWith();
      expect(UndiciInstrumentation).toHaveBeenCalledWith();
    });
  });
});

describe('refreshSessionContext', () => {
  let mockConfig: Config;

  beforeEach(() => {
    vi.clearAllMocks();
    mockConfig = {
      getTelemetryEnabled: () => true,
      getTelemetryOutfile: () => TELEMETRY_OUTFILE,
      getTelemetryResourceAttributes: () => ({}),
      getTelemetryMetricsIncludeSessionId: () => false,
      getTelemetryResourceAttributeWarnings: () => [],
      getDebugMode: () => false,
      getSessionId: () => 'test-session',
      getCliVersion: () => '1.0.0-test',
    } as unknown as Config;
  });

  afterEach(async () => {
    await shutdownTelemetry();
  });

  it('should update session context when telemetry is initialized', async () => {
    await initializeTelemetry(mockConfig);

    refreshSessionContext('new-session-id');

    expect(createSessionRootContext).toHaveBeenCalledWith('new-session-id');
    expect(setSessionContext).toHaveBeenCalledWith(
      { __sessionId: 'new-session-id' },
      'new-session-id',
    );
  });

  it('should be a no-op when telemetry is not initialized', () => {
    // Do NOT call initializeTelemetry — telemetryInitialized remains false
    refreshSessionContext('some-session');

    expect(createSessionRootContext).not.toHaveBeenCalled();
    expect(setSessionContext).not.toHaveBeenCalled();
  });

  it('should not throw when refreshing session context fails', async () => {
    await initializeTelemetry(mockConfig);
    vi.clearAllMocks();
    vi.mocked(createSessionRootContext).mockImplementationOnce(() => {
      throw new Error('session context failed');
    });

    expect(() => refreshSessionContext('bad-session')).not.toThrow();

    expect(createSessionRootContext).toHaveBeenCalledWith('bad-session');
    expect(setSessionContext).not.toHaveBeenCalled();
  });
});
