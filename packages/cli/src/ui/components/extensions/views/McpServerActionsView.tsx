/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { useState, useCallback, useEffect } from 'react';
import { Text } from 'ink';
import { theme } from '../../../semantic-colors.js';
import { t } from '../../../../i18n/index.js';
import {
  type Config,
  getMCPServerStatus,
  removeMCPServerStatus,
  addMCPStatusChangeListener,
  removeMCPStatusChangeListener,
  type MCPServerStatus,
  DiscoveredMCPTool,
  createDebugLogger,
  matchesAnyServerPattern,
} from '@qwen-code/qwen-code-core';
import { loadSettings, SettingScope } from '../../../../config/settings.js';
import { getErrorMessage } from '../../../../utils/errors.js';
import { ServerDetailStep } from '../../mcp/steps/ServerDetailStep.js';
import { ToolListStep } from '../../mcp/steps/ToolListStep.js';
import { ToolDetailStep } from '../../mcp/steps/ToolDetailStep.js';
import { ResourceListStep } from '../../mcp/steps/ResourceListStep.js';
import { ResourceDetailStep } from '../../mcp/steps/ResourceDetailStep.js';
import { isToolValid, getToolInvalidReasons } from '../../mcp/utils.js';
import type {
  MCPServerDisplayInfo,
  MCPToolDisplayInfo,
  MCPResourceDisplayInfo,
} from '../../mcp/types.js';
import type { StatusMessage } from '../ExtensionsManagerDialog.js';

const debugLogger = createDebugLogger('EXT_MCP_DETAIL');

type SubView =
  | 'detail'
  | 'tools'
  | 'tool-detail'
  | 'resources'
  | 'resource-detail';

interface McpServerActionsViewProps {
  config: Config;
  /** Name of the installed MCP server to manage. */
  serverName: string;
  /** Whether this view should respond to keyboard input. */
  isActive: boolean;
  onStatus: (status: StatusMessage | null) => void;
  /** Ask the parent list to reload (state changed). */
  onReload: () => void;
  /** Leave the detail and return to the list. */
  onExit: () => void;
}

/**
 * MCP server detail + actions inside the extensions manager, reusing the
 * `/mcp` dialog's ServerDetailStep / ToolListStep so the behaviour (live
 * status, view tools, enable/disable) stays identical to `/mcp`.
 */
