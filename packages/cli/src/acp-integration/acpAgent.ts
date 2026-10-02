/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { prepareFileWatchersForProcessExit } from '@qwen-code/qwen-code-core/utils/file-watcher-cleanup.js';
import {
  type ContentGeneratorConfig,
  APPROVAL_MODE_INFO,
  APPROVAL_MODES,
  AuthType,
  ALL_PROVIDERS,
  applyProviderInstallPlan,
  buildInstallPlan,
  getLocalBaseUrlError,
  getProviderModels,
  createDebugLogger,
  findProviderById,
  getAllMemoryFilenames,
  getAutoMemoryRoot,
  getUserAutoMemoryRoot,
  getScopedEnvContents,
  MCPServerConfig,
  SessionIdCaseConflictError,
  SessionService,
  SESSION_WRITER_RPC_CODES,
  SessionWriterUnavailableError,
  SESSION_TITLE_MAX_LENGTH,
  Storage,
  tokenLimit,
  initializeTelemetry,
  preloadContentGenerator,
  McpTransportPool,
  POOLED_TRANSPORTS_DEFAULT,
  findExistingProviderModels,
  ExtensionManager,
  ExtensionSettingScope,
  HookEventName,
  updateSetting,
  SessionEndReason,
  WorkspaceMcpBudget,
  restoreWorktreeContext,
  uiTelemetryService,
  SESSION_TRANSCRIPT_MAX_LIMIT,
  SessionTranscriptPageTooLargeError,
  SessionTranscriptSnapshotUnavailableError,
  SessionTranscriptTooLargeError,
  parseGoalSnapshotV2,
  parseGoalStateCause,
  IMAGE_CAPABILITY,
  registerAcpEventLoopLagGauge,
  SESSION_ARTIFACT_PERSISTENCE_VERSION,
  startEventLoopLagMonitor,
  REASONING_EFFORT_TIERS,
  addDaemonRequestAttribute,
  extractDaemonTraceContext,
  withDaemonSpan,
  ApprovalMode,
  type Config,
  type ConfigInitializeOptions,
  type McpBudgetEvent,
  type McpBudgetMode,
  type McpTransportKind,
  type ProviderConfig,
  type ProviderModelConfig,
  type ProviderSetupInputs,
  type ResumedSessionData,
  type SelectiveSessionRestoreOptions,
  type SessionLiveRestoreProjection,
  type SessionRestoreProjection,
  type ChatRecord,
  type WorkflowParams,
  type WorkflowToolResult,
  type WorkflowRunRegistry,
  isTerminalWorkflowStatus,
  listWorkflowSnapshots,
  claimInterruptedWorkflowRuns,
  sessionIdContext,
} from '@qwen-code/qwen-code-core';
import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { isDeepStrictEqual } from 'node:util';
import {
  AgentSideConnection,
  RequestError,
  PROTOCOL_VERSION,
} from '@agentclientprotocol/sdk';
import { isNotCurrentlyGeneratingCancelError } from '@qwen-code/acp-bridge/bridgeErrors';
import type { Content } from '@google/genai';
import type {
  Agent,
  AuthenticateRequest,
  CancelNotification,
  ClientCapabilities,
  InitializeRequest,
  InitializeResponse,
  ListSessionsRequest,
  ListSessionsResponse,
  LoadSessionRequest,
  LoadSessionResponse,
  McpServer,
  McpServerStdio,
  NewSessionRequest,
  NewSessionResponse,
  PromptRequest,
  PromptResponse,
  ResumeSessionRequest,
  ResumeSessionResponse,
  SessionConfigOption,
  SessionInfo,
  SessionUpdate,
  SessionModeState,
  SetSessionConfigOptionRequest,
  SetSessionConfigOptionResponse,
  SetSessionModelRequest,
  SetSessionModelResponse,
  SetSessionModeRequest,
  SetSessionModeResponse,
} from '@agentclientprotocol/sdk';
import { pickAuthMethodsForAuthRequired } from './authMethods.js';
import { AcpFileSystemService } from './service/filesystem.js';
import { ndJsonStream } from '@qwen-code/acp-bridge/ndJsonStream';
import { createAcpOutput } from './acp-output.js';
import { observeAcpToolResultWire } from '../nonInteractive/tool-result-boundary-diagnostics.js';
import { Readable } from 'node:stream';
import {
  SESSION_EXECUTION_ENGINE_META_KEY,
  SessionExecutionEngineError,
  type SessionExecutionEngine,
} from '@qwen-code/qwen-code-core/services/session-execution-engine.js';
import { realpathSync } from 'node:fs';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import type { LoadedSettings } from '../config/settings.js';
import {
  loadSettings,
  reloadEnvironment,
  SettingScope,
} from '../config/settings.js';
import { loadSettingsCached } from '../config/settings-cache.js';
import {
  normalizeSessionIdForLookup,
  parseCallerSuppliedSessionId,
} from '../config/session-id.js';
import {
  REDACTED_MCP_SECRET,
  redactMcpServerSecrets,
  restoreRedactedMcpSecrets,
} from '../config/mcp-server-secrets.js';
import {
  buildPermissionSettings,
  normalizePermissionRules,
  PermissionRulesValidationError,
  PERMISSION_RULE_TYPES,
  readPermissionRuleSet,
  type PermissionRuleSet,
} from '../config/permission-settings.js';
import { createLoadedSettingsAdapter } from '../config/loadedSettingsAdapter.js';
import {
} from '../utils/conversation-directory-identity.js';
import type { ApprovalModeValue } from './session/types.js';
import { z } from 'zod';
import type { CliArgs } from '../config/config.js';
import {
  buildDisabledSkillNamesProvider,
  buildEnabledSkillNamesProvider,
  loadCliConfig,
  SessionIdConflictError,
} from '../config/config.js';
import {
} from '../runtime/workspace-remember-errors.js';
import { Session } from './session/Session.js';
import { restoreSessionModelThenAuthenticate } from './session-model-persistence.js';
import { applyRestoredSessionApprovalMode } from './session-approval-mode-persistence.js';
import { HistoryReplayer } from './session/history-replayer.js';
import { renderPreparedGoalUpdate } from './session/recovered-goal-update.js';
import {
  applyReasoningSelection,
  buildModelReasoningConfigOption,
  clearReasoningRequestOverrides,
  getConfiguredModelReasoning,
  getDefaultReasoningConfig,
  getGptReasoningOverrideState,
  isReasoningSelectionSupported,
  PERSIST_REASONING_SELECTION_META_KEY,
  parseReasoningSelection,
  REASONING_SELECTION_PERSISTED_META_KEY,
  REASONING_EFFORT_DEFAULT,
  REASONING_EFFORT_NAMES,
  REASONING_EFFORT_NONE,
  type ModelReasoningConfiguration,
  type ReasoningSelection,
} from './model-configuration.js';
import {
  deleteManagedSkill,
  setManagedSkillEnabled,
} from './skill-management.js';
import {
  collectHistoryReplayUpdates,
  copyCumulativeUsage,
  createReplayCumulativeUsage,
  degradeReplayEnvelopeAppHtml,
  HistoryReplayLimitError,
} from './session/history-replay-page.js';
import {
  ACP_ROUTE_ID_PREFIX,
  buildAcpModelOptions,
  getCurrentAcpModelId,
  sanitizeProviderBaseUrl,
} from '../utils/acpModelUtils.js';
import {
  updateOutputLanguageFile,
} from '../i18n/languageUtils.js';
import { runWithAcpRuntimeOutputDir } from './runtimeOutputDirContext.js';
import { ACP_ERROR_CODES } from './errorCodes.js';
import { runExitCleanup } from '../utils/cleanup.js';
import { startNonInteractiveOpenAILogHousekeeping } from '../services/housekeeping/scheduler.js';
import {
  getCurrentLanguage,
} from '../i18n/index.js';
import {
  isWorkspaceTrusted,
} from '../config/trustedFolders.js';
import {
  DAEMON_OWNED_STANDALONE_CREATION_KEY,
  isReservedStandaloneSessionSourceType,
  SESSION_SOURCE_META_KEY,
} from '@qwen-code/acp-bridge/sessionSource';
import {
  type ActiveWorkHoldV1,
  DAEMON_CHANNEL_DELIVERY_META_KEY,
  DAEMON_PROMPT_DISPLAY_TEXT_META_KEY,
  DAEMON_SUBMITTED_PROMPT_META_KEY,
  SUBMITTED_PROMPT_META_KEY,
  DAEMON_RESTORE_ASK_USER_QUESTION_META_KEY,
  DAEMON_SUPPRESS_RESTORE_ASK_USER_QUESTION_META_KEY,
  DAEMON_SUPPRESS_WORKTREE_CONTEXT_RESTORE_META_KEY,
  LOAD_REPLAY_BULK_MODE,
  LOAD_REPLAY_HIDE_INHERITED_META_KEY,
  LOAD_REPLAY_MAX_BYTES,
  LOAD_REPLAY_MAX_UPDATES,
  LOAD_REPLAY_META_KEY,
  LOAD_REPLAY_MODE_META_KEY,
  LOAD_REPLAY_PAGE_SIZE_META_KEY,
  LOAD_REPLAY_VERSION,
  REQUESTED_SESSION_ID_META_KEY,
  SESSION_MODEL_PERSIST_DEFAULT_META_KEY,
  WORKTREE_MCP_DEFER_META_KEY,
  type BridgeLoadReplayEnvelope,
} from '@qwen-code/acp-bridge/bridgeTypes';
import { fireSessionDeleteHook } from '../hooks/session-delete-hook.js';

const debugLogger = createDebugLogger('ACP_AGENT');
const QWEN_ACP_LOCAL_READ_ROOTS_ENV = 'QWEN_ACP_LOCAL_READ_ROOTS';
const POSIX_TMP_LOCAL_READ_ROOT = '/tmp';
const SESSION_DRAIN_TIMEOUT_MS = 30_000;
const ACP_EVENT_LOOP_STALL_RESTART_MS = 5 * 60 * 1000;
const SESSION_ID_RE = /^[0-9a-fA-F-]{32,36}$/;


type AcpSessionProfileStage =
  | 'settings_load'
  | 'live_restore'
  | 'existence_check'
  | 'config_setup'
  | 'restore_approval_mode'
  | 'restore_session_model'
  | 'auth'
  | 'file_system_setup'
  | 'session_register'
  | 'runtime_initialize'
  | 'response_build'
  | 'history_replay'
  | 'post_replay_services';

interface AcpSessionProfileSpan {
  setAttribute(name: string, value: string | number | boolean): unknown;
}

function createAcpSessionProfiler(
  span: AcpSessionProfileSpan | undefined,
  attributePrefix: 'session_start' | 'session_restore',
) {
  let failedStage: AcpSessionProfileStage | undefined;
  const setAttribute = (
    name: string,
    value: string | number | boolean,
  ): void => {
    try {
      span?.setAttribute(name, value);
    } catch {
      // Telemetry must not affect session creation or restore.
    }
  };
  const recordStage = (stage: AcpSessionProfileStage, start: number): void => {
    const durationMs = Math.round((performance.now() - start) * 100) / 100;
    if (Number.isFinite(durationMs) && durationMs >= 0) {
      setAttribute(
        `qwen-code.daemon.${attributePrefix}.${stage}_ms`,
        durationMs,
      );
    }
  };
  const recordFailure = (stage: AcpSessionProfileStage): void => {
    if (failedStage !== undefined) return;
    failedStage = stage;
    setAttribute(`qwen-code.daemon.${attributePrefix}.failed_stage`, stage);
  };

  return {
    fail(stage: AcpSessionProfileStage): void {
      recordFailure(stage);
    },
    async time<T>(
      stage: AcpSessionProfileStage,
      fn: () => T | Promise<T>,
    ): Promise<T> {
      if (!span) return await fn();
      const start = performance.now();
      try {
        return await fn();
      } catch (error) {
        recordFailure(stage);
        throw error;
      } finally {
        recordStage(stage, start);
      }
    },
    timeSync<T>(stage: AcpSessionProfileStage, fn: () => T): T {
      if (!span) return fn();
      const start = performance.now();
      try {
        return fn();
      } catch (error) {
        recordFailure(stage);
        throw error;
      } finally {
        recordStage(stage, start);
      }
    },
    setSessionId(sessionId: string): void {
      setAttribute('session.id', sessionId);
    },
  };
}

function createAcpSessionStartProfiler(
  span: AcpSessionProfileSpan | undefined,
) {
  return createAcpSessionProfiler(span, 'session_start');
}

function createAcpSessionRestoreProfiler(
  span: AcpSessionProfileSpan | undefined,
) {
  return createAcpSessionProfiler(span, 'session_restore');
}

type AcpSessionRestoreProfiler = ReturnType<
  typeof createAcpSessionRestoreProfiler
>;

const SESSION_WRITER_MESSAGES = {
  session_writer_conflict:
    'This session is already open in another Qwen process.',
  session_writer_lost: 'Write ownership for this session was lost.',
  session_transcript_changed:
    'The session transcript changed outside its active writer.',
  session_writer_unavailable: 'Session write ownership could not be verified.',
} as const;

function getSessionWriterError(error: unknown):
  | {
      rpcCode: number;
      errorKind: keyof typeof SESSION_WRITER_RPC_CODES;
      message: string;
    }
  | undefined {
  if (!error || typeof error !== 'object') return undefined;
  const candidate = error as Record<string, unknown>;
  const errorKind = candidate['errorKind'];
  if (
    typeof errorKind !== 'string' ||
    !(errorKind in SESSION_WRITER_RPC_CODES)
  ) {
    return undefined;
  }
  const typedKind = errorKind as keyof typeof SESSION_WRITER_RPC_CODES;
  if (candidate['rpcCode'] !== SESSION_WRITER_RPC_CODES[typedKind]) {
    return undefined;
  }
  return {
    rpcCode: SESSION_WRITER_RPC_CODES[typedKind],
    errorKind: typedKind,
    message: SESSION_WRITER_MESSAGES[typedKind],
  };
}

function mapSessionWriterRequestError(error: unknown): unknown {
  const writerError = getSessionWriterError(error);
  return writerError
    ? new RequestError(writerError.rpcCode, writerError.message, {
        errorKind: writerError.errorKind,
      })
    : error;
}

async function shutdownSessionConfig(config: Config): Promise<void> {
  await config.shutdown({ shutdownTelemetry: false });
  if (config.hasSessionWriteOwnership()) {
    throw new SessionWriterUnavailableError();
  }
}

async function waitForSessionDrain(
  operation: Promise<void>,
  timeoutMs: number,
  kind: 'close' | 'restore',
  displayTimeoutMs?: number,
): Promise<void> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () =>
        reject(
          new Error(
            `Session ${kind} timed out after ${displayTimeoutMs ?? timeoutMs}ms`,
          ),
        ),
      timeoutMs,
    );
    timer.unref();
  });
  try {
    await Promise.race([operation, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function beginSessionCloseAfterCurrentGate(
  session: Session,
  timeoutMs: number,
): Promise<() => void> {
  const deadline = Date.now() + timeoutMs;
  while (true) {
    const releaseGate = session.beginCloseIfAvailable();
    if (releaseGate) return releaseGate;
    const remainingMs = deadline - Date.now();
    if (remainingMs <= 0) {
      throw new Error(`Session close timed out after ${timeoutMs}ms`);
    }
    await waitForSessionDrain(
      session.waitForCloseGateToRelease(),
      remainingMs,
      'close',
    );
  }
}

function parseAcpLocalReadRootsEnv(
  raw = process.env[QWEN_ACP_LOCAL_READ_ROOTS_ENV],
): string[] {
  if (!raw) return [];

  return raw
    .split(path.delimiter)
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0 && path.isAbsolute(entry));
}

function defaultAcpOnlyLocalReadRoots(): string[] {
  return process.platform === 'win32' ? [] : [POSIX_TMP_LOCAL_READ_ROOT];
}

function buildAcpLocalReadRoots(config: Config): string[] {
  return [
    // SYNC: The first group mirrors ReadFileTool's default allowed local roots,
    // including auto-memory roots. The ACP-only additions below expand only
    // local read fallback, not read_file's default permission.
    config.storage.getProjectTempDir(),
    path.join(config.storage.getProjectDir(), 'subagents'),
    path.join(config.getSessionRuntimeBaseDir(), 'tmp'),
    getAutoMemoryRoot(config.getTargetDir()),
    getUserAutoMemoryRoot(),
    ...config.storage.getUserSkillsDirs(),
    Storage.getUserExtensionsDir(),
    // Saved plan files (see ReadFileTool.getDefaultPermission for why the
    // plans dir must be readable without a confirmation prompt).
    config.getPlansDir(),
    Storage.getUserWorkflowsDir(),
    // Workflow run artifacts: resume journals, run snapshots, and persisted
    // inline scripts named by workflow results and notifications.
    config.storage.getWorkflowRunsDir(),
    ...defaultAcpOnlyLocalReadRoots(),
    ...parseAcpLocalReadRootsEnv(),
  ];
}

function isObjectRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isBulkLoadReplayRequest(params: LoadSessionRequest): boolean {
  const meta = isObjectRecord(params._meta) ? params._meta : undefined;
  return meta?.[LOAD_REPLAY_MODE_META_KEY] === LOAD_REPLAY_BULK_MODE;
}

function shouldHideInheritedHistory(params: LoadSessionRequest): boolean {
  const meta = isObjectRecord(params._meta) ? params._meta : undefined;
  return meta?.[LOAD_REPLAY_HIDE_INHERITED_META_KEY] === true;
}

function loadRestoreOptions(
  params: LoadSessionRequest,
): SelectiveSessionRestoreOptions {
  const hideInheritedHistory = shouldHideInheritedHistory(params);
  if (!isBulkLoadReplayRequest(params)) {
    return { replay: { kind: 'all', hideInheritedHistory } };
  }
  const limit = getLoadReplayPageSize(params);
  return limit === undefined
    ? { replay: { kind: 'all', hideInheritedHistory } }
    : { replay: { kind: 'recent', limit, hideInheritedHistory } };
}

const RESUME_RESTORE_OPTIONS: SelectiveSessionRestoreOptions = {
  replay: { kind: 'none' },
};

async function resolvePersistedSessionIdForRestore(
  sessionService: SessionService,
  sessionId: string,
): Promise<string | undefined> {
  try {
    return await sessionService.findSessionIdIgnoringCase(sessionId);
  } catch (error) {
    if (
      error instanceof SessionIdCaseConflictError &&
      error.reason === 'case_conflict' &&
      error.candidateSessionId === sessionId
    ) {
      return sessionId;
    }
    if (error instanceof SessionIdCaseConflictError) {
      throw RequestError.internalError(
        { errorKind: 'session_conflict', sessionId },
        error.message,
      );
    }
    throw error;
  }
}

/**
 * A paired Bridge names the engine it selected; this host only executes
 * Legacy sessions, so any other selection is refused before session work.
 */
function requestedExecutionEngine(
  meta: Record<string, unknown> | null | undefined,
  sessionId: string | undefined,
): SessionExecutionEngine | undefined {
  const engine = meta?.[SESSION_EXECUTION_ENGINE_META_KEY];
  if (engine === undefined || engine === 'legacy') return engine;
  throw new RequestError(
    -32024,
    'This ACP host only executes legacy sessions.',
    {
      errorKind: 'session_execution_engine_unavailable',
      ...(sessionId !== undefined ? { sessionId } : {}),
    },
  );
}

function withExecutionEngineReceipt<
  T extends { _meta?: Record<string, unknown> | null },
>(response: T, engine: SessionExecutionEngine | undefined): T {
  if (engine === undefined) return response;
  return {
    ...response,
    _meta: { ...response._meta, [SESSION_EXECUTION_ENGINE_META_KEY]: engine },
  };
}

function mapSessionRestoreRequestError(
  error: unknown,
  sessionId: string,
): unknown {
  const mappedWriterError = mapSessionWriterRequestError(error);
  if (mappedWriterError !== error) return mappedWriterError;
  if (error instanceof SessionExecutionEngineError) {
    return new RequestError(-32024, error.message, {
      errorKind: error.errorKind,
      sessionId,
    });
  }
  if (error instanceof SessionTranscriptSnapshotUnavailableError) {
    return new RequestError(-32010, error.message, {
      errorKind: 'transcript_snapshot_unavailable',
      sessionId,
    });
  }
  if (error instanceof SessionTranscriptTooLargeError) {
    return new RequestError(-32011, error.message, {
      errorKind: 'transcript_too_large',
      sessionId,
      snapshotSize: error.snapshotSize,
      maxBytes: error.maxBytes,
    });
  }
  if (error instanceof SessionTranscriptPageTooLargeError) {
    addDaemonRequestAttribute(
      'qwen-code.daemon.session_restore.envelope_limit_reason',
      'bytes',
    );
    return new RequestError(-32012, error.message, {
      errorKind: 'transcript_page_too_large',
      sessionId,
      pageBytes: error.pageBytes,
      maxBytes: error.maxBytes,
    });
  }
  if (error instanceof HistoryReplayLimitError) {
    addDaemonRequestAttribute(
      'qwen-code.daemon.session_restore.envelope_limit_reason',
      error.reason,
    );
    return new RequestError(-32012, error.message, {
      errorKind: 'transcript_page_too_large',
      sessionId,
      reason: error.reason,
      observed: error.observed,
      limit: error.limit,
    });
  }
  return error;
}

function validateLoadReplayEnvelope(
  sessionId: string,
  envelope: BridgeLoadReplayEnvelope,
  enforceLimits: boolean,
): void {
  if (!enforceLimits) return;
  if (envelope.updates.length > LOAD_REPLAY_MAX_UPDATES) {
    throw new HistoryReplayLimitError(
      sessionId,
      'updates',
      envelope.updates.length,
      LOAD_REPLAY_MAX_UPDATES,
    );
  }
  const pageBytes = Buffer.byteLength(JSON.stringify(envelope), 'utf8');
  if (pageBytes > LOAD_REPLAY_MAX_BYTES) {
    throw new HistoryReplayLimitError(
      sessionId,
      'bytes',
      pageBytes,
      LOAD_REPLAY_MAX_BYTES,
    );
  }
}

/**
 * Append the Goal updates a load publishes after its replayed page, unless
 * that would take the page over the limits it was cut to. Returns whether
 * they were appended: a page already at a limit ships without them rather
 * than failing the load, and the caller delivers them another way.
 */
function appendGoalUpdatesWithinLimits(
  sessionId: string,
  envelope: BridgeLoadReplayEnvelope,
  goalUpdates: readonly SessionUpdate[],
  enforceLimits: boolean,
): boolean {
  if (goalUpdates.length === 0) return true;
  const withGoal = {
    ...envelope,
    updates: [...envelope.updates, ...goalUpdates],
  };
  try {
    validateLoadReplayEnvelope(sessionId, withGoal, enforceLimits);
  } catch (error) {
    if (!(error instanceof HistoryReplayLimitError)) throw error;
    debugLogger.debug(
      `Kept ${goalUpdates.length} Goal update(s) off a full replay page: ${error.message}`,
    );
    return false;
  }
  envelope.updates = withGoal.updates;
  return true;
}

function replayGoalBootstrap(
  projection:
    | SessionRestoreProjection
    | SessionLiveRestoreProjection
    | undefined,
): ReturnType<typeof HistoryReplayer.v2GoalBootstrap> {
  if (projection && !('runtime' in projection)) {
    const sourceUuid = projection.goalRecoverySourceUuid;
    if (!sourceUuid) return undefined;
    if (
      projection.replay?.records.some((record) => record.uuid === sourceUuid)
    ) {
      return undefined;
    }
    const replay = projection.replay?.replay;
    if (isObjectRecord(replay)) {
      const bootstrap = HistoryReplayer.v2GoalBootstrap(
        replay['goalState'],
        replay['goalCause'],
      );
      if (bootstrap) return bootstrap;
    }
    const sourceRecord = projection.goalRecords?.find(
      (record) => record.uuid === sourceUuid,
    );
    if (sourceRecord?.subtype === 'goal_state') {
      const payload = isObjectRecord(sourceRecord.systemPayload)
        ? sourceRecord.systemPayload
        : undefined;
      return HistoryReplayer.v2GoalBootstrap(
        payload?.['snapshot'],
        payload?.['cause'],
      );
    }
    return undefined;
  }
  const sourceUuid = projection?.replay?.goalRecoverySourceUuid;
  if (!projection?.replay || !sourceUuid) return undefined;
  if (projection.replay.records.some((record) => record.uuid === sourceUuid)) {
    return undefined;
  }
  const goalBootstrapRecords = projection.replay.goalBootstrapRecords ?? [];
  const sourceRecord = goalBootstrapRecords.find(
    (record) => record.uuid === sourceUuid,
  );
  if (sourceRecord?.subtype === 'goal_state') {
    const payload = isObjectRecord(sourceRecord.systemPayload)
      ? sourceRecord.systemPayload
      : undefined;
    return HistoryReplayer.v2GoalBootstrap(
      payload?.['snapshot'],
      payload?.['cause'],
    );
  }
  return undefined;
}

function replayInitialGoalState(
  projection: SessionRestoreProjection | undefined,
): {
  initialGoalState?: NonNullable<
    Parameters<HistoryReplayer['replay']>[2]
  >['initialGoalState'];
  initialGoalCause?: NonNullable<
    Parameters<HistoryReplayer['replay']>[2]
  >['initialGoalCause'];
} {
  const replay = projection?.replay?.replay;
  if (!isObjectRecord(replay)) return {};
  const initialGoalState = parseGoalSnapshotV2(replay['goalState']);
  const initialGoalCause = parseGoalStateCause(replay['goalCause']);
  return {
    ...(initialGoalState ? { initialGoalState } : {}),
    ...(initialGoalCause ? { initialGoalCause } : {}),
  };
}

export function selectVisibleHistoryRecords(
  records: ChatRecord[],
  hideInheritedHistory: boolean,
): ChatRecord[] {
  const sourceBoundary = records.findIndex(
    (record) =>
      record.type === 'system' &&
      record.subtype === 'session_source' &&
      isObjectRecord(record.systemPayload) &&
      record.systemPayload['sourceType'] === 'side_task',
  );
  // A persisted side-task source boundary is authoritative for every replay;
  // callers cannot opt inherited parent history back into that child session.
  if (sourceBoundary >= 0) {
    return records
      .slice(sourceBoundary)
      .filter((record) => record.forkedFrom === undefined);
  }
  return hideInheritedHistory
    ? records.filter((record) => record.forkedFrom === undefined)
    : records;
}

interface SessionSource {
  sourceType: string;
  sourceId?: string;
  daemonOwnedStandaloneCreation?: true;
}

function getSessionSource(params: {
  _meta?: unknown;
}): SessionSource | undefined {
  const meta = isObjectRecord(params._meta) ? params._meta : undefined;
  const value = meta?.[SESSION_SOURCE_META_KEY];
  if (!isObjectRecord(value) || typeof value['sourceType'] !== 'string') {
    return undefined;
  }
  return {
    sourceType: value['sourceType'],
    ...(typeof value['sourceId'] === 'string'
      ? { sourceId: value['sourceId'] }
      : {}),
    ...(value[DAEMON_OWNED_STANDALONE_CREATION_KEY] === true
      ? { daemonOwnedStandaloneCreation: true }
      : {}),
  };
}

function shouldDeferMcpDiscovery(params: { _meta?: unknown }): boolean {
  const meta = isObjectRecord(params._meta) ? params._meta : undefined;
  return meta?.[WORKTREE_MCP_DEFER_META_KEY] === true;
}

function getLoadReplayPageSize(params: LoadSessionRequest): number | undefined {
  const meta = isObjectRecord(params._meta) ? params._meta : undefined;
  const value = meta?.[LOAD_REPLAY_PAGE_SIZE_META_KEY];
  if (value === undefined) return undefined;
  if (
    !Number.isSafeInteger(value) ||
    (value as number) < 1 ||
    (value as number) > SESSION_TRANSCRIPT_MAX_LIMIT
  ) {
    throw RequestError.invalidParams(
      undefined,
      `Invalid load replay page size; expected 1..${SESSION_TRANSCRIPT_MAX_LIMIT}`,
    );
  }
  return value as number;
}


/**
 * Env-var candidates per auth method, used by `buildAuthPreflightCell` for
 * a side-effect-free presence check. Mirrors `OPENAI_ENV_MAPPING.apiKey` from
 * `core/src/models/constants.ts`. Any auth method not listed here surfaces as
 * `status: 'unknown'` on the cell rather than a false `auth_env_error` — full
 * validation happens at session start.
 */
export const AUTH_PREFLIGHT_ENV_KEYS: Readonly<
  Record<string, readonly string[]>
> = {
  openai: ['OPENAI_API_KEY'],
};

type QwenMemorySettings = {
  enableManagedAutoMemory: boolean;
  enableManagedAutoDream: boolean;
  enableAutoSkill: boolean;
  autoSkillConfirm: boolean;
  enableTeamMemory: boolean;
};

type QwenMemoryPaths = {
  userMemoryFile: string;
  projectMemoryFile: string;
  autoMemoryDir: string;
};

type QwenSettingsScope = 'user' | 'workspace';
type QwenSettingValue = string | number | boolean | string[] | undefined;
type QwenMcpTransport = 'stdio';
type QwenHookEvent = HookEventName;

type QwenCoreSettingKey =
  | 'model.name'
  | 'fastModel'
  | 'general.outputLanguage'
  | 'general.language'
  | 'tools.approvalMode'
  | 'general.vimMode'
  | 'general.showSessionRecap'
  | 'general.sessionRecapAwayThresholdMinutes'
  | 'general.terminalBell'
  | 'general.notificationMode'
  | 'general.defaultFileEncoding'
  | 'context.fileFiltering.respectGitIgnore'
  | 'context.fileFiltering.respectQwenIgnore'
  | 'context.fileFiltering.enableFuzzySearch'
  | 'memory.enableManagedAutoMemory'
  | 'memory.enableManagedAutoDream'
  | 'memory.enableAutoSkill'
  | 'memory.autoSkillConfirm'
  | 'memory.enableTeamMemory'
  | 'disableAllHooks';

type QwenMcpServerConfig = {
  transport: QwenMcpTransport;
  command?: string;
  args?: string[];
  cwd?: string;
  env?: Record<string, string>;
  timeout?: number;
  versionNegotiation?: 'auto' | 'legacy';
  appResourceMaxBytes?: number;
  appResourceTimeoutMs?: number;
  trust?: boolean;
  description?: string;
  includeTools?: string[];
  excludeTools?: string[];
  extensionName?: string;
};

type QwenHookConfig = {
  type: 'command';
  command?: string;
  name?: string;
  description?: string;
  timeout?: number;
  env?: Record<string, string>;
  async?: boolean;
  statusMessage?: string;
  shell?: 'bash' | 'powershell';
};

type QwenHookDefinition = {
  matcher?: string;
  sequential?: boolean;
  hooks: QwenHookConfig[];
};

const QWEN_CORE_SETTING_DEFINITIONS = {
  'model.name': { type: 'string' },
  fastModel: { type: 'string' },
  'general.outputLanguage': { type: 'string' },
  'general.language': { type: 'string' },
  'tools.approvalMode': {
    type: 'enum',
    values: APPROVAL_MODES,
  },
  'general.vimMode': { type: 'boolean' },
  'general.showSessionRecap': { type: 'boolean' },
  'general.sessionRecapAwayThresholdMinutes': { type: 'number', min: 1 },
  'general.terminalBell': { type: 'boolean' },
  'general.notificationMode': {
    type: 'enum',
    values: ['all', 'task-complete'],
  },
  'general.defaultFileEncoding': {
    type: 'enum',
    values: ['utf-8', 'utf-8-bom'],
  },
  'context.fileFiltering.respectGitIgnore': { type: 'boolean' },
  'context.fileFiltering.respectQwenIgnore': { type: 'boolean' },
  'context.fileFiltering.enableFuzzySearch': { type: 'boolean' },
  'memory.enableManagedAutoMemory': { type: 'boolean' },
  'memory.enableManagedAutoDream': { type: 'boolean' },
  'memory.enableAutoSkill': { type: 'boolean' },
  'memory.autoSkillConfirm': { type: 'boolean' },
  'memory.enableTeamMemory': { type: 'boolean' },
  disableAllHooks: { type: 'boolean' },
} as const satisfies Record<
  QwenCoreSettingKey,
  {
    type: 'string' | 'number' | 'boolean' | 'enum';
    min?: number;
    values?: readonly string[];
  }
>;

const QWEN_CORE_SETTING_KEYS = Object.keys(
  QWEN_CORE_SETTING_DEFINITIONS,
) as QwenCoreSettingKey[];

const QWEN_HOOK_EVENTS = Object.values(HookEventName) as QwenHookEvent[];

const DEFAULT_QWEN_MEMORY_SETTINGS: QwenMemorySettings = {
  enableManagedAutoMemory: true,
  enableManagedAutoDream: true,
  enableAutoSkill: false,
  autoSkillConfirm: true,
  enableTeamMemory: false,
};

const QWEN_MEMORY_SETTING_KEYS = [
  'enableManagedAutoMemory',
  'enableManagedAutoDream',
  'enableAutoSkill',
  'autoSkillConfirm',
  'enableTeamMemory',
] as const satisfies ReadonlyArray<keyof QwenMemorySettings>;

function normalizeQwenMemorySettings(value: unknown): QwenMemorySettings {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return { ...DEFAULT_QWEN_MEMORY_SETTINGS };
  }

  const record = value as Record<string, unknown>;
  return {
    enableManagedAutoMemory:
      typeof record['enableManagedAutoMemory'] === 'boolean'
        ? record['enableManagedAutoMemory']
        : DEFAULT_QWEN_MEMORY_SETTINGS.enableManagedAutoMemory,
    enableManagedAutoDream:
      typeof record['enableManagedAutoDream'] === 'boolean'
        ? record['enableManagedAutoDream']
        : DEFAULT_QWEN_MEMORY_SETTINGS.enableManagedAutoDream,
    enableAutoSkill:
      typeof record['enableAutoSkill'] === 'boolean'
        ? record['enableAutoSkill']
        : DEFAULT_QWEN_MEMORY_SETTINGS.enableAutoSkill,
    autoSkillConfirm:
      typeof record['autoSkillConfirm'] === 'boolean'
        ? record['autoSkillConfirm']
        : DEFAULT_QWEN_MEMORY_SETTINGS.autoSkillConfirm,
    enableTeamMemory:
      typeof record['enableTeamMemory'] === 'boolean'
        ? record['enableTeamMemory']
        : DEFAULT_QWEN_MEMORY_SETTINGS.enableTeamMemory,
  };
}

function toRecord(value: unknown): Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function readOptionalString(
  value: unknown,
  fieldName: string,
): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string') {
    throw RequestError.invalidParams(
      undefined,
      `Invalid ${fieldName}: expected string`,
    );
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function readRequiredString(value: unknown, fieldName: string): string {
  const stringValue = readOptionalString(value, fieldName);
  if (!stringValue) {
    throw RequestError.invalidParams(
      undefined,
      `Invalid or missing ${fieldName}`,
    );
  }
  return stringValue;
}

function readStringArray(value: unknown, fieldName: string): string[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) {
    throw RequestError.invalidParams(
      undefined,
      `Invalid ${fieldName}: expected string[]`,
    );
  }
  return Array.from(
    new Set(
      value
        .map((item) => {
          if (typeof item !== 'string') {
            throw RequestError.invalidParams(
              undefined,
              `Invalid ${fieldName}: expected string[]`,
            );
          }
          return item.trim();
        })
        .filter(Boolean),
    ),
  );
}

