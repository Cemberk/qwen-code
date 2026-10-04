/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, vi, beforeEach, type Mock } from 'vitest';
import type {
  Counter,
  Meter,
  Attributes,
  Context,
  Histogram,
} from '@opentelemetry/api';
import type { Config } from '../config/config.js';
import { FileOperation, MemoryMetricType, ApiRequestPhase } from './metrics.js';
import { makeFakeConfig } from '../test-utils/config.js';
import type { GoalStateEvent } from './types.js';

const mockCounterAddFn: Mock<
  (value: number, attributes?: Attributes, context?: Context) => void
> = vi.fn();
const mockHistogramRecordFn: Mock<
  (value: number, attributes?: Attributes, context?: Context) => void
> = vi.fn();

const mockCreateCounterFn: Mock<(name: string, options?: unknown) => Counter> =
  vi.fn();
const mockCreateHistogramFn: Mock<
  (name: string, options?: unknown) => Histogram
> = vi.fn();

const mockCounterInstance: Counter = {
  add: mockCounterAddFn,
} as Partial<Counter> as Counter;

const mockHistogramInstance: Histogram = {
  record: mockHistogramRecordFn,
} as Partial<Histogram> as Histogram;

const mockMeterInstance: Meter = {
  createCounter: mockCreateCounterFn.mockReturnValue(mockCounterInstance),
  createHistogram: mockCreateHistogramFn.mockReturnValue(mockHistogramInstance),
} as Partial<Meter> as Meter;

function originalOtelMockFactory() {
  return {
    metrics: {
      getMeter: vi.fn(),
    },
    ValueType: {
      INT: 1,
      DOUBLE: 2,
    },
    diag: {
      setLogger: vi.fn(),
      warn: vi.fn(),
    },
  } as const;
}

vi.mock('@opentelemetry/api');

