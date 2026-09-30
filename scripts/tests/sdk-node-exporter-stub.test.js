/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import {
  SDK_NODE_STUBBED_EXPORTERS,
  isStubbedSdkNodeExporterImport,
} from '../sdk-node-exporter-stub.js';

describe('SDK_NODE_STUBBED_EXPORTERS', () => {
  it('matches the OTLP exporter packages across every transport', () => {
    for (const signal of ['trace', 'logs', 'metrics']) {
      for (const transport of ['grpc', 'http', 'proto']) {
        expect(
          SDK_NODE_STUBBED_EXPORTERS.test(
            `@opentelemetry/exporter-${signal}-otlp-${transport}`,
          ),
        ).toBe(true);
      }
    }
    expect(
      SDK_NODE_STUBBED_EXPORTERS.test('@opentelemetry/exporter-zipkin'),
    ).toBe(true);
    expect(
      SDK_NODE_STUBBED_EXPORTERS.test('@opentelemetry/exporter-prometheus'),
    ).toBe(true);
  });

  it('matches the sdk-node 0.221 env auto-configuration helper packages', () => {
    expect(
      SDK_NODE_STUBBED_EXPORTERS.test('@opentelemetry/configuration'),
    ).toBe(true);
    expect(
      SDK_NODE_STUBBED_EXPORTERS.test('@opentelemetry/otlp-exporter-base'),
    ).toBe(true);
    expect(
      SDK_NODE_STUBBED_EXPORTERS.test('@opentelemetry/otlp-grpc-exporter-base'),
    ).toBe(true);
  });

  it('does not match non-exporter or unrelated packages', () => {
    expect(SDK_NODE_STUBBED_EXPORTERS.test('@opentelemetry/sdk-node')).toBe(
      false,
    );
    expect(SDK_NODE_STUBBED_EXPORTERS.test('@opentelemetry/api')).toBe(false);
    // Subpath imports must not match — the anchor is end-of-string.
    expect(
      SDK_NODE_STUBBED_EXPORTERS.test(
        '@opentelemetry/exporter-trace-otlp-grpc/build/src/index.js',
      ),
    ).toBe(false);
    expect(
      SDK_NODE_STUBBED_EXPORTERS.test(
        '@opentelemetry/configuration/build/src/index.js',
      ),
    ).toBe(false);
  });
});

describe('isStubbedSdkNodeExporterImport', () => {
  it('stubs every import of a stubbed exporter package', () => {
    for (const packageName of [
      '@opentelemetry/exporter-trace-otlp-grpc',
      '@opentelemetry/exporter-metrics-otlp-http',
      '@opentelemetry/configuration',
      '@opentelemetry/otlp-exporter-base',
      '@opentelemetry/otlp-grpc-exporter-base',
    ]) {
      expect(isStubbedSdkNodeExporterImport(packageName)).toBe(true);
    }
  });

  it('does not stub non-exporter packages', () => {
    expect(
      isStubbedSdkNodeExporterImport('@opentelemetry/otlp-transformer'),
    ).toBe(false);
    expect(isStubbedSdkNodeExporterImport('@opentelemetry/sdk-node')).toBe(
      false,
    );
  });
});
