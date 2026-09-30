/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */
// @vitest-environment jsdom

import { render } from 'ink-testing-library';
import { render as inkRender } from 'ink';
import { EventEmitter } from 'node:events';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { waitFor } from '@testing-library/react';
import { ExtensionsManagerDialog } from './ExtensionsManagerDialog.js';
import { UIStateContext } from '../../contexts/UIStateContext.js';
import { KeypressProvider } from '../../contexts/KeypressContext.js';
import { SettingsContext } from '../../contexts/SettingsContext.js';
import { ShellFocusContext } from '../../contexts/ShellFocusContext.js';
import { LoadedSettings } from '../../../config/settings.js';
import type { UIState } from '../../contexts/UIStateContext.js';
import type { Config, Extension } from '@qwen-code/qwen-code-core';
import {
  ExtensionUpdateState,
  type ExtensionUpdateAction,
} from '../../state/extensions.js';

// The Installed tab reads real user/workspace settings from disk when MCP
// servers exist; stub loadSettings to keep these tests hermetic.
vi.mock('../../../config/settings.js', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('../../../config/settings.js')>();
  return {
    ...actual,
    loadSettings: vi.fn(() => ({
      forScope: () => ({ settings: {} }),
      setValue: vi.fn(),
    })),
  };
});

const mockExtension = (name: string, isActive = true): Extension =>
  ({
    id: name,
    name,
    version: '1.0.0',
    path: `/home/user/.qwen/extensions/${name}`,
    isActive,
    installMetadata: { type: 'local', source: `/src/${name}` },
    mcpServers: {},
    commands: [],
    skills: [],
    agents: [],
    resolvedSettings: [],
    config: {},
    contextFiles: [],
  }) as unknown as Extension;

interface ManagerOverrides {
  extensions?: Extension[];
  favorites?: string[];
  scopes?: Record<string, string>;
}

const createManager = (o: ManagerOverrides = {}) => {
  const extensions = o.extensions ?? [];
  return {
    refreshCache: vi.fn().mockResolvedValue(undefined),
    getLoadedExtensions: vi.fn(() => extensions),
    getFavorites: vi.fn(() => o.favorites ?? []),
    getExtensionScopes: vi.fn(() => o.scopes ?? {}),
    isFavorite: vi.fn((name: string) => (o.favorites ?? []).includes(name)),
    getExtensionScope: vi.fn((name: string) => o.scopes?.[name] ?? 'user'),
    toggleFavorite: vi.fn(() => true),
    setExtensionScope: vi.fn(),
    getDisabledMcpServers: vi.fn(() => []),
    setMcpServerDisabled: vi.fn(),
    enableExtension: vi.fn().mockResolvedValue(undefined),
    disableExtension: vi.fn().mockResolvedValue(undefined),
    uninstallExtension: vi.fn().mockResolvedValue(undefined),
    checkForAllExtensionUpdates: vi.fn().mockResolvedValue(undefined),
    updateExtension: vi.fn().mockResolvedValue(undefined),
  };
};

const createConfig = (
  manager: ReturnType<typeof createManager>,
  overrides: { mcpServers?: Record<string, unknown> } = {},
): Config =>
  ({
    getExtensionManager: () => manager,
    getMcpServers: () => overrides.mcpServers ?? {},
    getToolRegistry: () => undefined,
    getPromptRegistry: () => undefined,
    getResourceRegistry: () => undefined,
    isMcpServerDisabled: () => false,
    getExcludedMcpServers: () => [],
    setExcludedMcpServers: vi.fn(),
  }) as unknown as Config;

const createUIState = (
  extensionsUpdateState = new Map<string, ExtensionUpdateState>(),
  dispatchExtensionStateUpdate: (
    action: ExtensionUpdateAction,
  ) => void = vi.fn(),
): UIState =>
  ({
    extensionsUpdateState,
    // The dialog reaches the app's update-state reducer through the command
    // context it already gets on the UI state (the same route ExtensionsList
    // uses to read the config).
    commandContext: { ui: { dispatchExtensionStateUpdate } },
  }) as unknown as UIState;

