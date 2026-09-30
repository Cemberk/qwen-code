/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

export interface TelemetryRuntimeConfig {
  getTelemetryEnabled(): boolean;
  getTelemetryOutfile(): string | undefined;
  getTelemetryResourceAttributes(): Record<string, string>;
  getTelemetryMetricsIncludeSessionId(): boolean;
  getTelemetryResourceAttributeWarnings(): readonly string[];
  getCliVersion(): string | undefined;
  getSessionId(): string;
}
