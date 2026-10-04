/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { AgentStatistics } from './agent-statistics.js';

describe('AgentStatistics', () => {
  let stats: AgentStatistics;
  const baseTime = 1000000000000; // Fixed timestamp for consistent testing

  beforeEach(() => {
    stats = new AgentStatistics();
  });

  describe('basic statistics tracking', () => {
    it('should reset all statistics for a new turn', () => {
      stats.start(baseTime);
      stats.setRounds(3);
      stats.recordToolCall('file_read', false, 100, 'failed');
      stats.recordTokens(100, 50, 10, 5, 160);

      stats.reset();

      expect(stats.getSummary(baseTime + 5000)).toEqual({
        rounds: 0,
        totalDurationMs: 0,
        totalToolCalls: 0,
        successfulToolCalls: 0,
        failedToolCalls: 0,
        successRate: 0,
        inputTokens: 0,
        outputTokens: 0,
        thoughtTokens: 0,
        cachedTokens: 0,
        totalTokens: 0,
        toolUsage: [],
      });
    });

    it('should track execution time', () => {
      stats.start(baseTime);
      const summary = stats.getSummary(baseTime + 5000);

      expect(summary.totalDurationMs).toBe(5000);
    });

    it('should track rounds', () => {
      stats.setRounds(3);
      const summary = stats.getSummary();

      expect(summary.rounds).toBe(3);
    });

    it('should track tool calls', () => {
      stats.recordToolCall('file_read', true, 100);
      stats.recordToolCall('web_fetch', false, 200, 'Network timeout');

      const summary = stats.getSummary();
      expect(summary.totalToolCalls).toBe(2);
      expect(summary.successfulToolCalls).toBe(1);
      expect(summary.failedToolCalls).toBe(1);
      expect(summary.successRate).toBe(50);
    });

    it('should track tokens', () => {
      stats.recordTokens(1000, 500);
      stats.recordTokens(200, 100);

      const summary = stats.getSummary();
      expect(summary.inputTokens).toBe(1200);
      expect(summary.outputTokens).toBe(600);
      expect(summary.totalTokens).toBe(1800);
    });

    it('should track thought and cached tokens', () => {
      stats.recordTokens(100, 50, 10, 5);

      const summary = stats.getSummary();
      expect(summary.thoughtTokens).toBe(10);
      expect(summary.cachedTokens).toBe(5);
      // cachedTokens is a subset of inputTokens, not additive
      expect(summary.totalTokens).toBe(160); // 100 + 50 + 10
    });

    it('should use API-provided totalTokenCount when available', () => {
      stats.recordTokens(100, 50, 10, 5, 170);

      const summary = stats.getSummary();
      expect(summary.totalTokens).toBe(170);
    });

    it('should accumulate API totalTokenCount across rounds', () => {
      stats.recordTokens(100, 50, 0, 0, 150);
      stats.recordTokens(200, 80, 0, 0, 280);

      const summary = stats.getSummary();
      expect(summary.totalTokens).toBe(430); // 150 + 280
    });
  });

  describe('tool usage statistics', () => {
    it('should track individual tool usage', () => {
      stats.recordToolCall('file_read', true, 100);
      stats.recordToolCall('file_read', false, 150, 'Permission denied');
      stats.recordToolCall('web_fetch', true, 300);

      const summary = stats.getSummary();
      const fileReadTool = summary.toolUsage.find(
        (t) => t.name === 'file_read',
      );
      const webFetchTool = summary.toolUsage.find(
        (t) => t.name === 'web_fetch',
      );

      expect(fileReadTool).toEqual({
        name: 'file_read',
        count: 2,
        success: 1,
        failure: 1,
        lastError: 'Permission denied',
        totalDurationMs: 250,
        averageDurationMs: 125,
      });

      expect(webFetchTool).toEqual({
        name: 'web_fetch',
        count: 1,
        success: 1,
        failure: 0,
        lastError: undefined,
        totalDurationMs: 300,
        averageDurationMs: 300,
      });
    });
  });

  describe('formatCompact', () => {
    it('should format basic execution summary', () => {
      stats.start(baseTime);
      stats.setRounds(2);
      stats.recordToolCall('file_read', true, 100);
      stats.recordTokens(1000, 500, 20, 10);

      const result = stats.formatCompact('Test task', baseTime + 5000);

      expect(result).toContain('▸ Task Completed: Test task');
      expect(result).toContain('● Tool Usage: 1 calls, 100.0% success');
      expect(result).toContain('● Duration: 5.0s | ● Rounds: 2');
      expect(result).toContain('● Tokens: 1,520 (in 1000, out 500)');
    });

    it('should handle zero tool calls', () => {
      stats.start(baseTime);

      const result = stats.formatCompact('Empty task', baseTime + 1000);

      expect(result).toContain('● Tool Usage: 0 calls');
      expect(result).not.toContain('% success');
    });

    it('should show zero tokens when no tokens recorded', () => {
      stats.start(baseTime);
      stats.recordToolCall('test', true, 100);

      const result = stats.formatCompact('No tokens task', baseTime + 1000);

      expect(result).toContain('● Tokens: 0');
    });
  });

  describe('duration formatting', () => {
    it('should format milliseconds', () => {
      stats.start(baseTime);
      const result = stats.formatCompact('Quick task', baseTime + 500);
      expect(result).toContain('500ms');
    });

    it('should format seconds', () => {
      stats.start(baseTime);
      const result = stats.formatCompact('Second task', baseTime + 2500);
      expect(result).toContain('2.5s');
    });

    it('should format minutes and seconds', () => {
      stats.start(baseTime);
      const result = stats.formatCompact('Minute task', baseTime + 125000);
      expect(result).toContain('2m 5s');
    });

    it('should format hours and minutes', () => {
      stats.start(baseTime);
      const result = stats.formatCompact('Hour task', baseTime + 4500000);
      expect(result).toContain('1h 15m');
    });
  });
});