function readPositiveNumber(
  value: unknown,
  fieldName: string,
): number | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    throw RequestError.invalidParams(
      undefined,
      `Invalid ${fieldName}: expected positive number`,
    );
  }
  return value;
}

function readProviderAdvancedConfig(
  value: unknown,
): ProviderSetupInputs['advancedConfig'] | undefined {
  if (value === undefined || value === null) return undefined;
  const record = toRecord(value);
  if (
    record['enableThinking'] !== undefined &&
    typeof record['enableThinking'] !== 'boolean'
  ) {
    throw RequestError.invalidParams(
      undefined,
      'Invalid advancedConfig.enableThinking: expected boolean',
    );
  }
  const multimodalRecord = toRecord(record['multimodal']);
  const multimodal: NonNullable<
    ProviderSetupInputs['advancedConfig']
  >['multimodal'] = {};
  for (const key of ['image', 'video', 'audio', 'pdf'] as const) {
    const flag = multimodalRecord[key];
    if (flag !== undefined) {
      if (typeof flag !== 'boolean') {
        throw RequestError.invalidParams(
          undefined,
          `Invalid advancedConfig.multimodal.${key}: expected boolean`,
        );
      }
      multimodal[key] = flag;
    }
  }
  const contextWindowSize = readPositiveNumber(
    record['contextWindowSize'],
    'advancedConfig.contextWindowSize',
  );
  const maxTokens = readPositiveNumber(
    record['maxTokens'],
    'advancedConfig.maxTokens',
  );

  const advancedConfig: NonNullable<ProviderSetupInputs['advancedConfig']> = {
    ...(typeof record['enableThinking'] === 'boolean'
      ? { enableThinking: record['enableThinking'] }
      : {}),
    ...(Object.keys(multimodal).length > 0 ? { multimodal } : {}),
    ...(contextWindowSize ? { contextWindowSize } : {}),
    ...(maxTokens ? { maxTokens } : {}),
  };

  return Object.keys(advancedConfig).length > 0 ? advancedConfig : undefined;
}

function readSettingsEnv(
  settings: LoadedSettings,
  envKey: string | undefined,
): string | undefined {
  if (!envKey) return undefined;
  const env = toRecord((settings.merged as Record<string, unknown>)['env']);
  const value = env[envKey];
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function resolveProviderEnvKey(
  config: ProviderConfig,
  baseUrl: string,
): string | undefined {
  try {
    return config.envKey(config.protocol, baseUrl);
  } catch {
    return undefined;
  }
}

function readExistingAdvancedConfig(
  model: ProviderModelConfig | undefined,
): Record<string, unknown> | undefined {
  const generationConfig = toRecord(model?.generationConfig);
  const extraBody = toRecord(generationConfig['extra_body']);
  const advancedConfig: Record<string, unknown> = {};
  if (typeof extraBody['enable_thinking'] === 'boolean') {
    advancedConfig['enableThinking'] = extraBody['enable_thinking'];
  }
  if (typeof generationConfig['contextWindowSize'] === 'number') {
    advancedConfig['contextWindowSize'] = generationConfig['contextWindowSize'];
  }
  return Object.keys(advancedConfig).length > 0 ? advancedConfig : undefined;
}

function readExistingProviderConfig(
  config: ProviderConfig,
  settings: LoadedSettings,
): Record<string, unknown> | undefined {
  const existing = findExistingProviderModels(
    config,
    (settings.merged as Record<string, unknown>)['modelProviders'] as
      | Record<string, unknown>
      | undefined,
  );
  const firstModel = existing?.models[0];
  if (!firstModel) return undefined;
  const baseUrl = firstModel.baseUrl ?? '';
  const envKey =
    typeof firstModel.envKey === 'string'
      ? firstModel.envKey
      : resolveProviderEnvKey(config, baseUrl);
  const apiKey = readSettingsEnv(settings, envKey);
  const advancedConfig = readExistingAdvancedConfig(firstModel);

  return {
    protocol: config.protocol,
    baseUrl: sanitizeProviderBaseUrl(baseUrl),
    // Never serialize the raw secret over the ACP wire. Expose only whether a
    // key is stored; the client can omit `apiKey` on connect to keep it.
    ...(apiKey ? { hasApiKey: true } : {}),
    modelIds: existing.models
      .filter(
        (model) =>
          model.baseUrl === firstModel.baseUrl &&
          model.envKey === firstModel.envKey,
      )
      .map((model) => model.id),
    ...(advancedConfig ? { advancedConfig } : {}),
  };
}

// Resolves the raw, stored API key for a provider for server-side use only
// (never serialized to the client). Used so `qwen/providers/connect` can keep
// the existing key when the client updates other fields without resubmitting it.
function resolveExistingProviderApiKey(
  config: ProviderConfig,
  settings: LoadedSettings,
  baseUrl: string,
  modelIds: string[],
): string | undefined {
  const candidates = getProviderModels(settings.merged.modelProviders).filter(
    (model) =>
      model.baseUrl === baseUrl && model.envKey && modelIds.includes(model.id),
  );
  // Keep the first entry per model id (scan order) so this resolver agrees
  // with buildInstallPlan's first-wins identity match.
  const matched = candidates.filter(
    (model, index) =>
      candidates.findIndex((entry) => entry.id === model.id) === index,
  );
  const keys = new Set(matched.map((model) => model.envKey));
  if (keys.size === 1) return readSettingsEnv(settings, [...keys][0]);
  if (keys.size > 1) return undefined;
  return readSettingsEnv(settings, resolveProviderEnvKey(config, baseUrl));
}

function serializeProviderConfig(
  config: ProviderConfig,
  settings: LoadedSettings,
): Record<string, unknown> {
  const existingConfig = readExistingProviderConfig(config, settings);
  return {
    id: config.id,
    label: config.label,
    description: config.description,
    protocol: config.protocol,
    showAdvancedConfig: config.showAdvancedConfig === true,
    supportsModelDiscovery: config.supportsModelDiscovery === true,
    apiKeyPlaceholder: config.apiKeyPlaceholder,
    ...(existingConfig ? { existingConfig } : {}),
  };
}

function readProviderSetupInputs(
  config: ProviderConfig,
  params: Record<string, unknown>,
  resolveExistingApiKey?: (
    baseUrl: string,
    modelIds: string[],
  ) => string | undefined,
): ProviderSetupInputs {
  // No default: a missing or non-loopback base URL is rejected.
  const baseUrl = (
    readOptionalString(params['baseUrl'], 'baseUrl') ?? ''
  ).trim();
  const baseUrlError = getLocalBaseUrlError(baseUrl, 'baseUrl');
  if (baseUrlError) {
    throw RequestError.invalidParams(undefined, baseUrlError);
  }

  const modelIds = readStringArray(params['modelIds'], 'modelIds');
  if (modelIds.length === 0) {
    throw RequestError.invalidParams(
      undefined,
      `Invalid or missing modelIds for provider "${config.id}"`,
    );
  }

  // `apiKey` is optional on update: when the client omits it (e.g. it only
  // received `hasApiKey` from the list response), fall back to the stored key.
  const apiKey =
    readOptionalString(params['apiKey'], 'apiKey') ??
    resolveExistingApiKey?.(baseUrl, modelIds);
  if (!apiKey) {
    throw RequestError.invalidParams(undefined, 'Invalid or missing apiKey');
  }

  const advancedConfig = readProviderAdvancedConfig(params['advancedConfig']);

  return {
    baseUrl,
    apiKey,
    modelIds,
    ...(advancedConfig ? { advancedConfig } : {}),
  };
}

function readProviderConnectScope(value: unknown): SettingScope | undefined {
  if (value === undefined) return undefined;
  if (value === 'user') return SettingScope.User;
  if (value === 'workspace') return SettingScope.Workspace;
  throw RequestError.invalidParams(
    undefined,
    'Invalid scope for provider connect',
  );
}

function getNestedSettingValue(
  source: Record<string, unknown>,
  key: QwenCoreSettingKey,
): QwenSettingValue {
  let current: unknown = source;
  for (const segment of key.split('.')) {
    if (!current || typeof current !== 'object' || Array.isArray(current)) {
      return undefined;
    }
    current = (current as Record<string, unknown>)[segment];
  }
  if (
    typeof current === 'string' ||
    typeof current === 'number' ||
    typeof current === 'boolean' ||
    Array.isArray(current)
  ) {
    return current as QwenSettingValue;
  }
  return undefined;
}

function readCoreSettingValues(
  source: Record<string, unknown>,
): Partial<Record<QwenCoreSettingKey, QwenSettingValue>> {
  const values: Partial<Record<QwenCoreSettingKey, QwenSettingValue>> = {};
  for (const key of QWEN_CORE_SETTING_KEYS) {
    const value = getNestedSettingValue(source, key);
    if (value !== undefined) {
      values[key] = value;
    }
  }
  return values;
}

export function normalizeCoreSettingValue(
  key: QwenCoreSettingKey,
  value: unknown,
): QwenSettingValue {
  const definition = QWEN_CORE_SETTING_DEFINITIONS[key];
  switch (definition.type) {
    case 'boolean':
      if (typeof value !== 'boolean') {
        throw RequestError.invalidParams(undefined, `${key} must be a boolean`);
      }
      return value;
    case 'number':
      if (typeof value !== 'number' || !Number.isFinite(value)) {
        throw RequestError.invalidParams(undefined, `${key} must be a number`);
      }
      if (definition.min !== undefined && value < definition.min) {
        throw RequestError.invalidParams(
          undefined,
          `${key} must be at least ${definition.min}`,
        );
      }
      return value;
    case 'enum': {
      const values = definition.values as readonly string[] | undefined;
      if (typeof value !== 'string' || !values?.includes(value)) {
        throw RequestError.invalidParams(
          undefined,
          `${key} must be one of ${values?.join(', ')}`,
        );
      }
      return value;
    }
    case 'string': {
      if (value === undefined) return undefined;
      if (typeof value !== 'string') {
        throw RequestError.invalidParams(undefined, `${key} must be a string`);
      }
      // Strip control characters (incl. newlines) from string settings. Some
      // are embedded verbatim into instruction files / prompts — e.g.
      // general.outputLanguage is written into output-language.md, loaded as a
      // system instruction — where an embedded newline could forge a new
      // instruction line (persistent prompt injection).
      // eslint-disable-next-line no-control-regex
      const controlChars = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g;
      const sanitized = value.replace(controlChars, ' ').trim();
      // An input that is entirely control/whitespace chars (e.g. '\n') trims to
      // ''. For settings like model.name an empty string has different
      // semantics from undefined (a literal empty value vs. falling back to the
      // default), so collapse the empty result to undefined.
      return sanitized || undefined;
    }
    default:
      throw RequestError.invalidParams(
        undefined,
        `${key} has an unsupported setting type`,
      );
  }
}

function normalizeStringArray(value: unknown): string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) {
    throw RequestError.invalidParams(undefined, 'Expected an array of strings');
  }
  return value
    .map((item) => (typeof item === 'string' ? item.trim() : ''))
    .filter(Boolean);
}

function normalizeStringRecord(
  value: unknown,
): Record<string, string> | undefined {
  if (value === undefined) return undefined;
  const record = toRecord(value);
  const result: Record<string, string> = {};
  for (const [key, item] of Object.entries(record)) {
    if (typeof item === 'string' && key.trim()) {
      result[key.trim()] = item;
    }
  }
  return result;
}

function normalizeOptionalNumber(value: unknown): number | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  let numberValue: number;
  if (typeof value === 'number') {
    numberValue = value;
  } else if (typeof value === 'string') {
    const trimmed = value.trim();
    numberValue = /^\d+$/.test(trimmed) ? Number(trimmed) : Number.NaN;
  } else {
    numberValue = Number.NaN;
  }
  if (!Number.isInteger(numberValue) || numberValue <= 0) {
    throw RequestError.invalidParams(undefined, 'Expected a positive integer');
  }
  return numberValue;
}

function toMcpAppResourceLimit(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value)
    ? value
    : undefined;
}

function normalizeMcpServerConfig(value: unknown): QwenMcpServerConfig {
  const input = toRecord(value);
  const transport = input['transport'];
  if (transport !== 'stdio') {
    throw RequestError.invalidParams(undefined, 'MCP transport must be stdio');
  }

  const server: QwenMcpServerConfig = { transport };
  const description = input['description'];
  if (typeof description === 'string' && description.trim()) {
    server.description = description.trim();
  }
  const cwd = input['cwd'];
  if (typeof cwd === 'string' && cwd.trim()) server.cwd = cwd.trim();
  const timeout = normalizeOptionalNumber(input['timeout']);
  if (timeout !== undefined) server.timeout = timeout;
  const versionNegotiation = toMcpVersionNegotiation(
    input['versionNegotiation'],
  );
  if (
    input['versionNegotiation'] !== undefined &&
    versionNegotiation === undefined
  ) {
    throw RequestError.invalidParams(
      undefined,
      'MCP versionNegotiation must be auto or legacy',
    );
  }
  server.versionNegotiation = versionNegotiation;
  server.appResourceMaxBytes = toMcpAppResourceLimit(
    input['appResourceMaxBytes'],
  );
  server.appResourceTimeoutMs = toMcpAppResourceLimit(
    input['appResourceTimeoutMs'],
  );
  if (typeof input['trust'] === 'boolean') server.trust = input['trust'];
  server.includeTools = normalizeStringArray(input['includeTools']);
  server.excludeTools = normalizeStringArray(input['excludeTools']);

  const command = input['command'];
  if (typeof command !== 'string' || !command.trim()) {
    throw RequestError.invalidParams(
      undefined,
      'Stdio MCP servers require a command',
    );
  }
  server.command = command.trim();
  server.args = normalizeStringArray(input['args']);
  server.env = normalizeStringRecord(input['env']);
  return server;
}

function toStoredMcpServerConfig(
  server: QwenMcpServerConfig,
): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const key of [
    'timeout',
    'versionNegotiation',
    'appResourceMaxBytes',
    'appResourceTimeoutMs',
    'trust',
    'description',
    'includeTools',
    'excludeTools',
  ] as const) {
    if (server[key] !== undefined) result[key] = server[key];
  }
  result['command'] = server.command;
  if (server.args !== undefined) result['args'] = server.args;
  if (server.cwd !== undefined) result['cwd'] = server.cwd;
  if (server.env !== undefined) result['env'] = server.env;
  return result;
}

function toMcpServerConfig(value: unknown): QwenMcpServerConfig | undefined {
  const server = toRecord(value);
  if (typeof server['command'] === 'string') {
    return {
      transport: 'stdio',
      command: server['command'],
      args: normalizeStringArray(server['args']),
      cwd: typeof server['cwd'] === 'string' ? server['cwd'] : undefined,
      env: normalizeStringRecord(server['env']),
      timeout: normalizeOptionalNumber(server['timeout']),
      versionNegotiation: toMcpVersionNegotiation(server['versionNegotiation']),
      appResourceMaxBytes: toMcpAppResourceLimit(server['appResourceMaxBytes']),
      appResourceTimeoutMs: toMcpAppResourceLimit(
        server['appResourceTimeoutMs'],
      ),
      trust: typeof server['trust'] === 'boolean' ? server['trust'] : undefined,
      description:
        typeof server['description'] === 'string'
          ? server['description']
          : undefined,
      includeTools: normalizeStringArray(server['includeTools']),
      excludeTools: normalizeStringArray(server['excludeTools']),
      extensionName:
        typeof server['extensionName'] === 'string'
          ? server['extensionName']
          : undefined,
    };
  }
  return undefined;
}

function toMcpVersionNegotiation(
  value: unknown,
): 'auto' | 'legacy' | undefined {
  return value === 'auto' || value === 'legacy' ? value : undefined;
}

function redactSecretRecord(
  record: Record<string, string> | undefined,
): Record<string, string> | undefined {
  return record
    ? Object.fromEntries(
        Object.keys(record).map((key) => [key, REDACTED_MCP_SECRET]),
      )
    : record;
}

function restoreSecretRecord(
  incoming: Record<string, string> | undefined,
  prior: unknown,
): Record<string, string> | undefined {
  if (!incoming) return incoming;
  const priorRecord = toRecord(prior);
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(incoming)) {
    if (value !== REDACTED_MCP_SECRET) {
      result[key] = value;
      continue;
    }
    const priorValue = priorRecord[key];
    if (typeof priorValue === 'string') result[key] = priorValue;
  }
  return result;
}

// Hooks carry the same secret classes as MCP servers — command-hook `env`
// (tokens passed to scripts). Mask them in the settings response and restore
// them on write, mirroring the MCP scheme.
function redactHookSecrets(hook: QwenHookDefinition): QwenHookDefinition {
  return {
    ...hook,
    hooks: hook.hooks.map((config) => ({
      ...config,
      ...(config.env ? { env: redactSecretRecord(config.env) } : {}),
    })),
  };
}

function restoreRedactedHookSecrets(
  hook: QwenHookDefinition,
  prior: Record<string, unknown>,
): QwenHookDefinition {
  const priorHooks = Array.isArray(prior['hooks'])
    ? (prior['hooks'] as unknown[])
    : [];
  return {
    ...hook,
    hooks: hook.hooks.map((config, i) => {
      const priorConfig = toRecord(priorHooks[i]);
      return {
        ...config,
        ...(config.env
          ? { env: restoreSecretRecord(config.env, priorConfig['env']) }
          : {}),
      };
    }),
  };
}

