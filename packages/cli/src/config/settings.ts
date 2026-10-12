/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { homedir } from 'node:os';
import process from 'node:process';
import {
  FatalConfigError,
  getErrorMessage,
  isValidAdvisorMaxUses,
  Storage,
  createDebugLogger,
  stripRuntimeSnapshotPrefix,
} from '@qwen-code/qwen-code-core';
import type {
  MCPServerConfig,
  McpServerScope,
} from '@qwen-code/qwen-code-core';
import stripJsonComments from 'strip-json-comments';
import {
  parseExecutionSandboxSettings,
  readOperatorSandboxSettings,
  selectOperatorExecutionSandbox,
  stripUtf8Bom,
} from './execution-sandbox-settings.js';
import { isWorkspaceTrusted } from './trustedFolders.js';
import {
  type Settings,
  type MemoryImportFormat,
  type SettingsSchema,
  type SettingDefinition,
  getSettingsSchema,
} from './settingsSchema.js';
import { resolveEnvVarsInObject } from '@qwen-code/qwen-code-core/envVarResolver';
import {
  setNestedPropertySafe,
  WORKSPACE_RESTRICTED_ROOT_SETTINGS,
  WORKSPACE_RESTRICTED_SETTINGS,
  WORKSPACE_TIGHTEN_ONLY_SETTINGS,
} from './settingsUtils.js';
import { customDeepMerge, type MergeStrategy } from '../utils/deepMerge.js';
import { updateSettingsFilePreservingFormat } from '../utils/jsonc-editor.js';
import { runMigrations, needsMigration } from './migration/index.js';
import {
  V1_TO_V2_MIGRATION_MAP,
  V2_CONTAINER_KEYS,
} from './migration/versions/v1-to-v2-shared.js';
import {
  getHomeEnvFallbackVars,
  loadEnvironment,
  preResolveHomeEnvOverrides,
} from './environment.js';
import { isOperatorOnlyEnvKey } from './shared-env-keys.js';
import {
  DEFAULT_DARK_THEME_NAME,
  DEFAULT_LIGHT_THEME_NAME,
} from './default-theme-names.js';
import {
  getGlobalQwenDirLite,
  getSystemDefaultsPath,
  getSystemSettingsPath,
  spawnedEnvironmentView,
} from './storage-paths-lite.js';
import { readConfigFile } from './read-config-file.js';

export {
  DEFAULT_EXCLUDED_ENV_VARS,
  getHomeEnvFallbackVars,
  loadEnvironment,
  preResolveHomeEnvOverrides,
  resetEnvironmentTrackingForTesting,
  resetHomeEnvBootstrapForTesting,
  SETTINGS_DIRECTORY_NAME,
} from './environment.js';
export { getSystemDefaultsPath, getSystemSettingsPath };

const debugLogger = createDebugLogger('SETTINGS');

function getMergeStrategyForPath(path: string[]): MergeStrategy | undefined {
  let current: SettingDefinition | undefined = undefined;
  let currentSchema: SettingsSchema | undefined = getSettingsSchema();

  for (const key of path) {
    if (!currentSchema || !currentSchema[key]) {
      return undefined;
    }
    current = currentSchema[key];
    currentSchema = current.properties;
  }

  return current?.mergeStrategy;
}

export type { Settings, MemoryImportFormat };

// Lazy getters: must NOT be top-level consts. `QWEN_HOME` may be resolved
// from `~/.env` or `~/.qwen/.env` by `preResolveHomeEnvOverrides()` in
// `loadSettings()`, which runs after this module is imported. A const
// captured here would freeze the pre-bootstrap value and split state across
// callers.
export function getUserSettingsPath(): string {
  return Storage.getGlobalSettingsPath();
}
export function getUserSettingsDir(): string {
  return path.dirname(getUserSettingsPath());
}

// Settings version to track migration state
export const SETTINGS_VERSION = 4;
export const SETTINGS_VERSION_KEY = '$version';

export type { DnsResolutionOrder } from './settingsSchema.js';

export enum SettingScope {
  User = 'User',
  Workspace = 'Workspace',
  System = 'System',
  SystemDefaults = 'SystemDefaults',
}

export interface AccessibilitySettings {
  enableLoadingPhrases?: boolean;
  screenReader?: boolean;
}

export interface SettingsError {
  message: string;
  path: string;
}

export interface SettingsFile {
  settings: Settings;
  originalSettings: Settings;
  path: string;
  rawJson?: string;
}

function getSettingsFileKeyWarnings(
  settings: Record<string, unknown>,
  settingsFilePath: string,
): string[] {
  const version = settings[SETTINGS_VERSION_KEY];
  if (typeof version !== 'number' || version < SETTINGS_VERSION) {
    return [];
  }

  const warnings: string[] = [];
  const ignoredLegacyKeys = new Set<string>();

  // Ignored legacy keys (V1 top-level keys that moved to a nested V2 path).
  for (const [oldKey, newPath] of Object.entries(V1_TO_V2_MIGRATION_MAP)) {
    if (oldKey === newPath) {
      continue;
    }
    if (!(oldKey in settings)) {
      continue;
    }

    const oldValue = settings[oldKey];

    // If this key is a V2 container (like 'model') and it's already an object,
    // it's likely already in V2 format. Don't warn.
    if (
      V2_CONTAINER_KEYS.has(oldKey) &&
      typeof oldValue === 'object' &&
      oldValue !== null &&
      !Array.isArray(oldValue)
    ) {
      continue;
    }

    ignoredLegacyKeys.add(oldKey);
    warnings.push(
      `Warning: Legacy setting '${oldKey}' will be ignored in ${settingsFilePath}. Please use '${newPath}' instead.`,
    );
  }

  // Unknown top-level keys — log silently to debug output.
  const schemaKeys = new Set(Object.keys(getSettingsSchema()));
  for (const key of Object.keys(settings)) {
    if (key === SETTINGS_VERSION_KEY) {
      continue;
    }
    if (ignoredLegacyKeys.has(key)) {
      continue;
    }
    if (schemaKeys.has(key)) {
      continue;
    }

    debugLogger.warn(
      `Unknown setting '${key}' will be ignored in ${settingsFilePath}.`,
    );
  }

  return warnings;
}

