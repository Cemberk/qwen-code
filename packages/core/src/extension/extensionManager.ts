/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type {
  MCPServerConfig,
  ExtensionInstallMetadata,
} from '../config/config.js';
import type { Config } from '../config/config.js';
import { validateSkillName, type SkillConfig } from '../skills/types.js';
import type { SubagentConfig, SubagentError } from '../subagents/types.js';
import type { ClaudeMarketplaceConfig } from './claude-converter.js';
import type { HookEventName, HookDefinition } from '../hooks/types.js';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

import { atomicWriteFile } from '../utils/atomicFileWrite.js';
import { getErrorMessage } from '../utils/errors.js';
import {
  EXTENSIONS_CONFIG_FILENAME,
  EXTENSION_SETTINGS_FILENAME,
  INSTALL_METADATA_FILENAME,
  recursivelyHydrateStrings,
  substituteHookVariables,
  performVariableReplacement,
} from './variables.js';
import { resolveEnvVarsInObject } from '../utils/envVarResolver.js';
import {
  extractArchiveFile,
  isSupportedArchivePath,
} from './archive-extraction.js';
import type { LoadExtensionContext } from './variableSchema.js';
import { Override, type AllExtensionsEnablementConfig } from './override.js';
import {
  ExtensionPreferencesStore,
  type ExtensionScope,
} from './extensionPreferences.js';
import { convertCompatibleExtension } from './extension-converter.js';
import { glob } from 'glob';
import { createHash } from 'node:crypto';
import { ExtensionStorage } from './storage.js';
import {
  resolveExtensionConfigLocale,
  type RawExtensionConfig,
  type LocalizableString,
} from './i18n.js';
import {
  ExtensionSettingScope,
  getScopedEnvContents,
  maybePromptForSettings,
  promptForSetting,
  type PreparedExtensionSettingsMutation,
  validateExtensionSettingEnvVars,
} from './extensionSettings.js';
import type {
  ExtensionSetting,
  ResolvedExtensionSetting,
} from './extensionSettings.js';
import type { ExtensionOriginSource } from '../config/config.js';
import { loadSkillsFromDir } from '../skills/skill-load.js';
import { loadSubagentFromDir } from '../subagents/subagent-manager.js';
import {
  loadExtensionWorkflows,
  type ExtensionWorkflowDefinition,
} from '../agents/runtime/workflow-extension.js';
import { createDebugLogger } from '../utils/debugLogger.js';
import { refreshExtensionRuntime } from './extension-runtime-refresh.js';
import {
  ExtensionStore,
  type ExtensionStoreSnapshot,
  type InitialExtensionActivation,
} from './extension-store.js';
import {
  getAgentPluginSchemaStatus,
  loadAgentPluginManifest,
  loadAgentPluginMcpServers,
  loadAgentPluginSkills,
} from './agent-plugins-v1/index.js';

const debugLogger = createDebugLogger('EXTENSIONS');

export type ExtensionPackageFormat = 'qwen' | 'agent-plugins-v1';

interface LoadedExtensionManifest {
  format: ExtensionPackageFormat;
  config: ExtensionConfig;
}

// ============================================================================
// Types and Interfaces
// ============================================================================

export enum SettingScope {
  User = 'User',
  Workspace = 'Workspace',
  System = 'System',
  SystemDefaults = 'SystemDefaults',
}

export interface Extension {
  id: string;
  name: string;
  displayName?: string;
  version: string;
  isActive: boolean;
  path: string;
  config: ExtensionConfig;
  format?: ExtensionPackageFormat;
  installMetadata?: ExtensionInstallMetadata;

  mcpServers?: Record<string, MCPServerConfig>;
  contextFiles: string[];
  settings?: ExtensionSetting[];
  resolvedSettings?: ResolvedExtensionSetting[];
  commands?: string[];
  skills?: SkillConfig[];
  /** Runtime-only: missing skills may be discovery failures rather than removals. */
  skillsDiscoveryHasErrors?: boolean;
  agents?: SubagentConfig[];
  /** Workflow scripts this extension ships, addressed as `<name>:<meta.name>`. */
  workflows?: ExtensionWorkflowDefinition[];
  // R10-2: executor-block refusals for this extension's agent files, keyed by
  // lowercased declared name, recorded at load so a by-name dispatch can refuse
  // instead of falling through to a builtin of the same name.
  agentExecutorRefusals?: Map<string, SubagentError>;
  hooks?: { [K in HookEventName]?: HookDefinition[] };
}

export interface ExtensionConfig {
  name: string;
  version: string;
  displayName?: string;
  description?: string;
  /** Original localizable values before resolution, for runtime re-resolution on language change. */
  _rawLocalizable?: {
    displayName?: LocalizableString;
    description?: LocalizableString;
  };
  mcpServers?: Record<string, MCPServerConfig>;
  lspServers?: string | Record<string, unknown>;
  contextFileName?: string | string[];
  commands?: string | string[];
  skills?: string | string[];
  skillStates?: Record<string, boolean>;
  agents?: string | string[];
  /** Workflow directories or `.js` files; defaults to `workflows/`. */
  workflows?: string | string[];
  settings?: ExtensionSetting[];
  hooks?: { [K in HookEventName]?: HookDefinition[] };
}

export interface ExtensionUpdateInfo {
  name: string;
  originalVersion: string;
  updatedVersion: string;
  warnings?: Array<{ code: string; error: string }>;
}

export interface ExtensionCommittedWithWarningsError extends Error {
  code: 'extension_committed_with_warnings';
  committed: true;
  identity: { id: string; name: string };
  warnings: ReadonlyArray<{ code: string; error: string }>;
}

export function isExtensionCommittedWithWarningsError(
  error: unknown,
): error is ExtensionCommittedWithWarningsError {
  const candidate = error as Partial<ExtensionCommittedWithWarningsError>;
  return (
    error instanceof Error &&
    candidate.code === 'extension_committed_with_warnings' &&
    candidate.committed === true &&
    typeof candidate.identity?.id === 'string' &&
    typeof candidate.identity.name === 'string' &&
    Array.isArray(candidate.warnings)
  );
}

export interface ExtensionUpdateStatus {
  status: ExtensionUpdateState;
  processed: boolean;
}

export enum ExtensionUpdateState {
  CHECKING_FOR_UPDATES = 'checking for updates',
  UPDATED_NEEDS_RESTART = 'updated, needs restart',
  UPDATED_WITH_WARNINGS = 'updated with warnings',
  UPDATING = 'updating',
  UPDATED = 'updated',
  UPDATE_AVAILABLE = 'update available',
  UP_TO_DATE = 'up to date',
  ERROR = 'error',
  NOT_UPDATABLE = 'not updatable',
  UNKNOWN = 'unknown',
}

export type ExtensionRequestOptions = {
  extensionConfig: ExtensionConfig;
  originSource: ExtensionOriginSource;
  commands?: string[];
  skills?: SkillConfig[];
  subagents?: SubagentConfig[];
  workflows?: ExtensionWorkflowDefinition[];
  previousExtensionConfig?: ExtensionConfig;
  previousCommands?: string[];
  previousSkills?: SkillConfig[];
  previousSubagents?: SubagentConfig[];
  previousWorkflows?: ExtensionWorkflowDefinition[];
};

export interface ExtensionManagerOptions {
  /** Working directory for project-level extensions */
  workspaceDir?: string;
  /** Override list of enabled extension names (from CLI -e flag) */
  enabledExtensionOverrides?: string[];
  isWorkspaceTrusted: boolean;
  /** Locale code for resolving localizable fields (e.g., 'en', 'zh'). Defaults to 'en'. */
  locale?: string;
  config?: Config;
  requestConsent?: (options?: ExtensionRequestOptions) => Promise<void>;
  requestSetting?: (setting: ExtensionSetting) => Promise<string>;
  requestChoicePlugin?: (
    marketplace: ClaudeMarketplaceConfig,
  ) => Promise<string>;
  extensionStore?: ExtensionStore;
}