function readMcpServers(
  source: Record<string, unknown>,
  scope: QwenSettingsScope | 'extension',
): Array<{
  name: string;
  scope: QwenSettingsScope | 'extension';
  server: QwenMcpServerConfig;
}> {
  const servers = toRecord(source['mcpServers']);
  return Object.entries(servers)
    .map(([name, value]) => {
      try {
        const server = toMcpServerConfig(value);
        // Never expose stdio env in plaintext in the settings response — it
        // routinely holds API keys / tokens.
        return server
          ? { name, scope, server: redactMcpServerSecrets(server) }
          : undefined;
      } catch (error) {
        debugLogger.warn(
          `Skipping malformed MCP server config [${scope}:${name}]:`,
          error,
        );
        return undefined;
      }
    })
    .filter(
      (
        entry,
      ): entry is {
        name: string;
        scope: QwenSettingsScope | 'extension';
        server: QwenMcpServerConfig;
      } => !!entry,
    );
}

function isHookEvent(value: unknown): value is QwenHookEvent {
  return (
    typeof value === 'string' &&
    QWEN_HOOK_EVENTS.includes(value as QwenHookEvent)
  );
}

function normalizeHookConfig(value: unknown): QwenHookConfig {
  const input = toRecord(value);
  const type = input['type'];
  if (type !== 'command') {
    throw RequestError.invalidParams(undefined, 'Hook type must be command');
  }
  const config: QwenHookConfig = { type };
  const command = input['command'];
  if (typeof command !== 'string' || !command.trim()) {
    throw RequestError.invalidParams(
      undefined,
      'Command hooks require a command',
    );
  }
  config.command = command.trim();
  config.env = normalizeStringRecord(input['env']);
  if (typeof input['async'] === 'boolean') config.async = input['async'];
  const shell = input['shell'];
  if (shell === 'bash' || shell === 'powershell') config.shell = shell;
  const timeout = normalizeOptionalNumber(input['timeout']);
  if (timeout !== undefined) config.timeout = timeout;
  for (const key of ['name', 'description', 'statusMessage'] as const) {
    const item = input[key];
    if (typeof item === 'string' && item.trim()) {
      config[key] = item.trim();
    }
  }
  return config;
}

function normalizeHookDefinition(value: unknown): QwenHookDefinition {
  const input = toRecord(value);
  const hooks = input['hooks'];
  if (!Array.isArray(hooks) || hooks.length === 0) {
    throw RequestError.invalidParams(
      undefined,
      'Hook definition requires at least one hook',
    );
  }
  const definition: QwenHookDefinition = {
    hooks: hooks.map(normalizeHookConfig),
  };
  if (typeof input['matcher'] === 'string') {
    definition.matcher = input['matcher'];
  }
  if (typeof input['sequential'] === 'boolean') {
    definition.sequential = input['sequential'];
  }
  return definition;
}

function readHooks(
  source: Record<string, unknown>,
  scope: QwenSettingsScope | 'extension',
  extensionName?: string,
): Array<{
  event: QwenHookEvent;
  scope: QwenSettingsScope | 'extension';
  index: number;
  hook: QwenHookDefinition;
  extensionName?: string;
}> {
  const hooksRoot = toRecord(source['hooks']);
  const entries: Array<{
    event: QwenHookEvent;
    scope: QwenSettingsScope | 'extension';
    index: number;
    hook: QwenHookDefinition;
    extensionName?: string;
  }> = [];
  for (const event of QWEN_HOOK_EVENTS) {
    const eventHooks = hooksRoot[event];
    if (!Array.isArray(eventHooks)) continue;
    eventHooks.forEach((hookValue, index) => {
      try {
        entries.push({
          event,
          scope,
          index,
          hook: redactHookSecrets(normalizeHookDefinition(hookValue)),
          extensionName,
        });
      } catch (error) {
        debugLogger.warn(
          `Skipping malformed hook entry [${scope}:${event}:${index}]:`,
          error,
        );
      }
    });
  }
  return entries;
}

function toSettingsScope(scope: unknown): SettingScope {
  if (scope === 'workspace') return SettingScope.Workspace;
  if (scope === 'user') return SettingScope.User;
  throw RequestError.invalidParams(
    undefined,
    'scope must be user or workspace',
  );
}

function readScopeSettings(
  settings: LoadedSettings,
  scope: QwenSettingsScope,
): Record<string, unknown> {
  return settings.forScope(toSettingsScope(scope)).settings as Record<
    string,
    unknown
  >;
}

async function resolvePreferredMemoryFile(
  dir: string,
  fallbackFilename: string,
): Promise<string> {
  for (const filename of getAllMemoryFilenames()) {
    const filePath = path.join(dir, filename);
    try {
      await fs.access(filePath);
      return filePath;
    } catch {
      // Try the next configured file name.
    }
  }

  return path.join(dir, fallbackFilename);
}

async function resolveQwenMemoryPaths(params: {
  cwd: string;
  projectRoot: string;
}): Promise<QwenMemoryPaths> {
  const fallbackFilename = getAllMemoryFilenames()[0] ?? 'QWEN.md';
  const userMemoryFile = await resolvePreferredMemoryFile(
    Storage.getGlobalQwenDir(),
    fallbackFilename,
  );
  const projectMemoryFile = await resolvePreferredMemoryFile(
    params.cwd,
    fallbackFilename,
  );
  const autoMemoryDir = getAutoMemoryRoot(params.projectRoot);

  // Resolve-only: `getMemoryPaths` is a read query, so it must not create
  // files or directories as a side effect (the old code ran ensureMemoryFile
  // + fs.mkdir on every call, including against a client-controlled
  // projectRoot). Callers that write memory are responsible for ensuring the
  // target exists.
  return {
    userMemoryFile,
    projectMemoryFile,
    autoMemoryDir,
  };
}

export async function runAcpAgent(
  config: Config,
  settings: LoadedSettings,
  argv: CliArgs,
) {
  if (config.getShellExecutionSandbox?.()) {
    throw new Error(
      'Tool execution sandbox does not support ACP sessions yet.',
    );
  }
  // Freeze the restart-required writer protocol before the first await.
  // Per-request settings reloads must not mix leased and legacy writers
  // within one ACP process lifetime.
  const sessionWriterLeaseEnabledAtStartup =
    typeof config.isSessionWriterLeaseEnabled === 'function'
      ? config.isSessionWriterLeaseEnabled()
      : settings.merged.experimental?.sessionWriterLease === true;

  await config.initialize({
    skipLlmInitialization: true,
    // Bootstrap skips MCP discovery — each session runs its own
    // pool-routed discovery, so bootstrap-level spawns would be
    // redundant subprocess leaks (W119).
    skipMcpDiscovery: true,
  });
  // The ACP path exits llm.tsx before its startup-warning printing runs,
  // so config warnings (including initialize-time ones) would otherwise
  // vanish. stderr lands in the client's
  // logs without interfering with the ACP protocol on stdout.
  // Defensive `typeof` for tests that stub Config without getWarnings.
  const startupWarnings =
    typeof config.getWarnings === 'function' ? config.getWarnings() : [];
  for (const warning of startupWarnings) {
    process.stderr.write(`${warning}\n`);
  }
  const eventLoopMonitor = startEventLoopLagMonitor({
    suspendThresholdMs: ACP_EVENT_LOOP_STALL_RESTART_MS,
    onNewMaxStall: (maxMs) => {
      console.error(`[perf] acp agent event loop stall: max=${maxMs}ms`);
    },
  });

  let agentInstance: QwenAgent | undefined;
  let connection: AgentSideConnection;
  let output: ReturnType<typeof createAcpOutput>;
  try {
    output = createAcpOutput(process.stdout);
    const stdin = Readable.toWeb(process.stdin) as ReadableStream<Uint8Array>;

    // Stdout is used to send messages to the client, so console.log/console.info
    // messages to stderr so that they don't interfere with ACP.
    console.log = console.error;
    console.info = console.error;
    console.debug = console.error;

    let initializeRequestId: string | number | null | undefined;
    const pendingNewSessionRequestIds = new Set<string | number | null>();
    const stream = ndJsonStream(output.stream, stdin, {
      onMessageObserved: ({ direction, bytes, message }) => {
        if (direction === 'sent') {
          observeAcpToolResultWire(message, bytes);
        }
        if (
          direction === 'received' &&
          'id' in message &&
          'method' in message
        ) {
          if (message.method === 'session/new') {
            pendingNewSessionRequestIds.add(message.id);
          } else if (message.method === 'initialize') {
            initializeRequestId = message.id;
          }
          return;
        }
        if (
          direction === 'sent' &&
          'id' in message &&
          !('method' in message) &&
          pendingNewSessionRequestIds.delete(message.id) &&
          'result' in message &&
          typeof message.result === 'object' &&
          message.result !== null &&
          'sessionId' in message.result &&
          typeof message.result.sessionId === 'string'
        ) {
          const sessionId = message.result.sessionId;
          setImmediate(() => {
            const session = agentInstance
              ?.getActiveSessions()
              .find((candidate) => candidate.getId() === sessionId);
            if (!session) return;
            void preloadContentGenerator(
              session.getConfig().getContentGenerator(),
            ).catch((error: unknown) => {
              debugLogger.debug(
                `[ACP] Session provider preload failed for ${sessionId}: ${
                  error instanceof Error ? error.message : String(error)
                }`,
              );
            });
          }).unref();
        }
        if (
          direction !== 'sent' ||
          initializeRequestId === undefined ||
          !('id' in message) ||
          'method' in message ||
          message.id !== initializeRequestId
        ) {
          return;
        }
        initializeRequestId = undefined;
        if ('result' in message) {
          void initializeTelemetry(config).then(() => {
            registerAcpEventLoopLagGauge(() => eventLoopMonitor.snapshot());
          });
        }
      },
    });
    connection = new AgentSideConnection((conn) => {
      agentInstance = new QwenAgent(
        config,
        settings,
        argv,
        conn,
        sessionWriterLeaseEnabledAtStartup,
      );
      return agentInstance;
    }, stream);
  } catch (err) {
    eventLoopMonitor.dispose();
    throw err;
  }

  // Both the SIGTERM handler and the IDE-initiated close path need
  // to drain the MCP pool before runExitCleanup. Single helper
  // closure keeps the timeout + log labels consistent.
  let drainPoolPromise: Promise<void> | undefined;
  const drainPoolBeforeExit = async (
    label: string,
    strict = false,
  ): Promise<void> => {
    if (!agentInstance) return;
    try {
      drainPoolPromise ??= agentInstance.shutdownMcpPool(8_000);
      await drainPoolPromise;
    } catch (err) {
      debugLogger.error(`[ACP] MCP pool drain (${label}) error:`, err);
      if (strict) throw err;
    }
  };

  let disposeSessionsPromise: Promise<void> | undefined;
  const disposeSessionsOnce = (): Promise<void> => {
    if (!agentInstance) return Promise.resolve();
    disposeSessionsPromise ??= agentInstance.disposeSessions();
    return disposeSessionsPromise;
  };

  // Handle SIGTERM/SIGINT for graceful shutdown.
  // Without this, signal handlers registered elsewhere in the CLI
  // (e.g., stdin raw mode restoration) override the default exit behavior,
  // causing the ACP process to ignore termination signals.
  let shuttingDown = false;
  let sessionEndPromise: Promise<void> | undefined;

  // Helper to fire SessionEnd hook once, preventing double-fire from both
  // shutdown handler path and connection.closed path.
  const fireSessionEndOnce = (reason: SessionEndReason): Promise<void> => {
    if (sessionEndPromise) return sessionEndPromise;

    sessionEndPromise = (async () => {
      const configs = new Set<Config>([config]);
      const sessions = agentInstance?.getActiveSessions();
      if (sessions) {
        for (const session of sessions) {
          const sessionConfig = session.getConfig?.();
          if (sessionConfig) {
            configs.add(sessionConfig);
          }
        }
      }

      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 30_000);
      timeout.unref();
      try {
        const results = await Promise.allSettled(
          [...configs].flatMap((cfg) => {
            const hookSystem = cfg.getHookSystem?.();
            if (
              cfg.getDisableAllHooks?.() ||
              !hookSystem ||
              typeof hookSystem.fireSessionEndEvent !== 'function' ||
              !cfg.hasHooksForEvent?.('SessionEnd')
            ) {
              return [];
            }
            return [
              Promise.resolve().then(() =>
                hookSystem.fireSessionEndEvent(reason, controller.signal),
              ),
            ];
          }),
        );
        const failures = results
          .filter(
            (result): result is PromiseRejectedResult =>
              result.status === 'rejected',
          )
          .map((result) => result.reason);
        // A SessionEnd hook that outlives the 30s budget is cancelled rather
        // than rejected: `fireSessionEndEvent` resolves to `undefined` for a
        // cancelled hook (the `{ success: false, outcome: 'cancelled' }`
        // result never rejects), so `Promise.allSettled` cannot observe it and
        // `failures` above stays empty. Detect the abort directly so the
        // cancellation is recorded at all.
        if (controller.signal.aborted) {
          failures.push(
            new Error(
              'SessionEnd hook did not complete within 30s (cancelled)',
            ),
          );
        }
        for (const failure of failures) {
          debugLogger.warn(
            `SessionEnd hook failed: ${failure instanceof Error ? failure.message : String(failure)}`,
          );
        }
      } finally {
        clearTimeout(timeout);
      }
    })();
    return sessionEndPromise;
  };

  const shutdownHandler = async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    prepareFileWatchersForProcessExit();
    debugLogger.debug('[ACP] Shutdown signal received, closing streams');

    try {
      // Fire SessionEnd hook for all active sessions (aligned with core path)
      await fireSessionEndOnce(SessionEndReason.Other);
      await disposeSessionsOnce();

      try {
        process.stdin.destroy();
      } catch {
        // stdin may already be closed
      }
      try {
        process.stdout.destroy();
      } catch {
        // stdout may already be closed
      }
      // Drain the workspace MCP pool BEFORE runExitCleanup so the
      // descendant pid sweep can SIGTERM wrapper grandchildren.
      await drainPoolBeforeExit('signal');
    } catch (err) {
      debugLogger.error('[ACP] Shutdown error:', err);
    } finally {
      eventLoopMonitor.dispose();
    }
    // Clean up child processes (MCP servers, etc.) and force exit.
    // Without this, orphan subprocesses keep the Node.js event loop alive
    // and the CLI process never terminates after the IDE disconnects.
    runExitCleanup()
      .catch((err) => {
        debugLogger.error('[ACP] Cleanup error:', err);
      })
      .finally(() => {
        process.exit(0);
      });
  };
  process.on('SIGTERM', shutdownHandler);
  process.on('SIGINT', shutdownHandler);

  const shutdownFailures: unknown[] = [];
  try {
    await connection.closed;
    prepareFileWatchersForProcessExit();
    // Connection closed by IDE - fire SessionEnd hook (aligned with core path)
    await fireSessionEndOnce(SessionEndReason.PromptInputExit);
    // Mirror the SIGTERM handler's pool drain on the IDE-initiated
    // normal close path to avoid leaking shared MCP entries.
    await drainPoolBeforeExit('ide_close');
    await disposeSessionsOnce();
  } catch (error) {
    shutdownFailures.push(error);
  } finally {
    try {
      if (!shuttingDown) await output.close();
    } catch (error) {
      if (!shuttingDown) shutdownFailures.push(error);
    }
    process.off('SIGTERM', shutdownHandler);
    process.off('SIGINT', shutdownHandler);
    eventLoopMonitor.dispose();
  }
  if (shutdownFailures.length === 1) throw shutdownFailures[0];
  if (shutdownFailures.length > 1) {
    throw new AggregateError(shutdownFailures, 'ACP EOF shutdown failed');
  }
}

export function toStdioServer(server: McpServer): McpServerStdio | undefined {
  if ('command' in server && 'args' in server && 'env' in server) {
    return server as McpServerStdio;
  }
  return undefined;
}

/**
 * Parse `QWEN_SERVE_MCP_POOL_TRANSPORTS` env var. Comma-separated list
 * e.g. "stdio". Falls back to `POOLED_TRANSPORTS_DEFAULT`
 * on missing / malformed input. Unknown transport names are silently dropped.
 */
function parsePooledTransports(
  envValue: string | undefined,
): ReadonlySet<McpTransportKind> {
  if (!envValue || !envValue.trim()) return POOLED_TRANSPORTS_DEFAULT;
  const KNOWN: ReadonlySet<McpTransportKind> = new Set(['stdio']);
  const out = new Set<McpTransportKind>();
  for (const raw of envValue.split(',')) {
    const trimmed = raw.trim().toLowerCase();
    if (KNOWN.has(trimmed as McpTransportKind)) {
      out.add(trimmed as McpTransportKind);
    }
  }
  // Empty after parsing (all unknown) → fall back to defaults so an
  // operator typo doesn't silently disable the pool entirely.
  return out.size > 0 ? out : POOLED_TRANSPORTS_DEFAULT;
}

/**
 * Parse `QWEN_SERVE_MCP_POOL_DRAIN_MS` env var. Default 30000ms.
 * Bounded to [1000, 600000] (1s-10min).
 */
function parsePoolDrainMs(envValue: string | undefined): number {
  if (!envValue) return 30_000;
  // Reject input that contains anything other than digits. A unit
  // suffix or typo would silently truncate; strict regex prevents this.
  const trimmed = envValue.trim();
  if (!/^\d+$/.test(trimmed)) {
    process.stderr.write(
      `qwen serve: QWEN_SERVE_MCP_POOL_DRAIN_MS=${JSON.stringify(envValue)} ` +
        `is not a valid integer; using default 30000ms.\n`,
    );
    return 30_000;
  }
  const n = Number.parseInt(trimmed, 10);
  if (!Number.isFinite(n)) return 30_000;
  return Math.min(600_000, Math.max(1_000, n));
}

/**
 * Construct the workspace-scoped MCP budget controller from env vars.
 * Returns `undefined` when budget is unset or `off` mode. The pool
 * invokes `tryReserve`/`release`; this helper produces the controller
 * and wires the event callback.
 */
export function createWorkspaceMcpBudget(
  onEvent: (event: McpBudgetEvent) => void,
): WorkspaceMcpBudget | undefined {
  const rawBudget = process.env['QWEN_SERVE_MCP_CLIENT_BUDGET'];
  const rawMode = process.env['QWEN_SERVE_MCP_BUDGET_MODE'];
  // Match `McpClientManager.readBudgetFromEnv`'s parsing exactly: only plain
  // decimal digits set a budget. A loose `Number(...)` would silently accept
  // `0x10`=16, `1e2`=100, and `1.0`=1 (all pass `isInteger`); the strict
  // `/^\d+$/` + `isSafeInteger` check rejects them so the pool and the manager
  // honor the same env values.
  let budget: number | undefined;
  if (rawBudget !== undefined && rawBudget !== '') {
    const trimmed = rawBudget.trim();
    const parsed = Number(trimmed);
    if (/^\d+$/.test(trimmed) && Number.isSafeInteger(parsed) && parsed > 0) {
      budget = parsed;
    } else {
      process.stderr.write(
        `qwen serve: ignoring invalid QWEN_SERVE_MCP_CLIENT_BUDGET=` +
          `'${rawBudget}' (expected positive integer); ` +
          `MCP budget enforcement disabled for this child.\n`,
      );
    }
  }
  const mode: McpBudgetMode = (() => {
    if (rawMode === 'enforce' || rawMode === 'warn' || rawMode === 'off') {
      return rawMode;
    }
    return budget !== undefined ? 'warn' : 'off';
  })();
  if (mode === 'off' || budget === undefined) {
    return undefined;
  }
  return new WorkspaceMcpBudget({
    clientBudget: budget,
    mode,
    onEvent,
  });
}

const MAX_ACP_SESSION_PAGE_SIZE = 100;

function normalizeAcpSessionListSize(value: unknown): number | undefined {
  if (value == null) return undefined;
  if (typeof value !== 'number' || !Number.isSafeInteger(value)) {
    return undefined;
  }
  return Math.min(Math.max(value, 1), MAX_ACP_SESSION_PAGE_SIZE);
}

function parseAcpSessionListCursor(
  value: string | null | undefined,
): number | undefined {
  if (value == null || value === '') return undefined;
  const trimmed = value.trim();
  const parsedCursor = Number(trimmed);
  if (
    trimmed === '' ||
    !Number.isFinite(parsedCursor) ||
    parsedCursor < 0 ||
    parsedCursor > Number.MAX_SAFE_INTEGER
  ) {
    throw RequestError.invalidParams(
      undefined,
      `Invalid cursor: "${value}" is not a valid numeric cursor`,
    );
  }
  return parsedCursor;
}

interface TranscriptReplayConfigCacheEntry {
  settings: LoadedSettings;
  config?: Config;
  pending?: Promise<Config>;
}

interface ActivePromptCall {
  controller: AbortController;
  settled: Promise<void>;
}

class QwenAgent implements Agent {
  private sessions: Map<string, Session> = new Map();
  private modelProviderReloadRevision = 0;
  private readonly historyMutationTails = new Map<string, Promise<void>>();
  private readonly startingSessionIds = new Set<string>();
  /**
   * R7-10: workflow registries of sessions already removed from
   * `this.sessions` whose runs have not finished settling. Consulted by
   * `isWorkflowRunLiveOutsideSession` so a delete-history cannot delete
   * an orphaned live run out from under itself. Pruned as they drain.
   */
  private readonly detachedWorkflowRegistries = new Set<WorkflowRunRegistry>();
  private activePromptCalls = new Map<string, Set<ActivePromptCall>>();
  private readonly generationControllers = new Map<
    string,
    { sessionId: string; controller: AbortController }
  >();
  private readonly workspaceGenerationControllers = new Map<
    string,
    AbortController
  >();
  private readonly transcriptReplayConfigCache = new Map<
    string,
    TranscriptReplayConfigCacheEntry
  >();
  private readonly pendingConfigCleanup = new Map<string, Set<Config>>();
  private readonly initializingConfigs = new Set<Config>();
  /**
   * The last file-derived approval mode each live session actually
   * converged on, seeded with the session's boot-derived mode at
   * publication. `workspaceReload` compares the reloaded disk value against
   * this — not against each session's live mode — because approval mode has
   * writers (`ExitPlanModeTool` approved plan exits, ACP `session/set_mode`,
   * the `sessionApprovalMode` ext) that do not update workspace settings,
   * so a live session legitimately diverges from the file mid-workflow and
   * an unchanged file must not clobber those transitions. The record lives
   * on the daemon so it survives a `this.settings` cache swap, and per
   * session because one daemon-wide baseline cannot represent a partially
   * applied convergence: while a session skipped mid-flip still waits for
   * its value, the file can round-trip back to the old baseline and strand
   * the already-flipped sessions on the intermediate mode. An entry advances
   * only when that session successfully converges, so skipped sessions and
   * failed applies retry on the next reload, and an unparseable file value
   * (undefined fold) is never recorded.
   */
  private readonly sessionApprovalModeConverged = new Map<
    string,
    ApprovalMode
  >();
  private clientCapabilities: ClientCapabilities | undefined;

  /**
   * Workspace-shared MCP transport pool. Eagerly constructed; lazy
   * w.r.t. actual MCP work — spawns nothing until `pool.acquire`.
   *
   * `undefined` when `QWEN_SERVE_NO_MCP_POOL=1` (kill switch); sessions
   * then fall back to per-session McpClient spawn.
   */
  private readonly mcpPool?: McpTransportPool;

  /**
   * Workspace-scoped MCP budget controller. Constructed alongside
   * `mcpPool` when `--mcp-client-budget=N` is configured. `undefined`
   * when no budget is configured or pool kill switch is on.
   */
  private readonly workspaceMcpBudget?: WorkspaceMcpBudget;

  getActiveSessions(): Session[] {
    return [...this.sessions.values()];
  }

  private async runExclusiveHistoryMutation<T>(
    sessionId: string,
    operation: () => Promise<T>,
    waitTimeoutMs?: number,
    waitDisplayTimeoutMs?: number,
  ): Promise<T> {
    const previous =
      this.historyMutationTails.get(sessionId) ?? Promise.resolve();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const current = previous.then(() => gate);
    this.historyMutationTails.set(sessionId, current);
    try {
      if (waitTimeoutMs === undefined) {
        await previous;
      } else {
        await waitForSessionDrain(
          previous,
          waitTimeoutMs,
          'close',
          waitDisplayTimeoutMs,
        );
      }
    } catch (error) {
      release();
      void current.then(() => {
        if (this.historyMutationTails.get(sessionId) === current) {
          this.historyMutationTails.delete(sessionId);
        }
      });
      throw error;
    }
    try {
      return await operation();
    } finally {
      release();
      if (this.historyMutationTails.get(sessionId) === current) {
        this.historyMutationTails.delete(sessionId);
      }
    }
  }

  /**
   * Drain the workspace MCP transport pool. Called on shutdown so all
   * pool entries get a coordinated SIGTERM before process.exit. No-op
   * when pool is undefined (kill-switch mode).
   */
  async shutdownMcpPool(timeoutMs = 10_000): Promise<void> {
    if (!this.mcpPool) return;
    try {
      const result = await this.mcpPool.drainAll({ force: true, timeoutMs });
      if (result.forced > 0 || result.errors.length > 0) {
        debugLogger.warn(
          `MCP pool drain: ${result.drained} clean, ${result.forced} timed out, ` +
            `${result.errors.length} errors`,
        );
        throw new Error(
          `MCP pool drain incomplete: ${result.forced} forced, ${result.errors.length} errors`,
        );
      }
    } catch (err) {
      debugLogger.error(
        `MCP pool drainAll failed: ${err instanceof Error ? err.message : String(err)}`,
      );
      throw err;
    }
  }

  private async removeStoredSessionEntry(
    sessionId: string,
    session: Session,
    cleanupErrors: unknown[] = [],
    options: { shutdownConfig?: boolean } = {},
  ): Promise<void> {
    if (this.sessions.get(sessionId) !== session) return;
    try {
      session.dispose();
    } catch (error) {
      cleanupErrors.push(error);
    }
    try {
      await session.getConfig().unregisterSessionRegistry();
    } catch (error) {
      cleanupErrors.push(error);
    }
    if (options.shutdownConfig !== false) {
      try {
        await session.getConfig().shutdown({ shutdownTelemetry: false });
      } catch (error) {
        cleanupErrors.push(error);
      }
    }
    try {
      this.mcpPool?.releaseSession(sessionId);
    } catch (error) {
      cleanupErrors.push(error);
    }
    try {
      uiTelemetryService.removeSession(sessionId);
    } catch (error) {
      cleanupErrors.push(error);
    }
    this.sessions.delete(sessionId);
    this.sessionApprovalModeConverged.delete(sessionId);
    // R7-10: the registry outlives the session map entry while its runs
    // settle. Keep it reachable so the liveness gate still sees them.
    // Retention is bookkeeping, not cleanup: a Config that cannot answer
    // must not turn a successful close into a shutdown failure.
    try {
      // Prune here as well as on the delete-history path: a daemon that
      // closes sessions mid-run but never deletes history would otherwise
      // retain every one of their registries for its whole lifetime.
      this.pruneDrainedWorkflowRegistries();
      const registry = session.getConfig().getWorkflowRunRegistry?.();
      if (registry && QwenAgent.isWorkflowRegistryDraining(registry)) {
        this.detachedWorkflowRegistries.add(registry);
      }
    } catch (error) {
      debugLogger.warn(
        `Session ${sessionId}: could not retain its workflow registry for liveness checks:`,
        error,
      );
    }
    if (cleanupErrors.length > 0) {
      debugLogger.warn(
        `Session ${sessionId} closed after ${cleanupErrors.length} cleanup failure(s): ${cleanupErrors
          .map((error) =>
            error instanceof Error ? error.message : String(error),
          )
          .join('; ')}`,
      );
    }
  }