/**
 * Collects warnings for ignored legacy and unknown settings keys,
 * as well as migration warnings.
 *
 * For `$version: 2` settings files, we do not apply implicit migrations.
 * Instead, we surface actionable, de-duplicated warnings in the terminal UI.
 */
export function getSettingsWarnings(loadedSettings: LoadedSettings): string[] {
  const warningSet = new Set<string>();

  // Add migration warnings first
  for (const warning of loadedSettings.migrationWarnings) {
    warningSet.add(`Warning: ${warning}`);
  }

  for (const scope of [SettingScope.User, SettingScope.Workspace]) {
    const settingsFile = loadedSettings.forScope(scope);
    if (settingsFile.rawJson === undefined) {
      continue;
      // File not present / not loaded.
    }
    const settingsObject = settingsFile.originalSettings as unknown as Record<
      string,
      unknown
    >;

    for (const warning of getSettingsFileKeyWarnings(
      settingsObject,
      settingsFile.path,
    )) {
      warningSet.add(warning);
    }
  }

  // Settings restricted to trusted scopes are stripped from Workspace during
  // the merge; warn so the user knows their workspace setting has no effect.
  // Driven by WORKSPACE_RESTRICTED_SETTINGS so the warning cannot drift from
  // the strip that produces it.
  const workspaceFile = loadedSettings.forScope(SettingScope.Workspace);
  if (loadedSettings.isTrusted && workspaceFile.rawJson !== undefined) {
    for (const key of WORKSPACE_RESTRICTED_ROOT_SETTINGS) {
      if (workspaceFile.originalSettings[key] === undefined) continue;
      warningSet.add(
        `Warning: ${key} in workspace settings (${workspaceFile.path}) is ignored. This setting is only honored from User, System, or SystemDefaults scope settings.`,
      );
    }
    for (const { section, key } of WORKSPACE_RESTRICTED_SETTINGS) {
      const sectionValue = workspaceFile.originalSettings[section] as
        | Record<string, unknown>
        | undefined;
      if (sectionValue?.[key] === undefined) continue;
      warningSet.add(
        `Warning: ${section}.${key} in workspace settings (${workspaceFile.path}) is ignored. This setting is only honored from User, System, or SystemDefaults scope settings.`,
      );
    }
    for (const key of Object.keys(workspaceFile.originalSettings.env ?? {})) {
      if (!isOperatorOnlyEnvKey(key)) continue;
      warningSet.add(
        `Warning: env.${key} in workspace settings (${workspaceFile.path}) is ignored. This variable is only honored from User, System, or SystemDefaults scope settings.`,
      );
    }
    for (const [name, server] of Object.entries(
      workspaceFile.originalSettings.mcpServers ?? {},
    )) {
      if (server?.trust === undefined) continue;
      warningSet.add(
        `Warning: mcpServers.${name}.trust in workspace settings (${workspaceFile.path}) is ignored. Tool calls to workspace MCP servers always ask for confirmation.`,
      );
    }
    // Tighten-only keys: the same verdict the merge applied, so the
    // warning and the strip cannot disagree about a value. A value that
    // merely repeats what is already in force is dropped without a
    // warning — it lost nothing.
    for (const entry of WORKSPACE_TIGHTEN_ONLY_SETTINGS) {
      const verdict = tightenOnlyVerdict(entry, workspaceFile.settings, {
        system: loadedSettings.system.settings,
        systemDefaults: loadedSettings.systemDefaults.settings,
        user: loadedSettings.user.settings,
      });
      if (verdict === undefined || verdict.kept) continue;
      const key = `${entry.section}.${entry.key}`;
      if (verdict.reason === 'system-sets') {
        warningSet.add(
          `Warning: ${key} in workspace settings (${workspaceFile.path}) is ignored because System scope settings also set it.`,
        );
      } else if (verdict.reason === 'looser') {
        warningSet.add(
          `Warning: ${key} in workspace settings (${workspaceFile.path}) is ignored because it would loosen the ${verdict.against} value. A workspace may only make this setting stricter.`,
        );
      }
    }
  }
  // Core falls back to unlimited for an invalid value instead of refusing to
  // start; say so, since the user asked for a limit.
  const advisorMaxUses: unknown = loadedSettings.merged.advisorMaxUses;
  if (
    advisorMaxUses !== undefined &&
    advisorMaxUses !== null &&
    !isValidAdvisorMaxUses(advisorMaxUses)
  ) {
    warningSet.add(
      `Warning: advisorMaxUses must be a non-negative integer (0 means unlimited); ignoring ${JSON.stringify(advisorMaxUses)}. Advisor consultations are not limited in this session.`,
    );
  }
  return [...warningSet];
}

