/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Shared logic for the esbuild plugin that stubs the network exporter packages
 * `@opentelemetry/sdk-node` eagerly require()s for env-based auto-configuration
 * (issue #7264). qwen-code only writes telemetry to a local file, so no bundled
 * module may load a network exporter. Extracted from esbuild.config.js so the
 * resolve decision is unit-testable without running a full bundle.
 */

// Exporter packages sdk-node eagerly require()s: the three OTLP signals across
// grpc/http/proto transports, plus zipkin and prometheus. From sdk-node 0.221
// on, the env auto-configuration helpers were extracted into
// `@opentelemetry/configuration`, `@opentelemetry/otlp-exporter-base`, and
// `@opentelemetry/otlp-grpc-exporter-base`, which sdk-node's utils/start
// modules now require eagerly; the grpc one pulls @grpc/grpc-js and
// protobufjs, so all three need the same stub treatment.
export const SDK_NODE_STUBBED_EXPORTERS = new RegExp(
  '^@opentelemetry/(' +
    [
      'exporter-trace-otlp-(grpc|http|proto)',
      'exporter-logs-otlp-(grpc|http|proto)',
      'exporter-metrics-otlp-(grpc|http|proto)',
      'exporter-zipkin',
      'exporter-prometheus',
      'configuration',
      'otlp-exporter-base',
      'otlp-grpc-exporter-base',
    ].join('|') +
    ')$',
);

/**
 * Decide whether an esbuild import should resolve to the loud stub: every
 * import of a stubbed exporter package does, whoever the importer is.
 */
export function isStubbedSdkNodeExporterImport(importPath) {
  return SDK_NODE_STUBBED_EXPORTERS.test(importPath);
}
