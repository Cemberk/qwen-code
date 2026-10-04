/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

export {
  DEFAULT_SENSITIVE_SPAN_ATTRIBUTE_MAX_LENGTH,
  SENSITIVE_SPAN_ATTRIBUTE_MAX_LENGTH_LIMIT,
  isValidSensitiveSpanAttributeMaxLength,
} from './constants.js';
export {
  initializeTelemetry,
  shutdownTelemetry,
  refreshSessionContext,
  isTelemetrySdkInitialized,
} from './sdk.js';
export { resolveTelemetrySettings, parseBooleanEnvFlag } from './config.js';
export {
  logStartSession,
  logSessionEnd,
  logUserPrompt,
  logUserRetry,
  logToolCall,
  logApiRequest,
  logApiError,
  logApiCancel,
  logApiResponse,
  logGoalState,
  logSlashCommand,
  logConversationFinishedEvent,
  logKittySequenceOverflow,
  logChatCompression,
  logToolOutputTruncated,
  logRipgrepFallback,
  logRipgrepRuntimeRecovery,
  logNextSpeakerCheck,
  logAuth,
  logSkillLaunch,
  recordSkillInvocation,
  logArenaSessionStarted,
  logArenaAgentCompleted,
  logArenaSessionEnded,
  logMemoryExtract,
  logMemoryDream,
  logMemoryRecall,
  logMemoryRecallDelivery,
  logMemorySearch,
  logMemoryMigration,
  logMemoryRecallModeTransition,
} from './loggers.js';
export type {
  SlashCommandEvent,
  ChatCompressionEvent,
  GoalStateEvent,
  GoalStateEventCause,
} from './types.js';
export {
  SlashCommandStatus,
  EndSessionEvent,
  UserPromptEvent,
  UserRetryEvent,
  ApiRequestEvent,
  ApiErrorEvent,
  ApiResponseEvent,
  ApiCancelEvent,
  StartSessionEvent,
  ToolCallEvent,
  ConversationFinishedEvent,
  KittySequenceOverflowEvent,
  ToolOutputTruncatedEvent,
  RipgrepFallbackEvent,
  RipgrepRuntimeRecoveryEvent,
  NextSpeakerCheckEvent,
  AuthEvent,
  SkillLaunchEvent,
  makeArenaSessionStartedEvent,
  makeArenaAgentCompletedEvent,
  makeArenaSessionEndedEvent,
  MemoryExtractEvent,
  MemoryDreamEvent,
  MemoryRecallEvent,
  MemoryRecallDeliveryEvent,
  MemorySearchEvent,
  MemoryMigrationEvent,
  MemoryRecallModeTransitionEvent,
} from './types.js';
export {
  makeSlashCommandEvent,
  makeChatCompressionEvent,
  makeGoalStateEvent,
  GOAL_STATE_EVENT_CAUSES,
} from './types.js';
export {
  goalStateEventFromSnapshot,
  isGoalStateEventCause,
} from './goal-events.js';
export type {
  ArenaSessionStartedEvent,
  ArenaAgentCompletedEvent,
  ArenaSessionEndedEvent,
  ArenaSessionEndedStatus,
  ArenaAgentCompletedStatus,
} from './types.js';
export { SpanStatusCode, ValueType } from '@opentelemetry/api';
export { SemanticAttributes } from '@opentelemetry/semantic-conventions';
export * from './uiTelemetry.js';
export {
  recordToolCallMetrics,
  recordToolExecutionMetrics,
  recordTokenUsageMetrics,
  recordApiResponseMetrics,
  recordApiErrorMetrics,
  recordFileOperationMetric,
  recordContentRetry,
  recordContentRetryFailure,
  recordApiRetry,
  recordMemoryUsage,
  recordCpuUsage,
  recordApiRequestBreakdown,
  isPerformanceMonitoringActive,
  recordArenaSessionStartedMetrics,
  recordArenaAgentCompletedMetrics,
  recordArenaSessionEndedMetrics,
  recordGoalStateMetrics,
  recordMemoryExtractMetrics,
  recordMemoryDreamMetrics,
  recordMemoryRecallMetrics,
  recordMemoryRecallDeliveryMetrics,
  MemoryMetricType,
  ApiRequestPhase,
  FileOperation,
} from './metrics.js';
export {
  startInteractionSpan,
  endInteractionSpan,
  endLLMRequestSpan,
  startToolSpan,
  endToolSpan,
  runInToolSpanContext,
  startToolExecutionSpan,
  endToolExecutionSpan,
  startToolBlockedOnUserSpan,
  endToolBlockedOnUserSpan,
  startHookSpan,
  endHookSpan,
  startSubagentSpan,
  endSubagentSpan,
  runInSubagentSpanContext,
  getActiveInteractionSpan,
  recordInteractionActivity,
  truncateSpanError,
} from './session-tracing.js';
export type {
  StartInteractionOptions,
  StartLLMRequestSpanOptions,
  EndInteractionOptions,
  LLMRequestMetadata,
  ToolSpanMetadata,
  ToolBlockedDecision,
  ToolBlockedSource,
  HookEvent,
  StartHookSpanOptions,
  HookSpanMetadata,
  SubagentInvocationKind,
  SubagentStatus,
  StartSubagentSpanOptions,
  SubagentSpanMetadata,
} from './session-tracing.js';
export type { TelemetryRuntimeConfig } from './runtime-config.js';

export {
  addAgentInputMessageAttributes,
  addAgentOutputMessageAttributes,
  AgentOutputMessageCapture,
  addUserPromptAttributes,
  addToolArgumentsAttributes,
  addToolCallResultAttributes,
  areSensitiveSpanAttributesEnabled,
  truncateContent,
} from './detailed-span-attributes.js';
export { getTraceContext } from './trace-context.js';
export type { TraceContext } from './trace-context.js';