/**
 * Stamp every MCP server in a scope's settings with its provenance `scope`
 * BEFORE the merge, so the winning entry of the shallow `mcpServers` merge
 * carries the scope it actually came from. This drives both the approval gate
 * (`'workspace'` is gated) and precedence (`'workspace'`/`'system'` outrank a
 * `.mcp.json` server). User/default scopes are left unstamped (trusted, lower
 * precedence than `.mcp.json`). Returns a shallow copy — never mutates input.
 * See issue #4615.
 */
function tagMcpServerScope(
  settings: Settings,
  scope: McpServerScope,
): Settings {
  const servers = settings.mcpServers;
  if (!servers || Object.keys(servers).length === 0) {
    return settings;
  }
  const tagged: Record<string, MCPServerConfig> = {};
  for (const [name, config] of Object.entries(servers)) {
    tagged[name] = { ...config, scope };
  }
  return { ...settings, mcpServers: tagged };
}

type SettingKeyRef = {
  readonly section: keyof Settings;
  readonly key: string;
};

/**
 * Return `settings` without the given keys. Returns a shallow copy, and the
 * input unchanged when it carries none of them.
 */
function stripSettingKeys(
  settings: Settings,
  keys: Iterable<SettingKeyRef>,
): Settings {
  let stripped: Settings | undefined;
  for (const { section, key } of keys) {
    const source = (stripped ?? settings)[section] as
      | Record<string, unknown>
      | undefined;
    if (source?.[key] === undefined) continue;
    const { [key]: _removed, ...rest } = source;
    stripped = { ...(stripped ?? settings), [section]: rest } as Settings;
  }
  return stripped ?? settings;
}

/**
 * Strip the workspace-restricted settings before merging so a repository
 * cannot opt the user into those capabilities.
 */
function stripWorkspaceRestrictedSettings(settings: Settings): Settings {
  let stripped = settings;
  for (const key of WORKSPACE_RESTRICTED_ROOT_SETTINGS) {
    if (stripped[key] === undefined) continue;
    const { [key]: _restricted, ...rest } = stripped;
    stripped = rest as Settings;
  }
  if (stripped.env) {
    stripped = {
      ...stripped,
      env: Object.fromEntries(
        Object.entries(stripped.env).filter(
          ([key]) => !isOperatorOnlyEnvKey(key),
        ),
      ),
    };
  }
  if (stripped.mcpServers) {
    stripped = {
      ...stripped,
      mcpServers: Object.fromEntries(
        Object.entries(stripped.mcpServers).map(([name, server]) => {
          if (!server || typeof server !== 'object') return [name, server];
          const { trust: _trust, ...rest } = server;
          return [name, rest];
        }),
      ),
    };
  }
  return stripSettingKeys(stripped, WORKSPACE_RESTRICTED_SETTINGS);
}

type TightenOnlyEntry = (typeof WORKSPACE_TIGHTEN_ONLY_SETTINGS)[number];

type TightenOnlyVerdict =
  | { kept: true }
  | { kept: false; reason: 'system-sets' }
  | {
      kept: false;
      reason: 'looser';
      against: 'User' | 'SystemDefaults' | 'default';
    }
  | { kept: false; reason: 'same' };

/**
 * Decide one tighten-only key for a workspace, or `undefined` when the
 * workspace does not set it.
 *
 * System wins outright, as it does for every setting. Otherwise the
 * workspace value is compared against the value that would be in force
 * without it — User's when User sets the key, since User overrides
 * SystemDefaults in the merge, else SystemDefaults', else the feature's
 * default. Strictly stricter is kept; equal is dropped silently; looser is
 * dropped with a warning. Comparing against the stricter of User and
 * SystemDefaults instead would call a workspace value "equal" to a
 * SystemDefaults value that User already loosened, and drop the one
 * tightening that would have taken effect.
 */
function tightenOnlyVerdict(
  entry: TightenOnlyEntry,
  workspace: Settings,
  scopes: { system: Settings; systemDefaults: Settings; user: Settings },
): TightenOnlyVerdict | undefined {
  const read = (settings: Settings): unknown =>
    (settings[entry.section] as Record<string, unknown> | undefined)?.[
      entry.key
    ];
  const candidate = read(workspace);
  if (candidate === undefined) return undefined;
  if (read(scopes.system) !== undefined) {
    return { kept: false, reason: 'system-sets' };
  }
  const userValue = read(scopes.user);
  const systemDefaultsValue = read(scopes.systemDefaults);
  const against: 'User' | 'SystemDefaults' | 'default' =
    userValue !== undefined
      ? 'User'
      : systemDefaultsValue !== undefined
        ? 'SystemDefaults'
        : 'default';
  const baseline = entry.strictness(
    userValue !== undefined ? userValue : systemDefaultsValue,
  );
  const rank = entry.strictness(candidate);
  if (rank > baseline) return { kept: true };
  if (rank === baseline) return { kept: false, reason: 'same' };
  return { kept: false, reason: 'looser', against };
}

/**
 * Drop the workspace's tighten-only values that would not make the
 * setting stricter than the operator scopes already have it.
 */
function stripWorkspaceLoosenings(
  workspace: Settings,
  scopes: { system: Settings; systemDefaults: Settings; user: Settings },
): Settings {
  return stripSettingKeys(
    workspace,
    WORKSPACE_TIGHTEN_ONLY_SETTINGS.filter((entry) => {
      const verdict = tightenOnlyVerdict(entry, workspace, scopes);
      return verdict !== undefined && !verdict.kept;
    }),
  );
}

