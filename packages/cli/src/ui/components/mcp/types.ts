/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import type {
  MCPServerConfig,
  MCPServerStatus,
} from '@qwen-code/qwen-code-core';

/**
 * MCP management step definitions
 */
export const MCP_MANAGEMENT_STEPS = {
  SERVER_LIST: 'server-list',
  SERVER_DETAIL: 'server-detail',
  DISABLE_SCOPE_SELECT: 'disable-scope-select',
  TOOL_LIST: 'tool-list',
  TOOL_DETAIL: 'tool-detail',
  RESOURCE_LIST: 'resource-list',
  RESOURCE_DETAIL: 'resource-detail',
} as const;

/**
 * MCP server display info
 */
export interface MCPServerDisplayInfo {
  /** Server name */
  name: string;
  /** Connection status */
  status: MCPServerStatus;
  /** Source type */
  source: 'user' | 'project' | 'workspace' | 'system' | 'extension';
  /** Config file path */
  configPath?: string;
  /** Server config */
  config: MCPServerConfig;
  /** Tool count */
  toolCount: number;
  /** Invalid tool count (missing name or description) */
  invalidToolCount?: number;
  /** Prompt count */
  promptCount: number;
  /** Resource count */
  resourceCount: number;
  /** Error message */
  errorMessage?: string;
  /** Whether disabled (in the exclusion list) */
  isDisabled: boolean;
  /**
   * For gated (#4615) servers not yet approved: why discovery skipped it
   * (left disconnected). `pending` = awaiting first/re-approval,
   * `rejected` = rejected. Set only for gated scopes, else undefined.
   */
  approvalState?: 'pending' | 'rejected';
}

/**
 * MCP tool display info
 */
export interface MCPToolDisplayInfo {
  /** Tool name */
  name: string;
  /** Tool description */
  description?: string;
  /** Owning server */
  serverName: string;
  /** Tool schema */
  schema?: object;
  /** Tool annotations */
  annotations?: {
    title?: string;
    readOnlyHint?: boolean;
    destructiveHint?: boolean;
    idempotentHint?: boolean;
    openWorldHint?: boolean;
  };
  /** Valid if it has a name and description (required for LLM calls) */
  isValid: boolean;
  /** Reason it is invalid (when isValid is false) */
  invalidReason?: string;
}

/**
 * MCP resource display info
 */
export interface MCPResourceDisplayInfo {
  /** Resource URI (referenced in chat via @server:uri) */
  uri: string;
  /** Resource name */
  name?: string;
  /** Resource title (friendlier display name, if any) */
  title?: string;
  /** Resource description */
  description?: string;
  /** MIME type */
  mimeType?: string;
  /** Resource size (bytes) */
  size?: number;
  /** Owning server */
  serverName: string;
}

/**
 * Grouped server list
 */
export interface GroupedServers {
  /** Source identifier */
  source: string;
  /** Source display name */
  displayName: string;
  /** Config file path */
  configPath?: string;
  /** Server list */
  servers: MCPServerDisplayInfo[];
}

/**
 * ServerListStep component props
 */
export interface ServerListStepProps {
  /** Server list */
  servers: MCPServerDisplayInfo[];
  /** Selection callback */
  onSelect: (index: number) => void;
}

/**
 * ServerDetailStep component props
 */
export interface ServerDetailStepProps {
  /** Selected server */
  server: MCPServerDisplayInfo | null;
  /** View tool list callback */
  onViewTools: () => void;
  /** View resource list callback */
  onViewResources?: () => void;
  /** Reconnect callback */
  onReconnect?: () => void;
  /** Approve server callback (lifts the needs-approval gate) */
  onApprove?: () => void;
  /** Disable server callback */
  onDisable?: () => void;
  /** Back callback */
  onBack: () => void;
  /** Whether to respond to keyboard input (default true) */
  isActive?: boolean;
}

/**
 * DisableScopeSelectStep component props
 */
export interface DisableScopeSelectStepProps {
  /** Selected server */
  server: MCPServerDisplayInfo | null;
  /** Scope selection callback */
  onSelectScope: (scope: 'user' | 'workspace') => void;
  /** Back callback */
  onBack: () => void;
}

/**
 * ToolListStep component props
 */
export interface ToolListStepProps {
  /** Tool list */
  tools: MCPToolDisplayInfo[];
  /** Server name */
  serverName: string;
  /** Selection callback */
  onSelect: (tool: MCPToolDisplayInfo) => void;
  /** Back callback */
  onBack: () => void;
  /** Whether to respond to keyboard input (default true) */
  isActive?: boolean;
}

/**
 * ToolDetailStep component props
 */
export interface ToolDetailStepProps {
  /** Tool info */
  tool: MCPToolDisplayInfo | null;
  /** Back callback */
  onBack: () => void;
  /** Whether to respond to keyboard input (default true) */
  isActive?: boolean;
}

/**
 * ResourceListStep component props
 */
export interface ResourceListStepProps {
  /** Resource list */
  resources: MCPResourceDisplayInfo[];
  /** Server name */
  serverName: string;
  /** Selection callback */
  onSelect: (resource: MCPResourceDisplayInfo) => void;
  /** Back callback */
  onBack: () => void;
  /** Whether to respond to keyboard input (default true) */
  isActive?: boolean;
}

/**
 * ResourceDetailStep component props
 */
export interface ResourceDetailStepProps {
  /** Resource info */
  resource: MCPResourceDisplayInfo | null;
  /** Back callback */
  onBack: () => void;
  /** Whether to respond to keyboard input (default true) */
  isActive?: boolean;
}

/**
 * MCP management dialog props
 */
export interface MCPManagementDialogProps {
  /** Close callback */
  onClose: () => void;
}
