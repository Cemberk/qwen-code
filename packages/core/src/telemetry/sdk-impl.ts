/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Heavy half of the telemetry SDK split (issue #4748).
 *
 * This module owns NodeSDK, batch processors, the file exporters, and both
 * instrumentations. It must only ever be loaded via the dynamic `import()` in
 * `sdk.ts#initializeTelemetry`, so processes that never enable telemetry (the
 * default) skip the module-load cost entirely. Telemetry is only ever written
 * to the local `telemetry.outfile`; there is no network exporter.
 */

import type { Context, TextMapPropagator } from '@opentelemetry/api';
import {
  getNumberFromEnv,
  W3CTraceContextPropagator,
} from '@opentelemetry/core';
import { NodeSDK } from '@opentelemetry/sdk-node';
import { SemanticResourceAttributes } from '@opentelemetry/semantic-conventions';
import { resourceFromAttributes } from '@opentelemetry/resources';
import {
  BatchSpanProcessor,
  type ReadableSpan,
  type Span as SdkSpan,
  type SpanExporter,
  type SpanProcessor,
} from '@opentelemetry/sdk-trace-node';
import {
  BatchLogRecordProcessor,
  type LogRecordExporter,
} from '@opentelemetry/sdk-logs';
import { PeriodicExportingMetricReader } from '@opentelemetry/sdk-metrics';
import { HttpInstrumentation } from '@opentelemetry/instrumentation-http';
import { UndiciInstrumentation } from '@opentelemetry/instrumentation-undici';
import type { TelemetryRuntimeConfig } from './runtime-config.js';
import { SERVICE_NAME } from './constants.js';
import { setDaemonFallbackPropagator } from './daemon-tracing.js';
import { configureContextUsageAttributeLengthLimit } from './context-usage.js';
import {
  FileLogExporter,
  FileMetricExporter,
  FileSpanExporter,
} from './file-exporters.js';
import {
  getCurrentSessionId,
  getSessionIdFromContext,
} from './session-context.js';
import { sessionIdContext } from '../utils/sessionIdContext.js';

/**
 * `TextMapPropagator` that emits nothing, so `propagation.inject()` never
 * writes `traceparent` into outgoing request headers. UndiciInstrumentation
 * and HttpInstrumentation still create client HTTP spans for the outfile.
 */
const NOOP_PROPAGATOR: TextMapPropagator = {
  inject() {},
  extract(context: Context): Context {
    return context;
  },
  fields(): string[] {
    return [];
  },
};

class SessionIdSpanProcessor implements SpanProcessor {
  onStart(span: SdkSpan, parentContext: Context): void {
    try {
      const existingSessionId = span.attributes['session.id'];
      if (typeof existingSessionId === 'string' && existingSessionId) return;
      const sessionId =
        getSessionIdFromContext(parentContext) ??
        (sessionIdContext.getStore() || getCurrentSessionId());
      if (sessionId) {
        span.setAttribute('session.id', sessionId);
      }
    } catch {
      // OTel processor errors must not break span creation
    }
  }
  onEnd(_span: ReadableSpan): void {}
  async shutdown(): Promise<void> {}
  async forceFlush(): Promise<void> {}
}

export interface StartedTelemetrySdk {
  sdk: NodeSDK;
  metricReader: PeriodicExportingMetricReader | undefined;
}

/**
 * Assemble (but do not start) the NodeSDK for the given config. Returns
 * `undefined` when no telemetry outfile is configured: the outfile is the
 * only telemetry destination. The facade (`sdk.ts`) owns `start()`,
 * initialized-state, and session-context wiring.
 */
export async function startTelemetrySdk(
  config: TelemetryRuntimeConfig,
): Promise<StartedTelemetrySdk | undefined> {
  const telemetryOutfile = config.getTelemetryOutfile();
  if (!telemetryOutfile) return undefined;
  // User-provided resource attributes (env + settings, already merged with
  // RESERVED stripping and OTEL_SERVICE_NAME precedence in the resolver).
  // We strip service.name/service.version here too as defense-in-depth, then
  // re-apply runtime-controlled values on top.
  const userAttrs = config.getTelemetryResourceAttributes() ?? {};
  const userServiceName = userAttrs['service.name'];
  // Strip keys we re-inject below (service.name, service.version) plus
  // session.id, which never belongs on the Resource — Resource attributes
  // auto-attach to every metric data point, which would bypass the metric
  // cardinality toggle. The resolver normally drops session.id from user
  // input already; this destructure is defense-in-depth for callers that
  // bypass the resolver (e.g. direct Config construction in tests).
  const {
    'service.name': _ignoredServiceName,
    'service.version': _ignoredServiceVersion,
    'session.id': _ignoredSessionId,
    ...nonReservedUserAttrs
  } = userAttrs;
  const resource = resourceFromAttributes({
    ...nonReservedUserAttrs,
    // `.trim() || SERVICE_NAME`: catches both empty string (`""`) and
    // whitespace-only values (`" "`, `"\t"`) that would otherwise produce
    // a blank service name on Resource (some backends reject these). Both
    // settings (no value trimming there) and env (`%20` decodes to `" "`)
    // can deliver whitespace-only values, so trim at the fallback point.
    [SemanticResourceAttributes.SERVICE_NAME]:
      userServiceName?.trim() || SERVICE_NAME,
    [SemanticResourceAttributes.SERVICE_VERSION]:
      config.getCliVersion() || 'unknown',
  });

  // One-time user-visible summary of resource-attribute diagnostics
  // produced during config resolution. The per-warning `diag.warn` calls
  // route to the OTel debug log; without this summary, an operator whose
  // attributes are silently dropped has no console signal that anything
  // happened. Telemetry init runs before Ink renders, so console output
  // here does not interleave with the TUI.
  // `?? []` defends against test mocks (`vi.mock('../config/config.js')`)
  // that auto-stub Config methods to return undefined.
  const attrWarnings = config.getTelemetryResourceAttributeWarnings() ?? [];
  if (attrWarnings.length > 0) {
    // eslint-disable-next-line no-console
    console.warn(
      `[qwen-code telemetry] ${attrWarnings.length} resource attribute issue(s):`,
    );
    for (const w of attrWarnings) {
      // eslint-disable-next-line no-console
      console.warn(`  - ${w}`);
    }
  }

  const spanExporter: SpanExporter = new FileSpanExporter(telemetryOutfile);
  const logExporter: LogRecordExporter = new FileLogExporter(telemetryOutfile);
  const metricReader = new PeriodicExportingMetricReader({
    exporter: new FileMetricExporter(telemetryOutfile),
    exportIntervalMillis: 10000,
  });

  const spanAttributeValueLengthLimit =
    getNumberFromEnv('OTEL_SPAN_ATTRIBUTE_VALUE_LENGTH_LIMIT') ??
    getNumberFromEnv('OTEL_ATTRIBUTE_VALUE_LENGTH_LIMIT') ??
    Infinity;
  configureContextUsageAttributeLengthLimit(spanAttributeValueLengthLimit);

  const sdk = new NodeSDK({
    resource,
    // Disable async host/process/env resource detectors: they leave attributes
    // pending and trigger an OTel diag.error on any resource attribute read
    // before the detectors settle (e.g. during HttpInstrumentation span creation).
    autoDetectResources: false,
    textMapPropagator: NOOP_PROPAGATOR,
    spanLimits: {
      attributeValueLengthLimit: spanAttributeValueLengthLimit,
    },
    spanProcessors: [
      new SessionIdSpanProcessor(),
      new BatchSpanProcessor(spanExporter),
    ],
    logRecordProcessors: [
      new BatchLogRecordProcessor({ exporter: logExporter }),
    ],
    metricReaders: [metricReader],
    instrumentations: [new HttpInstrumentation(), new UndiciInstrumentation()],
  });

  // Construct the daemon fallback W3C propagator here rather than in
  // daemon-tracing.ts to keep @opentelemetry/core out of the static startup
  // graph: this module is only loaded via dynamic import when telemetry is
  // enabled, and its closure already contains @opentelemetry/core (via
  // sdk-node/resources), so the fallback adds no bytes to the CLI launch
  // path. The setter is a no-op-safe seam — until it runs, inbound
  // traceparent extraction yields no parent context, matching the
  // telemetry-off state.
  setDaemonFallbackPropagator(new W3CTraceContextPropagator());

  return { sdk, metricReader };
}