function mergeSettings(
  system: Settings,
  systemDefaults: Settings,
  user: Settings,
  workspace: Settings,
  isTrusted: boolean,
): Settings {
  const safeWorkspace = isTrusted
    ? tagMcpServerScope(
        stripWorkspaceLoosenings(stripWorkspaceRestrictedSettings(workspace), {
          system,
          systemDefaults,
          user,
        }),
        'workspace',
      )
    : ({} as Settings);

  // Settings are merged with the following precedence (last one wins for
  // single values):
  // 1. System Defaults
  // 2. User Settings
  // 3. Workspace Settings
  // 4. System Settings (as overrides)
  const merged = customDeepMerge(
    getMergeStrategyForPath,
    {}, // Start with an empty object
    systemDefaults,
    user,
    safeWorkspace,
    tagMcpServerScope(system, 'system'),
  ) as Settings;
  const executionSandbox = selectOperatorExecutionSandbox(
    systemDefaults,
    user,
    system,
  );
  const legacySandbox = [systemDefaults, user, system].reduce<
    NonNullable<Settings['tools']>['sandbox']
  >((current, scope) => scope.tools?.sandbox ?? current, undefined);
  // Restore the complete operator object even if a project replaced `tools`
  // with null, a scalar, or an array during the ordinary settings merge.
  if (executionSandbox) {
    const tools = merged.tools;
    merged.tools = {
      ...(tools && typeof tools === 'object' && !Array.isArray(tools)
        ? tools
        : {}),
      executionSandbox,
    };
    if (legacySandbox === undefined) {
      delete merged.tools.sandbox;
    } else {
      merged.tools.sandbox = legacySandbox;
    }
  } else if (merged.tools && typeof merged.tools === 'object') {
    delete merged.tools.executionSandbox;
  }
  return merged;
}

export class LoadedSettings {
  constructor(
    system: SettingsFile,
    systemDefaults: SettingsFile,
    user: SettingsFile,
    workspace: SettingsFile,
    isTrusted: boolean,
    migratedInMemoryScopes: Set<SettingScope>,
    migrationWarnings: string[] = [],
    workspaceSettingsActive: boolean = true,
  ) {
    this.system = system;
    this.systemDefaults = systemDefaults;
    this.user = user;
    this.workspace = workspace;
    this.isTrusted = isTrusted;
    this.migratedInMemoryScopes = migratedInMemoryScopes;
    this.migrationWarnings = migrationWarnings;
    this.workspaceSettingsActive = workspaceSettingsActive;
    this._merged = this.computeMergedSettings();
  }

  readonly system: SettingsFile;
  readonly systemDefaults: SettingsFile;
  readonly user: SettingsFile;
  readonly workspace: SettingsFile;
  readonly isTrusted: boolean;
  readonly migratedInMemoryScopes: Set<SettingScope>;
  readonly migrationWarnings: string[];
  readonly workspaceSettingsActive: boolean;

  private _merged: Settings;

  get merged(): Settings {
    return this._merged;
  }

  private computeMergedSettings(): Settings {
    return mergeSettings(
      this.system.settings,
      this.systemDefaults.settings,
      this.user.settings,
      this.workspace.settings,
      this.isTrusted,
    );
  }

  forScope(scope: SettingScope): SettingsFile {
    switch (scope) {
      case SettingScope.User:
        return this.user;
      case SettingScope.Workspace:
        return this.workspace;
      case SettingScope.System:
        return this.system;
      case SettingScope.SystemDefaults:
        return this.systemDefaults;
      default:
        throw new Error(`Invalid scope: ${scope}`);
    }
  }

  setValue(
    scope: SettingScope,
    key: string,
    value: unknown,
    assertCanCommit?: () => void,
    opts: { throwOnWriteFailure?: boolean } = {},
  ): void {
    // Never persist a runtime snapshot ID to model.name (it re-wraps on restart).
    if (key === 'model.name' && typeof value === 'string') {
      value = stripRuntimeSnapshotPrefix(value);
    }
    assertCanCommit?.();
    const settingsFile = this.forScope(scope);
    const replacePath = key === 'mcpServers' ? key.split('.') : [];
    if (opts.throwOnWriteFailure) {
      saveSettings(
        settingsFile,
        createSettingsUpdate(key, value),
        replacePath,
        {
          throwOnWriteFailure: true,
        },
      );
    }
    setNestedPropertySafe(settingsFile.settings, key, value);
    setNestedPropertySafe(settingsFile.originalSettings, key, value);
    this._merged = this.computeMergedSettings();
    if (!opts.throwOnWriteFailure) {
      saveSettings(settingsFile, createSettingsUpdate(key, value), replacePath);
    }
  }

  setValues(
    writes: ReadonlyArray<{
      scope: SettingScope;
      key: string;
      value: unknown;
    }>,
    onScopeCommitted?: (scope: SettingScope) => void,
    assertCanCommit?: () => void,
  ): void {
    const scopes = new Set<SettingScope>();
    for (const write of writes) {
      const value =
        write.key === 'model.name' && typeof write.value === 'string'
          ? stripRuntimeSnapshotPrefix(write.value)
          : write.value;
      const settingsFile = this.forScope(write.scope);
      setNestedPropertySafe(settingsFile.settings, write.key, value);
      setNestedPropertySafe(settingsFile.originalSettings, write.key, value);
      scopes.add(write.scope);
    }
    this._merged = this.computeMergedSettings();
    const scopeList = Array.from(scopes);
    for (let i = 0; i < scopeList.length; i++) {
      const scope = scopeList[i]!;
      try {
        assertCanCommit?.();
        saveSettings(this.forScope(scope), undefined, undefined, {
          throwOnWriteFailure: true,
        });
      } catch (err) {
        for (const uncommittedScope of scopeList.slice(i)) {
          this.reloadScopeFromDisk(uncommittedScope);
        }
        throw err;
      }
      onScopeCommitted?.(scope);
    }
  }