export interface PreparedExtensionMutation {
  readonly operation: 'install' | 'update';
  readonly identity: { id: string; name: string };
  readonly version: string;
  readonly expectedArtifactGeneration?: number;
  /** @internal */
  readonly initialActivation: InitialExtensionActivation;
  /** @internal */
  readonly stagingDirectory: string;
  /** @internal */
  readonly destinationDirectory: string;
  /** @internal */
  readonly cleanupPaths: readonly string[];
  /** @internal */
  readonly commitSettings?: () => Promise<void>;
  /** @internal */
  readonly discardSettings?: () => Promise<void>;
  /** @internal */
  settingsActivated: boolean;
  /** @internal */
  disposed: boolean;
}

export interface CommittedExtensionMutation {
  identity: { id: string; name: string };
  version: string;
  generation: number;
  extension?: Extension;
  warnings?: Array<{ code: string; error: string }>;
}

export interface ExtensionStoreMutationResult extends ExtensionStoreSnapshot {
  warnings?: Array<{ code: string; error: string }>;
  updated?: boolean;
}

export class ExtensionNotUpdatableError extends Error {
  readonly code = 'extension_not_updatable';

  constructor(name: string) {
    super(`Extension "${name}" is not updatable.`);
    this.name = 'ExtensionNotUpdatableError';
  }
}

export interface ExtensionMutationEvent {
  id: number;
  phase: 'start' | 'end';
  operation: string;
}

export type ExtensionMutationListener = (event: ExtensionMutationEvent) => void;

// ============================================================================
// Helper Functions
// ============================================================================

function ensureLeadingAndTrailingSlash(dirPath: string): string {
  let result = dirPath.replace(/\\/g, '/');
  if (result.charAt(0) !== '/') {
    result = '/' + result;
  }
  if (result.charAt(result.length - 1) !== '/') {
    result = result + '/';
  }
  return result;
}

function filterMcpConfig(original: MCPServerConfig): MCPServerConfig {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const { trust, ...rest } = original;
  return Object.freeze(rest);
}

function getContextFileNames(config: ExtensionConfig): string[] {
  if (!config.contextFileName || config.contextFileName.length === 0) {
    return ['QWEN.md'];
  } else if (!Array.isArray(config.contextFileName)) {
    return [config.contextFileName];
  }
  return config.contextFileName;
}

async function loadCommandsFromDir(dir: string): Promise<string[]> {
  const globOptions = {
    nodir: true,
    dot: true,
    follow: true,
  };

  try {
    const allFiles = await glob('**/*.{md,toml}', {
      ...globOptions,
      cwd: dir,
    });

    const commandNames = allFiles.map((file) => {
      const ext = path.extname(file);
      const relativePath = file.substring(0, file.length - ext.length);
      const commandName = relativePath
        .split(/[/\\]/)
        .map((segment) => segment.replaceAll(':', '_'))
        .join(':');

      return commandName;
    });

    return commandNames;
  } catch (error) {
    const isEnoent = (error as NodeJS.ErrnoException).code === 'ENOENT';
    const isAbortError = error instanceof Error && error.name === 'AbortError';
    if (!isEnoent && !isAbortError) {
      debugLogger.error(`Error loading commands from ${dir}:`, error);
    }
    return [];
  }
}

// ============================================================================
// ExtensionManager Class
// ============================================================================

export class ExtensionManager {
  private extensionCache: Map<string, Extension> | null = null;
  private storeSnapshot: ExtensionStoreSnapshot | undefined;
  private readonly mutationListeners = new Set<ExtensionMutationListener>();
  private nextMutationId = 0;

  // Enablement configuration (directly implemented)
  private readonly configDir: string;
  private readonly configFilePath: string;
  private readonly enabledExtensionNamesOverride: string[];
  private readonly workspaceDir: string;
  private readonly preferencesStore: ExtensionPreferencesStore;
  private readonly extensionStore: ExtensionStore;
  /** See `sourceFingerprint`. `undefined` until the first refresh commits. */

  private config?: Config;
  private isWorkspaceTrusted: boolean;
  private readonly locale: string;
  private requestConsent: (options?: ExtensionRequestOptions) => Promise<void>;
  private requestSetting?: (setting: ExtensionSetting) => Promise<string>;
  private requestChoicePlugin: (
    marketplace: ClaudeMarketplaceConfig,
  ) => Promise<string>;

  constructor(options: ExtensionManagerOptions) {
    this.workspaceDir = options.workspaceDir ?? process.cwd();
    this.locale = options.locale ?? 'en';
    this.enabledExtensionNamesOverride =
      options.enabledExtensionOverrides?.map((name) => name.toLowerCase()) ??
      [];
    this.extensionStore = options.extensionStore ?? new ExtensionStore();
    this.configDir = this.extensionStore.extensionsDir;
    this.configFilePath = path.join(
      this.configDir,
      'extension-enablement.json',
    );
    this.preferencesStore = new ExtensionPreferencesStore(
      path.join(this.configDir, 'extension-preferences.json'),
    );
    this.requestSetting = options.requestSetting;
    this.requestChoicePlugin =
      options.requestChoicePlugin || (() => Promise.resolve(''));
    this.requestConsent = options.requestConsent || (() => Promise.resolve());
    this.config = options.config;
    this.isWorkspaceTrusted = options.isWorkspaceTrusted;
  }

  setConfig(config: Config): void {
    this.config = config;
  }

  setRequestConsent(
    requestConsent: (options?: ExtensionRequestOptions) => Promise<void>,
  ): void {
    this.requestConsent = requestConsent;
  }

  setRequestSetting(
    requestSetting?: (setting: ExtensionSetting) => Promise<string>,
  ): void {
    this.requestSetting = requestSetting;
  }

  setRequestChoicePlugin(
    requestChoicePlugin: (
      marketplace: ClaudeMarketplaceConfig,
    ) => Promise<string>,
  ): void {
    this.requestChoicePlugin = requestChoicePlugin;
  }

  addMutationListener(listener: ExtensionMutationListener): () => void {
    this.mutationListeners.add(listener);
    return () => {
      this.mutationListeners.delete(listener);
    };
  }

  private beginMutation(operation: string): () => void {
    const id = ++this.nextMutationId;
    this.emitMutation({ id, phase: 'start', operation });
    let ended = false;
    return () => {
      if (ended) return;
      ended = true;
      this.emitMutation({ id, phase: 'end', operation });
    };
  }

  private emitMutation(event: ExtensionMutationEvent): void {
    for (const listener of this.mutationListeners) {
      try {
        listener(event);
      } catch (error) {
        debugLogger.warn('Extension mutation listener failed:', error);
      }
    }
  }