export const McpServerActionsView = ({
  config,
  serverName,
  isActive,
  onStatus,
  onReload,
  onExit,
}: McpServerActionsViewProps) => {
  const [sub, setSub] = useState<SubView>('detail');
  const [server, setServer] = useState<MCPServerDisplayInfo | null>(null);
  const [selectedTool, setSelectedTool] = useState<MCPToolDisplayInfo | null>(
    null,
  );
  const [selectedResource, setSelectedResource] =
    useState<MCPResourceDisplayInfo | null>(null);
  const [loading, setLoading] = useState(true);

  const buildServer =
    useCallback(async (): Promise<MCPServerDisplayInfo | null> => {
      const mcpServers = config.getMcpServers() || {};
      const serverConfig = mcpServers[serverName];
      if (!serverConfig) return null;

      const settings = loadSettings();
      const userSettings = settings.forScope(SettingScope.User).settings;
      const workspaceSettings = settings.forScope(
        SettingScope.Workspace,
      ).settings;

      const status = getMCPServerStatus(serverName);
      const toolRegistry = config.getToolRegistry();
      const serverTools = (toolRegistry?.getAllTools() || []).filter(
        (tool): tool is DiscoveredMCPTool =>
          tool instanceof DiscoveredMCPTool && tool.serverName === serverName,
      );
      const promptRegistry = config.getPromptRegistry();
      const serverPrompts = (promptRegistry?.getAllPrompts() || []).filter(
        (p) => 'serverName' in p && p.serverName === serverName,
      );
      const serverResources =
        config.getResourceRegistry()?.getResourcesByServer(serverName) || [];

      let source: 'user' | 'project' | 'extension' = 'user';
      if (serverConfig.extensionName) {
        source = 'extension';
      } else if (workspaceSettings.mcpServers?.[serverName]) {
        source = 'project';
      } else if (userSettings.mcpServers?.[serverName]) {
        source = 'user';
      }

      return {
        name: serverName,
        status,
        source,
        config: serverConfig,
        toolCount: serverTools.length,
        invalidToolCount: serverTools.filter((x) => !x.name || !x.description)
          .length,
        promptCount: serverPrompts.length,
        resourceCount: serverResources.length,
        isDisabled: config.isMcpServerDisabled(serverName),
      };
    }, [config, serverName]);

  // Re-stamp status synchronously right before setState: a status change
  // landing during buildServer's awaits would fire the listener against the
  // old state and then be overwritten by the stale snapshot.
  const freshen = useCallback(
    (info: MCPServerDisplayInfo | null): MCPServerDisplayInfo | null =>
      info ? { ...info, status: getMCPServerStatus(info.name) } : info,
    [],
  );

  const reload = useCallback(async () => {
    setLoading(true);
    try {
      setServer(freshen(await buildServer()));
    } catch (error) {
      debugLogger.error('Failed to load MCP server:', error);
    } finally {
      setLoading(false);
    }
    onReload();
  }, [buildServer, freshen, onReload]);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const info = await buildServer();
      if (!cancelled) {
        setServer(freshen(info));
        setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [buildServer, freshen]);

  // Live-update the connection status shown in the detail view.
  useEffect(() => {
    const listener = (name: string, status?: MCPServerStatus) => {
      if (name !== serverName || status === undefined) return;
      setServer((prev) => (prev ? { ...prev, status } : prev));
    };
    addMCPStatusChangeListener(listener);
    return () => removeMCPStatusChangeListener(listener);
  }, [serverName]);

  const getServerTools = useCallback((): MCPToolDisplayInfo[] => {
    const toolRegistry = config.getToolRegistry();
    if (!toolRegistry) return [];
    const out: MCPToolDisplayInfo[] = [];
    for (const tool of toolRegistry.getAllTools()) {
      if (
        !(tool instanceof DiscoveredMCPTool) ||
        tool.serverName !== serverName
      )
        continue;
      const valid = isToolValid(tool.name, tool.description);
      out.push({
        name: tool.name || t('(unnamed)'),
        description: tool.description,
        serverName: tool.serverName,
        schema: tool.parameterSchema as object | undefined,
        annotations: tool.annotations,
        isValid: valid,
        invalidReason: valid
          ? undefined
          : getToolInvalidReasons(tool.name, tool.description).join(', '),
      });
    }
    return out;
  }, [config, serverName]);

  const getServerResources = useCallback((): MCPResourceDisplayInfo[] => {
    const resourceRegistry = config.getResourceRegistry();
    if (!resourceRegistry) return [];
    return resourceRegistry
      .getResourcesByServer(serverName)
      .map((resource) => ({
        uri: resource.uri,
        name: resource.name,
        title: resource.title,
        description: resource.description,
        mimeType: resource.mimeType,
        size: resource.size,
        serverName: resource.serverName,
      }));
  }, [config, serverName]);

  const handleReconnect = useCallback(async () => {
    try {
      await config.getToolRegistry()?.discoverToolsForServer(serverName);
      await reload();
    } catch (error) {
      onStatus({ type: 'error', text: getErrorMessage(error) });
    }
  }, [config, serverName, reload, onStatus]);

  const handleToggleDisable = useCallback(async () => {
    if (!server) return;
    const toolRegistry = config.getToolRegistry();
    try {
      if (server.isDisabled) {
        // Enable: clear the extension-scoped disable flag (if any), drop from
        // both exclusion lists + runtime, then rediscover.
        const extensionName = server.config.extensionName;
        if (extensionName) {
          config
            .getExtensionManager()
            ?.setMcpServerDisabled(extensionName, serverName, false);
        }
        const settings = loadSettings();
        for (const scope of [SettingScope.User, SettingScope.Workspace]) {
          const excluded =
            settings.forScope(scope).settings.mcp?.excluded || [];
          if (excluded.includes(serverName)) {
            settings.setValue(
              scope,
              'mcp.excluded',
              excluded.filter((n: string) => n !== serverName),
            );
          }
        }
        const runtimeExcluded = config.getExcludedMcpServers() || [];
        config.setExcludedMcpServers(
          runtimeExcluded.filter((n) => n !== serverName),
        );
        await toolRegistry?.discoverToolsForServer(serverName);
      } else if (server.source === 'extension') {
        // Disable via the extension-scoped preference so the global
        // mcp.excluded list (and same-named servers elsewhere) are untouched.
        const extensionName = server.config.extensionName;
        const manager = config.getExtensionManager();
        if (!extensionName || !manager) {
          onStatus({
            type: 'info',
            text: t('Cannot disable an extension-provided MCP server here.'),
          });
          return;
        }
        manager.setMcpServerDisabled(extensionName, serverName, true);
        await toolRegistry?.disconnectServer(serverName);
        // Drop the status entry so the footer health pill doesn't keep
        // counting an intentionally disabled server as offline.
        removeMCPServerStatus(serverName);
      } else {
        const scope =
          server.source === 'project'
            ? SettingScope.Workspace
            : SettingScope.User;
        const settings = loadSettings();
        const excluded = settings.forScope(scope).settings.mcp?.excluded || [];
        if (!matchesAnyServerPattern(serverName, excluded)) {
          settings.setValue(scope, 'mcp.excluded', [...excluded, serverName]);
        }
        await toolRegistry?.disableMcpServer(serverName);
      }
      await reload();
    } catch (error) {
      onStatus({ type: 'error', text: getErrorMessage(error) });
    }
  }, [server, config, serverName, reload, onStatus]);

  if (loading && !server) {
    return <Text color={theme.text.secondary}>{t('Loading...')}</Text>;
  }

  if (sub === 'tool-detail') {
    return (
      <ToolDetailStep
        tool={selectedTool}
        isActive={isActive}
        onBack={() => setSub('tools')}
      />
    );
  }

  if (sub === 'tools') {
    return (
      <ToolListStep
        tools={getServerTools()}
        serverName={serverName}
        isActive={isActive}
        onSelect={(tool) => {
          setSelectedTool(tool);
          setSub('tool-detail');
        }}
        onBack={() => setSub('detail')}
      />
    );
  }

  if (sub === 'resource-detail') {
    return (
      <ResourceDetailStep
        resource={selectedResource}
        isActive={isActive}
        onBack={() => setSub('resources')}
      />
    );
  }

  if (sub === 'resources') {
    return (
      <ResourceListStep
        resources={getServerResources()}
        serverName={serverName}
        isActive={isActive}
        onSelect={(resource) => {
          setSelectedResource(resource);
          setSub('resource-detail');
        }}
        onBack={() => setSub('detail')}
      />
    );
  }

  return (
    <ServerDetailStep
      server={server}
      isActive={isActive}
      onViewTools={() => setSub('tools')}
      onViewResources={() => setSub('resources')}
      onReconnect={() => void handleReconnect()}
      onDisable={() => void handleToggleDisable()}
      onBack={onExit}
    />
  );
};