  recomputeMerged(): void {
    this._merged = this.computeMergedSettings();
  }

  reloadScopeFromDisk(scope: SettingScope): boolean {
    const file = this.forScope(scope);
    if (scope === SettingScope.Workspace && !this.workspaceSettingsActive) {
      file.settings = {};
      file.originalSettings = {};
      file.rawJson = undefined;
      this._merged = this.computeMergedSettings();
      return true;
    }
    let reloaded = false;
    try {
      if (!fs.existsSync(file.path)) {
        file.settings = {};
        file.originalSettings = {};
        file.rawJson = undefined;
        this._merged = this.computeMergedSettings();
        return true;
      }

      const content = fs.readFileSync(file.path, 'utf-8');
      const parsed = JSON.parse(stripJsonComments(stripUtf8Bom(content)));
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        if (scope !== SettingScope.Workspace) {
          parseExecutionSandboxSettings(parsed.tools?.executionSandbox);
        }
        const resolved = resolveEnvVarsInObject(
          parsed as Settings,
          getHomeEnvFallbackVars((message) => debugLogger.warn(message)),
        );
        file.settings = resolved;
        file.originalSettings = structuredClone(parsed) as Settings;
        file.rawJson = content;
        reloaded = true;
      } else {
        debugLogger.warn(
          `reloadScopeFromDisk(${scope}): settings file is not a JSON object, keeping previous settings`,
        );
      }
    } catch (err) {
      debugLogger.warn(
        `reloadScopeFromDisk(${scope}): ${getErrorMessage(err)}`,
      );
    }
    this._merged = this.computeMergedSettings();
    return reloaded;
  }

  reloadScopesFromDiskAtomically(scopes: readonly SettingScope[]): boolean {
    const snapshots = scopes.map((scope) => {
      const file = this.forScope(scope);
      return {
        file,
        settings: structuredClone(file.settings),
        originalSettings: structuredClone(file.originalSettings),
        rawJson: file.rawJson,
      };
    });
    const reloaded = scopes.map((scope) => this.reloadScopeFromDisk(scope));
    if (reloaded.every(Boolean)) return true;

    for (const snapshot of snapshots) {
      snapshot.file.settings = snapshot.settings;
      snapshot.file.originalSettings = snapshot.originalSettings;
      snapshot.file.rawJson = snapshot.rawJson;
    }
    this._merged = this.computeMergedSettings();
    return false;
  }

  /**
   * Get system-scope hooks: the SystemDefaults and System settings files,
   * merged with the same strategy as the full merge (each `hooks.<Event>` list
   * is concatenated), SystemDefaults first. Administrator configuration is not
   * gated by folder trust, exactly like user hooks. Returns undefined, not an
   * empty object, when neither file configures hooks, so callers can tell a
   * scope with no data apart from one with data.
   */
  getSystemHooks(): Record<string, unknown> | undefined {
    const merged = customDeepMerge(
      getMergeStrategyForPath,
      {},
      { hooks: this.systemDefaults.settings.hooks ?? {} },
      { hooks: this.system.settings.hooks ?? {} },
    ) as Settings;
    const hooks = merged.hooks;
    return hooks && Object.keys(hooks).length > 0 ? hooks : undefined;
  }

  /**
   * Get user-level hooks from user settings (not merged with workspace).
   * These hooks should always be loaded regardless of folder trust.
   */
  getUserHooks(): Record<string, unknown> | undefined {
    return this.user.settings.hooks;
  }
}

/**
 * Creates a minimal LoadedSettings instance with empty settings.
 * Used in stream-json mode where settings are ignored.
 */
export function createMinimalSettings(): LoadedSettings {
  const operator = readOperatorSandboxSettings();
  const executionSandbox = parseExecutionSandboxSettings(
    operator.tools?.executionSandbox,
  );
  const legacy = operator.tools?.sandbox;
  const operatorSettings: Settings = {
    ...(executionSandbox || legacy === 'bwrap'
      ? {
          tools: {
            executionSandbox,
            sandbox: legacy as boolean | string | undefined,
          },
        }
      : {}),
  };
  const emptySettingsFile: SettingsFile = {
    path: '',
    settings: {},
    originalSettings: {},
    rawJson: '{}',
  };
  return new LoadedSettings(
    {
      ...emptySettingsFile,
      settings: operatorSettings,
      originalSettings: operatorSettings,
    },
    emptySettingsFile,
    emptySettingsFile,
    emptySettingsFile,
    false,
    new Set(),
    [],
  );
}

/**
 * Surfaces a one-shot warning when QWEN_HOME has been redirected but the
 * user hasn't migrated their existing global state. Auto-copying OAuth
 * tokens / settings / memory is intentionally skipped, but silently starting
 * fresh is a footgun. Returns null when there's nothing to warn about.
 */