describe('Telemetry Metrics', () => {
  let initializeMetricsModule: typeof import('./metrics.js').initializeMetrics;
  let recordToolCallMetricsModule: typeof import('./metrics.js').recordToolCallMetrics;
  let recordTokenUsageMetricsModule: typeof import('./metrics.js').recordTokenUsageMetrics;
  let recordToolExecutionMetricsModule: typeof import('./metrics.js').recordToolExecutionMetrics;
  let recordFileOperationMetricModule: typeof import('./metrics.js').recordFileOperationMetric;
  let recordChatCompressionMetricsModule: typeof import('./metrics.js').recordChatCompressionMetrics;
  let recordMemoryUsageModule: typeof import('./metrics.js').recordMemoryUsage;
  let recordCpuUsageModule: typeof import('./metrics.js').recordCpuUsage;
  let recordApiRequestBreakdownModule: typeof import('./metrics.js').recordApiRequestBreakdown;
  let recordMemoryRecallDeliveryMetricsModule: typeof import('./metrics.js').recordMemoryRecallDeliveryMetrics;
  let recordGoalStateMetricsModule: typeof import('./metrics.js').recordGoalStateMetrics;

  beforeEach(async () => {
    vi.resetModules();
    vi.doMock('@opentelemetry/api', () => {
      const actualApi = originalOtelMockFactory();
      (actualApi.metrics.getMeter as Mock).mockReturnValue(mockMeterInstance);
      return actualApi;
    });

    const metricsJsModule = await import('./metrics.js');
    initializeMetricsModule = metricsJsModule.initializeMetrics;
    recordToolCallMetricsModule = metricsJsModule.recordToolCallMetrics;
    recordTokenUsageMetricsModule = metricsJsModule.recordTokenUsageMetrics;
    recordToolExecutionMetricsModule =
      metricsJsModule.recordToolExecutionMetrics;
    recordFileOperationMetricModule = metricsJsModule.recordFileOperationMetric;
    recordChatCompressionMetricsModule =
      metricsJsModule.recordChatCompressionMetrics;
    recordMemoryUsageModule = metricsJsModule.recordMemoryUsage;
    recordCpuUsageModule = metricsJsModule.recordCpuUsage;
    recordApiRequestBreakdownModule = metricsJsModule.recordApiRequestBreakdown;
    recordMemoryRecallDeliveryMetricsModule =
      metricsJsModule.recordMemoryRecallDeliveryMetrics;
    recordGoalStateMetricsModule = metricsJsModule.recordGoalStateMetrics;

    const otelApiModule = await import('@opentelemetry/api');

    mockCounterAddFn.mockClear();
    mockCreateCounterFn.mockClear();
    mockCreateHistogramFn.mockClear();
    mockHistogramRecordFn.mockClear();
    (otelApiModule.metrics.getMeter as Mock).mockClear();

    (otelApiModule.metrics.getMeter as Mock).mockReturnValue(mockMeterInstance);
    mockCreateCounterFn.mockReturnValue(mockCounterInstance);
    mockCreateHistogramFn.mockReturnValue(mockHistogramInstance);
  });

  describe('recordToolCallMetrics', () => {
    const config = makeFakeConfig({
      sessionId: 'test-session-id',
    });

    it('records an explicit terminal status only on the counter', () => {
      initializeMetricsModule(config);

      recordToolCallMetricsModule(config, 25, {
        function_name: 'read_file',
        success: false,
        status: 'cancelled',
        tool_type: 'native',
      });

      expect(mockCounterAddFn).toHaveBeenCalledWith(1, {
        function_name: 'read_file',
        success: false,
        status: 'cancelled',
        tool_type: 'native',
      });
      expect(mockHistogramRecordFn).toHaveBeenCalledWith(25, {
        function_name: 'read_file',
      });
    });

    it('derives status from success for legacy callers', () => {
      initializeMetricsModule(config);

      recordToolCallMetricsModule(config, 10, {
        function_name: 'legacy_tool',
        success: false,
      });

      expect(mockCounterAddFn).toHaveBeenCalledWith(1, {
        function_name: 'legacy_tool',
        success: false,
        status: 'error',
      });
    });
  });

  describe('recordChatCompressionMetrics', () => {
    it('does not record metrics if not initialized', () => {
      const lol = makeFakeConfig({});

      recordChatCompressionMetricsModule(lol, {
        tokens_after: 100,
        tokens_before: 200,
      });

      expect(mockCounterAddFn).not.toHaveBeenCalled();
    });

    it('records token compression with the correct attributes', () => {
      const config = makeFakeConfig({
        sessionId: 'test-session-id',
      });
      initializeMetricsModule(config);

      recordChatCompressionMetricsModule(config, {
        tokens_after: 100,
        tokens_before: 200,
      });

      expect(mockCounterAddFn).toHaveBeenCalledWith(1, {
        tokens_after: 100,
        tokens_before: 200,
      });
    });
  });

  describe('recordGoalStateMetrics', () => {
    const histogramSpies = new Map<string, Mock>();
    beforeEach(() => {
      histogramSpies.clear();
      mockCreateHistogramFn.mockImplementation((name: string) => {
        const record = vi.fn((...args: Parameters<Histogram['record']>) =>
          mockHistogramRecordFn(...args),
        );
        histogramSpies.set(name, record);
        return { record } as Histogram;
      });
    });

    const goalEvent = (fields: Partial<GoalStateEvent>): GoalStateEvent => ({
      'event.name': 'goal_state',
      'event.timestamp': '2025-01-01T00:00:00.000Z',
      cause: 'create',
      goal_id: 'g-1',
      revision: 1,
      ...fields,
    });

    it('records nothing before metrics are initialized', () => {
      recordGoalStateMetricsModule(
        makeFakeConfig({}),
        goalEvent({ cause: 'complete', tokens_used: 10, turn_count: 1 }),
      );

      expect(mockCounterAddFn).not.toHaveBeenCalled();
      expect(mockHistogramRecordFn).not.toHaveBeenCalled();
    });

    it('registers the Goal counter and histograms', () => {
      initializeMetricsModule(makeFakeConfig({}));

      expect(mockCreateCounterFn).toHaveBeenCalledWith(
        'qwen-code.goal.transition.count',
        expect.anything(),
      );
      expect(mockCreateHistogramFn).toHaveBeenCalledWith(
        'qwen-code.goal.tokens_used',
        expect.objectContaining({
          unit: '{token}',
          advice: {
            explicitBucketBoundaries: [
              1_000, 10_000, 100_000, 500_000, 1_000_000, 5_000_000, 10_000_000,
              30_000_000, 100_000_000, 300_000_000, 600_000_000,
            ],
          },
        }),
      );
      expect(mockCreateHistogramFn).toHaveBeenCalledWith(
        'qwen-code.goal.turn_count',
        expect.objectContaining({
          unit: '{turn}',
          advice: {
            explicitBucketBoundaries: [
              1, 5, 10, 25, 50, 100, 250, 500, 1_000, 5_000, 10_000, 25_000,
              50_000,
            ],
          },
        }),
      );
    });

    it('counts a transition by its bounded attributes only', () => {
      // The Goal id and revision are per-Goal values; on a metric they would
      // open a new time series for every Goal.
      const config = makeFakeConfig({ sessionId: 'test-session-id' });
      initializeMetricsModule(config);
      mockCounterAddFn.mockClear();

      recordGoalStateMetricsModule(
        config,
        goalEvent({
          cause: 'pause',
          status: 'paused',
          turn_count: 3,
          tokens_used: 500,
        }),
      );

      expect(mockCounterAddFn).toHaveBeenCalledWith(1, {
        cause: 'pause',
        status: 'paused',
      });
      // A pause is not an outcome, so nothing is recorded as spend.
      expect(mockHistogramRecordFn).not.toHaveBeenCalled();
    });

    it.each(['complete', 'blocked', 'usage_limited'] as const)(
      'records spend and turns on %s',
      (cause) => {
        const config = makeFakeConfig({ sessionId: 'test-session-id' });
        initializeMetricsModule(config);
        mockCounterAddFn.mockClear();
        const limitAttributes =
          cause === 'usage_limited'
            ? { limit_kind: 'time_budget' as const }
            : {};

        recordGoalStateMetricsModule(
          config,
          goalEvent({
            cause,
            status: cause,
            ...limitAttributes,
            turn_count: 12,
            tokens_used: 45_000,
          }),
        );

        expect(mockCounterAddFn).toHaveBeenCalledWith(1, {
          cause,
          status: cause,
          ...limitAttributes,
        });
        expect(
          histogramSpies.get('qwen-code.goal.tokens_used'),
        ).toHaveBeenCalledWith(45_000, {
          cause,
          ...limitAttributes,
        });
        expect(
          histogramSpies.get('qwen-code.goal.turn_count'),
        ).toHaveBeenCalledWith(12, {
          cause,
          ...limitAttributes,
        });
      },
    );

    it.each([
      'create',
      'replace',
      'edit',
      'pause',
      'resume',
      'clear',
      'verifier_reject',
    ] as const)('records no outcome figure on %s', (cause) => {
      const config = makeFakeConfig({});
      initializeMetricsModule(config);
      mockCounterAddFn.mockClear();
      recordGoalStateMetricsModule(
        config,
        goalEvent({ cause, tokens_used: 45_000, turn_count: 12 }),
      );
      expect(mockCounterAddFn).toHaveBeenCalledWith(1, { cause });
      expect(mockHistogramRecordFn).not.toHaveBeenCalled();
    });

    it('records cumulative observations on each stop of a resumed Goal', () => {
      const config = makeFakeConfig({});
      initializeMetricsModule(config);
      for (const [tokens_used, turn_count] of [
        [30_000_000, 2],
        [60_000_000, 4],
      ]) {
        recordGoalStateMetricsModule(
          config,
          goalEvent({
            cause: 'usage_limited',
            limit_kind: 'token_budget',
            tokens_used,
            turn_count,
          }),
        );
      }
      const attributes = { cause: 'usage_limited', limit_kind: 'token_budget' };
      expect(
        histogramSpies.get('qwen-code.goal.tokens_used')?.mock.calls,
      ).toEqual([
        [30_000_000, attributes],
        [60_000_000, attributes],
      ]);
      expect(
        histogramSpies.get('qwen-code.goal.turn_count')?.mock.calls,
      ).toEqual([
        [2, attributes],
        [4, attributes],
      ]);
    });

    it('records zero spend and turns on an outcome', () => {
      const config = makeFakeConfig({});
      initializeMetricsModule(config);

      recordGoalStateMetricsModule(
        config,
        goalEvent({
          cause: 'complete',
          status: 'complete',
          tokens_used: 0,
          turn_count: 0,
        }),
      );

      expect(mockHistogramRecordFn).toHaveBeenCalledTimes(2);
      expect(mockHistogramRecordFn).toHaveBeenNthCalledWith(1, 0, {
        cause: 'complete',
      });
      expect(mockHistogramRecordFn).toHaveBeenNthCalledWith(2, 0, {
        cause: 'complete',
      });
    });
  });

  describe('recordTokenUsageMetrics', () => {
    const mockConfig = {
      getSessionId: () => 'test-session-id',
      getTelemetryEnabled: () => true,
      getTelemetryMetricsIncludeSessionId: () => false,
    } as unknown as Config;

    it('should not record metrics if not initialized', () => {
      recordTokenUsageMetricsModule(mockConfig, 100, {
        model: 'gemini-pro',
        type: 'input',
      });
      expect(mockCounterAddFn).not.toHaveBeenCalled();
    });

    it('should record token usage with the correct attributes', () => {
      initializeMetricsModule(mockConfig);
      recordTokenUsageMetricsModule(mockConfig, 100, {
        model: 'gemini-pro',
        type: 'input',
      });
      expect(mockCounterAddFn).toHaveBeenCalledTimes(2);
      expect(mockCounterAddFn).toHaveBeenNthCalledWith(1, 1, {});
      expect(mockCounterAddFn).toHaveBeenNthCalledWith(2, 100, {
        model: 'gemini-pro',
        type: 'input',
      });
    });

    it('should record token usage for different types', () => {
      initializeMetricsModule(mockConfig);
      mockCounterAddFn.mockClear();

      recordTokenUsageMetricsModule(mockConfig, 50, {
        model: 'gemini-pro',
        type: 'output',
      });
      expect(mockCounterAddFn).toHaveBeenCalledWith(50, {
        model: 'gemini-pro',
        type: 'output',
      });

      recordTokenUsageMetricsModule(mockConfig, 25, {
        model: 'gemini-pro',
        type: 'thought',
      });
      expect(mockCounterAddFn).toHaveBeenCalledWith(25, {
        model: 'gemini-pro',
        type: 'thought',
      });

      recordTokenUsageMetricsModule(mockConfig, 75, {
        model: 'gemini-pro',
        type: 'cache',
      });
      expect(mockCounterAddFn).toHaveBeenCalledWith(75, {
        model: 'gemini-pro',
        type: 'cache',
      });
    });

    it('should handle different models', () => {
      initializeMetricsModule(mockConfig);
      mockCounterAddFn.mockClear();

      recordTokenUsageMetricsModule(mockConfig, 200, {
        model: 'gemini-ultra',
        type: 'input',
      });
      expect(mockCounterAddFn).toHaveBeenCalledWith(200, {
        model: 'gemini-ultra',
        type: 'input',
      });
    });
  });

  describe('recordToolExecutionMetrics', () => {
    const mockConfig = {
      getSessionId: () => 'test-session-id',
      getTelemetryEnabled: () => true,
      getTelemetryMetricsIncludeSessionId: () => false,
    } as unknown as Config;

    it('does not record before metrics are initialized', () => {
      recordToolExecutionMetricsModule(mockConfig, {
        execution_status: 'unknown',
        tool_type: 'native',
      });

      expect(mockCounterAddFn).not.toHaveBeenCalled();
    });

    it('uses a dedicated low-cardinality counter', () => {
      initializeMetricsModule(mockConfig);
      mockCounterAddFn.mockClear();

      recordToolExecutionMetricsModule(mockConfig, {
        execution_status: 'error',
        tool_type: 'mcp',
      });

      expect(mockCreateCounterFn).toHaveBeenCalledWith(
        'qwen-code.tool.execution.count',
        expect.any(Object),
      );
      expect(mockCounterAddFn).toHaveBeenCalledWith(1, {
        execution_status: 'error',
        tool_type: 'mcp',
      });
    });

    it('merges common attributes when session id is opted in', () => {
      const configWithSession = {
        ...mockConfig,
        getTelemetryMetricsIncludeSessionId: () => true,
      } as unknown as Config;
      initializeMetricsModule(configWithSession);
      mockCounterAddFn.mockClear();

      recordToolExecutionMetricsModule(configWithSession, {
        execution_status: 'success',
        tool_type: 'native',
      });

      expect(mockCounterAddFn).toHaveBeenCalledWith(1, {
        'session.id': 'test-session-id',
        execution_status: 'success',
        tool_type: 'native',
      });
    });
  });

  describe('recordFileOperationMetric', () => {
    const mockConfig = {
      getSessionId: () => 'test-session-id',
      getTelemetryEnabled: () => true,
      getTelemetryMetricsIncludeSessionId: () => false,
    } as unknown as Config;

    it('should not record metrics if not initialized', () => {
      recordFileOperationMetricModule(mockConfig, {
        operation: FileOperation.CREATE,
        lines: 10,
        mimetype: 'text/plain',
        extension: 'txt',
      });
      expect(mockCounterAddFn).not.toHaveBeenCalled();
    });

    it('should record file creation with all attributes', () => {
      initializeMetricsModule(mockConfig);
      recordFileOperationMetricModule(mockConfig, {
        operation: FileOperation.CREATE,
        lines: 10,
        mimetype: 'text/plain',
        extension: 'txt',
      });

      expect(mockCounterAddFn).toHaveBeenCalledTimes(2);
      expect(mockCounterAddFn).toHaveBeenNthCalledWith(1, 1, {});
      expect(mockCounterAddFn).toHaveBeenNthCalledWith(2, 1, {
        operation: FileOperation.CREATE,
        lines: 10,
        mimetype: 'text/plain',
        extension: 'txt',
      });
    });

    it('should record file read with minimal attributes', () => {
      initializeMetricsModule(mockConfig);
      mockCounterAddFn.mockClear();

      recordFileOperationMetricModule(mockConfig, {
        operation: FileOperation.READ,
      });
      expect(mockCounterAddFn).toHaveBeenCalledWith(1, {
        operation: FileOperation.READ,
      });
    });

    it('should record file update with some attributes', () => {
      initializeMetricsModule(mockConfig);
      mockCounterAddFn.mockClear();

      recordFileOperationMetricModule(mockConfig, {
        operation: FileOperation.UPDATE,
        mimetype: 'application/javascript',
      });
      expect(mockCounterAddFn).toHaveBeenCalledWith(1, {
        operation: FileOperation.UPDATE,
        mimetype: 'application/javascript',
      });
    });

    it('should record file operation without diffStat', () => {
      initializeMetricsModule(mockConfig);
      mockCounterAddFn.mockClear();

      recordFileOperationMetricModule(mockConfig, {
        operation: FileOperation.UPDATE,
      });

      expect(mockCounterAddFn).toHaveBeenCalledWith(1, {
        operation: FileOperation.UPDATE,
      });
    });

    it('should record minimal file operation when optional parameters are undefined', () => {
      initializeMetricsModule(mockConfig);
      mockCounterAddFn.mockClear();

      recordFileOperationMetricModule(mockConfig, {
        operation: FileOperation.UPDATE,
        lines: 10,
        mimetype: 'text/plain',
        extension: 'txt',
      });

      expect(mockCounterAddFn).toHaveBeenCalledWith(1, {
        operation: FileOperation.UPDATE,
        lines: 10,
        mimetype: 'text/plain',
        extension: 'txt',
      });
    });

    it('should not include diffStat attributes when diffStat is not provided', () => {
      initializeMetricsModule(mockConfig);
      mockCounterAddFn.mockClear();

      recordFileOperationMetricModule(mockConfig, {
        operation: FileOperation.UPDATE,
      });

      expect(mockCounterAddFn).toHaveBeenCalledWith(1, {
        operation: FileOperation.UPDATE,
      });
    });
  });

  describe('Performance Monitoring Metrics', () => {
    const mockConfig = {
      getSessionId: () => 'test-session-id',
      getTelemetryEnabled: () => true,
      getTelemetryMetricsIncludeSessionId: () => false,
    } as unknown as Config;

    describe('recordMemoryUsage', () => {
      it('should record memory usage for different memory types', () => {
        initializeMetricsModule(mockConfig);
        mockHistogramRecordFn.mockClear();

        recordMemoryUsageModule(mockConfig, 15728640, {
          memory_type: MemoryMetricType.HEAP_USED,
          component: 'startup',
        });

        expect(mockHistogramRecordFn).toHaveBeenCalledWith(15728640, {
          memory_type: 'heap_used',
          component: 'startup',
        });
      });

      it('should record memory usage for all memory metric types', () => {
        initializeMetricsModule(mockConfig);
        mockHistogramRecordFn.mockClear();

        recordMemoryUsageModule(mockConfig, 31457280, {
          memory_type: MemoryMetricType.HEAP_TOTAL,
          component: 'api_call',
        });
        recordMemoryUsageModule(mockConfig, 2097152, {
          memory_type: MemoryMetricType.EXTERNAL,
          component: 'tool_execution',
        });
        recordMemoryUsageModule(mockConfig, 41943040, {
          memory_type: MemoryMetricType.RSS,
          component: 'memory_monitor',
        });

        expect(mockHistogramRecordFn).toHaveBeenCalledTimes(3); // One for each call
        expect(mockHistogramRecordFn).toHaveBeenNthCalledWith(1, 31457280, {
          memory_type: 'heap_total',
          component: 'api_call',
        });
        expect(mockHistogramRecordFn).toHaveBeenNthCalledWith(2, 2097152, {
          memory_type: 'external',
          component: 'tool_execution',
        });
        expect(mockHistogramRecordFn).toHaveBeenNthCalledWith(3, 41943040, {
          memory_type: 'rss',
          component: 'memory_monitor',
        });
      });

      it('should record memory usage without component', () => {
        initializeMetricsModule(mockConfig);
        mockHistogramRecordFn.mockClear();

        recordMemoryUsageModule(mockConfig, 15728640, {
          memory_type: MemoryMetricType.HEAP_USED,
        });

        expect(mockHistogramRecordFn).toHaveBeenCalledWith(15728640, {
          memory_type: 'heap_used',
        });
      });
    });

    describe('recordCpuUsage', () => {
      it('should record CPU usage percentage', () => {
        initializeMetricsModule(mockConfig);
        mockHistogramRecordFn.mockClear();

        recordCpuUsageModule(mockConfig, 85.5, {
          component: 'tool_execution',
        });

        expect(mockHistogramRecordFn).toHaveBeenCalledWith(85.5, {
          component: 'tool_execution',
        });
      });

      it('should record CPU usage without component', () => {
        initializeMetricsModule(mockConfig);
        mockHistogramRecordFn.mockClear();

        recordCpuUsageModule(mockConfig, 42.3, {});

        expect(mockHistogramRecordFn).toHaveBeenCalledWith(42.3, {});
      });
    });

    describe('recordApiRequestBreakdown', () => {
      it('should record API request breakdown for all phases', () => {
        initializeMetricsModule(mockConfig);
        mockHistogramRecordFn.mockClear();

        recordApiRequestBreakdownModule(mockConfig, 15, {
          model: 'gemini-pro',
          phase: ApiRequestPhase.REQUEST_PREPARATION,
        });

        expect(mockHistogramRecordFn).toHaveBeenCalledWith(15, {
          model: 'gemini-pro',
          phase: 'request_preparation',
        });
      });

      it('should record API request breakdown for different phases', () => {
        initializeMetricsModule(mockConfig);
        mockHistogramRecordFn.mockClear();

        recordApiRequestBreakdownModule(mockConfig, 250, {
          model: 'gemini-pro',
          phase: ApiRequestPhase.NETWORK_LATENCY,
        });
        recordApiRequestBreakdownModule(mockConfig, 100, {
          model: 'gemini-pro',
          phase: ApiRequestPhase.RESPONSE_PROCESSING,
        });
        recordApiRequestBreakdownModule(mockConfig, 50, {
          model: 'gemini-pro',
          phase: ApiRequestPhase.TOKEN_PROCESSING,
        });

        expect(mockHistogramRecordFn).toHaveBeenCalledTimes(3); // One for each call
        expect(mockHistogramRecordFn).toHaveBeenNthCalledWith(1, 250, {
          model: 'gemini-pro',
          phase: 'network_latency',
        });
        expect(mockHistogramRecordFn).toHaveBeenNthCalledWith(2, 100, {
          model: 'gemini-pro',
          phase: 'response_processing',
        });
        expect(mockHistogramRecordFn).toHaveBeenNthCalledWith(3, 50, {
          model: 'gemini-pro',
          phase: 'token_processing',
        });
      });
    });
  });

  describe('metric attribute cardinality controls', () => {
    it('records memory recall delivery with low-cardinality attributes', () => {
      const config = makeFakeConfig({ sessionId: 'cardinality-test' });
      initializeMetricsModule(config);
      mockCounterAddFn.mockClear();
      mockHistogramRecordFn.mockClear();

      recordMemoryRecallDeliveryMetricsModule(config, 42, {
        phase: 'refined',
        delivery_point: 'discarded',
        discard_reason: 'reset',
        strategy: 'model',
      });

      const expectedAttrs = {
        phase: 'refined',
        delivery_point: 'discarded',
        discard_reason: 'reset',
        strategy: 'model',
      };
      expect(mockCounterAddFn).toHaveBeenCalledWith(1, expectedAttrs);
      expect(mockHistogramRecordFn).toHaveBeenCalledWith(42, expectedAttrs);
    });

    it('omits session.id from metric attributes by default', () => {
      const config = makeFakeConfig({ sessionId: 'cardinality-test' });
      initializeMetricsModule(config);
      mockCounterAddFn.mockClear();

      recordChatCompressionMetricsModule(config, {
        tokens_after: 1,
        tokens_before: 2,
      });

      const attrs = mockCounterAddFn.mock.calls[0]?.[1] ?? {};
      expect(attrs).not.toHaveProperty('session.id');
    });

    it('includes session.id when telemetry.metrics.includeSessionId is true', () => {
      const config = makeFakeConfig({
        sessionId: 'cardinality-test',
        telemetry: { metrics: { includeSessionId: true } },
      });
      initializeMetricsModule(config);
      mockCounterAddFn.mockClear();

      recordChatCompressionMetricsModule(config, {
        tokens_after: 1,
        tokens_before: 2,
      });

      const attrs = mockCounterAddFn.mock.calls[0]?.[1] ?? {};
      expect(attrs['session.id']).toBe('cardinality-test');
    });
  });
});
