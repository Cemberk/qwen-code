/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { metrics } from '@opentelemetry/api';
import { logs } from '@opentelemetry/api-logs';
import {
  initializeTelemetry,
  shutdownTelemetry,
  isTelemetrySdkInitialized,
} from './sdk.js';
import { Config } from '../config/config.js';
import { NodeTracerProvider } from '@opentelemetry/sdk-trace-node';
import { LoggerProvider } from '@opentelemetry/sdk-logs';
import { MeterProvider } from '@opentelemetry/sdk-metrics';

vi.mock('@opentelemetry/sdk-trace-node');
vi.mock('@opentelemetry/sdk-logs');
vi.mock('@opentelemetry/sdk-metrics');
vi.mock('../config/config.js');
vi.mock('./file-exporters.js');

describe('telemetry', () => {
  let mockConfig: Config;

  beforeEach(() => {
    vi.resetAllMocks();
    // Keep the mocked providers out of the process-wide OTel globals.
    vi.spyOn(metrics, 'setGlobalMeterProvider').mockReturnValue(true);
    vi.spyOn(logs, 'setGlobalLoggerProvider').mockImplementation((p) => p);

    mockConfig = new Config({
      model: 'test-model',
      targetDir: '/test/dir',
      debugMode: false,
      cwd: '/test/dir',
    });
    vi.spyOn(mockConfig, 'getTelemetryEnabled').mockReturnValue(true);
    vi.spyOn(mockConfig, 'getTelemetryOutfile').mockReturnValue(
      '/tmp/qwen-telemetry-test.log',
    );
    vi.spyOn(mockConfig, 'getSessionId').mockReturnValue('test-session-id');
  });

  afterEach(async () => {
    // Ensure we shut down telemetry even if a test fails.
    if (isTelemetrySdkInitialized()) {
      await shutdownTelemetry();
    }
  });

  it('should initialize the telemetry service', async () => {
    await initializeTelemetry(mockConfig);
    expect(NodeTracerProvider.prototype.register).toHaveBeenCalled();
    expect(metrics.setGlobalMeterProvider).toHaveBeenCalled();
    expect(logs.setGlobalLoggerProvider).toHaveBeenCalled();
  });

  it('should shutdown the telemetry service', async () => {
    await initializeTelemetry(mockConfig);
    await shutdownTelemetry();

    expect(NodeTracerProvider.prototype.shutdown).toHaveBeenCalled();
    expect(LoggerProvider.prototype.shutdown).toHaveBeenCalled();
    expect(MeterProvider.prototype.shutdown).toHaveBeenCalled();
  });
});