function detectQwenHomeRedirectWithoutMigration(
  activeUserSettingsPath: string,
): string | null {
  if (!process.env['QWEN_HOME']) {
    return null;
  }
  // Compute the legacy path by briefly unsetting QWEN_HOME so Storage uses
  // its homedir-based default — same homedir resolution as the rest of the
  // storage layer. try/finally restores the env on any throw.
  const activeQwenDir = Storage.getGlobalQwenDir();
  const savedQwenHome = process.env['QWEN_HOME'];
  delete process.env['QWEN_HOME'];
  let legacyQwenDir: string;
  try {
    legacyQwenDir = Storage.getGlobalQwenDir();
  } finally {
    process.env['QWEN_HOME'] = savedQwenHome;
  }
  if (path.resolve(activeQwenDir) === path.resolve(legacyQwenDir)) {
    return null;
  }
  if (fs.existsSync(activeUserSettingsPath)) {
    return null;
  }
  const legacyUserSettings = path.join(legacyQwenDir, 'settings.json');
  if (!fs.existsSync(legacyUserSettings)) {
    return null;
  }
  return (
    `QWEN_HOME points to "${activeQwenDir}" but no settings.json was found there. ` +
    `Existing config remains at "${legacyQwenDir}" — OAuth tokens, settings, memory, ` +
    `extensions, and skills are not auto-migrated. Copy them manually if you want them ` +
    `to apply at the new location.`
  );
}

/**
 * Load and merge settings from all scopes:
 * System Defaults → User (~/.qwen/settings.json) → Workspace → System.
 */
export interface LoadSettingsOptions {
  skipLoadEnvironment?: boolean;
  skipWorkspaceSettings?: boolean;
  workspaceTrusted?: boolean;
}

export function loadSettings(
  workspaceDir: string = process.cwd(),
  opts: LoadSettingsOptions = {},
): LoadedSettings {
  return readSettingsLayers(workspaceDir, opts);
}

/**
 * The real path of the home directory, as settings loading resolves it to tell
 * whether the workspace is the home directory. Throws when it cannot be
 * resolved, for example because it does not exist.
 */
export function resolveHomeDirectory(home: string = homedir()): string {
  return fs.realpathSync(path.resolve(home));
}