  private async withLiveSessionRestore<T>(
    sessionId: string,
    session: Session,
    options: SelectiveSessionRestoreOptions,
    operation: (
      config: Config,
      projection: SessionLiveRestoreProjection | undefined,
    ) => Promise<T>,
  ): Promise<T> {
    await session.assertCanStartTurn();
    const config = session.getConfig();
    const releaseGate = session.beginClose();
    try {
      await waitForSessionDrain(
        session.waitForActiveTurnsToSettle(),
        SESSION_DRAIN_TIMEOUT_MS,
        'restore',
      );
      const recorder = config.getChatRecordingService();
      const readProjection = () =>
        config
          .getSessionService()
          .readLiveRestoreProjection(sessionId, options);
      const projection = recorder
        ? await recorder.runWithWriteBarrier(readProjection)
        : await readProjection();
      if (!projection) throw new SessionWriterUnavailableError();
      return await operation(config, projection);
    } catch (error) {
      throw mapSessionRestoreRequestError(error, sessionId);
    } finally {
      releaseGate();
    }
  }

  private async cleanupUnstoredConfig(config: Config): Promise<void> {
    const sessionId = config.getSessionId();
    const cleanupKey = this.pendingConfigCleanupKey(
      config.getSessionRuntimeBaseDir(),
      sessionId,
    );
    try {
      await shutdownSessionConfig(config);
    } catch (error) {
      this.initializingConfigs.delete(config);
      const pending = this.pendingConfigCleanup.get(cleanupKey) ?? new Set();
      pending.add(config);
      this.pendingConfigCleanup.set(cleanupKey, pending);
      throw mapSessionWriterRequestError(error);
    }
    this.initializingConfigs.delete(config);
    const pending = this.pendingConfigCleanup.get(cleanupKey);
    pending?.delete(config);
    if (pending?.size === 0) {
      this.pendingConfigCleanup.delete(cleanupKey);
    }
  }

  private async cleanupAfterRequestFailure(
    error: unknown,
    cleanup: () => Promise<void>,
    sessionId?: string,
  ): Promise<never> {
    try {
      await cleanup();
    } catch (cleanupError) {
      debugLogger.warn(
        `Session cleanup failed while preserving the original request error: ${cleanupError instanceof Error ? cleanupError.message : String(cleanupError)}`,
      );
    }
    throw sessionId
      ? mapSessionRestoreRequestError(error, sessionId)
      : mapSessionWriterRequestError(error);
  }

  private pendingConfigCleanupKey(
    runtimeBaseDir: string,
    sessionId: string,
  ): string {
    return `${path.resolve(runtimeBaseDir)}\0${sessionId}`;
  }

  private withSessionRestoreMeta<
    T extends { _meta?: Record<string, unknown> | null },
  >(
    session: Session | undefined,
    response: T,
    suppressQuestionHint: boolean,
  ): T {
    const backgroundTurn = session?.getBackgroundTurn?.();
    const hasRunningBackgroundTasks = session?.hasRunningBackgroundTasks?.();
    if (backgroundTurn || hasRunningBackgroundTasks !== undefined) {
      response = {
        ...response,
        _meta: {
          ...response._meta,
          ...(backgroundTurn ? { backgroundTurn } : {}),
          ...(hasRunningBackgroundTasks !== undefined
            ? { hasRunningBackgroundTasks }
            : {}),
        },
      };
    }
    if (suppressQuestionHint || this.argv.restoreAskUserQuestion !== true) {
      return response;
    }
    if (!session?.shouldHintAskUserQuestionRestore()) {
      return response;
    }
    return {
      ...response,
      _meta: {
        ...(response._meta && typeof response._meta === 'object'
          ? response._meta
          : {}),
        [DAEMON_RESTORE_ASK_USER_QUESTION_META_KEY]: true,
      },
    };
  }

  private async retryPendingConfigCleanup(
    runtimeBaseDir: string,
    requiredSessionId?: string,
  ): Promise<void> {
    const resolvedRuntimeBaseDir = path.resolve(runtimeBaseDir);
    const configs = new Set<Config>();
    for (const pending of this.pendingConfigCleanup.values()) {
      for (const config of pending) {
        if (
          path.resolve(config.getSessionRuntimeBaseDir()) ===
          resolvedRuntimeBaseDir
        ) {
          configs.add(config);
        }
      }
    }
    for (const config of configs) {
      try {
        await this.cleanupUnstoredConfig(config);
      } catch (error) {
        if (config.getSessionId() === requiredSessionId) throw error;
        debugLogger.warn(
          `Deferred Config cleanup retry failed for session ${config.getSessionId()}: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
  }

  private async closeStoredSession(
    sessionId: string,
    opts?: {
      requireFlush?: boolean;
      drainTimeoutMs?: number;
      shutdownConfig?: boolean;
      waitForCloseGate?: boolean;
      /**
       * Close only if the Session holds no active work — the daemon's
       * automatic-cleanup path. Explicit close, kill, and shutdown leave this
       * unset and keep their force semantics.
       */
      onlyIfUnheld?: boolean;
    },
  ): Promise<{ closed: boolean; holds: ActiveWorkHoldV1[] }> {
    const session = this.sessions.get(sessionId);
    if (!session) {
      this.mcpPool?.releaseSession(sessionId);
      // Already gone is the outcome the caller wanted, not a refusal.
      return { closed: true, holds: [] };
    }

    const recorder = session.getConfig().getChatRecordingService();
    const requireFlush = opts?.requireFlush === true;
    if (requireFlush) await recorder?.flush();
    const drainTimeoutMs = opts?.drainTimeoutMs ?? SESSION_DRAIN_TIMEOUT_MS;
    const cancelClose = opts?.waitForCloseGate
      ? await beginSessionCloseAfterCurrentGate(session, drainTimeoutMs)
      : session.beginClose();
    const conditionalDrainDeadline = opts?.onlyIfUnheld
      ? Date.now() + drainTimeoutMs
      : undefined;
    // Reject known work before disturbing any active turn. The close gate
    // prevents new turns, but a turn that was already running can still settle
    // into a new hold while the drain below is in progress, so this early read
    // is an optimization rather than the final authorization.
    if (opts?.onlyIfUnheld) {
      const holds = session.collectActiveWorkHolds();
      if (holds.length > 0) {
        cancelClose();
        return { closed: false, holds };
      }
    }
    let removedFromStore = false;
    try {
      if (opts?.onlyIfUnheld) {
        // Let the turn that already owned the gate settle without cancelling
        // queues or stopping schedulers. It may create a hold while settling;
        // a refusal must leave the retained Session untouched.
        await waitForSessionDrain(
          session.waitForActiveTurnsToSettle(),
          drainTimeoutMs,
          'close',
        );
        const holds = session.collectActiveWorkHolds();
        if (holds.length > 0) {
          return { closed: false, holds };
        }
      }

      for (const [requestId, generation] of this.generationControllers) {
        if (generation.sessionId !== sessionId) continue;
        generation.controller.abort();
        this.generationControllers.delete(requestId);
      }
      await waitForSessionDrain(
        (async () => {
          try {
            session.cancelMcpAppCalls();
            await session.cancelPendingPrompt();
          } catch (err) {
            debugLogger.debug(
              `Session ${sessionId} cancel during close failed: ${
                err instanceof Error ? err.message : String(err)
              }`,
            );
          }
          await session.waitForActiveTurnsToSettle();
        })(),
        conditionalDrainDeadline === undefined
          ? drainTimeoutMs
          : Math.max(1, conditionalDrainDeadline - Date.now()),
        'close',
        // Report the shared budget, not the phase-2 residue — a residue like
        // "1ms" hides that the settle phase consumed the budget and sends
        // oncall grepping for a timeout setting that does not exist.
        drainTimeoutMs,
      );

      const blockedByHolds = await this.runExclusiveHistoryMutation(
        sessionId,
        async () => {
          if (this.sessions.get(sessionId) !== session) {
            removedFromStore = true;
            return undefined;
          }

          // Existing out-of-scope work such as a cron turn may have
          // registered a background shell while it drained. Re-check after
          // every active turn has settled, while both the close gate and the
          // history-mutation gate still block destructive races.
          if (opts?.onlyIfUnheld) {
            const holds = session.collectActiveWorkHolds();
            if (holds.length > 0) {
              return { closed: false, holds };
            }
          }

          recorder?.finalize();
          let flushError: unknown;
          try {
            await recorder?.flush();
          } catch (error) {
            flushError = error;
          }
          if (flushError !== undefined && requireFlush) {
            throw flushError;
          }

          let closeError: unknown;
          try {
            await recorder?.close();
          } catch (error) {
            closeError = error;
          }
          if (recorder?.hasWriteOwnership()) {
            throw closeError ?? new SessionWriterUnavailableError();
          }

          const cleanupErrors: unknown[] = [];
          if (flushError !== undefined) cleanupErrors.push(flushError);
          if (closeError !== undefined) cleanupErrors.push(closeError);
          await this.removeStoredSessionEntry(
            sessionId,
            session,
            cleanupErrors,
            {
              shutdownConfig: opts?.shutdownConfig,
            },
          );
          removedFromStore = true;
          return undefined;
        },
        // The mutation wait shares the conditional close's budget too, or
        // the whole round trip can outlast the daemon's outer wait — the
        // coupling the drain budget exists to keep. The mutation body
        // itself stays untimed, so the guarantee remains approximate. The
        // message reports the shared budget, not the residue.
        conditionalDrainDeadline === undefined
          ? drainTimeoutMs
          : Math.max(1, conditionalDrainDeadline - Date.now()),
        drainTimeoutMs,
      );
      if (blockedByHolds) return blockedByHolds;
    } finally {
      if (!removedFromStore) cancelClose();
    }
    return { closed: true, holds: [] };
  }

  private async discardStoredSessionIfCurrent(
    sessionId: string,
    session: Session,
    opts?: {
      requireFlush?: boolean;
      drainTimeoutMs?: number;
      shutdownConfig?: boolean;
      waitForCloseGate?: boolean;
    },
  ): Promise<void> {
    if (this.sessions.get(sessionId) !== session) {
      return;
    }
    await this.closeStoredSession(sessionId, opts);
  }

  async disposeSessions(): Promise<void> {
    for (const generation of this.generationControllers.values()) {
      generation.controller.abort();
    }
    this.generationControllers.clear();
    for (const controller of this.workspaceGenerationControllers.values()) {
      controller.abort();
    }
    this.workspaceGenerationControllers.clear();
    await Promise.allSettled(
      [...this.sessions.entries()].map(([sessionId, session]) =>
        this.discardStoredSessionIfCurrent(sessionId, session, {
          waitForCloseGate: true,
        }),
      ),
    );
    await Promise.allSettled(
      [...this.pendingConfigCleanup.values()]
        .flatMap((configs) => [...configs])
        .map((config) => this.cleanupUnstoredConfig(config)),
    );
    this.disposeTranscriptReplayConfigs();
  }

  constructor(
    private config: Config,
    private settings: LoadedSettings,
    private argv: CliArgs,
    private connection: AgentSideConnection,
    private readonly sessionWriterLeaseEnabledAtStartup = false,
  ) {
    if (config.getShellExecutionSandbox?.()) {
      throw new Error(
        'Tool execution sandbox does not support ACP sessions yet.',
      );
    }
    // Pool kill switch via env var so operators can A/B compare or
    // roll back without rebuilding. `run-qwen-serve.ts` sets this when
    // `--no-mcp-pool` is passed at daemon startup.
    if (process.env['QWEN_SERVE_NO_MCP_POOL'] === '1') {
      this.mcpPool = undefined;
      this.workspaceMcpBudget = undefined;
    } else {
      // Construct the workspace-scoped budget controller when
      // `--mcp-client-budget=N` was set at boot. With the pool active,
      // this controller's accounting REPLACES per-session copies.
      this.workspaceMcpBudget = createWorkspaceMcpBudget((event) => {
        this.broadcastBudgetEvent(event);
      });
      this.mcpPool = new McpTransportPool(this.config, {
        workspaceContext: this.config.getWorkspaceContext(),
        debugMode: this.config.getDebugMode(),
        // sendSdkMcpMessage left undefined: SDK MCP servers always
        // bypass the pool via createUnpooledConnection (per-session
        // routing through ACP control plane). The legacy
        // McpClientManager path retains its own per-session SDK
        // wiring; pool-mode discoverAllMcpToolsViaPool delegates SDK
        // MCP to that bypass.
        pooledTransports: parsePooledTransports(
          process.env['QWEN_SERVE_MCP_POOL_TRANSPORTS'],
        ),
        drainDelayMs: parsePoolDrainMs(
          process.env['QWEN_SERVE_MCP_POOL_DRAIN_MS'],
        ),
        budget: this.workspaceMcpBudget,
      });
    }
  }

  /**
   * Single choke point for pinning the runtime root of an operation to a
   * settings object and a cwd. Every caller in this class goes through here
   * rather than calling `runWithAcpRuntimeOutputDir` directly, so the routing
   * is composed in exactly one place. Which settings to pin with is still the
   * caller's decision at this level: callers that already hold deliberately
   * scoped settings (workspace MCP discovery, live-session scope checks,
   * session creation) pass them in. Per-request session-management handlers
   * (list, delete, rename, transcript page, transcript turn index, settled
   * turn status, and the non-live branch of loadUpdates) must not make that
   * decision themselves — they use `runWithPinnedRuntimeBaseDirForRequest`
   * below. Session load and
   * resume resolve the request's settings at the call site deliberately,
   * under profiler instrumentation, because they adopt those settings for
   * the session afterwards.
   */
  private runWithPinnedRuntimeBaseDir<T>(
    settings: LoadedSettings,
    cwd: string,
    operation: () => T,
  ): T {
    return runWithAcpRuntimeOutputDir(settings, cwd, operation);
  }

  /**
   * Per-request form of `runWithPinnedRuntimeBaseDir` for handlers that act
   * on a caller-supplied cwd. It resolves the settings for THAT cwd itself,
   * so the "which settings pin this operation" decision is made here, once,
   * and a handler cannot reach the pin with the process-wide `this.settings`
   * cache — the bug class fixed in #10095 (three handlers composed the
   * routing by hand and pinned another workspace's runtime root). The
   * operation receives the resolved settings for handlers that also need
   * them inside the pinned scope.
   */
  private runWithPinnedRuntimeBaseDirForRequest<T>(
    cwd: string,
    operation: (settings: LoadedSettings) => T,
  ): T {
    const settings = loadSettingsCached(cwd);
    return this.runWithPinnedRuntimeBaseDir(settings, cwd, () =>
      operation(settings),
    );
  }

  /**
   * Whether an ungated restore replay (qwen/session/loadUpdates) may
   * finalize dangling tool calls. A session with an active turn — a client
   * prompt or an autonomous goal/cron/notification turn — may still owe the
   * trailing call's result, so the replay keeps it pending and lets the
   * live stream deliver it (#9704). Samples the turn state before the
   * transcript read and again at replay time so a turn that starts or
   * settles inside the read window is seen. Not for the live loadSession
   * path: that restore runs under the close gate, which drains active
   * turns, blocks new ones, and reports closing=true — so isTurnIdle()
   * there is structurally false and would keep genuinely abandoned calls
   * pending forever.
   */
  private finalizeDanglingForRestore(
    session: Session | undefined,
    turnIdleBeforeRead: boolean,
  ): boolean {
    const idleAtReplay = session?.isTurnIdle() ?? true;
    const finalize = turnIdleBeforeRead && idleAtReplay;
    // Template literal, not printf-style placeholders: createDebugLogger's
    // formatArgs does no util.format substitution, it space-joins the args.
    debugLogger.debug(
      `[ACP] restore replay finalizeDangling=${finalize} (idleBeforeRead=${turnIdleBeforeRead}, idleAtReplay=${idleAtReplay}) session=${session?.getId() ?? '(non-live)'}`,
    );
    return finalize;
  }

  private async assertLiveSessionScope(
    config: Config,
    settings: LoadedSettings,
    cwd: string,
  ): Promise<void> {
    if (path.resolve(config.storage.getProjectRoot()) !== path.resolve(cwd)) {
      throw RequestError.invalidParams(
        undefined,
        'The live session belongs to another workspace.',
      );
    }
    const requestedRuntimeBaseDir = await this.runWithPinnedRuntimeBaseDir(
      settings,
      cwd,
      () => Storage.getRuntimeBaseDir(),
    );
    if (
      path.resolve(config.getSessionRuntimeBaseDir()) !==
      path.resolve(requestedRuntimeBaseDir)
    ) {
      throw mapSessionWriterRequestError(new SessionWriterUnavailableError());
    }
  }

  /** Expose the pool's workspace-scoped budget controller for snapshot builders. */
  getWorkspaceMcpBudget(): WorkspaceMcpBudget | undefined {
    return this.workspaceMcpBudget;
  }

  /**
   * Fan-out a workspace-scoped MCP budget event to every active
   * session's SSE bus. Each notification is independently
   * fire-and-forget.
   */
  private broadcastBudgetEvent(event: McpBudgetEvent): void {
    // The QwenAgent's `this.connection` is the single ACP channel to
    // the daemon. The daemon's bridge `bridgeClient.extNotification`
    // resolves the per-session SSE bus from the `sessionId` field of
    // each notification — so we send N notifications (one per active
    // session id) over the same connection. Each notification is
    // independently fire-and-forget; a mid-flight ACP disconnect
    // shouldn't sink delivery to siblings.
    //
    // Snapshot the session id list before the async fan-out so a
    // concurrent `killSession` can't corrupt the iterator.
    const sessionIds = Array.from(this.sessions.keys());
    for (const sid of sessionIds) {
      void this.connection
        .extNotification('qwen/notify/session/mcp-budget-event', {
          v: 1,
          sessionId: sid,
          // Tag workspace-scoped events so SDK reducers can branch.
          scope: 'workspace' as const,
          ...event,
        })
        .catch((err: unknown) => {
          debugLogger.debug(
            `MCP workspace budget event delivery to session ${sid} failed ` +
              `(kind=${event.kind}): ${err instanceof Error ? err.message : String(err)}`,
          );
        });
    }
  }

  async initialize(args: InitializeRequest): Promise<InitializeResponse> {
    this.clientCapabilities = args.clientCapabilities;
    const authMethods = pickAuthMethodsForAuthRequired(
      this.config.getCurrentAuthType?.() ?? this.config.getAuthType?.(),
    );
    const version = process.env['CLI_VERSION'] || process.version;

    return {
      protocolVersion: PROTOCOL_VERSION,
      agentInfo: {
        name: 'qwen-code',
        title: 'Qwen Code',
        version,
      },
      authMethods,
      agentCapabilities: {
        loadSession: true,
        promptCapabilities: {
          image: true,
          audio: true,
          embeddedContext: true,
        },
        sessionCapabilities: {
          list: {},
          resume: {},
        },
        _meta: {
          imageCapability: IMAGE_CAPABILITY,
        },
      },
    };
  }

  async authenticate({ methodId }: AuthenticateRequest): Promise<void> {
    const method = z.nativeEnum(AuthType).parse(methodId);
    await this.refreshAuthWithPersistedReasoning(
      this.config,
      this.settings,
      method,
    );
    this.settings.setValue(
      SettingScope.User,
      'security.auth.selectedType',
      method,
    );
  }

  private reserveStartingSessionId(sessionId: string): () => void {
    if (
      this.sessions.has(sessionId) ||
      this.startingSessionIds.has(sessionId)
    ) {
      throw new RequestError(
        ACP_ERROR_CODES.INVALID_PARAMS,
        `Session ${sessionId} is already active or starting.`,
        { errorKind: 'session_id_conflict', sessionId },
      );
    }
    this.startingSessionIds.add(sessionId);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.startingSessionIds.delete(sessionId);
    };
  }

  async newSession(params: NewSessionRequest): Promise<NewSessionResponse> {
    const { cwd, mcpServers } = params;
    const parsedSessionId = parseCallerSuppliedSessionId(
      params._meta?.[REQUESTED_SESSION_ID_META_KEY],
    );
    if (parsedSessionId.kind === 'invalid') {
      throw new RequestError(
        ACP_ERROR_CODES.INVALID_PARAMS,
        `\`_meta["${REQUESTED_SESSION_ID_META_KEY}"]\` must be an RFC UUID v1-v5`,
        { errorKind: 'invalid_session_id', httpStatus: 400 },
      );
    }
    const requestedSessionId =
      parsedSessionId.kind === 'valid' ? parsedSessionId.sessionId : undefined;
    const executionEngine = requestedExecutionEngine(
      params._meta,
      requestedSessionId,
    );
    const releaseStartingSessionId = requestedSessionId
      ? this.reserveStartingSessionId(requestedSessionId)
      : undefined;
    try {
      const sessionSource = getSessionSource(params);
      if (isReservedStandaloneSessionSourceType(sessionSource?.sourceType)) {
        throw RequestError.invalidParams(
          undefined,
          '`standalone` is reserved for daemon-owned session creation',
        );
      }
      const parentContext = extractDaemonTraceContext(params);
      return await withDaemonSpan(
        'qwen-code.daemon.session_start',
        { 'qwen-code.daemon.operation': 'acp_session_new' },
        async (span) => {
          const profiler = createAcpSessionStartProfiler(span);
          // Per-request settings: session handlers run concurrently, and
          // `this.settings` is only a "latest loaded" cache for agent-level
          // readers. Threading the instance explicitly keeps a slow session
          // creation from picking up whichever workspace loaded last — Session
          // persists model changes through this instance, so a mix-up writes to
          // another workspace's settings.json.
          const settings = profiler.timeSync('settings_load', () =>
            loadSettingsCached(cwd),
          );
          this.settings = settings;
          const deferMcpDiscovery = shouldDeferMcpDiscovery(params);
          const configProviderRevision = this.modelProviderReloadRevision;
          const config = await profiler.time('config_setup', () =>
            this.newSessionConfig(
              cwd,
              mcpServers,
              settings,
              sessionSource,
              requestedSessionId,
              undefined,
              deferMcpDiscovery ? { skipMcpDiscovery: true } : undefined,
              undefined,
              undefined,
              executionEngine,
            ),
          );
          let session: Session;
          try {
            await profiler.time('auth', () =>
              this.ensureAuthenticated(config, settings),
            );
            profiler.timeSync('file_system_setup', () =>
              this.setupFileSystem(config),
            );
            session = await profiler.time('session_register', () =>
              this.createAndStoreSession(config, settings, undefined, {
                configProviderRevision,
              }),
            );
          } catch (error) {
            return this.cleanupAfterRequestFailure(error, async () => {
              if (
                this.sessions
                  .get(normalizeSessionIdForLookup(config.getSessionId()))
                  ?.getConfig() !== config
              ) {
                await this.cleanupUnstoredConfig(config);
              }
            });
          }
          profiler.setSessionId(session.getId());
          return profiler.timeSync('response_build', () =>
            withExecutionEngineReceipt<NewSessionResponse>(
              {
                sessionId: session.getId(),
                models: this.buildAvailableModels(config),
                modes: this.buildModesData(config),
                configOptions: this.buildConfigOptions(
                  config,
                  session.getDefaultReasoningConfig(),
                ),
              },
              executionEngine,
            ),
          );
        },
        parentContext ? { parentContext } : {},
      );
    } finally {
      releaseStartingSessionId?.();
    }
  }

  async loadSession(params: LoadSessionRequest): Promise<LoadSessionResponse> {
    const sessionId = normalizeSessionIdForLookup(params.sessionId);
    const executionEngine = requestedExecutionEngine(params._meta, sessionId);
    const parentContext = extractDaemonTraceContext(params);
    return withExecutionEngineReceipt(
      await withDaemonSpan(
        'qwen-code.daemon.session_restore',
        {
          'qwen-code.daemon.operation': 'acp_session_load',
          'qwen-code.daemon.session_restore.action': 'load',
          'session.id': sessionId,
        },
        async (span) =>
          this.loadSessionWithProfiler(
            params,
            sessionId,
            createAcpSessionRestoreProfiler(span),
            executionEngine,
          ),
        parentContext ? { parentContext } : {},
      ),
      executionEngine,
    );
  }

  private async loadSessionWithProfiler(
    params: LoadSessionRequest,
    initialSessionId: string,
    profiler: AcpSessionRestoreProfiler,
    executionEngine: SessionExecutionEngine | undefined,
  ): Promise<LoadSessionResponse> {
    let sessionId = initialSessionId;
    const sessionSource = getSessionSource(params);
    if (isReservedStandaloneSessionSourceType(sessionSource?.sourceType)) {
      throw RequestError.invalidParams(
        undefined,
        '`standalone` is reserved for daemon-owned session restore',
      );
    }
    const restoreOptions = loadRestoreOptions(params);
    // The daemon already knows it will decline the re-hang (no attached
    // client, fork restore): emit no hint and don't skip finalizing the
    // trailing ask_user_question during replay, so skip and re-hang stay
    // in lockstep.
    const suppressRestoreAskUserQuestion =
      (params._meta as Record<string, unknown> | null | undefined)?.[
        DAEMON_SUPPRESS_RESTORE_ASK_USER_QUESTION_META_KEY
      ] === true;
    const suppressWorktreeContextRestore =
      (params._meta as Record<string, unknown> | null | undefined)?.[
        DAEMON_SUPPRESS_WORKTREE_CONTEXT_RESTORE_META_KEY
      ] === true;
    const withRestoreHint = <
      T extends { _meta?: Record<string, unknown> | null },
    >(
      session: Session | undefined,
      response: T,
    ): T =>
      this.withSessionRestoreMeta(
        session,
        response,
        suppressRestoreAskUserQuestion,
      );
    const liveSession = this.sessions.get(sessionId);
    if (liveSession) {
      const settings = profiler.timeSync('settings_load', () =>
        loadSettingsCached(params.cwd),
      );
      const liveConfig = liveSession.getConfig();
      return profiler.time('live_restore', async () => {
        await this.assertLiveSessionScope(liveConfig, settings, params.cwd);
        return this.withLiveSessionRestore(
          sessionId,
          liveSession,
          restoreOptions,
          async (config, projection) => {
            const response = profiler.timeSync(
              'response_build',
              () =>
                ({
                  modes: this.buildModesData(config),
                  models: this.buildAvailableModels(config),
                  configOptions: this.buildConfigOptions(
                    config,
                    liveSession.getDefaultReasoningConfig(),
                  ),
                  ...(projection?.artifactSnapshot
                    ? { artifactSnapshot: projection.artifactSnapshot }
                    : {}),
                }) as LoadSessionResponse,
            );
            const replayPage = projection?.replay;
            if (!replayPage || replayPage.records.length === 0) {
              return withRestoreHint(liveSession, response);
            }

            const bulkReplay = isBulkLoadReplayRequest(params);
            const replay = await profiler.time('history_replay', () =>
              collectHistoryReplayUpdates({
                sessionId,
                config,
                records: replayPage.records,
                gaps: replayPage.gaps,
                cumulativeUsage: createReplayCumulativeUsage(),
                replayState: replayPage.replay,
                goalBootstrap: replayGoalBootstrap(projection),
                suppressRestoreAskUserQuestion,
                // The restore gate already drained active turns and blocks
                // new ones (and a drain timeout rejects before replay), so
                // a trailing unmatched call here is genuinely abandoned —
                // finalize it. The turn-activity guard cannot be sampled
                // under the gate: isTurnIdle() is structurally false while
                // the close gate is held (#9704).
                finalizeDangling: true,
                ...(restoreOptions.replay.kind === 'recent'
                  ? {
                      limits: {
                        maxBytes: LOAD_REPLAY_MAX_BYTES,
                        maxUpdates: LOAD_REPLAY_MAX_UPDATES,
                      },
                    }
                  : {}),
                logger: debugLogger,
              }),
            );
            addDaemonRequestAttribute(
              'qwen-code.daemon.session_restore.partial_replay',
              replay.replayError !== undefined,
            );
            // A cold load publishes the recovered Goal after the replay; a
            // live session's Goal is already published, so the only thing
            // to append is the card that supersedes a running legacy card
            // the page ended on. Nothing, for any transcript this build
            // wrote. A partial replay gets nothing either: the page did not
            // end where the transcript does. The card is presentation, so
            // failing to render it is logged, never a failed load. Rendered
            // once the page is delivered, so it reads the Goal as it stands
            // then, not as it stood before the replay's awaits.
            const renderGoalUpdates = (): SessionUpdate[] => {
              if (replay.replayError !== undefined) return [];
              try {
                return liveSession.renderLegacyGoalSupersession(
                  replayPage.records,
                );
              } catch (error) {
                debugLogger.debug(
                  `Failed to render the legacy Goal supersession: ${
                    error instanceof Error ? error.message : String(error)
                  }`,
                );
                return [];
              }
            };
            if (!bulkReplay) {
              try {
                for (const update of replay.updates) {
                  await liveSession.sendUpdate(update);
                }
              } finally {
                // Replayed plan updates re-stamp the revision via sendUpdate;
                // drop it so a replayed snapshot cannot bind a later approval
                // (same rule Session.replayHistory applies to cold loads),
                // even if delivery fails part-way. The bulk path keeps a live
                // binding on purpose: it hands the updates to the client
                // instead of replaying them through this session.
                liveSession.clearActiveTodoPlanRevision();
              }
              if (replay.replayError !== undefined) {
                throw RequestError.internalError(undefined, replay.replayError);
              }
              for (const update of renderGoalUpdates()) {
                try {
                  await liveSession.sendUpdate(update);
                } catch (error) {
                  debugLogger.debug(
                    `Failed to send the legacy Goal supersession: ${
                      error instanceof Error ? error.message : String(error)
                    }`,
                  );
                }
              }
              return withRestoreHint(liveSession, response);
            }

            const enforceLimits = restoreOptions.replay.kind === 'recent';
            const envelope: BridgeLoadReplayEnvelope = {
              v: LOAD_REPLAY_VERSION,
              updates: replay.updates,
              ...(replayPage.anchorRecordId
                ? { anchorRecordId: replayPage.anchorRecordId }
                : {}),
              ...(replay.replayError !== undefined
                ? {
                    partial: true,
                    replayError: replay.replayError,
                  }
                : {}),
              ...(replayPage.hasMore ? { hasMore: true } : {}),
            };
            if (enforceLimits) {
              degradeReplayEnvelopeAppHtml(envelope, LOAD_REPLAY_MAX_BYTES);
            }
            validateLoadReplayEnvelope(sessionId, envelope, enforceLimits);
            // The card is presentation: a full page simply goes without it.
            appendGoalUpdatesWithinLimits(
              sessionId,
              envelope,
              renderGoalUpdates(),
              enforceLimits,
            );
            return withRestoreHint(liveSession, {
              ...response,
              _meta: {
                [LOAD_REPLAY_META_KEY]: envelope,
              },
            });
          },
        );
      });
    }
    const releaseStartingSessionId = this.reserveStartingSessionId(sessionId);
    try {
      // Load per-request settings only after reserving a non-live id. The check
      // must resolve `advanced.runtimeOutputDir` from this request's cwd.
      const settings = profiler.timeSync('settings_load', () =>
        loadSettingsCached(params.cwd),
      );
      const persistedSessionId = await profiler.time('existence_check', () =>
        this.runWithPinnedRuntimeBaseDir(settings, params.cwd, async () => {
          const sessionService = new SessionService(params.cwd);
          return resolvePersistedSessionIdForRestore(sessionService, sessionId);
        }),
      );
      if (!persistedSessionId) {
        profiler.fail('existence_check');
        throw RequestError.resourceNotFound(`session:${sessionId}`);
      }
      sessionId = persistedSessionId;
      profiler.setSessionId(sessionId);
      // Adopt into the "latest loaded" cache only once the session is
      // confirmed — a failed probe for a stale id must not repoint
      // agent-level readers at this request's workspace.
      this.settings = settings;

      const configProviderRevision = this.modelProviderReloadRevision;
      const config = await profiler.time('config_setup', () =>
        this.newSessionConfig(
          params.cwd,
          // `LoadSessionRequest.mcpServers` is required in today's ACP
          // schema, but mirror `unstable_resumeSession` and tolerate a
          // future loosening — `newSessionConfig` iterates the list, so
          // a `null`/`undefined` would otherwise throw `TypeError`.
          params.mcpServers ?? [],
          settings,
          sessionSource,
          sessionId,
          true,
          // Restore token counts only after the model route is authenticated.
          { skipLlmInitialization: true },
          undefined,
          restoreOptions,
          executionEngine,
        ),
      );
      if (suppressRestoreAskUserQuestion) {
        config.suppressRestorableAskUserQuestionPreservation();
      }
      const projection = config.consumeSessionRestoreProjection?.();
      const fileDerivedApprovalMode = config.getApprovalMode();
      profiler.timeSync('restore_approval_mode', () =>
        applyRestoredSessionApprovalMode(config, projection),
      );
      const suppressRecoveredGoalPresentation =
        projection?.runtime.goalRecoverySourceUuid !== undefined &&
        projection.runtime.goalRecoverySourceUuid !==
          projection.replay?.goalRecoverySourceUuid;
      const bulkReplay = isBulkLoadReplayRequest(params);
      let replayEnvelope: BridgeLoadReplayEnvelope | undefined;
      const replayUsage = createReplayCumulativeUsage();
      let recoveredGoalPublicationKey: string | undefined;
      let suppressedRecoveredGoalId: string | undefined;
      let streamGoalUpdates: SessionUpdate[] = [];
      let response: LoadSessionResponse | undefined;
      const buildResponse = () =>
        profiler.timeSync('response_build', () => ({
          modes: this.buildModesData(config),
          models: this.buildAvailableModels(config),
          configOptions: this.buildConfigOptions(
            config,
            getDefaultReasoningConfig(config, settings),
          ),
          ...(projection?.runtime.artifactSnapshot
            ? { artifactSnapshot: projection.runtime.artifactSnapshot }
            : {}),
          ...(replayEnvelope
            ? {
                _meta: {
                  [LOAD_REPLAY_META_KEY]: replayEnvelope,
                },
              }
            : {}),
        })) as LoadSessionResponse;
      try {
        await profiler.time('restore_session_model', () =>
          restoreSessionModelThenAuthenticate(config, projection, () =>
            profiler.time('auth', () =>
              this.ensureAuthenticated(config, settings),
            ),
          ),
        );
        profiler.timeSync('file_system_setup', () =>
          this.setupFileSystem(config),
        );
        await profiler.time('session_register', () =>
          this.createAndStoreSession(config, settings, undefined, {
            configProviderRevision,
            fileDerivedApprovalMode,
            replayHistory: false,
            prepareBeforeSessionCreate: async () => {
              if (bulkReplay && projection?.replay) {
                const replay = await profiler.time('history_replay', () =>
                  collectHistoryReplayUpdates({
                    sessionId,
                    config,
                    records: projection.replay!.records,
                    gaps: projection.replay!.gaps,
                    cumulativeUsage: replayUsage,
                    replayState: projection.replay!.replay,
                    goalBootstrap: replayGoalBootstrap(projection),
                    suppressRestoreAskUserQuestion,
                    ...(restoreOptions.replay.kind === 'recent'
                      ? {
                          limits: {
                            maxBytes: LOAD_REPLAY_MAX_BYTES,
                            maxUpdates: LOAD_REPLAY_MAX_UPDATES,
                          },
                        }
                      : {}),
                    logger: debugLogger,
                  }),
                );
                addDaemonRequestAttribute(
                  'qwen-code.daemon.session_restore.partial_replay',
                  replay.replayError !== undefined,
                );
                replayEnvelope = {
                  v: LOAD_REPLAY_VERSION,
                  updates: replay.updates,
                  ...(projection.replay.anchorRecordId
                    ? { anchorRecordId: projection.replay.anchorRecordId }
                    : {}),
                  ...(replay.replayError !== undefined
                    ? {
                        partial: true,
                        replayError: replay.replayError,
                      }
                    : {}),
                  ...(projection.replay.hasMore ? { hasMore: true } : {}),
                };
                if (restoreOptions.replay.kind === 'recent') {
                  degradeReplayEnvelopeAppHtml(
                    replayEnvelope,
                    LOAD_REPLAY_MAX_BYTES,
                  );
                }
                validateLoadReplayEnvelope(
                  sessionId,
                  replayEnvelope,
                  restoreOptions.replay.kind === 'recent',
                );
              }
              const goalBootstrap = replayGoalBootstrap(projection);
              const rendered = await renderPreparedGoalUpdate(
                () => config.getGoalRuntimePrepared(),
                {
                  ...(projection?.replay?.records
                    ? { replayedRecords: projection.replay.records }
                    : {}),
                  ...(suppressRecoveredGoalPresentation
                    ? { hideRuntimeGoal: true }
                    : {}),
                  ...(goalBootstrap ? { bootstrap: goalBootstrap } : {}),
                  ...(replayEnvelope?.partial ? { partialReplay: true } : {}),
                },
              ).catch((error) => {
                if (suppressRecoveredGoalPresentation) throw error;
                debugLogger.debug(
                  `Failed to render recovered Goal state: ${
                    error instanceof Error ? error.message : String(error)
                  }`,
                );
                return {
                  publicationKey: undefined,
                  suppressedGoalId: undefined,
                  updates: [],
                };
              });
              recoveredGoalPublicationKey = rendered.publicationKey;
              suppressedRecoveredGoalId = rendered.suppressedGoalId;
              if (!bulkReplay) {
                streamGoalUpdates = rendered.updates;
                return;
              }
              if (rendered.updates.length > 0) {
                replayEnvelope ??= {
                  v: LOAD_REPLAY_VERSION,
                  updates: [],
                };
                const appended = appendGoalUpdatesWithinLimits(
                  sessionId,
                  replayEnvelope,
                  rendered.updates,
                  restoreOptions.replay.kind === 'recent',
                );
                // What a full page cannot carry is the recovered Goal
                // state, which the client must still get: it is sent as
                // live updates once the session is up, as a streamed load
                // sends it. The publication key is primed either way, so
                // the subscription does not publish the same state twice.
                if (!appended) streamGoalUpdates = rendered.updates;
              }
            },
            beforeSessionPublish: () => {
              response = buildResponse();
            },
            primeSession: (createdSession) => {
              profiler.timeSync('runtime_initialize', () => {
                if (!projection) return;
                createdSession.primeTurnState(
                  projection.runtime.initialTurn,
                  projection.runtime.backgroundNotificationTaskIds,
                );
                copyCumulativeUsage(
                  createdSession.cumulativeUsage,
                  replayUsage,
                );
                createdSession.primeRecoveredGoalPublication(
                  recoveredGoalPublicationKey,
                  suppressedRecoveredGoalId,
                );
              });
            },
            beforeStartPostReplayServices: async (createdSession) => {
              if (!bulkReplay && projection?.replay) {
                await profiler.time('history_replay', async () => {
                  const goalBootstrap = replayGoalBootstrap(projection);
                  const initialGoalState = replayInitialGoalState(projection);
                  const hasGoalReplayState =
                    goalBootstrap !== undefined ||
                    initialGoalState.initialGoalState !== undefined ||
                    initialGoalState.initialGoalCause !== undefined;
                  if (hasGoalReplayState) {
                    await createdSession.replayHistory(
                      projection.replay!.records,
                      projection.replay!.gaps,
                      {
                        ...(goalBootstrap ? { goalBootstrap } : {}),
                        ...initialGoalState,
                        ...(suppressRestoreAskUserQuestion
                          ? { skipFinalizeCallIds: undefined }
                          : {}),
                      },
                    );
                  } else if (suppressRestoreAskUserQuestion) {
                    await createdSession.replayHistory(
                      projection.replay!.records,
                      projection.replay!.gaps,
                      { skipFinalizeCallIds: undefined },
                    );
                  } else {
                    await createdSession.replayHistory(
                      projection.replay!.records,
                      projection.replay!.gaps,
                    );
                  }
                });
              }
              try {
                for (const update of streamGoalUpdates) {
                  await createdSession.sendUpdate(update);
                }
              } catch (error) {
                debugLogger.debug(
                  `Failed to publish recovered Goal state: ${
                    error instanceof Error ? error.message : String(error)
                  }`,
                );
              }
              await profiler.time('post_replay_services', async () => {
                if (!suppressWorktreeContextRestore) {
                  await this.#restoreWorktreeOnResume(config, createdSession);
                }
                await this.#restoreBackgroundAgentsOnResume(
                  config,
                  createdSession,
                );
              });
            },
          }),
        );
      } catch (error) {
        return this.cleanupAfterRequestFailure(
          error,
          async () => {
            if (
              this.sessions
                .get(normalizeSessionIdForLookup(config.getSessionId()))
                ?.getConfig() !== config
            ) {
              await this.cleanupUnstoredConfig(config);
            }
          },
          sessionId,
        );
      }
      return withRestoreHint(
        this.sessions.get(normalizeSessionIdForLookup(sessionId)),
        response!,
      );
    } finally {
      releaseStartingSessionId();
    }
  }

