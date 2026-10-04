/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

export interface ToolUsageStats {
  name: string;
  count: number;
  success: number;
  failure: number;
  lastError?: string;
  totalDurationMs: number;
  averageDurationMs: number;
}

export interface AgentStatsSummary {
  rounds: number;
  totalDurationMs: number;
  totalToolCalls: number;
  successfulToolCalls: number;
  failedToolCalls: number;
  successRate: number;
  inputTokens: number;
  outputTokens: number;
  thoughtTokens: number;
  cachedTokens: number;
  totalTokens: number;
  toolUsage: ToolUsageStats[];
}

export class AgentStatistics {
  private startTimeMs = 0;
  private rounds = 0;
  private totalToolCalls = 0;
  private successfulToolCalls = 0;
  private failedToolCalls = 0;
  private inputTokens = 0;
  private outputTokens = 0;
  private thoughtTokens = 0;
  private cachedTokens = 0;
  private apiTotalTokens = 0;
  private toolUsage = new Map<string, ToolUsageStats>();

  reset(): void {
    this.startTimeMs = 0;
    this.rounds = 0;
    this.totalToolCalls = 0;
    this.successfulToolCalls = 0;
    this.failedToolCalls = 0;
    this.inputTokens = 0;
    this.outputTokens = 0;
    this.thoughtTokens = 0;
    this.cachedTokens = 0;
    this.apiTotalTokens = 0;
    this.toolUsage.clear();
  }

  start(now = Date.now()) {
    this.startTimeMs = now;
  }

  setRounds(rounds: number) {
    this.rounds = rounds;
  }

  recordToolCall(
    name: string,
    success: boolean,
    durationMs: number,
    lastError?: string,
  ) {
    this.totalToolCalls += 1;
    if (success) this.successfulToolCalls += 1;
    else this.failedToolCalls += 1;

    const tu = this.toolUsage.get(name) || {
      name,
      count: 0,
      success: 0,
      failure: 0,
      lastError: undefined,
      totalDurationMs: 0,
      averageDurationMs: 0,
    };
    tu.count += 1;
    if (success) tu.success += 1;
    else tu.failure += 1;
    if (lastError) tu.lastError = lastError;
    tu.totalDurationMs += Math.max(0, durationMs || 0);
    tu.averageDurationMs = tu.count > 0 ? tu.totalDurationMs / tu.count : 0;
    this.toolUsage.set(name, tu);
  }

  recordTokens(
    input: number,
    output: number,
    thought: number = 0,
    cached: number = 0,
    total: number = 0,
  ) {
    this.inputTokens += Math.max(0, input || 0);
    this.outputTokens += Math.max(0, output || 0);
    this.thoughtTokens += Math.max(0, thought || 0);
    this.cachedTokens += Math.max(0, cached || 0);
    this.apiTotalTokens += Math.max(0, total || 0);
  }

  getSummary(now = Date.now()): AgentStatsSummary {
    const totalDurationMs = this.startTimeMs ? now - this.startTimeMs : 0;
    const totalToolCalls = this.totalToolCalls;
    const successRate =
      totalToolCalls > 0
        ? (this.successfulToolCalls / totalToolCalls) * 100
        : 0;
    const totalTokens =
      this.apiTotalTokens > 0
        ? this.apiTotalTokens
        : this.inputTokens + this.outputTokens + this.thoughtTokens;
    return {
      rounds: this.rounds,
      totalDurationMs,
      totalToolCalls,
      successfulToolCalls: this.successfulToolCalls,
      failedToolCalls: this.failedToolCalls,
      successRate,
      inputTokens: this.inputTokens,
      outputTokens: this.outputTokens,
      thoughtTokens: this.thoughtTokens,
      cachedTokens: this.cachedTokens,
      totalTokens,
      toolUsage: Array.from(this.toolUsage.values()),
    };
  }

  formatCompact(taskDesc: string, now = Date.now()): string {
    const stats = this.getSummary(now);
    const sr =
      stats.totalToolCalls > 0
        ? (stats.successRate ??
          (stats.successfulToolCalls / stats.totalToolCalls) * 100)
        : 0;
    const lines = [
      `▸ Task Completed: ${taskDesc}`,
      `● Tool Usage: ${stats.totalToolCalls} calls${stats.totalToolCalls ? `, ${sr.toFixed(1)}% success` : ''}`,
      `● Duration: ${this.fmtDuration(stats.totalDurationMs)} | ● Rounds: ${stats.rounds}`,
    ];
    if (typeof stats.totalTokens === 'number') {
      const parts = [
        `in ${stats.inputTokens ?? 0}`,
        `out ${stats.outputTokens ?? 0}`,
      ];
      lines.push(
        `● Tokens: ${stats.totalTokens.toLocaleString()}${parts.length ? ` (${parts.join(', ')})` : ''}`,
      );
    }
    return lines.join('\n');
  }

  private fmtDuration(ms: number): string {
    if (ms < 1000) return `${Math.round(ms)}ms`;
    if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
    if (ms < 3600000) {
      const m = Math.floor(ms / 60000);
      const s = Math.floor((ms % 60000) / 1000);
      return `${m}m ${s}s`;
    }
    const h = Math.floor(ms / 3600000);
    const m = Math.floor((ms % 3600000) / 60000);
    return `${h}h ${m}m`;
  }
}