function readSettingsLayers(
  workspaceDir: string,
  opts: LoadSettingsOptions,
  snapshotOf?: { readonly environment: Readonly<NodeJS.ProcessEnv> },
): LoadedSettings {
  // A snapshot reads through the given environment and writes nothing. Every
  // step below that writes a file or `process.env` must be skipped when
  // `snapshot` is set; the snapshot tests compare the whole tree to hold it.
  const snapshot = snapshotOf !== undefined;
  const snapshotEnvironment = snapshotOf?.environment;
  // Apply any QWEN_HOME / QWEN_RUNTIME_DIR set in user-level `.env` files
  // BEFORE any code reads a path derived from them. After this call, the
  // lazy `getUserSettingsPath()` / `Storage.getGlobalQwenDir()` getters
  // return the post-bootstrap value.
  if (!snapshot) preResolveHomeEnvOverrides();
  // A malformed operator file cannot silently reset a confinement policy.
  // Validate literals before environment substitution.
  const operatorSandbox = snapshot
    ? undefined
    : readOperatorSandboxSettings().tools?.executionSandbox;
  const userSettingsPath = snapshot
    ? path.join(getGlobalQwenDirLite(snapshotEnvironment), 'settings.json')
    : getUserSettingsPath();
  const qwenHomeRedirectWarning = snapshot
    ? null
    : detectQwenHomeRedirectWithoutMigration(userSettingsPath);

  let systemSettings: Settings = {};
  let systemDefaultSettings: Settings = {};
  let userSettings: Settings = {};
  let workspaceSettings: Settings = {};
  const settingsErrors: SettingsError[] = [];
  const systemSettingsPath = getSystemSettingsPath(snapshotEnvironment);
  const systemDefaultsPath = getSystemDefaultsPath(snapshotEnvironment);
  const migratedInMemoryScopes = new Set<SettingScope>();

  // Resolve paths to their canonical representation to handle symlinks
  const resolvedWorkspaceDir = path.resolve(workspaceDir);

  let realWorkspaceDir = resolvedWorkspaceDir;
  try {
    // fs.realpathSync gets the "true" path, resolving any symlinks
    realWorkspaceDir = fs.realpathSync(resolvedWorkspaceDir);
  } catch (_e) {
    // This is okay. The path might not exist yet, and that's a valid state.
  }

  // We expect homedir to always exist and be resolvable.
  const realHomeDir = resolveHomeDirectory();

  const workspaceSettingsPath = new Storage(
    workspaceDir,
  ).getWorkspaceSettingsPath();

  const loadAndMigrate = (
    filePath: string,
    scope: SettingScope,
  ): {
    settings: Settings;
    rawJson?: string;
    migrationWarnings?: string[];
  } => {
    try {
      const content = snapshot
        ? readConfigFile(filePath)
        : fs.existsSync(filePath)
          ? fs.readFileSync(filePath, 'utf-8')
          : undefined;
      if (content !== undefined) {
        let rawSettings: unknown;
        try {
          rawSettings = JSON.parse(stripJsonComments(stripUtf8Bom(content)));
        } catch (parseError: unknown) {
          if (snapshot || scope !== SettingScope.Workspace || operatorSandbox)
            throw parseError;
          // Loading never writes: a repository can ship this file (and
          // links next to it), so it is reported and ignored in memory only.
          return {
            settings: {},
            migrationWarnings: [
              `Ignoring workspace settings file ${filePath}: invalid JSON (${getErrorMessage(parseError)}).`,
            ],
          };
        }

        if (
          typeof rawSettings !== 'object' ||
          rawSettings === null ||
          Array.isArray(rawSettings)
        ) {
          settingsErrors.push({
            message: 'Settings file is not a valid JSON object.',
            path: filePath,
          });
          return { settings: {} };
        }

        if (scope !== SettingScope.Workspace) {
          parseExecutionSandboxSettings(
            (rawSettings as Settings).tools?.executionSandbox,
          );
        }
        let settingsObject = rawSettings as Record<string, unknown>;
        const hasVersionKey = SETTINGS_VERSION_KEY in settingsObject;
        const versionValue = settingsObject[SETTINGS_VERSION_KEY];
        const hasInvalidVersion =
          hasVersionKey && typeof versionValue !== 'number';
        const hasLegacyNumericVersion =
          typeof versionValue === 'number' && versionValue < SETTINGS_VERSION;
        if (
          snapshot &&
          hasVersionKey &&
          !(Number.isInteger(versionValue) && (versionValue as number) >= 1)
        ) {
          throw new Error(
            `Settings file has an unsupported ${SETTINGS_VERSION_KEY}.`,
          );
        }
        let migrationWarnings: string[] | undefined;

        // Migrations apply in memory. Only the user's own settings file is
        // rewritten on disk; workspace and system files never are.
        const persistSettingsObject = (warningPrefix: string) => {
          if (snapshot || scope !== SettingScope.User) return;
          try {
            // Use sync mode to remove deprecated keys (zombie key prevention)
            // while preserving comments and formatting from the original file.
            // updateSettingsFilePreservingFormat handles atomicity internally
            // via temp-file + rename writes.
            const written = updateSettingsFilePreservingFormat(
              filePath,
              settingsObject,
              true,
            );
            if (!written) {
              debugLogger.error(
                `${warningPrefix}: updateSettingsFilePreservingFormat returned false for ${filePath}`,
              );
            }
          } catch (e) {
            debugLogger.error(`${warningPrefix}: ${getErrorMessage(e)}`);
          }
        };

        if (needsMigration(settingsObject)) {
          const migrationResult = runMigrations(settingsObject, scope);
          if (migrationResult.executedMigrations.length > 0) {
            settingsObject = migrationResult.settings as Record<
              string,
              unknown
            >;
            migrationWarnings = migrationResult.warnings;
            persistSettingsObject('Error migrating settings file on disk');
          } else if (hasLegacyNumericVersion || hasInvalidVersion) {
            // Migration was deemed needed but nothing executed. Normalize version metadata
            // to avoid repeated no-op checks on startup.
            settingsObject[SETTINGS_VERSION_KEY] = SETTINGS_VERSION;
            debugLogger.warn(
              `Settings version metadata in ${filePath} could not be migrated by any registered migration. Normalizing ${SETTINGS_VERSION_KEY} to ${SETTINGS_VERSION}.`,
            );
            persistSettingsObject('Error normalizing settings version on disk');
          }
        } else if (
          !hasVersionKey ||
          hasInvalidVersion ||
          hasLegacyNumericVersion
        ) {
          // No migration needed/executable, but version metadata is missing or invalid.
          // Normalize it to current version to avoid repeated startup work.
          settingsObject[SETTINGS_VERSION_KEY] = SETTINGS_VERSION;
          persistSettingsObject('Error normalizing settings version on disk');
        }
        if (
          snapshot &&
          settingsObject[SETTINGS_VERSION_KEY] !== SETTINGS_VERSION
        ) {
          throw new Error(
            `Settings file has an unsupported ${SETTINGS_VERSION_KEY}.`,
          );
        }

        return {
          settings: settingsObject as Settings,
          rawJson: content,
          migrationWarnings: migrationWarnings ?? [],
        };
      }
    } catch (error: unknown) {
      settingsErrors.push({
        message: getErrorMessage(error),
        path: filePath,
      });
    }
    return { settings: {} };
  };

  const systemResult = loadAndMigrate(systemSettingsPath, SettingScope.System);
  const systemDefaultsResult = loadAndMigrate(
    systemDefaultsPath,
    SettingScope.SystemDefaults,
  );
  const userResult = loadAndMigrate(userSettingsPath, SettingScope.User);

  let workspaceResult: {
    settings: Settings;
    rawJson?: string;
    migrationWarnings?: string[];
  } = {
    settings: {} as Settings,
    rawJson: undefined,
  };
  const workspaceSettingsActive =
    !opts.skipWorkspaceSettings && realWorkspaceDir !== realHomeDir;
  if (workspaceSettingsActive) {
    workspaceResult = loadAndMigrate(
      workspaceSettingsPath,
      SettingScope.Workspace,
    );
  }

  const systemOriginalSettings = structuredClone(systemResult.settings);
  const systemDefaultsOriginalSettings = structuredClone(
    systemDefaultsResult.settings,
  );
  const userOriginalSettings = structuredClone(userResult.settings);
  const workspaceOriginalSettings = structuredClone(workspaceResult.settings);

  // Resolve ${VAR} placeholders in settings using home .env as fallback.
  // getHomeEnvFallbackVars() excludes keys already in process.env, so
  // effective precedence is: process.env > home .env > unresolved placeholder.
  // The resolver checks customEnv before process.env, but since customEnv
  // never contains a process.env key, process.env always wins.
  // A snapshot environment is the environment of the session hosts it
  // describes and carries the user-level `.env` values its runtime applied, so
  // it is the only source, read as a host spawned with it sees it.
  const homeEnvFallback = snapshotOf
    ? spawnedEnvironmentView(snapshotOf.environment)
    : getHomeEnvFallbackVars((message) => debugLogger.warn(message));
  const resolveOptions = { processEnvFallback: !snapshot };
  systemSettings = resolveEnvVarsInObject(
    systemResult.settings,
    homeEnvFallback,
    resolveOptions,
  );
  systemDefaultSettings = resolveEnvVarsInObject(
    systemDefaultsResult.settings,
    homeEnvFallback,
    resolveOptions,
  );
  userSettings = resolveEnvVarsInObject(
    userResult.settings,
    homeEnvFallback,
    resolveOptions,
  );
  workspaceSettings = resolveEnvVarsInObject(
    workspaceResult.settings,
    homeEnvFallback,
    resolveOptions,
  );

  // Support legacy theme names
  if (userSettings.ui?.theme === 'VS') {
    userSettings.ui.theme = DEFAULT_LIGHT_THEME_NAME;
  } else if (userSettings.ui?.theme === 'VS2015') {
    userSettings.ui.theme = DEFAULT_DARK_THEME_NAME;
  }
  if (workspaceSettings.ui?.theme === 'VS') {
    workspaceSettings.ui.theme = DEFAULT_LIGHT_THEME_NAME;
  } else if (workspaceSettings.ui?.theme === 'VS2015') {
    workspaceSettings.ui.theme = DEFAULT_DARK_THEME_NAME;
  }

  // For the initial trust check we can only use the scopes that do not need
  // the decision being computed. `system-defaults` participates so an operator
  // enabling `security.folderTrust` there reaches the same "trust enabled"
  // answer the final merged settings (and `loadCliConfig`'s `trustedFolder`)
  // use; the workspace scope stays out, since a workspace file that only a
  // trusted workspace may contribute cannot decide its own trust.
  const initialTrustCheckSettings = customDeepMerge(
    getMergeStrategyForPath,
    {},
    systemDefaultSettings,
    userSettings,
    systemSettings,
  );
  const isTrusted =
    opts.workspaceTrusted ??
    isWorkspaceTrusted(
      initialTrustCheckSettings as Settings,
      undefined,
      realWorkspaceDir,
    ).isTrusted ??
    false;

  // Create a temporary merged settings object to pass to loadEnvironment.
  const tempMergedSettings = mergeSettings(
    systemSettings,
    systemDefaultSettings,
    userSettings,
    workspaceSettings,
    isTrusted,
  );

  // loadEnvironment depends on settings so we have to create a temp version of
  // the settings to avoid a cycle
  if (!opts.skipLoadEnvironment) {
    loadEnvironment(tempMergedSettings, workspaceDir);
  }

  // Create LoadedSettings first

  if (settingsErrors.length > 0) {
    const errorMessages = settingsErrors.map(
      (error) => `Error in ${error.path}: ${error.message}`,
    );
    throw new FatalConfigError(
      `${errorMessages.join('\n')}\nPlease fix the configuration file(s) and try again.`,
    );
  }

  // Collect all migration warnings from all scopes
  const allMigrationWarnings: string[] = [
    ...(qwenHomeRedirectWarning ? [qwenHomeRedirectWarning] : []),
    ...(systemResult.migrationWarnings ?? []),
    ...(systemDefaultsResult.migrationWarnings ?? []),
    ...(userResult.migrationWarnings ?? []),
    ...(workspaceResult.migrationWarnings ?? []),
  ];

  return new LoadedSettings(
    {
      path: systemSettingsPath,
      settings: systemSettings,
      originalSettings: systemOriginalSettings,
      rawJson: systemResult.rawJson,
    },
    {
      path: systemDefaultsPath,
      settings: systemDefaultSettings,
      originalSettings: systemDefaultsOriginalSettings,
      rawJson: systemDefaultsResult.rawJson,
    },
    {
      path: userSettingsPath,
      settings: userSettings,
      originalSettings: userOriginalSettings,
      rawJson: userResult.rawJson,
    },
    {
      path: workspaceSettingsPath,
      settings: workspaceSettings,
      originalSettings: workspaceOriginalSettings,
      rawJson: workspaceResult.rawJson,
    },
    isTrusted,
    migratedInMemoryScopes,
    allMigrationWarnings,
    workspaceSettingsActive,
  );
}