  /**
   * Determines if an extension is enabled based on its name and the current path.
   */
  isEnabled(extensionName: string, currentPath?: string): boolean {
    const checkPath = currentPath ?? this.workspaceDir;

    // If we have a single override called 'none', this disables all extensions.
    if (
      this.enabledExtensionNamesOverride.length === 1 &&
      this.enabledExtensionNamesOverride[0] === 'none'
    ) {
      return false;
    }

    // If we have explicit overrides, only enable those extensions.
    if (this.enabledExtensionNamesOverride.length > 0) {
      return this.enabledExtensionNamesOverride.includes(
        extensionName.toLowerCase(),
      );
    }

    // Otherwise, use the configuration settings
    const config = this.readEnablementConfig();
    const extensionConfig = config[extensionName];
    let enabled = true;
    const allOverrides = extensionConfig?.overrides ?? [];
    const lexicalPath = ensureLeadingAndTrailingSlash(checkPath);
    let canonicalPath = lexicalPath;
    try {
      canonicalPath = ensureLeadingAndTrailingSlash(
        fs.realpathSync.native(path.resolve(checkPath)),
      );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    for (const rule of allOverrides) {
      const override = Override.fromFileRule(rule);
      if (
        override.matchesPath(lexicalPath) ||
        override.matchesPath(canonicalPath)
      ) {
        enabled = !override.isDisable;
      }
    }
    return enabled;
  }

  /**
   * Enables an extension at the specified scope.
   */
  async enableExtension(
    name: string,
    scope: SettingScope,
  ): Promise<ExtensionStoreMutationResult> {
    if (
      scope === SettingScope.System ||
      scope === SettingScope.SystemDefaults
    ) {
      throw new Error('System and SystemDefaults scopes are not supported.');
    }
    const extension = this.getLoadedExtensions().find(
      (ext) => ext.name === name,
    );
    if (!extension) {
      throw new Error(`Extension with name ${name} does not exist.`);
    }

    const endMutation = this.beginMutation('enableExtension');
    try {
      let snapshot: ExtensionStoreSnapshot;
      if (scope === SettingScope.Workspace) {
        snapshot = await this.extensionStore.setWorkspaceActivation(
          { id: extension.id, name: extension.name },
          this.workspaceDir,
          'enabled',
        );
      } else {
        const scopePath = os.homedir();
        snapshot = await this.extensionStore.setLegacyPathActivation(
          { id: extension.id, name: extension.name },
          scopePath,
          'enabled',
        );
      }
      this.applyStoreActivation(snapshot);
      const warning = await this.refreshToolsAfterActivation(name);
      return warning ? { ...snapshot, warnings: [warning] } : snapshot;
    } finally {
      endMutation();
    }
  }

  /**
   * Disables an extension at the specified scope.
   */
  async disableExtension(
    name: string,
    scope: SettingScope,
  ): Promise<ExtensionStoreMutationResult> {
    if (
      scope === SettingScope.System ||
      scope === SettingScope.SystemDefaults
    ) {
      throw new Error('System and SystemDefaults scopes are not supported.');
    }
    const extension = this.getLoadedExtensions().find(
      (ext) => ext.name === name,
    );
    if (!extension) {
      throw new Error(`Extension with name ${name} does not exist.`);
    }

    const endMutation = this.beginMutation('disableExtension');
    try {
      let snapshot: ExtensionStoreSnapshot;
      if (scope === SettingScope.Workspace) {
        snapshot = await this.extensionStore.setWorkspaceActivation(
          { id: extension.id, name: extension.name },
          this.workspaceDir,
          'disabled',
        );
      } else {
        const scopePath = os.homedir();
        snapshot = await this.extensionStore.setLegacyPathActivation(
          { id: extension.id, name: extension.name },
          scopePath,
          'disabled',
        );
      }
      this.applyStoreActivation(snapshot);
      const warning = await this.refreshToolsAfterActivation(name);
      return warning ? { ...snapshot, warnings: [warning] } : snapshot;
    } finally {
      endMutation();
    }
  }

  getExtensionSkillState(
    extensionId: string,
    skillName: string,
    workspacePath: string = this.workspaceDir,
    snapshot: ExtensionStoreSnapshot | undefined = this.storeSnapshot,
  ): { defaultEnabled: boolean; workspaceEnabled: boolean | null } {
    const extension = this.findExtensionById(extensionId);
    const name = skillName.trim().toLowerCase();
    if (
      !extension.skills?.some(
        (skill) => skill.name.trim().toLowerCase() === name,
      )
    ) {
      throw new Error(
        `Skill "${skillName}" does not belong to extension "${extension.name}".`,
      );
    }
    const defaults = extension.config.skillStates;
    return {
      defaultEnabled:
        defaults && Object.hasOwn(defaults, name) ? defaults[name]! : true,
      workspaceEnabled: snapshot
        ? this.extensionStore.getSkillWorkspaceOverride(
            snapshot,
            extensionId,
            workspacePath,
            name,
          )
        : null,
    };
  }

  async setExtensionActivationScope(
    extensionId: string,
    activation: InitialExtensionActivation,
  ): Promise<ExtensionStoreMutationResult> {
    const extension = this.findExtensionById(extensionId);
    const endMutation = this.beginMutation('setExtensionActivationScope');
    try {
      const snapshot = await this.extensionStore.setActivationScope(
        { id: extension.id, name: extension.name },
        activation,
      );
      this.applyStoreActivation(snapshot);
      const warning = await this.refreshToolsAfterActivation(extension.name);
      return warning ? { ...snapshot, warnings: [warning] } : snapshot;
    } finally {
      endMutation();
    }
  }

  private findExtensionById(extensionId: string): Extension {
    const extension = this.getLoadedExtensions().find(
      (candidate) => candidate.id === extensionId,
    );
    if (!extension) {
      throw new Error(`Extension with id ${extensionId} does not exist.`);
    }
    return extension;
  }

  private applyStoreActivation(snapshot: ExtensionStoreSnapshot): void {
    this.storeSnapshot = snapshot;
    for (const extension of this.getLoadedExtensions()) {
      if (this.enabledExtensionNamesOverride.length > 0) {
        extension.isActive = this.isEnabled(extension.name);
        continue;
      }
      extension.isActive =
        this.extensionStore.getActivation(
          snapshot,
          extension.id,
          extension.name,
          this.workspaceDir,
        ).effective === 'enabled';
    }
  }

  private async refreshToolsAfterActivation(
    name: string,
  ): Promise<{ code: string; error: string } | undefined> {
    try {
      await this.refreshTools();
      return undefined;
    } catch (error) {
      debugLogger.warn(
        `Extension "${name}" activation changed, but runtime refresh failed: ${getErrorMessage(error)}`,
      );
      return {
        code: 'extension_runtime_refresh_failed',
        error: getErrorMessage(error),
      };
    }
  }

  // ==========================================================================
  // Favorites & scope preferences (Installed view grouping)
  // ==========================================================================

  isFavorite(name: string): boolean {
    return this.preferencesStore.isFavorite(name);
  }

  getFavorites(): string[] {
    return this.preferencesStore.getFavorites();
  }

  /** Toggles favorite state for an extension/MCP server; returns new state. */
  toggleFavorite(name: string): boolean {
    return this.preferencesStore.toggleFavorite(name);
  }

  getExtensionScope(name: string): ExtensionScope | undefined {
    return this.preferencesStore.getScope(name);
  }

  getExtensionScopes(): Record<string, ExtensionScope> {
    return this.preferencesStore.getScopes();
  }

  setExtensionScope(name: string, scope: ExtensionScope): void {
    const endMutation = this.beginMutation('setExtensionScope');
    try {
      this.preferencesStore.setScope(name, scope);
    } finally {
      endMutation();
    }
  }

  /** MCP servers individually disabled inside the given extension. */
  getDisabledMcpServers(extensionName: string): string[] {
    return this.preferencesStore.getDisabledMcpServers(extensionName);
  }

  setMcpServerDisabled(
    extensionName: string,
    serverName: string,
    disabled: boolean,
  ): void {
    const endMutation = this.beginMutation('setMcpServerDisabled');
    try {
      this.preferencesStore.setMcpServerDisabled(
        extensionName,
        serverName,
        disabled,
      );
    } finally {
      endMutation();
    }
  }

  private readEnablementConfig(): AllExtensionsEnablementConfig {
    try {
      const content = fs.readFileSync(this.configFilePath, 'utf-8');
      return JSON.parse(content);
    } catch (error) {
      if (
        error instanceof Error &&
        'code' in error &&
        error.code === 'ENOENT'
      ) {
        return {};
      }
      debugLogger.error('Error reading extension enablement config:', error);
      return {};
    }
  }

  /**
   * Refreshes the extension cache from disk.
   */
  async refreshCache(options?: { names?: string[] }): Promise<void> {
    await this.refreshCacheWithSnapshot(options);
  }

  async refreshCacheWithSnapshot(options?: {
    names?: string[];
  }): Promise<ExtensionStoreSnapshot> {
    const requestedNames = options?.names?.filter(Boolean) ?? [];
    const { value: extensions, snapshot } =
      await this.extensionStore.readConsistent(async () => {
        let loaded: Extension[];
        if (requestedNames.length > 0) {
          loaded = (
            await Promise.all(
              requestedNames.map((name) => this.loadExtensionByName(name)),
            )
          ).filter((extension): extension is Extension => extension !== null);
        } else {
          // Default: load all extensions from QWEN_HOME-aware user extensions dir.
          loaded = await this.loadExtensionsFromExtensionsDir(
            this.configDir,
            this.workspaceDir,
          );
        }
        return {
          value: loaded,
          extensions: loaded.map((extension) => ({
            id: extension.id,
            name: extension.name,
          })),
        };
      });
    const nextCache = new Map<string, Extension>();
    extensions.forEach((extension) => {
      nextCache.set(extension.name, extension);
    });
    this.extensionCache = nextCache;
    this.applyStoreActivation(snapshot);
    return snapshot;
  }

  getLoadedExtensions(): Extension[] {
    if (!this.extensionCache) {
      return [];
    }
    return [...this.extensionCache!.values()];
  }

  // ==========================================================================
  // Extension loading methods
  // ==========================================================================

  /**
   * Loads an extension by name.
   */
  async loadExtensionByName(
    name: string,
    workspaceDir?: string,
  ): Promise<Extension | null> {
    const cwd = workspaceDir ?? this.workspaceDir;
    const userExtensionsDir = this.configDir;
    if (!fs.existsSync(userExtensionsDir)) {
      return null;
    }

    for (const subdir of fs.readdirSync(userExtensionsDir)) {
      const extensionDir = path.join(userExtensionsDir, subdir);
      if (!fs.statSync(extensionDir).isDirectory()) {
        continue;
      }
      const extension = await this.loadExtension({
        extensionDir,
        workspaceDir: cwd,
      });
      if (
        extension &&
        extension.config.name.toLowerCase() === name.toLowerCase()
      ) {
        return extension;
      }
    }

    return null;
  }

  private async loadExtensionsFromExtensionsDir(
    extensionsDir: string,
    workspaceDir: string,
    options: { manifestOnly?: boolean } = {},
  ): Promise<Extension[]> {
    let subdirs: string[];
    try {
      subdirs = fs.readdirSync(extensionsDir);
    } catch {
      return [];
    }

    const extensions: Extension[] = [];
    for (const subdir of subdirs) {
      const extensionDir = path.join(extensionsDir, subdir);
      const extension = await this.loadExtension(
        { extensionDir, workspaceDir },
        { manifestOnly: options.manifestOnly },
      );
      if (extension != null) {
        extensions.push(extension);
      }
    }
    return extensions;
  }

  /**
   * Loads everything an extension's manifest itself provides: install
   * metadata, the parsed (and env-resolved) config, the extension id, and the
   * base `Extension` object. Everything sourced from subresource directories
   * (skills, commands, agents, hooks, context files) is left to the caller.
   *
   * The agent-plugins-v1 MCP load always runs here because its throws are
   * part of this head's rejection set — skipping it would change which
   * extensions a caller sees. With `createDataDir` (the default) a
   * successful load also mkdirs the plugin data root; catalog-style callers
   * pass `false` so a read-only refresh performs no write.
   */
  private async loadExtensionManifestHead(
    context: LoadExtensionContext,
    options: { createDataDir?: boolean } = {},
  ): Promise<{
    extension: Extension;
    loadedManifest: LoadedExtensionManifest;
  }> {
    const { extensionDir } = context;
    const installMetadata = this.loadInstallMetadata(extensionDir);
    let effectiveExtensionPath = extensionDir;

    if (
      installMetadata?.type === 'link' &&
      typeof installMetadata.source === 'string' &&
      installMetadata.source.length > 0
    ) {
      effectiveExtensionPath = installMetadata.source;
    }

    try {
      return await this.loadExtensionManifestHeadResolved(
        context,
        installMetadata,
        effectiveExtensionPath,
        options,
      );
    } catch (error) {
      // Name the path where the failure actually happened — the linked
      // source for linked installs, not the install dir that only holds the
      // metadata sidecar. loadExtension's catch surfaces this for its skip
      // warning.
      const withManifestPath = error as Error & { manifestPath?: string };
      if (!withManifestPath.manifestPath) {
        withManifestPath.manifestPath = effectiveExtensionPath;
      }
      throw error;
    }
  }

  private async loadExtensionManifestHeadResolved(
    context: LoadExtensionContext,
    installMetadata: ExtensionInstallMetadata | undefined,
    effectiveExtensionPath: string,
    options: { createDataDir?: boolean },
  ): Promise<{
    extension: Extension;
    loadedManifest: LoadedExtensionManifest;
  }> {
    const { workspaceDir } = context;
    const loadedManifest = this.loadExtensionManifest({
      extensionDir: effectiveExtensionPath,
      workspaceDir,
    });
    let config = loadedManifest.config;
    if (loadedManifest.format === 'qwen') {
      config = resolveEnvVarsInObject(config);
    }
    const extensionId = getExtensionId(config, installMetadata);
    if (loadedManifest.format === 'agent-plugins-v1') {
      // The MCP load runs on the manifest-only path too (with its data-dir
      // creation disabled): its throws are part of the head's rejection set,
      // so skipping it there would make the catalog list extensions the full
      // load skips — e.g. a plugin whose mcp.json is a path-escaping symlink.
      // With createDataDir (the default) a successful load also mkdirs the
      // plugin data root for stdio servers.
      config = {
        ...config,
        mcpServers: await loadAgentPluginMcpServers(
          effectiveExtensionPath,
          this.extensionStore.agentPluginDataRoot(extensionId),
          { createDataDir: options.createDataDir !== false },
        ),
      };
    }

    const extension: Extension = {
      id: extensionId,
      name: config.name,
      displayName: config.displayName,
      version:
        config.version ||
        installMetadata?.marketplaceConfig?.metadata?.version ||
        '1.0.0',
      path: effectiveExtensionPath,
      format: loadedManifest.format,
      installMetadata,
      isActive: this.isEnabled(config.name, this.workspaceDir),
      config,
      settings: config.settings,
      contextFiles: [],
    };

    if (config.mcpServers) {
      extension.mcpServers = Object.fromEntries(
        Object.entries(config.mcpServers).map(([key, value]) => [
          key,
          filterMcpConfig(value),
        ]),
      );
    }

    return { extension, loadedManifest };
  }

  async loadExtension(
    context: LoadExtensionContext,
    options: { throwOnError?: boolean; manifestOnly?: boolean } = {},
  ): Promise<Extension | null> {
    const { extensionDir } = context;
    if (!fs.statSync(extensionDir).isDirectory()) {
      return null;
    }

    let extension: Extension | undefined;
    try {
      // Destructured separately so `extension` stays visible in the catch
      // below for the skip warning's path.
      const head = await this.loadExtensionManifestHead(context, {
        createDataDir: !options.manifestOnly,
      });
      extension = head.extension;

      if (options.manifestOnly) {
        // Catalog-style loads: everything after the head is subresource work
        // the catalog never reads, and skipping it here keeps the inclusion
        // set identical to the full load — the head throws for the same
        // manifests the full load's catch would reject, so both paths list
        // exactly the same extensions.
        return extension;
      }

      const { loadedManifest } = head;
      const config = extension.config;
      const effectiveExtensionPath = extension.path;

      const onSkillsDiscoveryError = () => {
        head.extension.skillsDiscoveryHasErrors = true;
      };
      if (loadedManifest.format === 'agent-plugins-v1') {
        extension.commands = [];
        extension.skills = await loadAgentPluginSkills(
          effectiveExtensionPath,
          onSkillsDiscoveryError,
        );
        extension.agents = [];
        // The Agent Plugins v1 schema defines no workflows.
        extension.workflows = [];
      } else {
        extension.commands = await loadCommandsFromDir(
          `${effectiveExtensionPath}/commands`,
        );
        extension.contextFiles = getContextFileNames(config)
          .map((contextFileName) =>
            path.join(effectiveExtensionPath, contextFileName),
          )
          .filter((contextFilePath) => fs.existsSync(contextFilePath));
        extension.skills = await loadSkillsFromDir(
          `${effectiveExtensionPath}/skills`,
          onSkillsDiscoveryError,
        );
        const agentExecutorRefusals = new Map<string, SubagentError>();
        extension.agents = await loadSubagentFromDir(
          `${effectiveExtensionPath}/agents`,
          agentExecutorRefusals,
        );
        extension.agentExecutorRefusals = agentExecutorRefusals;
        extension.workflows = await loadExtensionWorkflows(
          effectiveExtensionPath,
          { name: config.name, displayName: config.displayName },
          config.workflows,
        );
      }

      if (
        loadedManifest.format === 'qwen' &&
        config.hooks &&
        typeof config.hooks !== 'string'
      ) {
        // Process the hooks to substitute variables like ${CLAUDE_PLUGIN_ROOT}
        extension.hooks = this.substituteHookVariables(
          config.hooks,
          effectiveExtensionPath,
        );
      }

      // Also load hooks from hooks directory or from config.hooks string path if available and not already set
      if (loadedManifest.format === 'qwen' && !extension.hooks) {
        const hooksDir = path.join(effectiveExtensionPath, 'hooks');
        const hooksJsonPath = path.join(hooksDir, 'hooks.json');

        const configHooksPath =
          typeof config.hooks === 'string'
            ? path.isAbsolute(config.hooks)
              ? config.hooks
              : path.join(effectiveExtensionPath, config.hooks)
            : null;

        if (
          fs.existsSync(hooksJsonPath) ||
          (configHooksPath && fs.existsSync(configHooksPath))
        ) {
          const hooksFilePath =
            configHooksPath && fs.existsSync(configHooksPath)
              ? configHooksPath
              : hooksJsonPath;

          try {
            const hooksContent = fs.readFileSync(hooksFilePath, 'utf-8');
            const parsedHooks = JSON.parse(hooksContent);

            let hooksData;
            if (parsedHooks.hooks && typeof parsedHooks.hooks === 'object') {
              hooksData = parsedHooks.hooks as {
                [K in HookEventName]?: HookDefinition[];
              };
            } else {
              // Assume the entire file content is the hooks object
              hooksData = parsedHooks as {
                [K in HookEventName]?: HookDefinition[];
              };
            }

            // Process the hooks to substitute variables like ${CLAUDE_PLUGIN_ROOT}
            extension.hooks = this.substituteHookVariables(
              hooksData,
              effectiveExtensionPath,
            );
          } catch (error) {
            debugLogger.warn(
              `Failed to parse hooks file ${hooksJsonPath}: ${error instanceof Error ? error.message : String(error)}`,
            );
          }
        }
      }

      return extension;
    } catch (e) {
      if (options.throwOnError) throw e;
      debugLogger.warn(
        `Warning: Skipping extension in ${(e as Error & { manifestPath?: string }).manifestPath ?? extension?.path ?? extensionDir}: ${getErrorMessage(
          e,
        )}`,
      );
      return null;
    }
  }

  /**
   * Substitute variables in hook configurations, particularly ${CLAUDE_PLUGIN_ROOT}
   */
  private substituteHookVariables(
    hooks: { [K in HookEventName]?: HookDefinition[] } | undefined,
    extensionPath: string,
  ): { [K in HookEventName]?: HookDefinition[] } | undefined {
    return substituteHookVariables(hooks, extensionPath);
  }

  loadInstallMetadata(
    extensionDir: string,
  ): ExtensionInstallMetadata | undefined {
    const metadataFilePath = path.join(extensionDir, INSTALL_METADATA_FILENAME);
    try {
      const configContent = fs.readFileSync(metadataFilePath, 'utf-8');
      const metadata = JSON.parse(configContent) as ExtensionInstallMetadata;
      return metadata;
    } catch (_e) {
      return undefined;
    }
  }

  loadExtensionConfig(context: LoadExtensionContext): ExtensionConfig {
    return this.loadExtensionManifest(context).config;
  }

  private loadExtensionManifest(
    context: LoadExtensionContext,
  ): LoadedExtensionManifest {
    const { extensionDir, workspaceDir = this.workspaceDir } = context;
    const agentPluginStatus = getAgentPluginSchemaStatus(extensionDir);
    if (agentPluginStatus !== 'unrelated') {
      try {
        return {
          format: 'agent-plugins-v1',
          config: loadAgentPluginManifest(extensionDir),
        };
      } catch (error) {
        throw new Error(
          `Failed to load Agent Plugins manifest from ${path.join(extensionDir, 'plugin.json')}: ${getErrorMessage(error)}`,
        );
      }
    }

    const configFilePath = path.join(extensionDir, EXTENSIONS_CONFIG_FILENAME);
    if (!fs.existsSync(configFilePath)) {
      throw new Error(`Configuration file not found at ${configFilePath}`);
    }
    try {
      const configContent = fs.readFileSync(configFilePath, 'utf-8');
      const parsedConfig = JSON.parse(configContent);
      const skillStates = parseSkillStates(parsedConfig?.skillStates);
      const rawConfig = recursivelyHydrateStrings(parsedConfig, {
        extensionPath: extensionDir,
        CLAUDE_PLUGIN_ROOT: extensionDir,
        workspacePath: workspaceDir,
        '/': path.sep,
        pathSeparator: path.sep,
      }) as unknown as RawExtensionConfig;

      const config = resolveExtensionConfigLocale(rawConfig, this.locale);
      if (skillStates !== undefined) config.skillStates = skillStates;

      if (!config.name) {
        throw new Error(
          `Invalid configuration in ${configFilePath}: missing "name"`,
        );
      }
      validateName(config.name);
      validateExtensionSettingEnvVars(config.settings);
      return { format: 'qwen', config };
    } catch (e) {
      throw new Error(
        `Failed to load extension config from ${configFilePath}: ${getErrorMessage(
          e,
        )}`,
      );
    }
  }

  // ==========================================================================
  // Extension installation/uninstallation
  // ==========================================================================

  /**
   * Installs an extension.
   */
  async installExtension(
    installMetadata: ExtensionInstallMetadata,
    requestConsent?: (options?: ExtensionRequestOptions) => Promise<void>,
    requestSetting?: (setting: ExtensionSetting) => Promise<string>,
    cwd?: string,
    initialActivation: InitialExtensionActivation = { scope: 'user' },
  ): Promise<Extension> {
    const endMutation = this.beginMutation('installExtension');
    let prepared: PreparedExtensionMutation | undefined;
    try {
      prepared = await this.installExtensionInternal(
        { ...installMetadata },
        requestConsent,
        requestSetting,
        cwd,
        undefined,
        initialActivation,
        undefined,
      );
      const committed = await this.commitPreparedExtension(prepared);
      const warnings = committed.warnings ?? [];
      if (!committed.extension || warnings.length > 0) {
        const reloadWarning = committed.warnings?.find(
          (warning) => warning.code === 'extension_reload_failed',
        );
        const firstWarning = reloadWarning ?? warnings[0];
        const error = new Error(
          `Extension "${prepared.identity.name}" committed with warnings${
            firstWarning ? `: ${firstWarning.code}: ${firstWarning.error}` : '.'
          }`,
          firstWarning ? { cause: new Error(firstWarning.error) } : undefined,
        ) as ExtensionCommittedWithWarningsError;
        error.code = 'extension_committed_with_warnings';
        error.committed = true;
        error.identity = committed.identity;
        error.warnings = warnings;
        throw error;
      }
      return committed.extension;
    } finally {
      if (prepared) await this.disposePreparedExtension(prepared);
      endMutation();
    }
  }

  private async prepareExtensionUpdateFromState(
    extension: Extension,
    signal?: AbortSignal,
  ): Promise<PreparedExtensionMutation> {
    const installMetadata = this.loadInstallMetadata(extension.path);
    if (!installMetadata?.type || installMetadata.type === 'link') {
      throw new Error(`Extension ${extension.name} cannot be updated.`);
    }
    if (installMetadata.type !== 'local') {
      throw new ExtensionNotUpdatableError(extension.name);
    }
    const previousConfig = this.loadExtensionConfig({
      extensionDir: extension.path,
    });
    return await this.installExtensionInternal(
      { ...installMetadata },
      undefined,
      undefined,
      undefined,
      previousConfig,
      { scope: 'user' },
      signal,
    );
  }

  private async installExtensionInternal(
    installMetadata: ExtensionInstallMetadata,
    requestConsent:
      | ((options?: ExtensionRequestOptions) => Promise<void>)
      | undefined,
    requestSetting:
      | ((setting: ExtensionSetting) => Promise<string>)
      | undefined,
    cwd: string | undefined,
    previousExtensionConfig: ExtensionConfig | undefined,
    initialActivation: InitialExtensionActivation,
    signal: AbortSignal | undefined,
  ): Promise<PreparedExtensionMutation> {
    const currentDir = cwd ?? this.workspaceDir;

    const isUpdate = !!previousExtensionConfig;
    const expectedArtifactGeneration = previousExtensionConfig
      ? ((await this.extensionStore.readSnapshot()).extensions[
          getExtensionId(previousExtensionConfig, installMetadata)
        ]?.artifactGeneration ?? 0)
      : undefined;
    let newExtensionConfig: ExtensionConfig | null = null;
    let localSourcePath: string | undefined;
    let tempDir: string | undefined;
    let convertedSourcePath: string | undefined;
    let stagingPath: string | undefined;
    let preparedSettings: PreparedExtensionSettingsMutation | undefined;

    let ownershipTransferred = false;
    try {
      if (!this.isWorkspaceTrusted) {
        throw new Error(
          `Could not install extension from untrusted folder at ${installMetadata.source}`,
        );
      }

      const extensionsDir = this.configDir;
      await fs.promises.mkdir(extensionsDir, { recursive: true });

      if (
        !path.isAbsolute(installMetadata.source) &&
        (installMetadata.type === 'local' || installMetadata.type === 'link')
      ) {
        installMetadata.source = path.resolve(
          currentDir,
          installMetadata.source,
        );
      }

      if (
        installMetadata.originSource === 'Claude' &&
        installMetadata.marketplaceConfig &&
        !installMetadata.pluginName
      ) {
        const pluginName = await this.requestChoicePlugin(
          installMetadata.marketplaceConfig,
        );
        installMetadata.pluginName = pluginName;
      }

      if (
        installMetadata.type === 'local' &&
        isSupportedArchivePath(installMetadata.source)
      ) {
        tempDir = await ExtensionStorage.createTmpDir();
        await extractArchiveFile(installMetadata.source, tempDir, signal);
        localSourcePath = tempDir;
      } else if (
        installMetadata.type === 'local' ||
        installMetadata.type === 'link'
      ) {
        localSourcePath = installMetadata.source;
      } else {
        throw new Error(`Unsupported install type: ${installMetadata.type}`);
      }

      signal?.throwIfAborted();
      try {
        const sourceBeforeConversion = localSourcePath;
        const { extensionDir, originSource } = await convertCompatibleExtension(
          sourceBeforeConversion,
          installMetadata.pluginName,
          signal,
        );
        signal?.throwIfAborted();

        if (extensionDir !== sourceBeforeConversion) {
          convertedSourcePath = extensionDir;
        }
        localSourcePath = extensionDir;
        installMetadata.originSource = originSource;

        newExtensionConfig = this.loadExtensionConfig({
          extensionDir: localSourcePath,
          workspaceDir: currentDir,
        });
        const isAgentPlugin = originSource === 'AgentPlugins';
        const extensionId = getExtensionId(newExtensionConfig, installMetadata);
        if (isAgentPlugin) {
          newExtensionConfig = {
            ...newExtensionConfig,
            mcpServers: await loadAgentPluginMcpServers(
              localSourcePath,
              this.extensionStore.agentPluginDataRoot(extensionId),
            ),
          };
        }

        const newExtensionName = newExtensionConfig.name;
        const previous = this.getLoadedExtensions().find(
          (installed) =>
            installed.name.toLowerCase() === newExtensionName.toLowerCase(),
        );
        if (isUpdate && !previous) {
          throw new Error(
            `Extension "${newExtensionName}" was not already installed, cannot update it.`,
          );
        } else if (!isUpdate && previous) {
          throw new Error(
            `Extension "${newExtensionName}" is already installed. Please uninstall it first.`,
          );
        }

        const commands = isAgentPlugin
          ? []
          : await loadCommandsFromDir(`${localSourcePath}/commands`);
        const previousCommands = previous?.commands ?? [];

        const skills = isAgentPlugin
          ? await loadAgentPluginSkills(localSourcePath)
          : await loadSkillsFromDir(`${localSourcePath}/skills`);
        const previousSkills = previous?.skills ?? [];

        const subagents = isAgentPlugin
          ? []
          : await loadSubagentFromDir(`${localSourcePath}/agents`);
        const previousSubagents = previous?.agents ?? [];

        // Resolve environment variables the way loading does, so consent lists
        // the workflows that will load, without rewriting the saved manifest.
        // A copied install replaces each symlink with its target, so consent
        // follows links there; a linked extension loads the source as-is.
        const workflowConfig = resolveEnvVarsInObject({
          name: newExtensionConfig.name,
          displayName: newExtensionConfig.displayName,
          workflows: newExtensionConfig.workflows,
        });
        const workflows = isAgentPlugin
          ? []
          : await loadExtensionWorkflows(
              localSourcePath,
              {
                name: workflowConfig.name,
                displayName: workflowConfig.displayName,
              },
              workflowConfig.workflows,
              { followSymlinks: installMetadata.type !== 'link' },
            );
        const previousWorkflows = previous?.workflows ?? [];

        if (requestConsent) {
          await requestConsent({
            extensionConfig: newExtensionConfig,
            commands,
            skills,
            subagents,
            previousExtensionConfig,
            previousCommands,
            previousSkills,
            previousSubagents,
            workflows,
            previousWorkflows,
            originSource,
          });
        } else {
          await this.requestConsent({
            extensionConfig: newExtensionConfig,
            commands,
            skills,
            subagents,
            previousExtensionConfig,
            previousCommands,
            previousSkills,
            previousSubagents,
            workflows,
            previousWorkflows,
            originSource,
          });
        }

        const destinationPath = path.join(this.configDir, newExtensionName);
        if (isUpdate && previous?.id !== extensionId) {
          throw new Error(
            `Extension "${newExtensionName}" changed its stable id during update.`,
          );
        }
        let previousSettings: Record<string, string> | undefined;
        if (isUpdate && previousExtensionConfig.settings?.length) {
          // The update rewrites user-scope settings only; workspace values
          // stay in their own scope.
          previousSettings = await getScopedEnvContents(
            previousExtensionConfig,
            extensionId,
            ExtensionSettingScope.USER,
          );
        }
        stagingPath = await this.extensionStore.createStagingDirectory();

        if (installMetadata.type !== 'link') {
          await copyExtension(localSourcePath, stagingPath, {
            skipSymlinks: isAgentPlugin,
          });
        }

        if (isUpdate) {
          preparedSettings = await maybePromptForSettings(
            newExtensionConfig,
            extensionId,
            requestSetting || this.requestSetting || promptForSetting,
            previousExtensionConfig,
            previousSettings,
            path.join(stagingPath, EXTENSION_SETTINGS_FILENAME),
            true,
          );
        } else {
          preparedSettings = await maybePromptForSettings(
            newExtensionConfig,
            extensionId,
            requestSetting || this.requestSetting || promptForSetting,
            undefined,
            undefined,
            path.join(stagingPath, EXTENSION_SETTINGS_FILENAME),
            true,
          );
        }

        // Perform variable replacement in extension files (e.g., ${CLAUDE_PLUGIN_ROOT}) for Claude extensions
        const hooksDir = path.join(stagingPath, 'hooks');
        const configHooksPath =
          typeof newExtensionConfig.hooks === 'string'
            ? path.isAbsolute(newExtensionConfig.hooks)
              ? newExtensionConfig.hooks
              : path.join(stagingPath, newExtensionConfig.hooks)
            : null;

        const usesPluginVariables =
          originSource === 'Claude' || originSource === 'Qoder';
        if (
          usesPluginVariables &&
          (fs.existsSync(hooksDir) ||
            (configHooksPath && fs.existsSync(configHooksPath)))
        ) {
          try {
            await performVariableReplacement(stagingPath, destinationPath);
          } catch (error) {
            debugLogger.error('Variable replacement failed', error);
          }
        }

        const metadataString = JSON.stringify(installMetadata, null, 2);
        const metadataPath = path.join(stagingPath, INSTALL_METADATA_FILENAME);
        await atomicWriteFile(metadataPath, metadataString);

        const stagedExtension = await this.loadExtension(
          { extensionDir: stagingPath, workspaceDir: currentDir },
          { throwOnError: true },
        );
        if (!stagedExtension) {
          throw new Error('Prepared extension could not be loaded.');
        }

        signal?.throwIfAborted();
        const cleanupPaths = [
          tempDir,
          convertedSourcePath !== tempDir ? convertedSourcePath : undefined,
        ].filter((value): value is string => !!value);
        const prepared: PreparedExtensionMutation = {
          operation: isUpdate ? 'update' : 'install',
          identity: { id: extensionId, name: newExtensionName },
          version: stagedExtension.version,
          ...(expectedArtifactGeneration === undefined
            ? {}
            : { expectedArtifactGeneration }),
          initialActivation,
          stagingDirectory: stagingPath,
          destinationDirectory: destinationPath,
          cleanupPaths,
          ...(preparedSettings
            ? {
                commitSettings: preparedSettings.commit,
                discardSettings: preparedSettings.discard,
              }
            : {}),
          settingsActivated: false,
          disposed: false,
        };
        ownershipTransferred = true;
        return prepared;
      } finally {
        if (!ownershipTransferred && preparedSettings) {
          await preparedSettings.discard().catch((error) => {
            debugLogger.warn(
              `Failed to discard prepared extension settings: ${getErrorMessage(error)}`,
            );
          });
        }
        if (stagingPath && !ownershipTransferred) {
          await fs.promises.rm(stagingPath, {
            recursive: true,
            force: true,
          });
          stagingPath = undefined;
        }
        if (tempDir && !ownershipTransferred) {
          await fs.promises.rm(tempDir, { recursive: true, force: true });
        }
        if (
          convertedSourcePath &&
          convertedSourcePath !== tempDir &&
          !ownershipTransferred
        ) {
          await fs.promises.rm(convertedSourcePath, {
            recursive: true,
            force: true,
          });
        }
      }
    } catch (error) {
      if (!newExtensionConfig && localSourcePath) {
        try {
          newExtensionConfig = this.loadExtensionConfig({
            extensionDir: localSourcePath,
            workspaceDir: currentDir,
          });
        } catch {
          // Ignore error
        }
      }
      if (tempDir) {
        await fs.promises.rm(tempDir, { recursive: true, force: true });
      }
      if (convertedSourcePath && convertedSourcePath !== tempDir) {
        await fs.promises.rm(convertedSourcePath, {
          recursive: true,
          force: true,
        });
      }
      throw error;
    }
  }

  private async commitPreparedExtension(
    prepared: PreparedExtensionMutation,
  ): Promise<CommittedExtensionMutation> {
    const snapshot = await this.extensionStore.commitArtifact({
      operation: prepared.operation,
      identity: prepared.identity,
      stagingDirectory: prepared.stagingDirectory,
      destinationDirectory: prepared.destinationDirectory,
      ...(prepared.operation === 'install'
        ? { initialActivation: prepared.initialActivation }
        : {
            expectedArtifactGeneration:
              prepared.expectedArtifactGeneration ?? 0,
          }),
    });
    prepared.settingsActivated = true;
    const warnings: NonNullable<CommittedExtensionMutation['warnings']> = [];
    try {
      await prepared.commitSettings?.();
    } catch (error) {
      warnings.push({
        code: 'extension_settings_legacy_sync_failed',
        error: getErrorMessage(error),
      });
    }
    let extension: Extension | undefined;
    try {
      extension =
        (await this.loadExtension(
          {
            extensionDir: prepared.destinationDirectory,
          },
          { throwOnError: true },
        )) ?? undefined;
      if (!extension) throw new Error('Extension not found after commit.');
      this.extensionCache?.set(extension.name, extension);
      this.applyStoreActivation(snapshot);
    } catch (error) {
      this.extensionCache?.delete(prepared.identity.name);
      this.applyStoreActivation(snapshot);
      warnings.push({
        code: 'extension_reload_failed',
        error: getErrorMessage(error),
      });
    }

    try {
      await this.refreshTools();
    } catch (error) {
      warnings.push({
        code: 'extension_runtime_refresh_failed',
        error: getErrorMessage(error),
      });
    }
    for (const error of await this.cleanupPreparedExtension(prepared)) {
      warnings.push({
        code: 'extension_temp_cleanup_failed',
        error: getErrorMessage(error),
      });
    }
    return {
      identity: prepared.identity,
      version: prepared.version,
      generation: snapshot.generation,
      ...(extension ? { extension } : {}),
      ...(warnings.length > 0 ? { warnings } : {}),
    };
  }

  private async disposePreparedExtension(
    prepared: PreparedExtensionMutation,
  ): Promise<void> {
    for (const error of await this.cleanupPreparedExtension(prepared)) {
      debugLogger.warn(
        `Failed to clean prepared extension files: ${getErrorMessage(error)}`,
      );
    }
  }

  private async cleanupPreparedExtension(
    prepared: PreparedExtensionMutation,
  ): Promise<unknown[]> {
    if (prepared.disposed) return [];
    const settingsCleanup =
      !prepared.settingsActivated && prepared.discardSettings
        ? await Promise.allSettled([prepared.discardSettings()])
        : [];
    const settingsErrors = settingsCleanup.flatMap((result) =>
      result.status === 'rejected' ? [result.reason] : [],
    );
    const paths = [prepared.stagingDirectory, ...prepared.cleanupPaths];
    let failedPaths = paths;
    let pathErrors: unknown[] = [];
    for (let attempt = 0; attempt < 2 && failedPaths.length > 0; attempt++) {
      const results = await Promise.allSettled(
        failedPaths.map(async (target) =>
          fs.promises.rm(target, { recursive: true, force: true }),
        ),
      );
      pathErrors = results.flatMap((result) =>
        result.status === 'rejected' ? [result.reason] : [],
      );
      failedPaths = failedPaths.filter(
        (_target, index) => results[index]?.status === 'rejected',
      );
    }
    const errors = [...settingsErrors, ...pathErrors];
    prepared.disposed = errors.length === 0;
    return errors;
  }

  /**
   * Uninstalls an extension.
   */
  async uninstallExtension(
    extensionIdentifier: string,
  ): Promise<ExtensionStoreMutationResult> {
    const endMutation = this.beginMutation('uninstallExtension');
    try {
      const installedExtensions = this.getLoadedExtensions();
      const extension = installedExtensions.find(
        (installed) =>
          installed.config.name.toLowerCase() ===
            extensionIdentifier.toLowerCase() ||
          installed.installMetadata?.source.toLowerCase() ===
            extensionIdentifier.toLowerCase(),
      );
      if (!extension) {
        throw new Error(`Extension not found.`);
      }
      return await this.uninstallExtensionPolicy(
        { id: extension.id, name: extension.name },
        extension.installMetadata?.type === 'link'
          ? path.join(this.configDir, extension.name)
          : extension.path,
      );
    } finally {
      endMutation();
    }
  }

  private async uninstallExtensionPolicy(
    identity: { id: string; name: string },
    destinationDirectory: string,
  ): Promise<ExtensionStoreMutationResult> {
    const snapshot = await this.extensionStore.commitArtifact({
      operation: 'uninstall',
      identity,
      destinationDirectory,
    });
    this.extensionCache?.delete(identity.name);
    const warnings: NonNullable<ExtensionStoreMutationResult['warnings']> = [];
    try {
      this.preferencesStore.clear(identity.name);
    } catch (error) {
      debugLogger.warn(
        `Extension "${identity.name}" was uninstalled, but preference cleanup failed: ${getErrorMessage(error)}`,
      );
      warnings.push({
        code: 'extension_preferences_cleanup_failed',
        error: getErrorMessage(error),
      });
    }
    try {
      await this.refreshTools();
    } catch (error) {
      debugLogger.warn(
        `Extension "${identity.name}" was uninstalled, but runtime refresh failed: ${getErrorMessage(error)}`,
      );
      warnings.push({
        code: 'extension_runtime_refresh_failed',
        error: getErrorMessage(error),
      });
    }
    return warnings.length > 0 ? { ...snapshot, warnings } : snapshot;
  }

  async checkForAllExtensionUpdates(
    callback: (extensionName: string, state: ExtensionUpdateState) => void,
    signal?: AbortSignal,
    schedule: <T>(task: () => Promise<T>) => Promise<T> = async (task) =>
      await task(),
  ): Promise<void> {
    const extensions = this.getLoadedExtensions();
    const promises: Array<Promise<void>> = [];
    for (const extension of extensions) {
      if (!extension.installMetadata) {
        callback(extension.name, ExtensionUpdateState.NOT_UPDATABLE);
        continue;
      }
      callback(extension.name, ExtensionUpdateState.CHECKING_FOR_UPDATES);
      promises.push(
        schedule(
          async () => await checkForExtensionUpdate(extension, this, signal),
        )
          .then((state) => callback(extension.name, state))
          .catch(() => {
            signal?.throwIfAborted();
            callback(extension.name, ExtensionUpdateState.ERROR);
          }),
      );
    }
    const results = await Promise.allSettled(promises);
    signal?.throwIfAborted();
    const rejected = results.find(
      (result): result is PromiseRejectedResult => result.status === 'rejected',
    );
    if (rejected) throw rejected.reason;
  }

  async updateExtension(
    extension: Extension,
    currentState: ExtensionUpdateState,
    callback: (extensionName: string, state: ExtensionUpdateState) => void,
    enableExtensionReloading: boolean = true,
    signal?: AbortSignal,
  ): Promise<ExtensionUpdateInfo | undefined> {
    if (currentState === ExtensionUpdateState.UPDATING) {
      return undefined;
    }
    callback(extension.name, ExtensionUpdateState.UPDATING);
    const installMetadata = this.loadInstallMetadata(extension.path);

    if (!installMetadata?.type) {
      callback(extension.name, ExtensionUpdateState.ERROR);
      throw new Error(
        `Extension ${extension.name} cannot be updated, type is unknown.`,
      );
    }
    if (installMetadata?.type === 'link') {
      callback(extension.name, ExtensionUpdateState.UP_TO_DATE);
      throw new Error(`Extension is linked so does not need to be updated`);
    }
    if (installMetadata.type !== 'local') {
      callback(extension.name, ExtensionUpdateState.NOT_UPDATABLE);
      throw new ExtensionNotUpdatableError(extension.name);
    }
    const endMutation = this.beginMutation('updateExtension');
    const originalVersion = extension.version;
    let prepared: PreparedExtensionMutation | undefined;

    try {
      prepared = await this.prepareExtensionUpdateFromState(extension, signal);
      const committed = await this.commitPreparedExtension(prepared);
      const warnings = committed.warnings ?? [];
      for (const warning of warnings) {
        debugLogger.warn(
          `Update of "${extension.name}" warning: ${warning.code}: ${warning.error}`,
        );
      }
      const updatedVersion = committed.extension?.version ?? committed.version;
      const needsRestart = warnings.some(
        (warning) =>
          warning.code === 'extension_reload_failed' ||
          warning.code === 'extension_runtime_refresh_failed',
      );
      callback(
        extension.name,
        !committed.extension || needsRestart || !enableExtensionReloading
          ? ExtensionUpdateState.UPDATED_NEEDS_RESTART
          : warnings.length > 0
            ? ExtensionUpdateState.UPDATED_WITH_WARNINGS
            : ExtensionUpdateState.UPDATED,
      );
      return {
        name: extension.name,
        originalVersion,
        updatedVersion,
        ...(warnings.length > 0 ? { warnings } : {}),
      };
    } catch (e) {
      debugLogger.error(`Error updating extension. ${getErrorMessage(e)}`);
      callback(extension.name, ExtensionUpdateState.ERROR);
      throw e;
    } finally {
      if (prepared) await this.disposePreparedExtension(prepared);
      endMutation();
    }
  }

  async updateAllUpdatableExtensions(
    extensionsState: Map<string, ExtensionUpdateStatus>,
    callback: (extensionName: string, state: ExtensionUpdateState) => void,
    enableExtensionReloading: boolean = true,
  ): Promise<ExtensionUpdateInfo[]> {
    const extensions = this.getLoadedExtensions();
    return (
      await Promise.all(
        extensions
          .filter(
            (extension) =>
              extensionsState.get(extension.name)?.status ===
              ExtensionUpdateState.UPDATE_AVAILABLE,
          )
          .map((extension) =>
            this.updateExtension(
              extension,
              extensionsState.get(extension.name)!.status,
              callback,
              enableExtensionReloading,
            ),
          ),
      )
    ).filter((updateInfo) => !!updateInfo);
  }

  async refreshTools(): Promise<void> {
    await refreshExtensionRuntime(this.config);
  }
}

export async function checkForExtensionUpdate(
  extension: Extension,
  extensionManager: ExtensionManager,
  signal?: AbortSignal,
): Promise<ExtensionUpdateState> {
  signal?.throwIfAborted();
  const installMetadata = extension.installMetadata;
  if (installMetadata?.type !== 'local') {
    return ExtensionUpdateState.NOT_UPDATABLE;
  }
  let latestConfig: ExtensionConfig | undefined;
  let tempDir: string | undefined;
  let convertedDir: string | undefined;
  try {
    let extensionDir = installMetadata.source;
    if (isSupportedArchivePath(installMetadata.source)) {
      tempDir = await fs.promises.mkdtemp(
        path.join(os.tmpdir(), 'extension-archive-update-'),
      );
      signal?.throwIfAborted();
      await extractArchiveFile(installMetadata.source, tempDir, signal);
      signal?.throwIfAborted();
      extensionDir = tempDir;
    }
    if (tempDir !== undefined || installMetadata.originSource === 'Qoder') {
      const sourceBeforeConversion = extensionDir;
      const converted = await convertCompatibleExtension(
        sourceBeforeConversion,
        installMetadata.pluginName,
        signal,
      );
      extensionDir = converted.extensionDir;
      if (extensionDir !== sourceBeforeConversion) {
        convertedDir = extensionDir;
      }
    }
    signal?.throwIfAborted();
    latestConfig = extensionManager.loadExtensionConfig({
      extensionDir,
    });
  } catch (e) {
    signal?.throwIfAborted();
    debugLogger.error(
      `Failed to check for update for local extension "${extension.name}". Could not load extension from source path: ${installMetadata.source}. Error: ${getErrorMessage(e)}`,
    );
    return ExtensionUpdateState.NOT_UPDATABLE;
  } finally {
    if (tempDir) {
      await fs.promises.rm(tempDir, { recursive: true, force: true });
    }
    if (convertedDir) {
      await fs.promises.rm(convertedDir, { recursive: true, force: true });
    }
  }

  if (!latestConfig) {
    debugLogger.error(
      `Failed to check for update for local extension "${extension.name}". Could not load extension from source path: ${installMetadata.source}`,
    );
    return ExtensionUpdateState.NOT_UPDATABLE;
  }
  if (latestConfig.version !== extension.version) {
    return ExtensionUpdateState.UPDATE_AVAILABLE;
  }
  return ExtensionUpdateState.UP_TO_DATE;
}

export async function copyExtension(
  source: string,
  destination: string,
  options: {
    skipSymlinks?: boolean;
  } = {},
): Promise<void> {
  const copySource = options.skipSymlinks
    ? await fs.promises.realpath(source)
    : source;
  await fs.promises.cp(copySource, destination, {
    recursive: true,
    dereference: !options.skipSymlinks,
    filter: async (src: string) => {
      try {
        const stats = options.skipSymlinks
          ? await fs.promises.lstat(src)
          : await fs.promises.stat(src);
        if (options.skipSymlinks && stats.isSymbolicLink()) return false;
        // Only copy regular files and directories
        // Skip sockets, FIFOs, block devices, and character devices
        return stats.isFile() || stats.isDirectory();
      } catch {
        // If we can't stat the file, skip it
        return false;
      }
    },
  });
}

export function getExtensionId(
  config: ExtensionConfig,
  installMetadata?: ExtensionInstallMetadata,
): string {
  let idValue = installMetadata?.source ?? config.name;
  // A marketplace repo can host several plugins; hashing only the repo URL
  // collapses them into one id and the second install trips the store's
  // id-ownership check (#7568). Suffix the plugin name so each plugin from
  // the same source gets its own id. Installs recorded under the old
  // repo-only id are re-keyed when the extension store initializes.
  if (installMetadata?.pluginName) {
    idValue += `:${installMetadata.pluginName}`;
  }
  return hashValue(idValue);
}

function parseSkillStates(value: unknown): Record<string, boolean> | undefined {
  if (value === undefined) return undefined;
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('"skillStates" must be an object of boolean values.');
  }
  return Object.fromEntries(
    Object.entries(value).map(([name, enabled]) => {
      const normalizedName = name.trim().toLowerCase();
      validateSkillName(normalizedName);
      if (typeof enabled !== 'boolean') {
        throw new Error('"skillStates" must be an object of boolean values.');
      }
      return [normalizedName, enabled];
    }),
  );
}

export function hashValue(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

export function validateName(name: string) {
  if (!/^[a-zA-Z0-9-_.]+$/.test(name)) {
    throw new Error(
      `Invalid extension name: "${name}". Only letters (a-z, A-Z), numbers (0-9), underscores (_), dots (.), and dashes (-) are allowed.`,
    );
  }
}