const mockSettings = new LoadedSettings(
  { path: '', settings: {}, originalSettings: {} },
  { path: '', settings: {}, originalSettings: {} },
  { path: '', settings: {}, originalSettings: {} },
  { path: '', settings: {}, originalSettings: {} },
  true,
  new Set(),
);

const renderDialog = (
  config: Config,
  opts: {
    onClose?: () => void;
    uiState?: UIState;
  } = {},
) =>
  render(
    <SettingsContext.Provider value={mockSettings}>
      <ShellFocusContext.Provider value={true}>
        <UIStateContext.Provider value={opts.uiState ?? createUIState()}>
          <KeypressProvider kittyProtocolEnabled={false}>
            <ExtensionsManagerDialog
              onClose={opts.onClose ?? vi.fn()}
              config={config}
            />
          </KeypressProvider>
        </UIStateContext.Provider>
      </ShellFocusContext.Provider>
    </SettingsContext.Provider>,
  );

const stripAnsi = (s: string): string =>
  // eslint-disable-next-line no-control-regex
  s.replace(/\u001b\[[0-9;]*m/g, '');

// ink-testing-library hard-codes an 80/100-column buffer, which is too narrow
// to reproduce wide-terminal layout bugs. Render through ink directly with a
// custom wide stdout so the dialog lays out at the requested width.
const renderWide = (config: Config, columns: number) => {
  let lastFrame = '';
  const stdout = Object.assign(new EventEmitter(), {
    columns,
    rows: 50,
    write: (frame: string) => {
      lastFrame = frame;
    },
  });
  const stderr = Object.assign(new EventEmitter(), {
    columns,
    rows: 50,
    write: () => {},
  });
  // A TTY-like stdin so KeypressProvider can enable raw mode (ink-testing-
  // library supplies one; ink's real render against a custom stdout does not).
  const stdin = Object.assign(new EventEmitter(), {
    isTTY: true,
    setRawMode: () => {},
    setEncoding: () => {},
    resume: () => {},
    pause: () => {},
    ref: () => {},
    unref: () => {},
    read: () => null,
  });
  const instance = inkRender(
    <SettingsContext.Provider value={mockSettings}>
      <ShellFocusContext.Provider value={true}>
        <UIStateContext.Provider value={createUIState()}>
          <KeypressProvider kittyProtocolEnabled={false}>
            <ExtensionsManagerDialog onClose={vi.fn()} config={config} />
          </KeypressProvider>
        </UIStateContext.Provider>
      </ShellFocusContext.Provider>
    </SettingsContext.Provider>,
    {
      stdout: stdout as unknown as NodeJS.WriteStream,
      stderr: stderr as unknown as NodeJS.WriteStream,
      stdin: stdin as unknown as NodeJS.ReadStream,
      // debug:true makes ink write the full frame synchronously (as
      // ink-testing-library does) instead of throttled cursor-diff output.
      debug: true,
      patchConsole: false,
      exitOnCtrlC: false,
    },
  );
  return { lastFrame: () => lastFrame, unmount: instance.unmount };
};

describe('ExtensionsManagerDialog', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('caps its width on a wide terminal so the status column is not clipped', async () => {
    // Regression: the dialog computed boxWidth = columns - 4 with no cap, while
    // the app's main content area is capped at 100 cols (AppContainer). On a
    // wide terminal the dialog overflowed its container and the right-aligned
    // status column ("Extension v… (…)") was clipped off-screen to a sliver
    // ("扩…"). The dialog must stay within ~100 columns regardless of terminal
    // width. Rendered through a 200-column stdout to exercise the wide case.
    const original = Object.getOwnPropertyDescriptor(process.stdout, 'columns');
    Object.defineProperty(process.stdout, 'columns', {
      value: 200,
      configurable: true,
    });
    let unmount: (() => void) | undefined;
    try {
      const r = renderWide(
        createConfig(
          createManager({
            extensions: [mockExtension('alpha'), mockExtension('beta', false)],
          }),
        ),
        200,
      );
      unmount = r.unmount;
      await waitFor(() => {
        expect(stripAnsi(r.lastFrame())).toContain('alpha');
      });
      const frame = stripAnsi(r.lastFrame());
      // No rendered line spills past the ~100-col content area (the uncapped
      // dialog produced ~196-col lines and clipped the status column).
      const widest = Math.max(...frame.split('\n').map((line) => line.length));
      expect(widest).toBeLessThanOrEqual(102);
      // And the status column is fully present, not truncated to a sliver.
      expect(frame).toMatch(/v1\.0\.0\s*\([^)]+\)/);
    } finally {
      unmount?.();
      if (original) {
        Object.defineProperty(process.stdout, 'columns', original);
      } else {
        // Non-TTY (CI/piped stdout): `columns` is inherited from the prototype,
        // so there was no own-property to restore. Delete the override we added
        // so it doesn't leak `200` into later test files via useTerminalSize.
        delete (process.stdout as unknown as Record<string, unknown>)[
          'columns'
        ];
      }
    }
  });

  it('groups installed plugins by scope on the Installed tab', async () => {
    const config = createConfig(
      createManager({
        extensions: [
          mockExtension('alpha', true),
          mockExtension('beta', false),
        ],
        scopes: { alpha: 'user' },
      }),
    );
    const { lastFrame } = renderDialog(config, {});
    await waitFor(() => {
      expect(lastFrame()).toContain('alpha');
    });
    const frame = lastFrame();
    expect(frame).toContain('User level');
    expect(frame).toContain('Disabled');
    expect(frame).toContain('beta');
    // Plugins show their type + version (parallel to "MCP"), not a bare version.
    expect(frame).toContain('Extension v1.0.0');
  });

  it('nests extension-bundled MCP servers under their extension on the Installed tab', async () => {
    const ext = mockExtension('alpha', true);
    (ext as unknown as { mcpServers: Record<string, unknown> }).mcpServers = {
      'alpha-mcp': { command: 'node' },
    };
    const config = createConfig(
      createManager({ extensions: [ext, mockExtension('beta', true)] }),
      {
        mcpServers: {
          'alpha-mcp': { command: 'node', extensionName: 'alpha' },
        },
      },
    );
    const { stdin, lastFrame } = renderDialog(config, {});
    await waitFor(() => {
      expect(lastFrame()).toContain('alpha-mcp');
    });
    const frame = lastFrame()!;
    // Bundled MCP renders indented under its parent extension.
    expect(frame).toContain('└ alpha-mcp');
    // The group count only includes top-level items (the two extensions).
    expect(frame).toContain('User level (2)');
    // MCP rows show the live connection state, not a bare enabled flag.
    expect(frame).toContain('disconnected');
    // Enter on the nested row opens the MCP detail view with Extension source.
    stdin.write('\x1B[B'); // down: alpha -> alpha-mcp
    await waitFor(() => {
      expect(lastFrame()).toMatch(/●\uFE0E\s+└ alpha-mcp/);
    });
    stdin.write('\r');
    await waitFor(() => {
      expect(lastFrame()).toContain('Source:');
    });
    expect(lastFrame()).toContain('Extension');
  });

  it('disables an extension-bundled MCP server individually with Space', async () => {
    const ext = mockExtension('alpha', true);
    (ext as unknown as { mcpServers: Record<string, unknown> }).mcpServers = {
      'alpha-mcp': { command: 'node' },
    };
    const manager = createManager({ extensions: [ext] });
    const config = createConfig(manager, {
      mcpServers: {
        'alpha-mcp': { command: 'node', extensionName: 'alpha' },
      },
    });
    const { stdin, lastFrame } = renderDialog(config, {});
    await waitFor(() => {
      expect(lastFrame()).toContain('alpha-mcp');
    });
    stdin.write('\x1B[B'); // down: alpha -> alpha-mcp
    await waitFor(() => {
      expect(lastFrame()).toMatch(/●\uFE0E\s+└ alpha-mcp/);
    });
    stdin.write(' '); // Space -> disable just this server
    await waitFor(() => {
      // The disable is recorded against the extension, not mcp.excluded.
      expect(manager.setMcpServerDisabled).toHaveBeenCalledWith(
        'alpha',
        'alpha-mcp',
        true,
      );
    });
  });

  it('toggles favorite when pressing f on the Installed tab', async () => {
    const manager = createManager({
      extensions: [mockExtension('alpha', true)],
    });
    const { stdin, lastFrame } = renderDialog(createConfig(manager), {});
    await waitFor(() => {
      expect(lastFrame()).toContain('alpha');
    });
    stdin.write('f');
    await waitFor(() => {
      expect(manager.toggleFavorite).toHaveBeenCalledWith('alpha');
    });
  });

  it('moves a plugin into the Favorites group after favoriting (regroup/reload)', async () => {
    const favorites: string[] = [];
    const manager = createManager({
      extensions: [mockExtension('alpha', true), mockExtension('beta', true)],
    });
    manager.getFavorites = vi.fn(() => [...favorites]);
    manager.toggleFavorite = vi.fn((name: string) => {
      const i = favorites.indexOf(name);
      if (i >= 0) {
        favorites.splice(i, 1);
        return false;
      }
      favorites.push(name);
      return true;
    });
    const { stdin, lastFrame } = renderDialog(createConfig(manager), {});
    await waitFor(() => {
      expect(lastFrame()).toContain('alpha');
    });
    // Initially there is no Favorites group.
    expect(lastFrame()).not.toContain('Favorites');
    stdin.write('f'); // favorite the selected item (alpha, first in the list)
    await waitFor(() => {
      expect(lastFrame()).toContain('Favorites');
    });
    expect(manager.toggleFavorite).toHaveBeenCalledWith('alpha');
    // The list re-rendered cleanly (no stuck/empty frame) and still shows beta.
    expect(lastFrame()).toContain('beta');
  });

  it('closes on Escape from a tab root', async () => {
    const onClose = vi.fn();
    const { stdin } = renderDialog(createConfig(createManager()), { onClose });
    await waitFor(() => {});
    stdin.write('\x1b'); // escape
    await waitFor(() => {
      expect(onClose).toHaveBeenCalled();
    });
  });

  it('renders a pending install consent prompt in place of the list', async () => {
    const uiState = {
      extensionsUpdateState: new Map<string, ExtensionUpdateState>(),
      confirmUpdateExtensionRequests: [
        { prompt: 'Do you trust this extension?', onConfirm: vi.fn() },
      ],
      settingInputRequests: [],
      pluginChoiceRequests: [],
    } as unknown as UIState;
    const { lastFrame } = renderDialog(
      createConfig(
        createManager({ extensions: [mockExtension('alpha', true)] }),
      ),
      { uiState },
    );
    await waitFor(() => {
      expect(lastFrame()).toContain('Do you trust this extension?');
    });
    // The list is hidden while the prompt is shown, but the dialog stays
    // mounted.
    expect(lastFrame()).not.toContain('alpha');
  });

  it('adopts the state a successful update settled on into the app-level map', async () => {
    const manager = createManager({ extensions: [mockExtension('alpha')] });
    manager.updateExtension = vi.fn(
      async (
        ext: Extension,
        _state: ExtensionUpdateState,
        callback: (name: string, state: ExtensionUpdateState) => void,
      ) => {
        callback(ext.name, ExtensionUpdateState.UPDATING);
        callback(ext.name, ExtensionUpdateState.UPDATED);
        return {
          name: ext.name,
          originalVersion: '1.0.0',
          updatedVersion: '1.0.1',
        };
      },
    );
    const dispatchExtensionStateUpdate = vi.fn();
    const { stdin, lastFrame } = renderDialog(createConfig(manager), {
      uiState: createUIState(
        new Map([['alpha', ExtensionUpdateState.UPDATE_AVAILABLE]]),
        dispatchExtensionStateUpdate,
      ),
    });

    await waitFor(() => {
      expect(lastFrame()).toContain('alpha');
    });
    stdin.write('\r'); // Enter -> plugin detail
    await waitFor(() => {
      expect(lastFrame()).toContain('Update Now');
    });
    // Disable, Add to Favorites, Change scope, Mark for Update, Update Now.
    for (let i = 0; i < 4; i++) {
      stdin.write('\x1B[B');
    }
    stdin.write('\r');

    await waitFor(() => {
      expect(dispatchExtensionStateUpdate).toHaveBeenCalledWith({
        type: 'SET_STATE',
        payload: { name: 'alpha', state: ExtensionUpdateState.UPDATED },
      });
    });
    // The extension is current again, so the menu stops offering the update.
    await waitFor(() => {
      expect(lastFrame()).not.toContain('Update Now');
    });
  });
});
