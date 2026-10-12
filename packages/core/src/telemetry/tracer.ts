/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  trace,
  ROOT_CONTEXT,
  type Span,
  type Context,
  TraceFlags,
} from '@opentelemetry/api';
import { deriveTraceId, randomSpanId } from './trace-id-utils.js';
import { createDebugLogger } from '../utils/debugLogger.js';

const debugLogger = createDebugLogger('OTEL_TRACER');
const TELEMETRY_WARNING_INTERVAL_MS = 30_000;
export const API_CALL_FAILED_SPAN_STATUS_MESSAGE = 'API call failed';
export const API_CALL_ABORTED_SPAN_STATUS_MESSAGE = 'API call aborted';
let lastTelemetryWarningMs: number | undefined;
let suppressedTelemetryWarnings = 0;

function warnTelemetryOperationFailed(operation: string, error: unknown): void {
  const now = Date.now();
  if (
    lastTelemetryWarningMs !== undefined &&
    now - lastTelemetryWarningMs < TELEMETRY_WARNING_INTERVAL_MS
  ) {
    suppressedTelemetryWarnings += 1;
    return;
  }

  const suppressedSuffix =
    suppressedTelemetryWarnings > 0
      ? `; suppressed ${suppressedTelemetryWarnings} similar warning(s)`
      : '';
  suppressedTelemetryWarnings = 0;
  lastTelemetryWarningMs = now;

  try {
    debugLogger.warn(
      `OTel span ${operation} failed: ${error instanceof Error ? error.message : String(error)}${suppressedSuffix}`,
    );
  } catch {
    // Diagnostics must not mask caller behavior.
  }
}

export function safeSetStatus(
  span: Span,
  status: Parameters<Span['setStatus']>[0],
): void {
  try {
    span.setStatus(status);
  } catch (error) {
    warnTelemetryOperationFailed('setStatus', error);
    // OTel errors must not mask caller behavior.
  }
}

/**
 * Determine whether the synthetic session root should force the SAMPLED flag.
 *
 * This function reads `OTEL_TRACES_SAMPLER` to infer the sampler type.
 * If a sampler is configured programmatically (e.g. via the tracer provider)
 * without setting the env var, this heuristic will not detect it.
 *
 * parentbased_* samplers delegate to localParentNotSampled (default AlwaysOff)
 * when the parent carries TraceFlags.NONE. Since our synthetic root is the
 * parent of all session spans, it MUST carry SAMPLED for most parentbased_*
 * samplers — otherwise zero traces are exported.
 *
 * Note: `parentbased_traceidratio` users expect probabilistic sampling, but
 * because our synthetic root is always present with SAMPLED, the ratio sampler
 * (only consulted for parentless root spans) is never invoked — they
 * effectively get 100% sampling. This is intentional: the alternative
 * (TraceFlags.NONE) would produce zero traces.
 *
 * Exception: `parentbased_always_off` explicitly wants no sampling. Forcing
 * SAMPLED would cause ParentBasedSampler to delegate to localParentSampled
 * (default AlwaysOn), sampling everything — the opposite of the user's intent.
 *
 * For non-parentbased samplers (e.g. `traceidratio`, `always_off`), each span
 * is evaluated independently regardless of parent flags, so we use NONE to
 * let the sampler decide. `always_on` is the exception — it ignores parent
 * flags, so SAMPLED is harmless and keeps the decision matrix explicit.
 */
export function shouldForceSampled(): boolean {
  const sampler =
    process.env['OTEL_TRACES_SAMPLER']?.trim().toLowerCase() ?? '';
  if (!sampler || sampler.startsWith('parentbased_')) {
    if (sampler.includes('always_off')) return false;
    return true;
  }
  return sampler === 'always_on';
}

/**
 * @deprecated No longer used for span parenting — each interaction is now a
 * trace root with its own traceId. Retained for backward compatibility
 * and existing tests.
 */
export function createSessionRootContext(sessionId: string): Context {
  const traceId = deriveTraceId(sessionId);
  const spanId = randomSpanId();
  const rootSpan = trace.wrapSpanContext({
    traceId,
    spanId,
    traceFlags: shouldForceSampled() ? TraceFlags.SAMPLED : TraceFlags.NONE,
    isRemote: false,
  });
  return trace.setSpan(ROOT_CONTEXT, rootSpan);
}
