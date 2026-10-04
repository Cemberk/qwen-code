/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * @fileoverview Shared types for multi-agent systems (Arena, Team, Swarm)
 * and the Backend abstraction layer.
 *
 * These types are used across different agent orchestration modes.
 */

import type { Content } from '@google/genai';
import type { ContentGenerator } from '../../core/contentGenerator.js';
import type {
  AgentMessage,
  AgentStatus,
  PromptConfig,
  ModelConfig,
  RunConfig,
  ToolConfig,
} from '../runtime/agent-types.js';
import type { AgentEventEmitter } from '../runtime/agent-events.js';
import type { ApprovalMode } from '../../config/config.js';
import type { TeammateIdentity } from '../team/types.js';

/**
 * Canonical display mode values shared across core and CLI.
 */
export const DISPLAY_MODE = {
  IN_PROCESS: 'in-process',
} as const;

/**
 * Supported display mode values.
 */
export type DisplayMode = (typeof DISPLAY_MODE)[keyof typeof DISPLAY_MODE];

/**
 * Configuration for spawning an agent.
 */
export interface AgentSpawnConfig {
  /** Unique identifier for this agent */
  agentId: string;
  /** Working directory for the agent */
  cwd: string;
  /** In-process spawn configuration used to create the AgentInteractive. */
  inProcess: InProcessSpawnConfig;
}

/**
 * Configuration for spawning an in-process agent.
 */
export interface InProcessSpawnConfig {
  /** Human-readable agent name for display. */
  agentName: string;
  /** Optional initial task to start working on immediately. */
  initialTask?: string;
  /**
   * When true, the agent transitions to COMPLETED instead of IDLE when
   * its message queue empties. Used for team teammates.
   */
  completeOnIdle?: boolean;
  /** Runtime configuration for the AgentCore. */
  runtimeConfig: {
    promptConfig: PromptConfig;
    modelConfig: ModelConfig;
    runConfig: RunConfig;
    toolConfig?: ToolConfig;
  };
  /** Optional per-agent approval mode override. */
  approvalMode?: ApprovalMode;
  /** Optional teammate identity for in-process team agents. */
  teammateIdentity?: TeammateIdentity;
  /**
   * Per-agent auth/provider overrides. When present, a dedicated
   * ContentGenerator is created for this agent instead of inheriting
   * the parent process's. This enables Arena agents to target different
   * model providers (OpenAI, Anthropic, Gemini, etc.) in the same session.
   */
  authOverrides?: {
    authType: string;
    apiKey?: string;
    baseUrl?: string;
  };
  /**
   * Optional chat history from the parent session. When provided, this
   * history is prepended to the agent's chat so it has conversational
   * context from the session that spawned it.
   */
  chatHistory?: Content[];
}

/**
 * Callback for agent exit events.
 */
export type AgentExitCallback = (
  agentId: string,
  exitCode: number | null,
  signal: number | null,
) => void;

/**
 * Minimal handle a backend can return for an in-process agent.
 *
 * Both `AgentInteractive` (real) and `FakeAgent` (tests) satisfy this
 * shape.
 */
export interface TeamAgentHandle {
  getStatus(): AgentStatus;
  getEventEmitter(): AgentEventEmitter | undefined;
  enqueueMessage(msg: string): void;
  abort(): void;
  /**
   * Last fatal error, when the agent failed to start or run.
   * Optional: both AgentInteractive and FakeAgent provide it; future
   * handles may not.
   */
  getError?(): string | undefined;
  /**
   * Conversation message history. Optional: AgentInteractive and
   * FakeAgent provide it; future handles may not.
   * TeamManager reads it to recover round text emitted before its
   * event bridge attached.
   */
  getMessages?(): readonly AgentMessage[];
}

/**
 * Backend abstracts the agent management layer for multi-agent systems.
 *
 * The orchestration layer (Arena, Team, etc.) delegates agent lifecycle
 * operations through the backend.
 */
export interface Backend {
  /** Backend type identifier. */
  readonly type: DisplayMode;

  /**
   * Initialize the backend.
   */
  init(): Promise<void>;

  // ─── Agent Lifecycle ────────────────────────────────────────

  /**
   * Spawn a new agent.
   *
   * @param config - Agent spawn configuration
   * @returns Promise that resolves when the agent is created and ready.
   */
  spawnAgent(config: AgentSpawnConfig): Promise<void>;

  /**
   * Stop a specific agent.
   */
  stopAgent(agentId: string): void;

  /**
   * Get an in-process agent handle by id. Backends that keep no handle
   * may omit this method.
   */
  getAgent?(agentId: string): TeamAgentHandle | undefined;

  /**
   * Get the dedicated ContentGenerator an in-process agent was spawned
   * with, when the backend created one for an explicitly requested
   * per-agent route. Lets spawn callers verify a requested route
   * actually materialized instead of silently falling back to the
   * parent's generator. A backend may omit this method; note that
   * TeamManager fails the spawn of a model-selecting definition on a
   * backend that omits it, because absence makes the route unverifiable.
   */
  getAgentContentGenerator?(agentId: string): ContentGenerator | undefined;

  /**
   * Get why the dedicated ContentGenerator could not be created for an
   * agent, when the backend swallowed the creation failure and fell
   * back to the parent's generator. Lets spawn callers surface the
   * underlying cause (missing API key, bad base URL, ...) instead of a
   * bare "route did not materialize". A backend may omit this method.
   */
  getAgentContentGeneratorError?(agentId: string): string | undefined;

  /**
   * Stop all running agents.
   */
  stopAll(): void;

  /**
   * Clean up all resources.
   */
  cleanup(): Promise<void>;

  /**
   * Register a callback for agent exit events.
   */
  setOnAgentExit(callback: AgentExitCallback): void;

  /**
   * Wait for all agents to exit, with an optional timeout.
   *
   * @returns true if all agents exited, false if timeout was reached.
   */
  waitForAll(timeoutMs?: number): Promise<boolean>;
}