function createSettingsUpdate(
  key: string,
  value: unknown,
): Record<string, unknown> {
  const root: Record<string, unknown> = {};
  setNestedPropertySafe(root, key, value);
  return root;
}

export function saveSettings(
  settingsFile: SettingsFile,
  updates: Record<string, unknown> = settingsFile.originalSettings as Record<
    string,
    unknown
  >,
  replacePath: readonly string[] = [],
  opts: { throwOnWriteFailure?: boolean } = {},
): void {
  try {
    // Ensure the directory exists
    const dirPath = path.dirname(settingsFile.path);
    if (!fs.existsSync(dirPath)) {
      fs.mkdirSync(dirPath, { recursive: true, mode: 0o700 });
    }

    // Use the format-preserving update function
    const written = updateSettingsFilePreservingFormat(
      settingsFile.path,
      updates,
      false,
      replacePath,
    );
    if (!written) {
      const message = `saveSettings: updateSettingsFilePreservingFormat returned false for ${settingsFile.path}`;
      if (opts.throwOnWriteFailure) {
        throw new Error(message);
      }
      debugLogger.error(message);
    }
  } catch (error) {
    debugLogger.error('Error saving user settings file.');
    debugLogger.error(error instanceof Error ? error.message : String(error));
    throw error;
  }
}