  async unstable_resumeSession(
    params: ResumeSessionRequest,
  ): Promise<ResumeSessionResponse> {
    const sessionId = normalizeSessionIdForLookup(params.sessionId);
    const executionEngine = requestedExecutionEngine(params._meta, sessionId);
    const parentContext = extractDaemonTraceContext(params);
    return withExecutionEngineReceipt(
      await withDaemonSpan(
        'qwen-code.daemon.session_restore',
        {
          'qwen-code.daemon.operation': 'acp_session_resume',
          'qwen-code.daemon.session_restore.action': 'resume',
          'session.id': sessionId,
        },
        async (span) =>
          this.resumeSessionWithProfiler(
            params,
            sessionId,
            createAcpSessionRestoreProfiler(span),
            executionEngine,
          ),
        parentContext ? { parentContext } : {},
      ),
      executionEngine,
    );
  }

  private async resumeSessionWithProfiler(
    params: ResumeSessionRequest,
    initialSessionId: string,
    profiler: AcpSessionRestoreProfiler,
    executionEngine: SessionExecutionEngine | undefined,
  ): Promise<ResumeSessionResponse> {
    let sessionId = initialSessionId;
    const sessionSource = getSessionSource(params);
    if (isReservedStandaloneSessionSourceType(sessionSource?.sourceType)) {
      throw RequestError.invalidParams(
        undefined,
        '`standalone` is reserved for daemon-owned session restore',
      );
    }
    // Same daemon-decline suppression as loadSessionWithProfiler: no hint,
    // and the replay finalize-skip stays aligned with the re-hang decision.
    const suppressRestoreAskUserQuestion =
      (params._meta as Record<string, unknown> | null | undefined)?.[
        DAEMON_SUPPRESS_RESTORE_ASK_USER_QUESTION_META_KEY
      ] === true;
    const suppressWorktreeContextRestore =
      (params._meta as Record<string, unknown> | null | undefined)?.[
        DAEMON_SUPPRESS_WORKTREE_CONTEXT_RESTORE_META_KEY
      ] === true;
    const withRestoreHint = <
      T extends { _meta?: Record<string, unknown> | null },
    >(
      session: Session | undefined,
      response: T,
    ): T =>
      this.withSessionRestoreMeta(
        session,
        response,
        suppressRestoreAskUserQuestion,
      );
    const liveSession = this.sessions.get(sessionId);
    if (liveSession) {
      const settings = profiler.timeSync('settings_load', () =>
        loadSettingsCached(params.cwd),
      );
      const liveConfig = liveSession.getConfig();
      return profiler.time('live_restore', async () => {
        await this.assertLiveSessionScope(liveConfig, settings, params.cwd);
        return this.withLiveSessionRestore(
          sessionId,
          liveSession,
          RESUME_RESTORE_OPTIONS,
          async (config, projection) =>
            withRestoreHint(
              liveSession,
              profiler.timeSync(
                'response_build',
                () =>
                  ({
                    modes: this.buildModesData(config),
                    models: this.buildAvailableModels(config),
                    configOptions: this.buildConfigOptions(
                      config,
                      liveSession.getDefaultReasoningConfig(),
                    ),
                    ...(projection?.artifactSnapshot
                      ? { artifactSnapshot: projection.artifactSnapshot }
                      : {}),
                  }) as ResumeSessionResponse,
              ),
            ),
        );
      });
    }
    const releaseStartingSessionId = this.reserveStartingSessionId(sessionId);
    try {
      // Same per-request settings discipline as `loadSession`.
      const settings = profiler.timeSync('settings_load', () =>
        loadSettingsCached(params.cwd),
      );
      const persistedSessionId = await profiler.time('existence_check', () =>
        this.runWithPinnedRuntimeBaseDir(settings, params.cwd, async () => {
          const sessionService = new SessionService(params.cwd);
          return resolvePersistedSessionIdForRestore(sessionService, sessionId);
        }),
      );
      if (!persistedSessionId) {
        profiler.fail('existence_check');
        throw RequestError.resourceNotFound(`session:${sessionId}`);
      }
      sessionId = persistedSessionId;
      profiler.setSessionId(sessionId);
      this.settings = settings;

      const configProviderRevision = this.modelProviderReloadRevision;
      const config = await profiler.time('config_setup', () =>
        this.newSessionConfig(
          params.cwd,
          params.mcpServers ?? [],
          settings,
          sessionSource,
          sessionId,
          true,
          // Restore token counts only after the model route is authenticated.
          { skipLlmInitialization: true },
          undefined,
          RESUME_RESTORE_OPTIONS,
          executionEngine,
        ),
      );
      if (suppressRestoreAskUserQuestion) {
        config.suppressRestorableAskUserQuestionPreservation();
      }
      const projection = config.consumeSessionRestoreProjection?.();
      const fileDerivedApprovalMode = config.getApprovalMode();
      profiler.timeSync('restore_approval_mode', () =>
        applyRestoredSessionApprovalMode(config, projection),
      );
      let response: ResumeSessionResponse | undefined;
      try {
        await profiler.time('restore_session_model', () =>
          restoreSessionModelThenAuthenticate(config, projection, () =>
            profiler.time('auth', () =>
              this.ensureAuthenticated(config, settings),
            ),
          ),
        );
        profiler.timeSync('file_system_setup', () =>
          this.setupFileSystem(config),
        );
        await profiler.time('session_register', () =>
          this.createAndStoreSession(config, settings, undefined, {
            configProviderRevision,
            fileDerivedApprovalMode,
            replayHistory: false,
            beforeSessionPublish: () => {
              response = profiler.timeSync('response_build', () => ({
                modes: this.buildModesData(config),
                models: this.buildAvailableModels(config),
                configOptions: this.buildConfigOptions(
                  config,
                  getDefaultReasoningConfig(config, settings),
                ),
                ...(projection?.runtime.artifactSnapshot
                  ? { artifactSnapshot: projection.runtime.artifactSnapshot }
                  : {}),
              })) as ResumeSessionResponse;
            },
            primeSession: (createdSession) => {
              profiler.timeSync('runtime_initialize', () => {
                if (!projection) return;
                createdSession.primeTurnState(
                  projection.runtime.initialTurn,
                  projection.runtime.backgroundNotificationTaskIds,
                );
              });
            },
            beforeStartPostReplayServices: async (createdSession) => {
              await profiler.time('post_replay_services', async () => {
                if (!suppressWorktreeContextRestore) {
                  await this.#restoreWorktreeOnResume(config, createdSession);
                }
                await this.#restoreBackgroundAgentsOnResume(
                  config,
                  createdSession,
                );
              });
            },
          }),
        );
      } catch (error) {
        return this.cleanupAfterRequestFailure(
          error,
          async () => {
            if (
              this.sessions
                .get(normalizeSessionIdForLookup(config.getSessionId()))
                ?.getConfig() !== config
            ) {
              await this.cleanupUnstoredConfig(config);
            }
          },
          sessionId,
        );
      }

      return withRestoreHint(
        this.sessions.get(normalizeSessionIdForLookup(sessionId)),
        response!,
      );
    } finally {
      releaseStartingSessionId();
    }
  }

  /**
   * Shared worktree restore for both ACP entry points (`loadSession` and
   * `unstable_resumeSession`). Best-effort: failures don't block session
   * load — worktree context is a hint to the model, not a correctness
   * requirement.
   */
  async #restoreWorktreeOnResume(
    config: Config,
    session: Session,
  ): Promise<void> {
    try {
      const sessionPath = config
        .getSessionService()
        .getWorktreeSessionPath(config.getSessionId());
      const restored = await restoreWorktreeContext(
        sessionPath,
        (error) => debugLogger.warn(`ACP worktree restore warning: ${error}`),
        config.getSessionId(),
      );
      if (restored.contextMessage) {
        session.pendingWorktreeNotice = restored.contextMessage;
      }
    } catch (error) {
      debugLogger.warn(`ACP worktree restore failed: ${error}`);
    }
  }

  async #restoreBackgroundAgentsOnResume(
    config: Config,
    session: Session,
  ): Promise<void> {
    await config.loadPausedBackgroundAgents(config.getSessionId());
    session.pendingRecoveredAgentsNotice =
      config.consumePendingRecoveredAgentsNotice();
  }

  async unstable_listSessions(
    params: ListSessionsRequest,
  ): Promise<ListSessionsResponse> {
    const cwd = params.cwd || process.cwd();
    const numericCursor = parseAcpSessionListCursor(params.cursor);

    // The ACP spec's ListSessionsRequest doesn't include a page-size field,
    // so the SDK's zod validator strips any top-level `size` the client sends
    // before it reaches this handler. Carry page size through `_meta.size`
    // (same pattern filesystem.ts uses for `_meta.bom` / `_meta.encoding`).
    const size = normalizeAcpSessionListSize(params._meta?.['size']);

    // Per-request settings: `this.settings` is a "latest loaded" cache, so in
    // a multi-workspace daemon it may hold another workspace's
    // advanced.runtimeOutputDir and this listing would scan the wrong runtime
    // root (returning an empty/foreign list for this cwd).
    const result = await this.runWithPinnedRuntimeBaseDirForRequest(cwd, () => {
      const sessionService = new SessionService(cwd);
      return sessionService.listSessions({
        cursor: numericCursor,
        size,
      });
    });

    const sessions: SessionInfo[] = result.items.map((item) => ({
      _meta: {
        createdAt: item.startTime,
        startTime: item.startTime,
        preview: item.prompt,
        ...(item.gitBranch ? { gitBranch: item.gitBranch } : {}),
        ...(item.titleSource ? { titleSource: item.titleSource } : {}),
      },
      cwd: item.cwd,
      sessionId: item.sessionId,
      title: item.customTitle || item.prompt || '(session)',
      updatedAt: new Date(item.mtime).toISOString(),
    }));

    return {
      sessions,
      nextCursor:
        result.nextCursor != null ? String(result.nextCursor) : undefined,
    };
  }

  async setSessionMode(
    params: SetSessionModeRequest,
  ): Promise<SetSessionModeResponse | void> {
    const sessionId = normalizeSessionIdForLookup(params.sessionId);
    const session = this.sessions.get(sessionId);
    if (!session) {
      throw RequestError.invalidParams(
        undefined,
        `Session not found for id: ${sessionId}`,
      );
    }
    return this.runInSessionContext(session, () =>
      session.setMode({ ...params, sessionId }),
    );
  }

  async unstable_setSessionModel(
    params: SetSessionModelRequest,
  ): Promise<SetSessionModelResponse | void> {
    const sessionId = normalizeSessionIdForLookup(params.sessionId);
    const session = this.sessions.get(sessionId);
    if (!session) {
      throw RequestError.invalidParams(
        undefined,
        `Session not found for id: ${sessionId}`,
      );
    }
    return await this.runInSessionContext(session, () =>
      params._meta?.[SESSION_MODEL_PERSIST_DEFAULT_META_KEY] === false
        ? session.setModel({ ...params, sessionId }, { persistDefault: false })
        : session.setModel({ ...params, sessionId }),
    );
  }

  async setSessionConfigOption(
    params: SetSessionConfigOptionRequest,
  ): Promise<SetSessionConfigOptionResponse> {
    const sessionId = normalizeSessionIdForLookup(params.sessionId);
    const { configId, value } = params;

    const session = this.sessions.get(sessionId);
    if (!session) {
      throw RequestError.invalidParams(
        undefined,
        `Session not found for id: ${sessionId}`,
      );
    }

    return this.runInSessionContext(session, async () => {
      switch (configId) {
        case 'mode': {
          await this.setSessionMode({
            sessionId,
            modeId: value as string,
          });
          break;
        }
        case 'model': {
          await session.setModel(
            {
              sessionId,
              modelId: value as string,
            },
            { persistDefault: false },
          );
          break;
        }
        case 'reasoning_effort': {
          const config = session.getConfig();
          const generation = config.getContentGeneratorConfig();
          const defaultReasoning = session.getDefaultReasoningConfig();
          const option = this.buildConfigOptions(config, defaultReasoning).find(
            (candidate) => candidate.id === 'reasoning_effort',
          );
          const modelReasoning = this.getModelReasoningConfiguration(config);
          const selected = parseReasoningSelection(value);
          const choices =
            option?.options.flatMap((choice) =>
              'value' in choice
                ? [choice.value]
                : choice.options.map((nested) => nested.value),
            ) ?? [];
          if (
            !option ||
            !selected ||
            (selected !== REASONING_EFFORT_DEFAULT &&
              !choices.includes(selected))
          ) {
            const allowedChoices = modelReasoning
              ? choices
              : [
                  REASONING_EFFORT_DEFAULT,
                  ...choices.filter(
                    (choice) => choice !== REASONING_EFFORT_DEFAULT,
                  ),
                ];
            throw RequestError.invalidParams(
              undefined,
              option
                ? `Unknown reasoning effort: ${String(value)}. Choose one of: ${allowedChoices.join(', ')}`
                : 'Reasoning is not supported by the current model',
            );
          }

          const persist =
            params._meta?.[PERSIST_REASONING_SELECTION_META_KEY] === true;
          const tierSelected =
            selected !== REASONING_EFFORT_NONE &&
            selected !== REASONING_EFFORT_DEFAULT;
          if (
            !modelReasoning &&
            tierSelected &&
            generation.reasoning === false
          ) {
            throw RequestError.invalidParams(
              undefined,
              'Reasoning effort cannot be applied while thinking is disabled',
            );
          }
          const previous = {
            reasoning: generation.reasoning,
            extra_body: generation.extra_body,
            samplingParams: generation.samplingParams,
          };
          const rebuildable = config
            .getModelsConfig?.()
            ?.getGenerationConfig?.();
          const previousRebuildableReasoning = rebuildable?.reasoning;
          try {
            if (modelReasoning && !modelReasoning.toggleOnly) {
              clearReasoningRequestOverrides(generation);
            }
            applyReasoningSelection(config, selected, defaultReasoning);
            if (!modelReasoning && selected !== REASONING_EFFORT_NONE) {
              config.setReasoningEffort?.(
                selected === REASONING_EFFORT_DEFAULT
                  ? defaultReasoning
                    ? defaultReasoning.effort
                    : undefined
                  : selected,
              );
            }
            const configOptions = this.buildConfigOptions(
              config,
              defaultReasoning,
            );
            const confirmedValue = configOptions.find(
              (candidate) => candidate.id === 'reasoning_effort',
            )?.currentValue;
            const confirmed =
              selected === REASONING_EFFORT_DEFAULT
                ? confirmedValue !== undefined
                : confirmedValue === selected;
            if (
              !confirmed ||
              (tierSelected &&
                getGptReasoningOverrideState(generation, modelReasoning)
                  ?.blocksTierChange)
            ) {
              throw RequestError.invalidParams(
                undefined,
                modelReasoning
                  ? `Reasoning selection was not applied: ${selected}`
                  : 'Reasoning effort cannot be applied while thinking is disabled',
              );
            }
            if (persist) {
              session.persistReasoningSelection(selected);
            }
            session.setSessionReasoningSelection(
              persist ? undefined : selected,
            );
            return {
              configOptions,
              ...(persist
                ? { _meta: { [REASONING_SELECTION_PERSISTED_META_KEY]: true } }
                : {}),
            };
          } catch (error) {
            Object.assign(generation, previous);
            if (rebuildable)
              rebuildable.reasoning = previousRebuildableReasoning;
            throw error;
          }
        }
        default:
          throw RequestError.invalidParams(
            undefined,
            `Unsupported configId: ${configId}`,
          );
      }

      return {
        configOptions: this.buildConfigOptions(
          session.getConfig(),
          session.getDefaultReasoningConfig(),
        ),
      };
    });
  }

  async prompt(params: PromptRequest): Promise<PromptResponse> {
    const sessionId = normalizeSessionIdForLookup(params.sessionId);
    const session = this.sessions.get(sessionId);
    if (!session) {
      throw new Error(`Session not found: ${sessionId}`);
    }
    const sanitizedParams = { ...params, sessionId };
    const meta =
      params._meta && typeof params._meta === 'object'
        ? { ...params._meta }
        : {};
    const submittedPrompt = meta[SUBMITTED_PROMPT_META_KEY];
    delete meta[DAEMON_PROMPT_DISPLAY_TEXT_META_KEY];
    delete meta[SUBMITTED_PROMPT_META_KEY];
    delete meta[DAEMON_SUBMITTED_PROMPT_META_KEY];
    if (typeof submittedPrompt === 'string') {
      meta[DAEMON_SUBMITTED_PROMPT_META_KEY] = submittedPrompt;
    }
    delete meta['qwen.goalProposalApproval'];
    delete meta[DAEMON_CHANNEL_DELIVERY_META_KEY];
    if (Object.keys(meta).length > 0) {
      sanitizedParams._meta = meta;
    } else {
      delete sanitizedParams._meta;
    }

    let settleCall = () => {};
    const call: ActivePromptCall = {
      controller: new AbortController(),
      settled: new Promise<void>((resolve) => {
        settleCall = resolve;
      }),
    };
    let calls = this.activePromptCalls.get(sessionId);
    if (!calls) {
      calls = new Set();
      this.activePromptCalls.set(sessionId, calls);
    }
    calls.add(call);
    try {
      return await session.prompt(sanitizedParams, call.controller.signal);
    } finally {
      calls.delete(call);
      if (calls.size === 0) {
        this.activePromptCalls.delete(sessionId);
      }
      settleCall();
    }
  }

  async cancel(params: CancelNotification): Promise<void> {
    const sessionId = normalizeSessionIdForLookup(params.sessionId);
    const session = this.sessions.get(sessionId);
    if (!session) {
      throw new Error(`Session not found: ${sessionId}`);
    }
    await this.runInSessionContext(session, async () => {
      try {
        await session.cancelPendingPrompt();
      } catch (error) {
        if (!isNotCurrentlyGeneratingCancelError(error)) {
          throw error;
        }
      }
      // Prompt calls still waiting at Session admission are tracked in
      // activePromptCalls but have no session pendingPrompt yet, so
      // cancelPendingPrompt cannot see them. Abort their controllers too, or a
      // cancelled prompt would run in full once admission frees.
      for (const call of this.activePromptCalls.get(sessionId) ?? []) {
        call.controller.abort();
      }
    });
  }

  private loadPermissionSettings(cwd: string): LoadedSettings {
    return this.adoptRequestSettings(this.loadRequestSettings(cwd), cwd);
  }

  /**
   * Publish a freshly loaded `LoadedSettings` into the process-wide
   * `this.settings` cache only when it was loaded for the daemon's own
   * workspace. `this.settings` is the "latest loaded" cache read by the
   * daemon-global control handlers (`workspaceReload`,
   * `workspaceModelProvidersReload`, `qwen/settings/getPath`, workspace
   * status): a session-scoped load for a foreign workspace (worktree) must
   * stay request-local, or that workspace's settings, approval mode, MCP
   * servers, hooks and permission rules would bleed into every other live
   * session. The load still returns the caller's instance either way.
   */
  private adoptRequestSettings(
    settings: LoadedSettings,
    settingsCwd: string,
  ): LoadedSettings {
    if (
      this.canonicalWorkspacePath(settingsCwd) ===
      this.canonicalWorkspacePath(this.config.getTargetDir())
    ) {
      this.settings = settings;
    }
    return settings;
  }

  /**
   * Canonical spelling for workspace-coordinate comparisons. A session's
   * admission root and a request's settings cwd can name the same directory
   * through a symlink (`/tmp` vs `/private/tmp` on macOS) or a different case
   * on a case-insensitive volume; a plain string compare then turns a
   * workspace grant's *revocation* into a no-op on the live session while the
   * caller is told it saved (fail-open). `realpathSync.native()` resolves
   * both through the filesystem — including the on-disk casing on macOS and
   * Windows — and deliberately does NOT fold case itself: on a case-sensitive
   * volume `proj` and `PROJ` are genuinely different workspaces, and folding
   * would silently authorise one under a rule written for the other.
   */
  private canonicalWorkspacePath(workspacePath: string): string {
    const resolved = path.resolve(workspacePath);
    try {
      return realpathSync.native(resolved);
    } catch {
      // The path does not exist (yet); compare the resolved spelling.
      return resolved;
    }
  }

  /**
   * Load settings for a single `qwen/settings/*` / `qwen/permissions/*`
   * request. `skipLoadEnvironment` is set because a per-request read — and, for
   * session-scoped calls, a foreign-workspace read — must not inject that
   * workspace's `.env` into the daemon's process-wide `process.env`; env
   * application stays with the daemon-global reload handlers that call
   * `reloadEnvironment` deliberately. `consumeCorruptionEnvVars` is stated
   * explicitly because passing an options object replaces `loadSettings`'s
   * `= true` default.
   */
  private loadRequestSettings(settingsCwd: string): LoadedSettings {
    return loadSettings(settingsCwd, {
      consumeCorruptionEnvVars: true,
      skipLoadEnvironment: true,
    });
  }

  /**
   * Resolve the workspace root for the session-aware `qwen/settings/*` +
   * `qwen/permissions/*` handlers — the ones whose write and read-back share
   * the resolved coordinate. The handlers whose status/apply routes are
   * workspace-global (`setMcpServer`, `removeMcpServer`, `setHook`,
   * `removeHook`, `setExtensionSetting`) deliberately do NOT resolve
   * `sessionId`: their write would land in the session's worktree while the
   * status and reload routes keep reading the bootstrap workspace, so the
   * handler would answer "saved" for a server no route ever lists or applies.
   * Those five resolve `requestedCwd || this.config.getTargetDir()` instead
   * (`||`, not `??`: a present-but-empty `cwd` is not a workspace and falls to
   * the bootstrap dir like an absent one).
   *
   * `sessionId` names the requesting session, whose own Config is
   * relocated to its worktree; without one the daemon's bootstrap
   * `this.config` is used — nothing relocates the agent-level Config, so that
   * is the boot workspace and swapping `process.cwd()` for
   * `this.config.getTargetDir()` is a no-op there. An unresolvable `sessionId`
   * is rejected rather than silently retargeting the read/write to the
   * bootstrap workspace, whose trust decision and settings the caller never
   * selected.
   */
  private settingsCwdFor(
    requestedCwd: string | undefined,
    params: Record<string, unknown>,
  ): string {
    // An explicit `cwd` from the request wins outright: the `sessionId` lookup
    // below only exists to resolve the session's own workspace root when the
    // caller did not name one, so a well-targeted request must not be rejected
    // over a field the resolver will not use.
    if (requestedCwd) {
      return requestedCwd;
    }
    const sessionId = params['sessionId'];
    if (sessionId !== undefined && sessionId !== null) {
      if (typeof sessionId !== 'string' || sessionId.length === 0) {
        // A present-but-malformed `sessionId` (a number, an object, an empty
        // string) is a caller error, not "absent": falling through would
        // silently read/write the bootstrap workspace the caller never
        // selected.
        throw RequestError.invalidParams(
          undefined,
          'Invalid sessionId: expected a non-empty string',
        );
      }
      const session = this.sessions.get(sessionId);
      if (!session) {
        throw new RequestError(-32004, `Session not found: ${sessionId}`, {
          errorKind: 'session_not_found',
          sessionId,
        });
      }
      // Resolve the session's stable workspace root, not its live cwd:
      // `session/cd` relocates `config.targetDir` into a subdirectory that
      // carries no `.qwen/settings.json`, while `storage` stays bound to the
      // admission workspace (`relocateWorkingDirectory` runs with
      // `skipArtifactMigration: true`, so it never replaces `storage`). The
      // live cwd would make all twelve handlers read/write a stray
      // `<subdir>/.qwen/settings.json` after a single cd.
      return this.sessionWorkspaceRoot(session.getConfig());
    }
    return this.config.getTargetDir();
  }

  private async buildCoreSettings(
    settings: LoadedSettings,
    cwd: string,
  ): Promise<Record<string, unknown>> {
    const userSettings = settings.user.settings as Record<string, unknown>;
    const workspaceSettings = settings.workspace.settings as Record<
      string,
      unknown
    >;
    const mergedSettings = settings.merged as Record<string, unknown>;

    let extensions: ReturnType<ExtensionManager['getLoadedExtensions']> = [];
    try {
      const extensionManager = new ExtensionManager({
        workspaceDir: cwd,
        isWorkspaceTrusted: settings.isTrusted,
        locale: getCurrentLanguage(),
      });
      await extensionManager.refreshCache();
      extensions = extensionManager.getLoadedExtensions();
    } catch (error) {
      debugLogger.warn(
        'Extension loading failed, continuing without extensions:',
        error,
      );
    }

    const extensionEntries = await Promise.all(
      extensions.map(async (extension) => {
        const userEnv = await getScopedEnvContents(
          extension.config,
          extension.id,
          ExtensionSettingScope.USER,
        );
        const workspaceEnv = await getScopedEnvContents(
          extension.config,
          extension.id,
          ExtensionSettingScope.WORKSPACE,
        );
        const settingDefs = extension.settings ?? [];
        return {
          id: extension.id,
          name: extension.name,
          displayName: extension.displayName,
          version: extension.version,
          isActive: extension.isActive,
          path: extension.path,
          commands: extension.commands ?? [],
          skills: (extension.skills ?? []).map((skill) => skill.name),
          mcpServers: Object.keys(extension.config.mcpServers ?? {}),
          settings: settingDefs.map((setting) => {
            const userValue = userEnv[setting.envVar];
            const workspaceValue = workspaceEnv[setting.envVar];
            const hasWorkspaceValue = workspaceValue !== undefined;
            const hasUserValue = userValue !== undefined;
            const effectiveValue = hasWorkspaceValue
              ? workspaceValue
              : userValue;
            const effectiveScope = hasWorkspaceValue
              ? 'workspace'
              : hasUserValue
                ? 'user'
                : undefined;
            return {
              name: setting.name,
              description: setting.description,
              envVar: setting.envVar,
              sensitive: !!setting.sensitive,
              userValue: setting.sensitive ? undefined : userValue,
              workspaceValue: setting.sensitive ? undefined : workspaceValue,
              effectiveValue: setting.sensitive ? undefined : effectiveValue,
              effectiveScope,
              hasUserValue,
              hasWorkspaceValue,
            };
          }),
        };
      }),
    );

    const activeExtensions = extensions.filter(
      (extension) => extension.isActive,
    );
    const extensionMcpServers = activeExtensions.flatMap((extension) =>
      readMcpServers(
        { mcpServers: extension.config.mcpServers ?? {} },
        'extension',
      ).map((entry) => ({
        ...entry,
        server: {
          ...entry.server,
          extensionName: extension.displayName ?? extension.name,
        },
      })),
    );
    const extensionHooks = activeExtensions.flatMap((extension) =>
      readHooks(
        { hooks: extension.hooks ?? {} },
        'extension',
        extension.displayName ?? extension.name,
      ),
    );

    // Build the merged MCP/hook lists from the user and workspace settings
    // separately so each entry keeps its real scope label. Reading
    // mergedSettings with a single 'workspace' label mislabeled user-scope
    // servers/hooks. MCP servers are keyed by name, so dedupe with workspace
    // overriding user (matching the merged/effective semantics); hooks stack
    // across scopes, so they are concatenated.
    const mergedMcpByName = new Map<
      string,
      ReturnType<typeof readMcpServers>[number]
    >();
    for (const entry of readMcpServers(userSettings, 'user')) {
      mergedMcpByName.set(entry.name, entry);
    }
    if (settings.isTrusted) {
      for (const entry of readMcpServers(workspaceSettings, 'workspace')) {
        mergedMcpByName.set(entry.name, entry);
      }
    }
    const mergedHooks = [
      ...readHooks(userSettings, 'user'),
      ...(settings.isTrusted ? readHooks(workspaceSettings, 'workspace') : []),
    ];

    return {
      user: {
        path: settings.user.path,
        values: readCoreSettingValues(userSettings),
        mcpServers: readMcpServers(userSettings, 'user'),
        hooks: readHooks(userSettings, 'user'),
      },
      workspace: {
        path: settings.workspace.path,
        values: readCoreSettingValues(workspaceSettings),
        mcpServers: readMcpServers(workspaceSettings, 'workspace'),
        hooks: readHooks(workspaceSettings, 'workspace'),
      },
      merged: {
        values: readCoreSettingValues(mergedSettings),
        mcpServers: [...mergedMcpByName.values(), ...extensionMcpServers],
        hooks: [...mergedHooks, ...extensionHooks],
      },
      extensions: extensionEntries,
      isTrusted: settings.isTrusted,
    };
  }

  private syncLivePermissionManagers(
    before: PermissionRuleSet,
    after: PermissionRuleSet,
    settingScope: SettingScope,
    settingsCwd: string,
  ): void {
    for (const ruleType of PERMISSION_RULE_TYPES) {
      const oldRules = new Set(before[ruleType]);
      const newRules = new Set(after[ruleType]);
      const removed = before[ruleType].filter((rule) => !newRules.has(rule));
      const added = after[ruleType].filter((rule) => !oldRules.has(rule));

      if (removed.length === 0 && added.length === 0) continue;

      for (const session of this.sessions.values()) {
        if (settingScope === SettingScope.Workspace) {
          // A workspace-scoped write only applies to sessions bound to the
          // workspace it landed in. `settingsCwd` is the requesting session's
          // stable workspace root; skip sessions in other workspaces so a
          // worktree's grant/deny doesn't fan out to every live session with
          // no record in their own settings files.
          const sessionWorkspace = this.sessionWorkspaceRoot(
            session.getConfig(),
          );
          if (
            this.canonicalWorkspacePath(sessionWorkspace) !==
            this.canonicalWorkspacePath(settingsCwd)
          ) {
            continue;
          }
        }
        const pm = session.getConfig().getPermissionManager?.();
        if (!pm) continue;
        // Isolate per-session failures: a stale/broken permission manager for
        // one session must not abort syncing the rest (settings are already
        // persisted, so the in-memory sync is best-effort).
        try {
          for (const rule of removed) {
            pm.removePersistentRule(rule, ruleType);
          }
          for (const rule of added) {
            pm.addPersistentRule(rule, ruleType);
          }
        } catch (error) {
          debugLogger.warn(
            `Failed to sync permission rules to a live session: ${
              error instanceof Error ? error.message : String(error)
            }`,
          );
        }
      }
    }
  }

  /**
   * The stable workspace root a session was admitted under. Unlike
   * `Config.getProjectRoot()` (the live `targetDir`), this reads the admission-bound `storage`, which
   * `relocateWorkingDirectory` leaves untouched when `session/cd` moves a
   * session into a subdirectory (`skipArtifactMigration: true`). Keying the
   * twelve `qwen/settings/*` / `qwen/permissions/*` handlers and the
   * workspace-scoped permission fan-out on this root — rather than the live
   * cwd — is what keeps a post-`cd` request from reading/writing a stray
   * `<subdir>/.qwen/settings.json`.
   */
  private sessionWorkspaceRoot(config: Config): string {
    return config.storage.getProjectRoot();
  }

  private sessionOrThrow(sessionId: string): Session {
    const session = this.sessions.get(sessionId);
    if (!session) {
      throw RequestError.invalidParams(
        undefined,
        `Session not found for id: ${sessionId}`,
      );
    }
    return session;
  }

  private runInSessionContext<T>(session: Session, fn: () => T): T {
    // Use the Config's session id spelling (not the lowercased lookup form
    // stored on the Session object) so the context matches the binding in
    // Session.ts and the debug log filename on disk.
    return sessionIdContext.run(session.getConfig().getSessionId(), fn);
  }

  private isSessionScopedExtMethod(method: string): boolean {
    return (
      method.startsWith('qwen/session/') ||
      method === 'deleteSession' ||
      method === 'renameSession' ||
      method === 'rewindSession' ||
      method === 'restoreSessionHistory'
    );
  }

  async extMethod(
    method: string,
    params: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    try {
      const rawSessionId = params['sessionId'];
      const normalizedParams =
        typeof rawSessionId === 'string'
          ? {
              ...params,
              sessionId: normalizeSessionIdForLookup(rawSessionId),
            }
          : params;
      const sessionId = normalizedParams['sessionId'];
      const session =
        typeof sessionId === 'string' && sessionId.length > 0
          ? this.sessions.get(sessionId)
          : undefined;
      if (
        typeof sessionId === 'string' &&
        sessionId.length > 0 &&
        this.isSessionScopedExtMethod(method) &&
        (session !== undefined || SESSION_ID_RE.test(sessionId))
      ) {
        return await sessionIdContext.run(
          session?.getConfig().getSessionId() ?? sessionId,
          () => this.extMethodInternal(method, normalizedParams),
        );
      }

      return await this.extMethodInternal(method, normalizedParams);
    } catch (error) {
      const writerError = getSessionWriterError(error);
      if (writerError) {
        throw new RequestError(writerError.rpcCode, writerError.message, {
          errorKind: writerError.errorKind,
        });
      }
      throw error;
    }
  }

  private async extMethodInternal(
    method: string,
    params: Record<string, unknown>,
  ): Promise<Record<string, unknown>> {
    const requestedCwd =
      typeof params['cwd'] === 'string' ? params['cwd'] : undefined;
    const cwd = requestedCwd || process.cwd();

    switch (method) {
      case 'qwen/providers/list': {
        return {
          providers: ALL_PROVIDERS.map((provider) =>
            serializeProviderConfig(provider, this.settings),
          ),
        };
      }
      case 'qwen/providers/connect': {
        const providerId = readRequiredString(
          params['providerId'],
          'providerId',
        );
        const providerConfig = findProviderById(providerId);
        if (!providerConfig) {
          throw RequestError.invalidParams(
            undefined,
            `Unknown provider: ${providerId}`,
          );
        }

        const inputs = readProviderSetupInputs(
          providerConfig,
          params,
          (baseUrl, modelIds) =>
            resolveExistingProviderApiKey(
              providerConfig,
              this.settings,
              baseUrl,
              modelIds,
            ),
        );
        const persistScope = readProviderConnectScope(params['scope']);
        const plan = buildInstallPlan(
          providerConfig,
          inputs,
          getProviderModels(this.settings.merged.modelProviders),
        );
        const adapter = createLoadedSettingsAdapter(
          this.settings,
          persistScope,
        );
        await applyProviderInstallPlan(plan, {
          settings: adapter,
          reloadModelProviders: (modelProviders) =>
            this.config.reloadModelProvidersConfig(modelProviders),
          syncAuthState: (authType, modelId, baseUrl) =>
            this.config.syncModelSelection(authType, modelId, baseUrl),
          refreshAuth: (authType) =>
            this.refreshAuthWithPersistedReasoning(
              this.config,
              this.settings,
              authType,
            ),
        });
        const effectiveModelId =
          (adapter.getValue('model.name') as string | undefined) ??
          plan.modelSelection?.modelId;
        const effectiveBaseUrl =
          (adapter.getValue('model.baseUrl') as string | undefined) ??
          plan.modelSelection?.baseUrl;
        return {
          success: true,
          providerId: providerConfig.id,
          providerLabel: providerConfig.label,
          authType: plan.authType,
          ...(effectiveModelId ? { modelId: effectiveModelId } : {}),
          ...(effectiveBaseUrl ? { baseUrl: effectiveBaseUrl } : {}),
        };
      }
      case 'qwen/skills/delete': {
        return deleteManagedSkill(this.config, params);
      }
      case 'qwen/skills/setEnabled': {
        return setManagedSkillEnabled(this.config, params, requestedCwd);
      }
      case 'qwen/settings/getMemory': {
        const settingsCwd = this.settingsCwdFor(requestedCwd, params);
        const settings = this.loadRequestSettings(settingsCwd);
        this.adoptRequestSettings(settings, settingsCwd);
        return {
          settings: normalizeQwenMemorySettings(settings.merged.memory),
        };
      }
      case 'qwen/settings/setMemory': {
        const updates = toRecord(params['updates']);
        // Mutate a freshly loaded settings object and adopt it, mirroring the
        // other settings mutation handlers, instead of writing through the
        // possibly-stale cached `this.settings` and reading it back.
        const settingsCwd = this.settingsCwdFor(requestedCwd, params);
        const settings = this.loadRequestSettings(settingsCwd);
        for (const key of QWEN_MEMORY_SETTING_KEYS) {
          if (updates[key] === undefined) continue;
          if (typeof updates[key] !== 'boolean') {
            throw RequestError.invalidParams(
              undefined,
              `Invalid memory setting '${key}': expected boolean`,
            );
          }
          settings.setValue(SettingScope.User, `memory.${key}`, updates[key]);
        }
        this.adoptRequestSettings(settings, settingsCwd);
        return {
          settings: normalizeQwenMemorySettings(settings.merged.memory),
        };
      }
      case 'qwen/settings/getPath': {
        return { path: this.settings.user.path };
      }
      case 'qwen/settings/getMemoryPaths': {
        const settingsCwd = this.settingsCwdFor(requestedCwd, params);
        const projectRoot =
          typeof params['projectRoot'] === 'string'
            ? params['projectRoot']
            : settingsCwd;
        return {
          paths: await resolveQwenMemoryPaths({
            cwd: settingsCwd,
            projectRoot,
          }),
        };
      }
      case 'qwen/session/recordTextElements': {
        const sessionId = params['sessionId'];
        const content = params['content'];
        const textElements = params['textElements'];
        if (typeof sessionId !== 'string' || sessionId.length === 0) {
          throw RequestError.invalidParams(
            undefined,
            'Invalid or missing sessionId',
          );
        }
        if (typeof content !== 'string' || !Array.isArray(textElements)) {
          throw RequestError.invalidParams(
            undefined,
            'Invalid user text elements payload',
          );
        }
        const session = this.sessionOrThrow(sessionId);
        await session.assertCanStartTurn();
        const recording = session.getConfig().getChatRecordingService();
        if (!recording) {
          throw RequestError.internalError(
            undefined,
            'Chat recording service unavailable',
          );
        }
        await recording.recordUserTextElements({ content, textElements });
        return { sessionId, persisted: true };
      }
      case 'deleteSession': {
        const sessionId = params['sessionId'] as string;
        if (!sessionId || !SESSION_ID_RE.test(sessionId)) {
          throw RequestError.invalidParams(
            undefined,
            'Invalid or missing sessionId',
          );
        }
        // Per-request settings, not the "latest loaded" this.settings cache:
        // another workspace's advanced.runtimeOutputDir would point this
        // destructive lookup at the wrong runtime root — silently returning
        // success:false for a session that exists, or deleting a stale
        // same-id copy under the wrong root.
        const success = await this.runWithPinnedRuntimeBaseDirForRequest(
          cwd,
          async () => {
            const sessionService = new SessionService(cwd);
            return sessionService.removeSession(sessionId);
          },
        );
        if (success) {
          fireSessionDeleteHook(this.config, sessionId, debugLogger);
        }
        return { success };
      }
      case 'renameSession': {
        const sessionId = params['sessionId'] as string;
        const title = params['title'] as string;
        if (!sessionId || !SESSION_ID_RE.test(sessionId)) {
          throw RequestError.invalidParams(
            undefined,
            'Invalid or missing sessionId',
          );
        }
        if (!title || typeof title !== 'string') {
          throw RequestError.invalidParams(
            undefined,
            'Invalid or missing title',
          );
        }
        if (title.length > SESSION_TITLE_MAX_LENGTH) {
          throw RequestError.invalidParams(
            undefined,
            `Title too long (max ${SESSION_TITLE_MAX_LENGTH} chars)`,
          );
        }
        // When the target session is currently live in this process, route
        // through its ChatRecordingService so the in-memory `currentCustomTitle`
        // stays in sync. Writing directly to disk via SessionService here
        // would leave the live recording's cache stale; the next title
        // re-anchor (every 32KB of writes) or finalize() would re-emit the
        // old title and silently revert the rename. The disk-only path
        // remains for the dead-session case (e.g., another client renaming
        // a session that isn't active in this process).
        const liveRecording = this.sessions
          .get(sessionId)
          ?.getConfig()
          .getChatRecordingService();
        if (liveRecording) {
          const ok = await liveRecording.recordCustomTitle(title, 'manual');
          return { success: ok };
        }
        // Per-request settings for the same reason as deleteSession above.
        const success = await this.runWithPinnedRuntimeBaseDirForRequest(
          cwd,
          async () => {
            const sessionService = new SessionService(cwd);
            return sessionService.renameSession(sessionId, title);
          },
        );
        return { success };
      }
      case 'rewindSession': {
        const sessionId = params['sessionId'] as string;
        if (!sessionId || !SESSION_ID_RE.test(sessionId)) {
          throw RequestError.invalidParams(
            undefined,
            'Invalid or missing sessionId',
          );
        }
        const session = this.sessions.get(sessionId);
        if (!session) {
          throw RequestError.invalidParams(
            undefined,
            `Session not found for id: ${sessionId}`,
          );
        }

        // Fail fast like branch admission: the bridge bounds this RPC with a
        // timeout that races but cannot cancel queued work, so a rewind
        // admitted behind an active turn would still truncate history after
        // the client was told it failed. rewindToTurn re-checks inside the
        // gate.
        if (!session.isTurnIdle()) {
          throw new RequestError(
            -32602,
            'Cannot rewind while a prompt is running',
            {
              errorKind: 'session_busy',
            },
          );
        }

        // Validate request FORMAT synchronously at RPC entry so a malformed
        // rewind fails with a deterministic invalid_rewind_target instead of
        // queueing behind an active mutation and surfacing as a bridge
        // timeout (which for a destructive op means "may have executed").
        // Only the snapshot-index resolution needs the gate.
        const rawPromptId = params['promptId'];
        if (rawPromptId !== undefined && typeof rawPromptId !== 'string') {
          throw new RequestError(-32602, 'Invalid promptId format', {
            errorKind: 'invalid_rewind_target',
          });
        }
        const promptId =
          typeof rawPromptId === 'string' ? rawPromptId : undefined;
        let turnIndex: number | undefined = params['targetTurnIndex'] as
          | number
          | undefined;
        const resolveFromPromptId =
          promptId !== undefined &&
          (turnIndex === undefined || turnIndex === null);
        if (resolveFromPromptId) {
          const prefix = sessionId + '########';
          if (!promptId.startsWith(prefix)) {
            throw new RequestError(-32602, 'Invalid promptId format', {
              errorKind: 'invalid_rewind_target',
            });
          }
          const suffix = promptId.slice(prefix.length);
          if (!/^\d+$/.test(suffix)) {
            throw new RequestError(
              -32602,
              'Invalid promptId: non-numeric turn suffix',
              { errorKind: 'invalid_rewind_target' },
            );
          }
        } else if (!Number.isInteger(turnIndex) || (turnIndex as number) < 0) {
          throw RequestError.invalidParams(
            undefined,
            'Invalid or missing targetTurnIndex',
          );
        }

        return await this.runExclusiveHistoryMutation(sessionId, async () => {
          if (resolveFromPromptId) {
            // Derive turnIndex from the snapshot's position in the array,
            // NOT from the promptId suffix. Session.turn is monotonic and
            // does not reset on rewind, so after a rewind cycle the suffix
            // no longer matches the turn's position in the current history.
            const fhs = session.getConfig().getFileHistoryService();
            const snapshots = fhs.getSnapshots();
            const snapshotIdx = snapshots.findIndex(
              (s) => s.promptId === promptId,
            );
            if (snapshotIdx < 0) {
              throw new RequestError(
                -32602,
                'Snapshot not found for the given promptId',
                { errorKind: 'invalid_rewind_target' },
              );
            }
            turnIndex = snapshotIdx;
          }

          const rewindFiles = params['rewindFiles'] !== false;
          const historyBeforeRewind = session.captureHistorySnapshot();
          let rewindResult;
          let releaseHistoryMutation: () => void;
          try {
            rewindResult = session.rewindToTurn(turnIndex as number, {
              rewindFiles,
            });
            releaseHistoryMutation = session.beginHistoryMutation();
          } catch (err) {
            if (err instanceof RequestError) {
              const msg = err.message;
              if (
                msg.includes('Cannot rewind while a prompt is running') ||
                msg.includes('Session is busy processing a turn')
              ) {
                throw new RequestError(err.code, msg, {
                  errorKind: 'session_busy',
                });
              }
              if (msg.includes('compressed or does not exist')) {
                throw new RequestError(err.code, msg, {
                  errorKind: 'invalid_rewind_target',
                });
              }
            }
            throw err;
          }

          try {
            let filesChanged: string[] = [];
            let filesFailed: string[] = [];
            if (rewindFiles && promptId) {
              const fhs = session.getConfig().getFileHistoryService();
              try {
                const fileResult = await fhs.rewind(promptId, true);
                filesChanged = fileResult.filesChanged;
                filesFailed = fileResult.filesFailed;
              } catch (err) {
                const reason = err instanceof Error ? err.message : String(err);
                debugLogger.error(
                  `[ACP] File-history rewind failed for session=${sessionId} promptId=${promptId}: ${reason}`,
                );
                filesFailed = [`file-history-rewind: ${reason}`];
              }
            }
            let artifactSnapshot: unknown;
            let artifactSnapshotUnavailable: string | undefined;
            try {
              const config = session.getConfig();
              const recording = config.getChatRecordingService();
              await recording?.flush();
              const loadAuthoritative = () =>
                config.getSessionService().loadSession(sessionId);
              const sessionData = recording
                ? await recording.runWithWriteBarrier(loadAuthoritative)
                : await loadAuthoritative();
              if (sessionData === undefined) {
                artifactSnapshotUnavailable =
                  'session data unavailable after rewind';
              } else if (sessionData.artifactSnapshot) {
                artifactSnapshot = sessionData.artifactSnapshot;
              } else {
                // A successful reload with no artifact records is a valid empty
                // artifact timeline, distinct from an unavailable reload.
                artifactSnapshot = {
                  v: SESSION_ARTIFACT_PERSISTENCE_VERSION,
                  sessionId,
                  sequence: 0,
                  artifacts: [],
                  tombstonedIds: [],
                  stickyEphemeralIds: [],
                  warnings: [],
                };
              }
            } catch (err) {
              const reason = err instanceof Error ? err.message : String(err);
              artifactSnapshotUnavailable =
                'artifact snapshot unavailable after rewind';
              debugLogger.warn(
                `[ACP] Failed to rebuild artifact snapshot after rewind for session=${sessionId}: ${reason}`,
              );
            }

            return {
              success: true,
              historyBeforeRewind,
              ...rewindResult,
              filesChanged,
              filesFailed,
              ...(artifactSnapshot ? { artifactSnapshot } : {}),
              ...(artifactSnapshotUnavailable
                ? { artifactSnapshotUnavailable }
                : {}),
            };
          } finally {
            releaseHistoryMutation();
          }
        });
      }
      case 'qwen/session/loadUpdates': {
        const sessionId = params['sessionId'] as string;
        if (!sessionId || !SESSION_ID_RE.test(sessionId)) {
          throw RequestError.invalidParams(
            undefined,
            'Invalid or missing sessionId',
          );
        }

        const liveSession = this.sessions.get(sessionId);
        const turnIdleBeforeRead = liveSession?.isTurnIdle() ?? true;
        let replayConfig = this.config;
        let sessionData: ResumedSessionData | undefined;
        if (liveSession) {
          const config = liveSession.getConfig();
          await this.assertLiveSessionScope(
            config,
            loadSettingsCached(cwd),
            cwd,
          );
          const recording = config.getChatRecordingService();
          const loadAuthoritative = () =>
            config.getSessionService().loadSession(sessionId);
          sessionData = recording
            ? await recording.runWithWriteBarrier(loadAuthoritative)
            : await loadAuthoritative();
          replayConfig = config;
        } else {
          sessionData = await this.runWithPinnedRuntimeBaseDirForRequest(
            cwd,
            async () => {
              const sessionService = new SessionService(cwd);
              return sessionService.loadSession(sessionId);
            },
          );
        }
        if (!sessionData?.conversation) {
          return { updates: [] };
        }

        const replay = await collectHistoryReplayUpdates({
          sessionId,
          config: replayConfig,
          records: sessionData.conversation.messages,
          gaps: sessionData.historyGaps,
          cumulativeUsage: createReplayCumulativeUsage(),
          logger: debugLogger,
          // Read-only history dump never re-hangs the question. Skip
          // finalize only on load/resume that will actually restore.
          suppressRestoreAskUserQuestion: true,
          // Ungated read: unlike the live loadSession restore (whose gate
          // drains turns), a turn may still be running here, so guard on
          // turn activity instead of finalizing unconditionally (#9704).
          finalizeDangling: this.finalizeDanglingForRestore(
            liveSession,
            turnIdleBeforeRead,
          ),
        });

        return {
          updates: replay.updates,
          startTime: sessionData.conversation.startTime,
          lastUpdated: sessionData.conversation.lastUpdated,
          // Signal to the client that replay aborted partway so it doesn't
          // render a truncated replay as the full conversation.
          ...(replay.replayError !== undefined
            ? { partial: true, replayError: replay.replayError }
            : {}),
        };
      }
      case 'restoreSessionHistory': {
        const sessionId = params['sessionId'] as string;
        const history = params['history'];
        if (!sessionId || !SESSION_ID_RE.test(sessionId)) {
          throw RequestError.invalidParams(
            undefined,
            'Invalid or missing sessionId',
          );
        }
        if (!Array.isArray(history)) {
          throw RequestError.invalidParams(
            undefined,
            'Invalid or missing history',
          );
        }
        const session = this.sessions.get(sessionId);
        if (!session) {
          throw RequestError.invalidParams(
            undefined,
            `Session not found for id: ${sessionId}`,
          );
        }

        session.restoreHistory(history as Content[]);
        return { success: true };
      }
      case 'getAccountInfo': {
        const sessionId = params['sessionId'] as string | undefined;
        const session = sessionId ? this.sessions.get(sessionId) : undefined;
        const config = session ? session.getConfig() : this.config;
        const cfg = config.getContentGeneratorConfig();
        return {
          authType: cfg?.authType ?? config.getAuthType() ?? null,
          model: cfg?.model ?? config.getModel() ?? null,
          baseUrl: cfg?.baseUrl ? sanitizeProviderBaseUrl(cfg.baseUrl) : null,
          apiKeyEnvKey: cfg?.apiKeyEnvKey ?? null,
        };
      }
      case 'qwen/settings/getCore': {
        const settingsCwd = this.settingsCwdFor(requestedCwd, params);
        const settings = this.loadRequestSettings(settingsCwd);
        this.adoptRequestSettings(settings, settingsCwd);
        return this.buildCoreSettings(settings, settingsCwd);
      }
      case 'qwen/settings/setCoreValue': {
        const key = params['key'];
        if (
          typeof key !== 'string' ||
          !QWEN_CORE_SETTING_KEYS.includes(key as QwenCoreSettingKey)
        ) {
          throw RequestError.invalidParams(
            undefined,
            'Unsupported Qwen setting key',
          );
        }
        const settingsCwd = this.settingsCwdFor(requestedCwd, params);
        const settings = this.loadRequestSettings(settingsCwd);
        const settingKey = key as QwenCoreSettingKey;
        const normalizedValue = normalizeCoreSettingValue(
          settingKey,
          params['value'],
        );
        const scope = toSettingsScope(params['scope']);
        settings.setValue(scope, key, normalizedValue);
        if (settingKey === 'model.name') {
          // Selecting a model by id here can't disambiguate providers that
          // share that id, so clear the paired baseUrl disambiguator left by a
          // previous model-picker selection. Empty-string tombstone overrides a
          // lower-scope value on merge (undefined would be dropped from JSON).
          settings.setValue(scope, 'model.baseUrl', '');
        }
        if (
          settingKey === 'general.outputLanguage' &&
          typeof normalizedValue === 'string' &&
          scope === SettingScope.User
        ) {
          // output-language.md is a single global instruction file. Only a
          // user-scoped change should rewrite it; a workspace-scoped change is
          // persisted to the workspace settings file and must not clobber the
          // global file (which would silently affect every other workspace and
          // session).
          updateOutputLanguageFile(normalizedValue);
        }
        // `setValue` already persisted to disk and recomputed the in-memory
        // merged view, so reloading from disk here is redundant I/O.
        this.adoptRequestSettings(settings, settingsCwd);
        return this.buildCoreSettings(settings, settingsCwd);
      }
      case 'qwen/settings/setMcpServer': {
        const name = params['name'];
        if (typeof name !== 'string' || !name.trim()) {
          throw RequestError.invalidParams(
            undefined,
            'MCP server name is required',
          );
        }
        // Workspace-global write: the MCP status/apply routes
        // (`buildManagedWorkspaceMcpStatus`, `reloadWorkspaceMcpDiscovery`)
        // resolve only the bootstrap workspace, so a session-scoped write
        // here would be listed nowhere and applied never. Session-aware
        // resolution returns only once those routes share the coordinate.
        const settingsCwd = requestedCwd || this.config.getTargetDir();
        const settings = this.loadRequestSettings(settingsCwd);
        const settingScope = toSettingsScope(params['scope']);
        const scope =
          settingScope === SettingScope.Workspace ? 'workspace' : 'user';
        const existing = readScopeSettings(settings, scope);
        const existingServers = toRecord(existing['mcpServers']);
        const mcpServers = {
          ...existingServers,
          [name.trim()]: toStoredMcpServerConfig(
            restoreRedactedMcpSecrets(
              normalizeMcpServerConfig(params['server']),
              toRecord(existingServers[name.trim()]),
            ),
          ),
        };
        settings.setValue(settingScope, 'mcpServers', mcpServers);
        // `setValue` already persisted to disk and recomputed the in-memory
        // merged view, so reloading from disk here is redundant I/O.
        this.adoptRequestSettings(settings, settingsCwd);
        return this.buildCoreSettings(settings, settingsCwd);
      }
      case 'qwen/settings/removeMcpServer': {
        const name = params['name'];
        if (typeof name !== 'string' || !name.trim()) {
          throw RequestError.invalidParams(
            undefined,
            'MCP server name is required',
          );
        }
        // Workspace-global write, same contract as setMcpServer above.
        const settingsCwd = requestedCwd || this.config.getTargetDir();
        const settings = this.loadRequestSettings(settingsCwd);
        const settingScope = toSettingsScope(params['scope']);
        const scope =
          settingScope === SettingScope.Workspace ? 'workspace' : 'user';
        const existing = readScopeSettings(settings, scope);
        const mcpServers = { ...toRecord(existing['mcpServers']) };
        delete mcpServers[name.trim()];
        settings.setValue(settingScope, 'mcpServers', mcpServers);
        // `setValue` already persisted to disk and recomputed the in-memory
        // merged view, so reloading from disk here is redundant I/O.
        this.adoptRequestSettings(settings, settingsCwd);
        return this.buildCoreSettings(settings, settingsCwd);
      }
      case 'qwen/settings/setHook': {
        const event = params['event'];
        if (!isHookEvent(event)) {
          throw RequestError.invalidParams(undefined, 'Invalid hook event');
        }
        // Workspace-global write: the workspaceHooks status route reports the
        // bootstrap Config's live hook registry, so a session-scoped write
        // would diverge from what is reported and applied.
        const settingsCwd = requestedCwd || this.config.getTargetDir();
        const settings = this.loadRequestSettings(settingsCwd);
        const settingScope = toSettingsScope(params['scope']);
        const scope =
          settingScope === SettingScope.Workspace ? 'workspace' : 'user';
        const existing = readScopeSettings(settings, scope);
        const hooksRoot = { ...toRecord(existing['hooks']) };
        const eventHooks = Array.isArray(hooksRoot[event])
          ? [...(hooksRoot[event] as unknown[])]
          : [];
        const incomingHook = normalizeHookDefinition(params['hook']);
        const index = params['index'];
        // Only replace when the index points at an existing entry. An
        // out-of-range index would create sparse-array holes that serialize to
        // `null` in settings.json and corrupt hook loading, so treat it (and a
        // missing/negative index) as an append.
        const isReplace =
          typeof index === 'number' &&
          Number.isInteger(index) &&
          index >= 0 &&
          index < eventHooks.length;
        // Restore any `__redacted__` env/header values the client echoed back
        // from getCore against the hook being replaced, so masking on read
        // never persists the sentinel over a real secret.
        const hook = restoreRedactedHookSecrets(
          incomingHook,
          isReplace ? toRecord(eventHooks[index as number]) : {},
        );
        if (isReplace) {
          eventHooks[index as number] = hook;
        } else {
          // Missing/negative/non-integer index → append. (A non-integer like
          // 1.5 would otherwise create a sparse, non-integer array property
          // that JSON.stringify silently drops, corrupting the hook list.)
          eventHooks.push(hook);
        }
        hooksRoot[event] = eventHooks;
        settings.setValue(settingScope, 'hooks', hooksRoot);
        // `setValue` already persisted to disk and recomputed the in-memory
        // merged view, so reloading from disk here is redundant I/O.
        this.adoptRequestSettings(settings, settingsCwd);
        return this.buildCoreSettings(settings, settingsCwd);
      }
      case 'qwen/settings/removeHook': {
        const event = params['event'];
        if (!isHookEvent(event)) {
          throw RequestError.invalidParams(undefined, 'Invalid hook event');
        }
        const index = params['index'];
        if (
          typeof index !== 'number' ||
          !Number.isInteger(index) ||
          index < 0
        ) {
          throw RequestError.invalidParams(undefined, 'Invalid hook index');
        }
        // Workspace-global write, same contract as setHook above.
        const settingsCwd = requestedCwd || this.config.getTargetDir();
        const settings = this.loadRequestSettings(settingsCwd);
        const settingScope = toSettingsScope(params['scope']);
        const scope =
          settingScope === SettingScope.Workspace ? 'workspace' : 'user';
        const existing = readScopeSettings(settings, scope);
        const hooksRoot = { ...toRecord(existing['hooks']) };
        const eventHooks = Array.isArray(hooksRoot[event])
          ? [...(hooksRoot[event] as unknown[])]
          : [];
        if (index >= eventHooks.length) {
          throw RequestError.invalidParams(
            undefined,
            `Hook index ${index} out of range (event has ${eventHooks.length} hooks)`,
          );
        }
        eventHooks.splice(index, 1);
        hooksRoot[event] = eventHooks;
        settings.setValue(settingScope, 'hooks', hooksRoot);
        // `setValue` already persisted to disk and recomputed the in-memory
        // merged view, so reloading from disk here is redundant I/O.
        this.adoptRequestSettings(settings, settingsCwd);
        return this.buildCoreSettings(settings, settingsCwd);
      }
      case 'qwen/settings/setExtensionSetting': {
        const extensionId = params['extensionId'];
        const settingKey = params['settingKey'];
        const value = params['value'];
        if (typeof extensionId !== 'string' || !extensionId) {
          throw RequestError.invalidParams(
            undefined,
            'extensionId is required',
          );
        }
        if (typeof settingKey !== 'string' || !settingKey) {
          throw RequestError.invalidParams(undefined, 'settingKey is required');
        }
        if (typeof value !== 'string') {
          throw RequestError.invalidParams(undefined, 'value must be a string');
        }
        // Workspace-global write: the workspaceExtensions status route
        // reports the bootstrap workspace, same contract as setMcpServer.
        const settingsCwd = requestedCwd || this.config.getTargetDir();
        const settings = this.loadRequestSettings(settingsCwd);
        const extensionManager = new ExtensionManager({
          workspaceDir: settingsCwd,
          isWorkspaceTrusted:
            isWorkspaceTrusted(settings.merged).isTrusted ?? true,
          locale: getCurrentLanguage(),
        });
        await extensionManager.refreshCache();
        const extension = extensionManager
          .getLoadedExtensions()
          .find((item) => item.id === extensionId || item.name === extensionId);
        if (!extension) {
          throw RequestError.invalidParams(undefined, 'Extension not found');
        }
        const extScope =
          toSettingsScope(params['scope']) === SettingScope.Workspace
            ? ExtensionSettingScope.WORKSPACE
            : ExtensionSettingScope.USER;
        await updateSetting(
          extension.config,
          extension.id,
          settingKey,
          async () => value,
          extScope,
        );
        // Unlike the sibling core-setting handlers, this persists through
        // `updateSetting` (extension settings store), not `settings.setValue`,
        // so `settings` here is just the snapshot loaded above and is reused to
        // build the response.
        this.adoptRequestSettings(settings, settingsCwd);
        return this.buildCoreSettings(settings, settingsCwd);
      }
      case 'qwen/permissions/getSettings': {
        const settingsCwd = this.settingsCwdFor(requestedCwd, params);
        const settings = this.loadPermissionSettings(settingsCwd);
        return buildPermissionSettings(settings) as unknown as Record<
          string,
          unknown
        >;
      }
      case 'qwen/permissions/setRules': {
        const scope = params['scope'];
        const ruleType = params['ruleType'];
        if (scope !== 'user' && scope !== 'workspace') {
          throw RequestError.invalidParams(
            undefined,
            'scope must be "user" or "workspace"',
          );
        }
        if (ruleType !== 'allow' && ruleType !== 'ask' && ruleType !== 'deny') {
          throw RequestError.invalidParams(
            undefined,
            'ruleType must be "allow", "ask", or "deny"',
          );
        }

        const settingsCwd = this.settingsCwdFor(requestedCwd, params);
        const settings = this.loadPermissionSettings(settingsCwd);
        const before = readPermissionRuleSet(settings.merged);
        const settingScope =
          scope === 'workspace' ? SettingScope.Workspace : SettingScope.User;
        const scopeSettings =
          scope === 'workspace'
            ? settings.workspace.settings
            : settings.user.settings;
        const existingRules = readPermissionRuleSet(scopeSettings)[ruleType];
        let rules: string[];
        try {
          rules = normalizePermissionRules(params['rules'], {
            existingRules,
          });
        } catch (error) {
          if (error instanceof PermissionRulesValidationError) {
            throw RequestError.invalidParams(undefined, error.message);
          }
          throw error;
        }

        settings.setValue(settingScope, `permissions.${ruleType}`, rules);
        // `setValue` already recomputed the in-memory merged view, so read the
        // "after" state from the same instance instead of reloading from disk
        // (avoids redundant I/O and a concurrency window where another handler
        // could mutate settings between the two loads).
        const after = readPermissionRuleSet(settings.merged);
        this.syncLivePermissionManagers(
          before,
          after,
          settingScope,
          settingsCwd,
        );
        return buildPermissionSettings(settings) as unknown as Record<
          string,
          unknown
        >;
      }
      default:
        throw RequestError.methodNotFound(method);
    }
  }

  // --- private helpers ---

  private disposeTranscriptReplayConfig(config: Config): void {
    try {
      void Promise.resolve(config.getToolRegistry()?.stop()).catch((err) => {
        debugLogger.debug(
          `Transcript replay config tool registry stop failed: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      });
    } catch (err) {
      debugLogger.debug(
        `Transcript replay config tool registry stop failed: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }

  private disposeTranscriptReplayConfigs(): void {
    for (const entry of this.transcriptReplayConfigCache.values()) {
      if (entry.config) {
        this.disposeTranscriptReplayConfig(entry.config);
      }
    }
    this.transcriptReplayConfigCache.clear();
  }

  private async newSessionConfig(
    cwd: string,
    mcpServers: McpServer[],
    settings: LoadedSettings,
    sessionSource?: SessionSource,
    sessionId?: string,
    resume?: boolean,
    initializeOptions: ConfigInitializeOptions = {},
    chatRecording?: boolean,
    restoreOptions?: SelectiveSessionRestoreOptions,
    executionEngine?: SessionExecutionEngine,
  ): Promise<Config> {
    // Transcript replay is the only recording-disabled Config and must remain
    // id-less; it borrows the validated target session context from extMethod.
    const preserveIdlessSession =
      sessionId === undefined && chatRecording === false;
    const inheritedSessionId = preserveIdlessSession
      ? sessionIdContext.getStore()
      : undefined;
    // A generated id exists only to bind the debug-log context before Config
    // construction; loadCliConfig must not treat it as caller-supplied (the
    // occupancy check is for caller-chosen ids that may have a case-twin).
    const sessionIdGenerated =
      sessionId === undefined && !preserveIdlessSession;
    const effectiveSessionId =
      sessionId ?? (sessionIdGenerated ? randomUUID() : undefined);
    const debugSessionId =
      effectiveSessionId ?? inheritedSessionId ?? 'transcript-replay';
    try {
      return await sessionIdContext.run(debugSessionId, () =>
        this.runWithPinnedRuntimeBaseDir(settings, cwd, async () => {
          await this.retryPendingConfigCleanup(
            Storage.getRuntimeBaseDir(),
            effectiveSessionId,
          );
          return this.newSessionConfigInRuntimeContext(
            cwd,
            mcpServers,
            settings,
            sessionSource,
            effectiveSessionId,
            resume,
            initializeOptions,
            chatRecording,
            restoreOptions,
            sessionIdGenerated,
            executionEngine,
          );
        }),
      );
    } catch (error) {
      if (error instanceof SessionIdConflictError) {
        throw new RequestError(ACP_ERROR_CODES.INVALID_PARAMS, error.message, {
          errorKind: 'session_id_conflict',
          sessionId: error.sessionId,
        });
      }
      const writerError = getSessionWriterError(error);
      if (writerError) {
        throw new RequestError(writerError.rpcCode, writerError.message, {
          errorKind: writerError.errorKind,
        });
      }
      throw sessionId && restoreOptions
        ? mapSessionRestoreRequestError(error, sessionId)
        : error;
    }
  }

  private async newSessionConfigInRuntimeContext(
    cwd: string,
    mcpServers: McpServer[],
    settings: LoadedSettings,
    sessionSource?: SessionSource,
    sessionId?: string,
    resume?: boolean,
    initializeOptions: ConfigInitializeOptions = {},
    chatRecording?: boolean,
    restoreOptions?: SelectiveSessionRestoreOptions,
    sessionIdGenerated?: boolean,
    executionEngine?: SessionExecutionEngine,
  ): Promise<Config> {
    // ACP/IDE-injected servers are session-level: they must outrank a project
    // `.mcp.json` and stay un-gated. Collect them separately and pass them as
    // `sessionMcpServers` (top precedence tier) rather than merging into
    // `settings.mcpServers`, where `assembleMcpServers` would demote them below
    // `.mcp.json` (#4615).
    const sessionMcpServers: Record<string, MCPServerConfig> = {};

    for (const server of mcpServers) {
      const stdioServer = toStdioServer(server);
      if (stdioServer) {
        const env: Record<string, string> = {};
        for (const { name: envName, value } of stdioServer.env) {
          env[envName] = value;
        }
        sessionMcpServers[stdioServer.name] = new MCPServerConfig(
          stdioServer.command,
          stdioServer.args,
          env,
        );
      }
    }

    const mergedSettings = {
      ...settings.merged,
      experimental: {
        ...settings.merged.experimental,
        sessionWriterLease: this.sessionWriterLeaseEnabledAtStartup,
        ...(sessionSource?.sourceType === 'channel' ? { cron: false } : {}),
      },
    };

    const sessionArg =
      resume === true
        ? { resume: sessionId, sessionId: undefined }
        : {
            sessionId,
            sessionIdGenerated: sessionIdGenerated === true || undefined,
            resume: undefined,
          };
    const argvForSession = {
      ...this.argv,
      // Docker sandbox relaunch injects a fixed --sandbox-session-id into
      // the ACP process argv. Without clearing it, every newSession()
      // inherits the same ID and the second session collides with the
      // first's writer lease (#7435).
      sandboxSessionId: undefined,
      ...sessionArg,
      continue: false,
      ...(chatRecording !== undefined ? { chatRecording } : {}),
    };

    const config = await loadCliConfig(
      mergedSettings,
      argvForSession,
      cwd,
      // ACP sessions do not provide an extension override. Passing [] is a
      // truthy override and prevents default/argv extension commands from
      // loading, so leave it unset to preserve normal CLI behavior.
      undefined,
      // Pass separated hooks for proper source attribution
      {
        systemHooks: settings.getSystemHooks(),
        userHooks: settings.getUserHooks(),
      },
      // CRITICAL: close over the per-request `settings` (LoadedSettings
      // instance), NOT over the `mergedSettings` snapshot built above.
      // `LoadedSettings.setValue` replaces `_merged`, so a closure over the
      // snapshot would never see workspace toggles applied during the
      // session. ACP/Zed sessions otherwise leak persisted disabled skills
      // into the first <available_skills> at cold start.
      buildDisabledSkillNamesProvider(settings),
      sessionMcpServers,
      // The daemon owns the settings watcher lifecycle.
      undefined,
      // A duplicate caller-supplied session id must fail this one request,
      // not process.exit(1) the shared ACP child and every session on its
      // channel. newSessionConfig maps the throw to a RequestError.
      true,
      restoreOptions || executionEngine
        ? {
            ...(executionEngine ? { executionEngine } : {}),
            ...(restoreOptions && sessionId
              ? {
                  sessionRestore: {
                    projectionSource: (restoreSessionId) =>
                      new SessionService(cwd, {
                        runtimeBaseDir: Storage.getRuntimeBaseDir(),
                      }).readRestoreProjection(
                        restoreSessionId,
                        restoreOptions,
                      ),
                  },
                }
              : {}),
          }
        : undefined,
      buildEnabledSkillNamesProvider(settings),
    );
    if (sessionSource) {
      config.setSessionSource(sessionSource.sourceType, sessionSource.sourceId);
    }
    if (this.clientCapabilities?._meta?.['qwen.goalProposals'] === true) {
      config.setGoalProposalHostSupported(true);
    }
    if (chatRecording !== false) {
      this.initializingConfigs.add(config);
    }
    // ACP sessions run with piped stdio (non-TTY), so the default
    // interactive-based gating disables file checkpointing. Enable it
    // explicitly so /rewind works across daemon session resume.
    if (
      !initializeOptions.skipFileCheckpointing &&
      typeof config.enableFileCheckpointing === 'function'
    ) {
      config.enableFileCheckpointing();
    }
    // Inject the workspace-shared MCP transport pool BEFORE
    // `config.initialize()` so the ToolRegistry picks it up.
    if (
      this.mcpPool !== undefined &&
      typeof config.setMcpTransportPool === 'function'
    ) {
      config.setMcpTransportPool(this.mcpPool);
    }
    // Register the MCP budget-event callback BEFORE `config.initialize()`
    // so it catches events from both synchronous and background discovery.
    const wiredSessionId =
      typeof config.getSessionId === 'function'
        ? config.getSessionId()
        : undefined;
    // When the workspace-scoped budget controller is active, skip the
    // per-session callback to prevent double-firing. Daemons without
    // a configured budget keep the per-session callback.
    const skipPerSessionBudgetCallback = this.workspaceMcpBudget !== undefined;
    if (
      !skipPerSessionBudgetCallback &&
      typeof config.setMcpBudgetEventCallback === 'function' &&
      wiredSessionId !== undefined
    ) {
      const acpSessionId = wiredSessionId;
      config.setMcpBudgetEventCallback((event) => {
        sessionIdContext.run(config.getSessionId(), () => {
          // Fire-and-forget. `.catch` suppresses unhandled rejections
          // and logs at debug level for operator visibility.
          void this.connection
            .extNotification('qwen/notify/session/mcp-budget-event', {
              v: 1,
              sessionId: acpSessionId,
              ...event,
            })
            .catch((err: unknown) => {
              debugLogger.debug(
                `MCP budget extNotification dropped ` +
                  `(session=${acpSessionId}, kind=${event.kind}): ` +
                  `${err instanceof Error ? err.message : String(err)}`,
              );
            });
        });
      });
    }
    try {
      await config.initialize(initializeOptions);
    } catch (error) {
      return this.cleanupAfterRequestFailure(error, () =>
        this.cleanupUnstoredConfig(config),
      );
    }
    startNonInteractiveOpenAILogHousekeeping(config, settings);
    // ACP sessions are interactive: MCP tools can arrive progressively, but
    // session creation/loading must not wait for a slow or wedged server
    // discovery.
    void this.surfaceMcpFailuresWhenReady(config);
    return config;
  }

  private async surfaceMcpFailuresWhenReady(config: Config): Promise<void> {
    try {
      await config.waitForMcpReady();
    } catch (err) {
      debugLogger.error(
        `MCP discovery readiness failed: ${err instanceof Error ? err.message : String(err)}`,
      );
      return;
    }

    const failedMcpServers =
      typeof config.getFailedMcpServerNames === 'function'
        ? config.getFailedMcpServerNames()
        : [];
    if (failedMcpServers.length > 0) {
      process.stderr.write(
        `Warning: MCP server(s) failed to start: ${failedMcpServers.join(', ')}. ` +
          `Continuing with built-in tools and any servers that did connect.\n`,
      );
    }
  }

  private async refreshAuthWithPersistedReasoning(
    config: Config,
    settings: LoadedSettings,
    authType: AuthType,
    sessionSelection?: ReasoningSelection,
  ): Promise<void> {
    await config.refreshAuth(authType);
    const selection =
      sessionSelection ??
      parseReasoningSelection(settings.merged.model?.reasoningEffort);
    if (!selection || selection === REASONING_EFFORT_DEFAULT) {
      return;
    }
    const generation = config.getContentGeneratorConfig?.();
    const modelId = generation?.model ?? config.getModel();
    const modelReasoning = getConfiguredModelReasoning(config, modelId);
    if (
      !isReasoningSelectionSupported(
        modelId,
        selection,
        generation?.thinkingMandatory === true,
        modelReasoning,
      )
    ) {
      return;
    }
    if (generation && modelReasoning && !modelReasoning.toggleOnly) {
      clearReasoningRequestOverrides(generation);
    }
    if (selection === REASONING_EFFORT_NONE) {
      applyReasoningSelection(config, REASONING_EFFORT_NONE);
    }
  }

  private async ensureAuthenticated(
    config: Config,
    settings: LoadedSettings,
  ): Promise<void> {
    const selectedType = config.getModelsConfig().getCurrentAuthType();
    if (!selectedType) {
      throw RequestError.authRequired(
        { authMethods: pickAuthMethodsForAuthRequired() },
        'Use Qwen Code CLI to authenticate first.',
      );
    }

    try {
      await this.refreshAuthWithPersistedReasoning(
        config,
        settings,
        selectedType,
      );
    } catch (e) {
      debugLogger.error(`Authentication failed: ${e}`);
      throw RequestError.authRequired(
        {
          authMethods: pickAuthMethodsForAuthRequired(selectedType),
        },
        'Authentication failed: ' + (e as Error).message,
      );
    }
  }

  private setupFileSystem(config: Config): void {
    if (!this.clientCapabilities?.fs) return;

    const acpFileSystemService = new AcpFileSystemService(
      this.connection,
      config.getSessionId(),
      this.clientCapabilities.fs,
      config.getFileSystemService(),
      {
        localReadRoots: buildAcpLocalReadRoots(config),
      },
    );
    config.setFileSystemService(acpFileSystemService);
  }

  /**
   * All sessions in this child share one workflow snapshot store but each
   * keeps a private run registry, so one session's history deletion must
   * see every sibling registry — or it can delete a run another session
   * is still executing or settling. A handle outlives the terminal
   * transition until the snapshot write lands, so it blocks too.
   *
   * R7-10: iterating `this.sessions` alone left a blind spot the width of
   * a whole run. A workflow can outlive its owning session's removal —
   * explicit close/kill/shutdown use force semantics, and a background
   * run owns a detached controller — so once `removeStoredSessionEntry`
   * deleted the session, a still-settling run became invisible here and
   * unreachable by the delete handler's sibling `removeTerminal` loop. A
   * sibling `delete-history` then passed every check, removed the LIVE
   * run's journal directory and snapshot, and answered `{changed: true}`;
   * the orphan kept going and its settlement `writeWorkflowSnapshot`
   * recreated the file — resurrection, plus a run whose journal was rm'd
   * under it.
   *
   * The repair has two halves. `Session.dispose()` now aborts its
   * workflow registry the way it already aborts the agent registry, so an
   * orphan settles instead of running on; and the registry of a removed
   * session stays reachable here until its runs drain, so the gate keeps
   * answering for the settlement window that abort cannot compress to
   * zero (the handle is released only after the snapshot write lands).
   */
  private isWorkflowRunLiveOutsideSession(
    excludeSessionId: string,
    runId: string,
  ): boolean {
    for (const [sessionId, session] of this.sessions) {
      if (sessionId === excludeSessionId) continue;
      if (
        QwenAgent.isWorkflowRunLiveInRegistry(
          session.getConfig().getWorkflowRunRegistry(),
          runId,
        )
      ) {
        return true;
      }
    }
    this.pruneDrainedWorkflowRegistries();
    for (const registry of this.detachedWorkflowRegistries) {
      if (QwenAgent.isWorkflowRunLiveInRegistry(registry, runId)) return true;
    }
    return false;
  }

  private static isWorkflowRunLiveInRegistry(
    registry: WorkflowRunRegistry,
    runId: string,
  ): boolean {
    if (registry.isStarting?.(runId)) return true;
    const entry = registry.get(runId);
    if (entry && !isTerminalWorkflowStatus(entry.status)) return true;
    return registry.getHandle(runId) !== undefined;
  }

  /**
   * Registries of removed sessions are retained only while they still
   * hold work — an aborted run keeps its handle until settlement releases
   * it. Dropping drained ones keeps this from becoming a leak that grows
   * with every closed session.
   */
  private pruneDrainedWorkflowRegistries(): void {
    for (const registry of this.detachedWorkflowRegistries) {
      if (!QwenAgent.isWorkflowRegistryDraining(registry)) {
        this.detachedWorkflowRegistries.delete(registry);
      }
    }
  }

  /** Still holding work: an active entry, or a handle awaiting settlement. */
  private static isWorkflowRegistryDraining(
    registry: WorkflowRunRegistry,
  ): boolean {
    if (registry.hasRunningEntries?.()) return true;
    return (
      registry.list?.().some((entry) => registry.getHandle(entry.runId)) ??
      false
    );
  }

  private async createAndStoreSession(
    config: Config,
    settings: LoadedSettings,
    sessionData?: ResumedSessionData,
    options: {
      replayHistory?: boolean;
      configProviderRevision?: number;
      fileDerivedApprovalMode?: ApprovalMode;
      prepareBeforeSessionCreate?: () => Promise<void>;
      beforeSessionPublish?: () => void;
      primeSession?: (session: Session) => void;
      beforeStartPostReplayServices?: (session: Session) => Promise<void>;
      signal?: AbortSignal;
    } = {},
  ): Promise<Session> {
    options.signal?.throwIfAborted();
    const sessionId = normalizeSessionIdForLookup(config.getSessionId());
    const llmClient = config.getLlmClient();
    const needsInitialize = !llmClient.isInitialized();

    if (needsInitialize) {
      await llmClient.initialize(undefined, options.signal);
    }
    options.signal?.throwIfAborted();

    if (this.sessions.has(sessionId)) {
      throw new RequestError(
        ACP_ERROR_CODES.INVALID_PARAMS,
        `Session ${sessionId} is already active.`,
        { errorKind: 'session_id_conflict', sessionId },
      );
    }

    await options.prepareBeforeSessionCreate?.();
    options.signal?.throwIfAborted();
    if (this.sessions.has(sessionId)) {
      throw new RequestError(
        ACP_ERROR_CODES.INVALID_PARAMS,
        `Session ${sessionId} is already active.`,
        { errorKind: 'session_id_conflict', sessionId },
      );
    }
    // A run the previous daemon process was running when it exited has no
    // snapshot until something claims it; claimed here, it joins the history
    // this session lists as a failed run.
    try {
      await claimInterruptedWorkflowRuns(config);
    } catch (error) {
      debugLogger.debug(`Claiming interrupted workflow runs failed: ${error}`);
    }
    const workflowHistory = await listWorkflowSnapshots(config);
    const session = new Session(
      sessionId,
      config,
      this.connection,
      settings,
      (operation) => this.runExclusiveHistoryMutation(sessionId, operation),
      undefined,
      workflowHistory,
      (runId) => this.isWorkflowRunLiveOutsideSession(sessionId, runId),
    );
    const replaySessionHistory = async () => {
      if (
        options.replayHistory === false ||
        !sessionData?.conversation.messages
      ) {
        return;
      }
      await session.replayHistory(
        sessionData.conversation.messages,
        sessionData.historyGaps,
      );
      try {
        await session.publishRecoveredGoalState(
          sessionData.conversation.messages,
        );
      } catch (error) {
        debugLogger.debug(
          `Failed to publish recovered Goal state: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
    };
    let published = false;
    try {
      options.signal?.throwIfAborted();
      let forceAuthenticationRefresh =
        options.configProviderRevision !== this.modelProviderReloadRevision;
      while (true) {
        const providerReloadRevision = this.modelProviderReloadRevision;
        const previousModelProviders = settings.merged.modelProviders;
        const settingsReloaded =
          settings.reloadScopesFromDiskAtomically?.([
            SettingScope.User,
            SettingScope.Workspace,
          ]) !== false;
        if (!settingsReloaded) {
          if (providerReloadRevision !== options.configProviderRevision) {
            throw new Error(
              'Unable to reload model-provider settings from disk.',
            );
          }
          debugLogger.warn(
            'Final model-provider settings reload failed; keeping current settings',
          );
        }
        config.reloadModelProvidersConfig?.(settings.merged.modelProviders);
        const envReload = reloadEnvironment(
          settings.merged,
          config.getTargetDir(),
        );
        const providerSettingsChanged = !isDeepStrictEqual(
          previousModelProviders,
          settings.merged.modelProviders,
        );
        if (
          forceAuthenticationRefresh ||
          providerSettingsChanged ||
          envReload.updatedKeys.length > 0 ||
          envReload.removedKeys.length > 0
        ) {
          await this.ensureAuthenticated(config, settings);
        }
        if (providerReloadRevision === this.modelProviderReloadRevision) break;
        forceAuthenticationRefresh = true;
      }
      options.beforeSessionPublish?.();
      options.primeSession?.(session);
      config.hydrateSessionRestoreFileHistory?.();
      this.sessions.set(sessionId, session);
      // Track the file-derived mode, not a mode restored from the transcript.
      // An unchanged settings reload must not overwrite session-local state.
      this.sessionApprovalModeConverged.set(
        sessionId,
        options.fileDerivedApprovalMode ?? config.getApprovalMode(),
      );
      published = true;
      this.initializingConfigs.delete(config);

      if (sessionData?.fileHistorySnapshots?.length) {
        config
          .getFileHistoryService()
          .restoreFromSnapshots(sessionData.fileHistorySnapshots);
      }

      if (sessionData?.conversation.messages) {
        config
          .getChatRecordingService()
          ?.rebuildTurnBoundaries(sessionData.conversation.messages);
      }

      await replaySessionHistory();

      await options.beforeStartPostReplayServices?.(session);

      // Install rewriter AFTER history replay to avoid rewriting historical messages
      session.installRewriter();

      config.finalizeSessionRestore?.();

      // After replay and resume-state restoration so a durable cron fire can't
      // interleave with either.
      session.startCronScheduler();

      setTimeout(() => {
        void session.sendAvailableCommandsUpdate();
      }, 0);
      return session;
    } catch (error) {
      if (!published) {
        try {
          session.dispose();
        } catch (disposeError) {
          debugLogger.warn(
            `Failed to dispose unpublished session ${sessionId}: ${disposeError instanceof Error ? disposeError.message : String(disposeError)}`,
          );
        }
        throw error;
      }
      try {
        await this.discardStoredSessionIfCurrent(sessionId, session, {
          shutdownConfig: false,
        });
      } catch (cleanupError) {
        await this.removeStoredSessionEntry(
          sessionId,
          session,
          [cleanupError],
          { shutdownConfig: false },
        );
      }
      throw error;
    }
  }

  private buildAvailableModels(config: Config): NewSessionResponse['models'] {
    const rawCurrentModelId = (
      config.getModel() ||
      this.config.getModel() ||
      ''
    ).trim();
    const currentAuthType = config.getAuthType();
    const modelOptions = this.buildSelectableModelOptions(config);

    const activeRuntimeSnapshot = config.getActiveRuntimeModelSnapshot?.();
    const currentModelId = getCurrentAcpModelId(
      modelOptions,
      activeRuntimeSnapshot?.id ?? rawCurrentModelId,
      activeRuntimeSnapshot?.authType ?? currentAuthType,
      activeRuntimeSnapshot
        ? undefined
        : config.getCurrentModelRegistryBaseUrl?.(),
    );

    const mappedAvailableModels = modelOptions.map(({ model, modelId }) => ({
      modelId,
      name: model.label,
      description: model.description ?? null,
      _meta: {
        contextLimit: model.contextWindowSize ?? tokenLimit(model.id),
      },
    }));

    return {
      currentModelId,
      availableModels: mappedAvailableModels,
    };
  }

  private buildModesData(config: Config): SessionModeState {
    const currentApprovalMode = config.getApprovalMode();

    const availableModes = APPROVAL_MODES.map((mode) => ({
      id: mode as ApprovalModeValue,
      name: APPROVAL_MODE_INFO[mode].name,
      description: APPROVAL_MODE_INFO[mode].description,
    }));

    return {
      currentModeId: currentApprovalMode as ApprovalModeValue,
      ...(currentApprovalMode === ApprovalMode.PLAN
        ? {
            _meta: {
              planExecutionMode:
                config.getPlanExecutionMode?.() ?? config.getPrePlanMode?.(),
            },
          }
        : {}),
      availableModes,
    };
  }

  private buildConfigOptions(
    config: Config,
    defaultReasoning: ContentGeneratorConfig['reasoning'],
  ): SessionConfigOption[] {
    const currentApprovalMode = config.getApprovalMode();
    const modelOptions = this.buildSelectableModelOptions(config);
    const rawCurrentModelId = (config.getModel() || '').trim();
    const currentAuthType = config.getAuthType?.();

    const activeRuntimeSnapshot = config.getActiveRuntimeModelSnapshot?.();
    const currentModelId = getCurrentAcpModelId(
      modelOptions,
      activeRuntimeSnapshot?.id ?? rawCurrentModelId,
      activeRuntimeSnapshot?.authType ?? currentAuthType,
      activeRuntimeSnapshot
        ? undefined
        : config.getCurrentModelRegistryBaseUrl?.(),
    );

    const modeOptions = APPROVAL_MODES.map((mode) => ({
      value: mode,
      name: APPROVAL_MODE_INFO[mode].name,
      description: APPROVAL_MODE_INFO[mode].description,
    }));

    const modeConfigOption: SessionConfigOption = {
      id: 'mode',
      name: 'Mode',
      description: 'Session permission mode',
      category: 'mode',
      type: 'select' as const,
      currentValue: currentApprovalMode,
      options: modeOptions,
    };

    const configModelOptions = modelOptions.map(({ model, modelId }) => ({
      value: modelId,
      name: model.label,
      description: model.description ?? '',
    }));

    const modelConfigOption: SessionConfigOption = {
      id: 'model',
      name: 'Model',
      description: 'AI model to use',
      category: 'model',
      type: 'select' as const,
      currentValue: currentModelId,
      options: configModelOptions,
    };

    const modelReasoning = this.getModelReasoningConfiguration(
      config,
      currentModelId,
    );

    if (
      activeRuntimeSnapshot ||
      (currentModelId.startsWith(ACP_ROUTE_ID_PREFIX) &&
        !modelReasoning?.profile) ||
      !isReasoningSelectionSupported(
        rawCurrentModelId,
        REASONING_EFFORT_DEFAULT,
        false,
        modelReasoning,
      )
    ) {
      return [modeConfigOption, modelConfigOption];
    }

    const generation = config.getContentGeneratorConfig?.();
    if (!generation) {
      return [modeConfigOption, modelConfigOption];
    }
    const currentModelEffort = config.getReasoningEffort?.();
    const gptOverride = getGptReasoningOverrideState(
      generation,
      modelReasoning,
    );
    if (
      modelReasoning?.profile &&
      gptOverride?.enabled &&
      gptOverride.useDefaultEffort
    ) {
      return [modeConfigOption, modelConfigOption];
    }
    const gptEnableOverride =
      generation.reasoning === false
        ? getGptReasoningOverrideState(
            { ...generation, reasoning: undefined },
            modelReasoning,
          )
        : gptOverride;
    const effectiveModelEffort =
      modelReasoning && !modelReasoning.toggleOnly
        ? gptOverride?.useDefaultEffort
          ? modelReasoning.defaultEffort
          : (gptOverride?.effort ?? currentModelEffort)
        : currentModelEffort;
    const reasoningEnabled =
      generation.reasoning === undefined && gptOverride?.enabled === undefined
        ? undefined
        : generation.reasoning !== false && gptOverride?.enabled !== false;
    const canDisableReasoning = generation.thinkingMandatory !== true;
    const reasoningEffortConfigOption: SessionConfigOption = (modelReasoning
      ? buildModelReasoningConfigOption(
          rawCurrentModelId,
          {
            enabled: reasoningEnabled,
            effort: effectiveModelEffort,
            ...(gptEnableOverride?.blocksTierChange
              ? gptEnableOverride.enabled && defaultReasoning !== false
                ? { enableValue: REASONING_EFFORT_DEFAULT }
                : { canEnable: false }
              : {}),
            thinkingMandatory: generation.thinkingMandatory === true,
          },
          modelReasoning,
        )
      : undefined) ?? {
      id: 'reasoning_effort',
      name: 'Reasoning effort',
      description: 'How hard reasoning-capable models should think',
      category: 'thought_level',
      type: 'select' as const,
      currentValue:
        generation.reasoning === false && canDisableReasoning
          ? REASONING_EFFORT_NONE
          : (currentModelEffort ?? REASONING_EFFORT_DEFAULT),
      options: [
        ...(canDisableReasoning
          ? [
              {
                value: REASONING_EFFORT_NONE,
                name: 'Thinking off',
                description: 'Disable thinking for this session',
              },
            ]
          : []),
        {
          value: REASONING_EFFORT_DEFAULT,
          name: 'Default',
          description: 'Use the model or provider default',
        },
        ...REASONING_EFFORT_TIERS.map((effort) => ({
          value: effort,
          name: REASONING_EFFORT_NAMES[effort],
          description:
            'Providers map or clamp the requested tier for the active model',
        })),
      ],
    };

    return [modeConfigOption, modelConfigOption, reasoningEffortConfigOption];
  }

  private getModelReasoningConfiguration(
    config: Config,
    currentAcpModelId?: string,
  ): ModelReasoningConfiguration | undefined {
    if (config.getActiveRuntimeModelSnapshot?.()) {
      return undefined;
    }
    const completeModelId =
      currentAcpModelId ??
      getCurrentAcpModelId(
        this.buildSelectableModelOptions(config),
        (config.getModel() || '').trim(),
        config.getAuthType?.(),
        config.getCurrentModelRegistryBaseUrl?.(),
      );
    const reasoning = getConfiguredModelReasoning(config);
    return completeModelId.startsWith(ACP_ROUTE_ID_PREFIX) &&
      !reasoning?.profile
      ? undefined
      : reasoning;
  }

  private buildSelectableModelOptions(config: Config) {
    return buildAcpModelOptions(config.getAllConfiguredModels());
  }
}
