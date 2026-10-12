/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  INSTALL_METADATA_FILENAME,
  EXTENSIONS_CONFIG_FILENAME,
} from './variables.js';
import { ExtensionStorage } from './storage.js';
import {
  ExtensionSettingScope,
  getScopedEnvContents,
  updateSetting,
} from './extensionSettings.js';
import { QWEN_DIR } from '../config/storage.js';
import {
  ExtensionManager,
  ExtensionUpdateState,
  SettingScope,
  type ExtensionManagerOptions,
  type Extension,
  validateName,
  getExtensionId,
  hashValue,
  type ExtensionConfig,
  type ExtensionMutationEvent,
  type PreparedExtensionMutation,
} from './extensionManager.js';
import type {
  Config,
  MCPServerConfig,
  ExtensionInstallMetadata,
} from '../index.js';
import { ExtensionStore } from './extension-store.js';
import { ExtensionPreferencesStore } from './extensionPreferences.js';
import {
  AGENT_PLUGIN_MCP_SCHEMA,
  AGENT_PLUGIN_SCHEMA,
} from './agent-plugins-v1/index.js';
import { SkillManager } from '../skills/skill-manager.js';

const mockExtractArchiveFile = vi.hoisted(() => vi.fn());

vi.mock('./archive-extraction.js', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('./archive-extraction.js')>();
  return {
    ...actual,
    extractArchiveFile: mockExtractArchiveFile,
  };
});

const mockHomedir = vi.hoisted(() => vi.fn());
vi.mock('os', async (importOriginal) => {
  const mockedOs = await importOriginal<typeof os>();
  return {
    ...mockedOs,
    homedir: mockHomedir,
  };
});

const EXTENSIONS_DIRECTORY_NAME = path.join(QWEN_DIR, 'extensions');

function createExtension({
  extensionsDir = 'extensions-dir',
  name = 'my-extension',
  version = '1.0.0',
  addContextFile = false,
  contextFileName = undefined as string | undefined,
  mcpServers = {} as Record<string, MCPServerConfig>,
  installMetadata = undefined as ExtensionInstallMetadata | undefined,
} = {}): string {
  const extDir = path.join(extensionsDir, name);
  fs.mkdirSync(extDir, { recursive: true });
  fs.writeFileSync(
    path.join(extDir, EXTENSIONS_CONFIG_FILENAME),
    JSON.stringify({ name, version, contextFileName, mcpServers }),
  );

  if (addContextFile) {
    fs.writeFileSync(path.join(extDir, 'QWEN.md'), 'context');
  }

  if (contextFileName) {
    fs.writeFileSync(path.join(extDir, contextFileName), 'context');
  }

  if (installMetadata) {
    fs.writeFileSync(
      path.join(extDir, INSTALL_METADATA_FILENAME),
      JSON.stringify(installMetadata),
    );
  }
  return extDir;
}

function createAgentPlugin(
  pluginRoot: string,
  {
    name = 'portable-plugin',
    version,
  }: { name?: string; version?: string } = {},
): void {
  fs.mkdirSync(path.join(pluginRoot, 'skills', 'direct'), {
    recursive: true,
  });
  fs.mkdirSync(path.join(pluginRoot, 'bin'), { recursive: true });
  fs.writeFileSync(
    path.join(pluginRoot, 'plugin.json'),
    JSON.stringify({
      $schema: AGENT_PLUGIN_SCHEMA,
      name,
      ...(version === undefined ? {} : { version }),
    }),
  );
  fs.writeFileSync(
    path.join(pluginRoot, 'skills', 'direct', 'SKILL.md'),
    '---\nname: direct\ndescription: Direct skill\nallowed-tools: Read\n---\nPortable instructions.',
  );
  fs.writeFileSync(path.join(pluginRoot, 'bin', 'server'), 'portable server');
  fs.writeFileSync(
    path.join(pluginRoot, 'mcp.json'),
    JSON.stringify({
      $schema: AGENT_PLUGIN_MCP_SCHEMA,
      mcpServers: {
        local: {
          type: 'stdio',
          command: './bin/server',
          args: ['${PLUGIN_ROOT}', '${PLUGIN_DATA}'],
        },
        remote: {
          type: 'streamable-http',
          url: 'https://example.com/mcp',
        },
        legacy: {
          type: 'sse',
          url: 'https://example.com/sse',
        },
      },
    }),
  );
}

describe('extension tests', () => {
  let tempHomeDir: string;
  let tempWorkspaceDir: string;
  let userExtensionsDir: string;
  let savedQwenHome: string | undefined;

  beforeEach(() => {
    savedQwenHome = process.env['QWEN_HOME'];
    delete process.env['QWEN_HOME'];
    tempHomeDir = fs.mkdtempSync(
      path.join(os.tmpdir(), 'qwen-code-test-home-'),
    );
    tempWorkspaceDir = fs.mkdtempSync(
      path.join(tempHomeDir, 'qwen-code-test-workspace-'),
    );
    userExtensionsDir = path.join(tempHomeDir, EXTENSIONS_DIRECTORY_NAME);
    fs.mkdirSync(userExtensionsDir, { recursive: true });

    mockHomedir.mockReturnValue(tempHomeDir);
    vi.spyOn(process, 'cwd').mockReturnValue(tempWorkspaceDir);
    mockExtractArchiveFile.mockReset();
  });

  afterEach(() => {
    fs.rmSync(tempHomeDir, { recursive: true, force: true });
    if (savedQwenHome === undefined) {
      delete process.env['QWEN_HOME'];
    } else {
      process.env['QWEN_HOME'] = savedQwenHome;
    }
    vi.restoreAllMocks();
  });

  function createExtensionManager(
    options: Partial<ExtensionManagerOptions> = {},
  ): ExtensionManager {
    return new ExtensionManager({
      workspaceDir: tempWorkspaceDir,
      isWorkspaceTrusted: true,
      extensionStore: new ExtensionStore({
        extensionsDir: userExtensionsDir,
      }),
      ...options,
    });
  }

  async function readStoreSnapshot(extensionsDir: string = userExtensionsDir) {
    return await new ExtensionStore({ extensionsDir }).readSnapshot();
  }

  async function readActivation(
    extension: { id: string; name: string },
    workspacePath: string = tempWorkspaceDir,
  ) {
    const store = new ExtensionStore({ extensionsDir: userExtensionsDir });
    return store.getActivation(
      await store.readSnapshot(),
      extension.id,
      extension.name,
      workspacePath,
    );
  }

  describe('extension workflows', () => {
    const workflowSource = (name: string) =>
      `export const meta = { name: '${name}', description: 'Runs ${name}' };\nreturn 1;\n`;

    it('loads workflows from the default directory as <extension>:<meta.name>', async () => {
      const directory = createExtension({
        extensionsDir: userExtensionsDir,
        name: 'suite',
      });
      fs.mkdirSync(path.join(directory, 'workflows'));
      fs.writeFileSync(
        path.join(directory, 'workflows', 'audit.js'),
        workflowSource('audit'),
      );

      const manager = createExtensionManager();
      await manager.refreshCache();
      const [extension] = manager.getLoadedExtensions();

      expect(extension.workflows?.map((workflow) => workflow.name)).toEqual([
        'suite:audit',
      ]);
      expect(extension.workflows?.[0]?.scriptPath).toBe(
        fs.realpathSync(path.join(directory, 'workflows', 'audit.js')),
      );
    });

    it('reads only the paths the manifest declares in workflows', async () => {
      const directory = createExtension({
        extensionsDir: userExtensionsDir,
        name: 'suite',
      });
      fs.writeFileSync(
        path.join(directory, EXTENSIONS_CONFIG_FILENAME),
        JSON.stringify({
          name: 'suite',
          version: '1.0.0',
          workflows: '${extensionPath}${/}flows',
        }),
      );
      fs.mkdirSync(path.join(directory, 'workflows'));
      fs.writeFileSync(
        path.join(directory, 'workflows', 'default.js'),
        workflowSource('default'),
      );
      fs.mkdirSync(path.join(directory, 'flows'));
      fs.writeFileSync(
        path.join(directory, 'flows', 'custom.js'),
        workflowSource('custom'),
      );

      const manager = createExtensionManager();
      await manager.refreshCache();
      const [extension] = manager.getLoadedExtensions();

      expect(extension.workflows?.map((workflow) => workflow.name)).toEqual([
        'suite:custom',
      ]);
    });

    it('offers the workflows it ships for consent on install', async () => {
      const sourcePath = path.join(tempWorkspaceDir, 'workflow-source');
      fs.mkdirSync(path.join(sourcePath, 'workflows'), { recursive: true });
      fs.writeFileSync(
        path.join(sourcePath, EXTENSIONS_CONFIG_FILENAME),
        JSON.stringify({ name: 'wf-ext', version: '1.0.0' }),
      );
      fs.writeFileSync(
        path.join(sourcePath, 'workflows', 'audit.js'),
        workflowSource('audit'),
      );

      const requestConsent = vi.fn(async () => {});
      const manager = createExtensionManager();
      await manager.refreshCache();
      const extension = await manager.installExtension(
        { type: 'local', source: sourcePath },
        requestConsent,
      );

      expect(requestConsent).toHaveBeenCalledWith(
        expect.objectContaining({
          workflows: [
            expect.objectContaining({
              name: 'wf-ext:audit',
              description: 'Runs audit',
              scriptPath: path.join(sourcePath, 'workflows', 'audit.js'),
            }),
          ],
          previousWorkflows: [],
        }),
      );
      expect(extension.workflows?.map((workflow) => workflow.name)).toEqual([
        'wf-ext:audit',
      ]);
      // The installed copy, not the source, is what loads.
      expect(extension.workflows?.[0]?.scriptPath).toBe(
        fs.realpathSync(path.join(extension.path, 'workflows', 'audit.js')),
      );
    });

    it.skipIf(process.platform === 'win32')(
      'discloses a symlinked workflow that the install copies as a regular file',
      async () => {
        const sourcePath = path.join(tempWorkspaceDir, 'linked-source');
        fs.mkdirSync(path.join(sourcePath, 'workflows'), { recursive: true });
        fs.mkdirSync(path.join(sourcePath, 'shared'), { recursive: true });
        fs.writeFileSync(
          path.join(sourcePath, EXTENSIONS_CONFIG_FILENAME),
          JSON.stringify({ name: 'wf-ext', version: '1.0.0' }),
        );
        fs.writeFileSync(
          path.join(sourcePath, 'shared', 'audit.js'),
          workflowSource('audit'),
        );
        fs.symlinkSync(
          path.join(sourcePath, 'shared', 'audit.js'),
          path.join(sourcePath, 'workflows', 'audit.js'),
        );

        const requestConsent = vi.fn(async () => {});
        const manager = createExtensionManager();
        await manager.refreshCache();
        const extension = await manager.installExtension(
          { type: 'local', source: sourcePath },
          requestConsent,
        );

        expect(requestConsent).toHaveBeenCalledWith(
          expect.objectContaining({
            workflows: [expect.objectContaining({ name: 'wf-ext:audit' })],
          }),
        );
        expect(
          fs
            .lstatSync(path.join(extension.path, 'workflows', 'audit.js'))
            .isSymbolicLink(),
        ).toBe(false);
        expect(extension.workflows?.map((workflow) => workflow.name)).toEqual([
          'wf-ext:audit',
        ]);
      },
    );

    it.skipIf(process.platform === 'win32')(
      'keeps runtime symlink rules for a linked extension, in consent and at load',
      async () => {
        const sourcePath = path.join(
          tempWorkspaceDir,
          'linked-workflow-source',
        );
        fs.mkdirSync(path.join(sourcePath, 'workflows'), { recursive: true });
        fs.mkdirSync(path.join(sourcePath, 'shared'), { recursive: true });
        fs.writeFileSync(
          path.join(sourcePath, EXTENSIONS_CONFIG_FILENAME),
          JSON.stringify({ name: 'wf-ext', version: '1.0.0' }),
        );
        fs.writeFileSync(
          path.join(sourcePath, 'shared', 'audit.js'),
          workflowSource('audit'),
        );
        fs.symlinkSync(
          path.join(sourcePath, 'shared', 'audit.js'),
          path.join(sourcePath, 'workflows', 'audit.js'),
        );

        const requestConsent = vi.fn(async () => {});
        const manager = createExtensionManager();
        await manager.refreshCache();
        const extension = await manager.installExtension(
          { type: 'link', source: sourcePath },
          requestConsent,
        );

        // A linked extension loads its source as-is, where links are refused,
        // so consent must not list what will never load.
        expect(requestConsent).toHaveBeenCalledWith(
          expect.objectContaining({ workflows: [] }),
        );
        expect(extension.workflows).toEqual([]);
      },
    );

    it.each([
      'flows',
      '${extensionPath}${/}flows',
      '$QWEN_TEST_WORKFLOW_DIR',
      '${QWEN_TEST_WORKFLOW_DIR}',
    ])('discloses and loads the same workflows for %s', async (workflows) => {
      const saved = process.env['QWEN_TEST_WORKFLOW_DIR'];
      process.env['QWEN_TEST_WORKFLOW_DIR'] = 'flows';
      try {
        const sourcePath = path.join(tempWorkspaceDir, 'workflow-source');
        fs.mkdirSync(path.join(sourcePath, 'flows'), { recursive: true });
        fs.writeFileSync(
          path.join(sourcePath, EXTENSIONS_CONFIG_FILENAME),
          JSON.stringify({ name: 'wf-ext', version: '1.0.0', workflows }),
        );
        fs.writeFileSync(
          path.join(sourcePath, 'flows', 'a.js'),
          workflowSource('audit'),
        );

        const requestConsent = vi.fn(async () => {});
        const manager = createExtensionManager();
        await manager.refreshCache();
        const extension = await manager.installExtension(
          { type: 'local', source: sourcePath },
          requestConsent,
        );

        expect(requestConsent).toHaveBeenCalledWith(
          expect.objectContaining({
            workflows: [expect.objectContaining({ name: 'wf-ext:audit' })],
            previousWorkflows: [],
          }),
        );
        expect(extension.workflows?.map((workflow) => workflow.name)).toEqual([
          'wf-ext:audit',
        ]);
      } finally {
        if (saved === undefined) delete process.env['QWEN_TEST_WORKFLOW_DIR'];
        else process.env['QWEN_TEST_WORKFLOW_DIR'] = saved;
      }
    });
  });

  it('retains extension skill discovery errors until the next successful load', async () => {
    const extensionDirectory = createExtension({
      extensionsDir: userExtensionsDir,
      name: 'broken-skill',
    });
    const skillDirectory = path.join(extensionDirectory, 'skills', 'review');
    fs.mkdirSync(skillDirectory, { recursive: true });
    const manifestPath = path.join(skillDirectory, 'SKILL.md');
    fs.writeFileSync(manifestPath, 'invalid frontmatter');
    const manager = createExtensionManager();
    await manager.refreshCache();
    const [broken] = manager.getLoadedExtensions();
    expect(broken).toBeDefined();
    expect(broken.skills).toEqual([]);
    expect(broken.skillsDiscoveryHasErrors).toBe(true);
    fs.writeFileSync(
      manifestPath,
      '---\nname: review\ndescription: Review code\n---\nBody.',
    );
    await manager.refreshCache();
    const [recovered] = manager.getLoadedExtensions();
    expect(recovered.skills?.map((skill) => skill.name)).toEqual(['review']);
    expect(recovered.skillsDiscoveryHasErrors).not.toBe(true);
    fs.rmSync(skillDirectory, { recursive: true });
    await manager.refreshCache();
    expect(manager.getLoadedExtensions()[0].skillsDiscoveryHasErrors).not.toBe(
      true,
    );
  });

  it('propagates Agent Plugin root discovery failures through recovery and confirmed removal', async () => {
    const pluginDirectory = path.join(userExtensionsDir, 'portable-plugin');
    createAgentPlugin(pluginDirectory);
    const skillsDirectory = path.join(pluginDirectory, 'skills');
    const outsideDirectory = path.join(tempWorkspaceDir, 'outside-skills');
    const manager = createExtensionManager();
    const skillManager = new SkillManager({
      isSafeMode: () => false,
      getBareMode: () => false,
      getProjectRoot: () => tempWorkspaceDir,
      getDisabledSkillLevels: () => new Set(['project', 'user', 'bundled']),
      getActiveExtensions: () =>
        manager.getLoadedExtensions().filter((extension) => extension.isActive),
    } as unknown as Config);
    const refresh = async () => {
      await manager.refreshCache();
      await skillManager.refreshCache();
      return manager.getLoadedExtensions()[0];
    };

    await refresh();
    expect(skillManager.getCachedSkills()?.map((skill) => skill.name)).toEqual([
      'portable-plugin:direct',
    ]);
    fs.renameSync(skillsDirectory, outsideDirectory);
    fs.symlinkSync(
      outsideDirectory,
      skillsDirectory,
      process.platform === 'win32' ? 'junction' : 'dir',
    );
    const broken = await refresh();
    expect(broken.format).toBe('agent-plugins-v1');
    expect(broken.skills).toEqual([]);
    expect(broken.skillsDiscoveryHasErrors).toBe(true);
    expect(skillManager.getCachedSkills()).toEqual([]);
    expect(skillManager.hasDiscoveryErrors()).toBe(true);

    fs.unlinkSync(skillsDirectory);
    fs.renameSync(outsideDirectory, skillsDirectory);
    const recovered = await refresh();
    expect(recovered.skills?.map((skill) => skill.name)).toEqual(['direct']);
    expect(recovered.skillsDiscoveryHasErrors).not.toBe(true);
    expect(skillManager.getCachedSkills()?.map((skill) => skill.name)).toEqual([
      'portable-plugin:direct',
    ]);
    expect(skillManager.hasDiscoveryErrors()).toBe(false);

    fs.rmSync(skillsDirectory, { recursive: true });
    const removed = await refresh();
    expect(removed.skills).toEqual([]);
    expect(removed.skillsDiscoveryHasErrors).not.toBe(true);
    expect(skillManager.getCachedSkills()).toEqual([]);
    expect(skillManager.hasDiscoveryErrors()).toBe(false);
  });

  describe('extension skill states', () => {
    let manager: ExtensionManager;
    let extensionDirectory: string;
    let extensionId: string;

    beforeEach(async () => {
      extensionDirectory = createExtension({
        extensionsDir: userExtensionsDir,
        name: 'suite',
      });
      for (const name of ['skill-a', 'skill-b', 'constructor', '__proto__']) {
        const skillDirectory = path.join(extensionDirectory, 'skills', name);
        fs.mkdirSync(skillDirectory, { recursive: true });
        fs.writeFileSync(
          path.join(skillDirectory, 'SKILL.md'),
          `---\nname: ${name}\ndescription: Test skill\n---\nSkill body`,
        );
      }
      manager = createExtensionManager();
      await manager.refreshCache();
      extensionId = manager.getLoadedExtensions()[0]!.id;
    });

    it.each([undefined, {}])(
      'defaults undeclared skill states to enabled: %j',
      async (skillStates) => {
        fs.writeFileSync(
          path.join(extensionDirectory, EXTENSIONS_CONFIG_FILENAME),
          JSON.stringify({ name: 'suite', version: '1.0.0', skillStates }),
        );
        await manager.refreshCache();
        expect(
          manager.getExtensionSkillState(extensionId, '__proto__'),
        ).toEqual({
          defaultEnabled: true,
          workspaceEnabled: null,
        });
      },
    );

    it('parses normalized boolean defaults without losing prototype-named skills', async () => {
      fs.writeFileSync(
        path.join(extensionDirectory, EXTENSIONS_CONFIG_FILENAME),
        JSON.stringify({
          name: 'suite',
          version: '1.0.0',
          skillStates: Object.fromEntries([
            [' Skill-A ', false],
            ['constructor', true],
            ['__proto__', false],
          ]),
        }),
      );
      await manager.refreshCache();
      for (const [name, expected] of [
        ['skill-a', false],
        ['skill-b', true],
        ['constructor', true],
        ['__proto__', false],
      ] as const) {
        expect(
          manager.getExtensionSkillState(extensionId, name).defaultEnabled,
        ).toBe(expected);
      }
    });

    it.each([
      null,
      [],
      'enabled',
      { 'skill-a': 'false' },
      { 'bad name': true },
    ])('rejects invalid native skillStates: %j', (skillStates) => {
      fs.writeFileSync(
        path.join(extensionDirectory, EXTENSIONS_CONFIG_FILENAME),
        JSON.stringify({ name: 'suite', version: '1.0.0', skillStates }),
      );
      expect(() =>
        manager.loadExtensionConfig({ extensionDir: extensionDirectory }),
      ).toThrow();
    });
  });

  describe('installExtension', () => {
    function writeExtractedExtension(destination: string, name: string) {
      fs.mkdirSync(destination, { recursive: true });
      fs.writeFileSync(
        path.join(destination, EXTENSIONS_CONFIG_FILENAME),
        JSON.stringify({ name, version: '1.0.0' }),
      );
    }

    function writeQoderPlugin(destination: string) {
      fs.mkdirSync(path.join(destination, '.qoder-plugin'), {
        recursive: true,
      });
      fs.writeFileSync(
        path.join(destination, '.qoder-plugin', 'plugin.json'),
        JSON.stringify({ name: 'sample-qoder-plugin', version: '1.0.0' }),
      );
      fs.writeFileSync(
        path.join(destination, 'system-prompt.md'),
        '# System context',
      );
    }

    it('installs an Agent Plugin without converting package files', async () => {
      const sourcePath = path.join(tempWorkspaceDir, 'portable-source');
      createAgentPlugin(sourcePath);
      for (const component of ['commands', 'agents', 'hooks']) {
        fs.mkdirSync(path.join(sourcePath, component));
        fs.writeFileSync(path.join(sourcePath, component, 'ignored.md'), 'no');
      }
      fs.writeFileSync(path.join(sourcePath, 'QWEN.md'), 'ignored context');
      // The Agent Plugins v1 schema defines no workflows, so a shipped
      // workflows/ directory must neither be disclosed nor loaded.
      fs.mkdirSync(path.join(sourcePath, 'workflows'));
      fs.writeFileSync(
        path.join(sourcePath, 'workflows', 'audit.js'),
        "export const meta = { name: 'audit', description: 'Audit' };\nreturn 1;\n",
      );
      const sourceContents = new Map(
        [
          'plugin.json',
          'mcp.json',
          path.join('skills', 'direct', 'SKILL.md'),
          path.join('bin', 'server'),
        ].map((file) => [file, fs.readFileSync(path.join(sourcePath, file))]),
      );
      const outside = path.join(tempWorkspaceDir, 'outside.txt');
      fs.writeFileSync(outside, 'outside');
      if (process.platform !== 'win32') {
        fs.symlinkSync(outside, path.join(sourcePath, 'outside-link'));
      }

      const requestConsent = vi.fn(async () => {});
      const manager = createExtensionManager();
      await manager.refreshCache();
      const extension = await manager.installExtension(
        { type: 'local', source: sourcePath },
        requestConsent,
      );

      expect(extension.version).toBe('1.0.0');
      expect(extension.format).toBe('agent-plugins-v1');
      expect(extension.installMetadata?.originSource).toBe('AgentPlugins');
      expect(extension.skills?.map((skill) => skill.name)).toEqual(['direct']);
      expect(extension.skills?.[0]?.allowedTools).toBeUndefined();
      expect(extension.commands).toEqual([]);
      expect(extension.agents).toEqual([]);
      expect(extension.workflows).toEqual([]);
      expect(extension.contextFiles).toEqual([]);
      expect(extension.hooks).toBeUndefined();
      expect(extension.settings).toBeUndefined();
      expect(Object.keys(extension.mcpServers ?? {})).toEqual(['local']);
      expect(extension.mcpServers?.['local']?.agentPluginV1).toBe(true);
      expect(requestConsent).toHaveBeenCalledWith(
        expect.objectContaining({
          originSource: 'AgentPlugins',
          commands: [],
          subagents: [],
          workflows: [],
          skills: [expect.objectContaining({ name: 'direct' })],
        }),
      );
      expect(extension.workflows).toEqual([]);

      for (const [file, contents] of sourceContents) {
        expect(fs.readFileSync(path.join(extension.path, file))).toEqual(
          contents,
        );
      }
      expect(
        fs.existsSync(path.join(extension.path, EXTENSIONS_CONFIG_FILENAME)),
      ).toBe(false);
      expect(
        fs.existsSync(path.join(extension.path, INSTALL_METADATA_FILENAME)),
      ).toBe(true);
      if (process.platform !== 'win32') {
        expect(fs.existsSync(path.join(extension.path, 'outside-link'))).toBe(
          false,
        );
      }
      const pluginData = extension.mcpServers?.['local']?.env?.['PLUGIN_DATA'];
      expect(pluginData).toBeDefined();
      expect(fs.statSync(pluginData!).isDirectory()).toBe(true);
    });

    it.runIf(process.platform !== 'win32')(
      'installs an Agent Plugin through a symlinked source root',
      async () => {
        const sourcePath = path.join(tempWorkspaceDir, 'portable-source-real');
        const symlinkPath = path.join(tempWorkspaceDir, 'portable-source-link');
        createAgentPlugin(sourcePath, { name: 'symlinked-plugin' });
        fs.symlinkSync(sourcePath, symlinkPath, 'dir');

        const manager = createExtensionManager();
        await manager.refreshCache();
        const installed = await manager.installExtension(
          { type: 'local', source: symlinkPath },
          async () => {},
        );

        expect(installed.name).toBe('symlinked-plugin');
        expect(installed.installMetadata).toMatchObject({
          source: symlinkPath,
          originSource: 'AgentPlugins',
        });
        expect(fs.existsSync(path.join(installed.path, 'plugin.json'))).toBe(
          true,
        );
      },
    );

    it('preserves Agent Plugin data across update and reinstall', async () => {
      const sourcePath = path.join(tempWorkspaceDir, 'persistent-source');
      createAgentPlugin(sourcePath, {
        name: 'persistent-plugin',
        version: '1.0.0',
      });
      const installMetadata = { type: 'local' as const, source: sourcePath };
      const manager = createExtensionManager();
      await manager.refreshCache();

      const installed = await manager.installExtension(
        installMetadata,
        async () => {},
      );
      const pluginData = installed.mcpServers?.['local']?.env?.['PLUGIN_DATA'];
      expect(pluginData).toBeDefined();
      fs.writeFileSync(path.join(pluginData!, 'state.txt'), 'persistent');

      createAgentPlugin(sourcePath, {
        name: 'persistent-plugin',
        version: '1.0.1',
      });
      const updateInfo = await manager.updateExtension(
        installed,
        ExtensionUpdateState.UPDATE_AVAILABLE,
        () => {},
      );
      expect(updateInfo?.updatedVersion).toBe('1.0.1');
      const updated = manager
        .getLoadedExtensions()
        .find((extension) => extension.id === installed.id)!;
      expect(updated.version).toBe('1.0.1');
      expect(updated.mcpServers?.['local']?.env?.['PLUGIN_DATA']).toBe(
        pluginData,
      );
      expect(fs.readFileSync(path.join(pluginData!, 'state.txt'), 'utf8')).toBe(
        'persistent',
      );

      await manager.uninstallExtension(updated.name);
      const reinstalled = await manager.installExtension(
        installMetadata,
        async () => {},
      );
      expect(reinstalled.mcpServers?.['local']?.env?.['PLUGIN_DATA']).toBe(
        pluginData,
      );
      expect(fs.readFileSync(path.join(pluginData!, 'state.txt'), 'utf8')).toBe(
        'persistent',
      );
    });

    it('links an Agent Plugin and reloads its native manifest from the source', async () => {
      const sourcePath = path.join(tempWorkspaceDir, 'linked-source');
      createAgentPlugin(sourcePath, {
        name: 'linked-plugin',
        version: '1.0.0',
      });
      const manager = createExtensionManager();
      await manager.refreshCache();

      const linked = await manager.installExtension(
        { type: 'link', source: sourcePath },
        async () => {},
      );
      expect(linked.path).toBe(sourcePath);
      expect(linked.installMetadata).toMatchObject({
        type: 'link',
        source: sourcePath,
        originSource: 'AgentPlugins',
      });

      const manifest = JSON.parse(
        fs.readFileSync(path.join(sourcePath, 'plugin.json'), 'utf8'),
      ) as Record<string, unknown>;
      fs.writeFileSync(
        path.join(sourcePath, 'plugin.json'),
        JSON.stringify({ ...manifest, version: '1.0.1-longer' }),
      );
      await manager.refreshCache();
      expect(manager.getLoadedExtensions()[0]?.version).toBe('1.0.1-longer');
      const installedPath = path.join(userExtensionsDir, 'linked-plugin');
      expect(fs.readdirSync(installedPath)).toEqual([
        INSTALL_METADATA_FILENAME,
      ]);
    });

    it.each([undefined, 42, ''])(
      'isolates link metadata with invalid source %s during refresh',
      async (source) => {
        const brokenLink = path.join(userExtensionsDir, 'broken-link');
        fs.mkdirSync(brokenLink, { recursive: true });
        fs.writeFileSync(
          path.join(brokenLink, INSTALL_METADATA_FILENAME),
          JSON.stringify({ type: 'link', source }),
        );
        createAgentPlugin(path.join(userExtensionsDir, 'valid-plugin'), {
          name: 'valid-plugin',
        });

        const manager = createExtensionManager();
        await expect(manager.refreshCache()).resolves.toBeUndefined();
        expect(manager.getLoadedExtensions().map(({ name }) => name)).toEqual([
          'valid-plugin',
        ]);
      },
    );

    it('installs an Agent Plugin from an archive', async () => {
      const archivePath = path.join(tempWorkspaceDir, 'portable-plugin.zip');
      fs.writeFileSync(archivePath, 'synthetic archive');
      mockExtractArchiveFile.mockImplementation(
        async (_source: string, destination: string) => {
          createAgentPlugin(destination, { name: 'archived-plugin' });
        },
      );
      const manager = createExtensionManager();
      await manager.refreshCache();

      const installed = await manager.installExtension(
        { type: 'local', source: archivePath },
        async () => {},
      );

      expect(installed.name).toBe('archived-plugin');
      expect(installed.installMetadata?.originSource).toBe('AgentPlugins');
      expect(
        fs.existsSync(path.join(installed.path, 'qwen-extension.json')),
      ).toBe(false);
    });

    it('installs and uninstalls within an injected extension store root', async () => {
      const archivePath = path.join(tempWorkspaceDir, 'custom-root.zip');
      fs.writeFileSync(archivePath, 'archive');
      mockExtractArchiveFile.mockImplementation(
        async (_source: string, destination: string) => {
          writeExtractedExtension(destination, 'custom-root');
        },
      );
      const customExtensionsDir = path.join(tempHomeDir, 'custom-extensions');
      const manager = createExtensionManager({
        extensionStore: new ExtensionStore({
          extensionsDir: customExtensionsDir,
        }),
      });

      const installed = await manager.installExtension(
        { type: 'local', source: archivePath },
        async () => {},
      );

      expect(installed.path).toBe(
        path.join(customExtensionsDir, 'custom-root'),
      );
      await manager.refreshCache();
      await manager.uninstallExtension(installed.name);
      expect(fs.existsSync(installed.path)).toBe(false);
    });

    it('commits workspace initial activation with the installed artifact', async () => {
      const archivePath = path.join(tempWorkspaceDir, 'workspace-ext.zip');
      fs.writeFileSync(archivePath, 'archive');
      mockExtractArchiveFile.mockImplementation(
        async (_source: string, destination: string) => {
          writeExtractedExtension(destination, 'workspace-ext');
        },
      );
      const manager = createExtensionManager();
      await manager.refreshCache();

      const extension = await manager.installExtension(
        { type: 'local', source: archivePath },
        () => Promise.resolve(),
        undefined,
        tempWorkspaceDir,
        { scope: 'workspace', workspacePath: tempWorkspaceDir },
      );

      const activation = await readActivation(extension);
      expect(activation).toMatchObject({
        default: 'disabled',
        workspace: 'enabled',
        effective: 'enabled',
      });
    });

    it('fully validates the staged extension before commit', async () => {
      const archivePath = path.join(tempWorkspaceDir, 'invalid-context.zip');
      fs.writeFileSync(archivePath, 'archive');
      mockExtractArchiveFile.mockImplementation(
        async (_source: string, destination: string) => {
          fs.mkdirSync(destination, { recursive: true });
          fs.writeFileSync(
            path.join(destination, EXTENSIONS_CONFIG_FILENAME),
            JSON.stringify({
              name: 'invalid-context',
              version: '1.0.0',
              contextFileName: 42,
            }),
          );
        },
      );
      const manager = createExtensionManager();
      const before = await readStoreSnapshot();

      await expect(
        manager.installExtension(
          { type: 'local', source: archivePath },
          async () => {},
        ),
      ).rejects.toThrow();

      expect(await readStoreSnapshot()).toEqual(before);
      expect(
        fs.existsSync(path.join(userExtensionsDir, 'invalid-context')),
      ).toBe(false);
    });

    it('commits a fully validated extension without an explicit version', async () => {
      const archivePath = path.join(tempWorkspaceDir, 'default-version.zip');
      fs.writeFileSync(archivePath, 'archive');
      mockExtractArchiveFile.mockImplementation(
        async (_source: string, destination: string) => {
          fs.mkdirSync(destination, { recursive: true });
          fs.writeFileSync(
            path.join(destination, EXTENSIONS_CONFIG_FILENAME),
            JSON.stringify({ name: 'default-version' }),
          );
        },
      );
      const manager = createExtensionManager();

      const extension = await manager.installExtension(
        { type: 'local', source: archivePath },
        async () => {},
      );

      expect(extension.version).toBe('1.0.0');
    });

    it('stops update preparation when cancellation follows extraction', async () => {
      const archivePath = path.join(tempWorkspaceDir, 'cancelled.zip');
      fs.writeFileSync(archivePath, 'archive');
      createExtension({
        extensionsDir: userExtensionsDir,
        name: 'my-extension',
        version: '1.0.0',
        installMetadata: {
          type: 'local',
          source: archivePath,
          originSource: 'QwenCode',
        },
      });
      const controller = new AbortController();
      const reason = new Error('preparation expired');
      mockExtractArchiveFile.mockImplementationOnce(async () => {
        controller.abort(reason);
      });
      const manager = createExtensionManager();
      await manager.refreshCache();
      const extension = manager.getLoadedExtensions()[0]!;

      await expect(
        manager.updateExtension(
          extension,
          ExtensionUpdateState.UPDATE_AVAILABLE,
          () => {},
          true,
          controller.signal,
        ),
      ).rejects.toBe(reason);
    });

    it('uses the installed path for Claude plugin root replacement', async () => {
      const archivePath = path.join(tempWorkspaceDir, 'claude-ext.zip');
      fs.writeFileSync(archivePath, 'archive');
      mockExtractArchiveFile.mockImplementation(
        async (_source: string, destination: string) => {
          const pluginDirectory = path.join(destination, '.claude-plugin');
          fs.mkdirSync(pluginDirectory, { recursive: true });
          fs.writeFileSync(
            path.join(pluginDirectory, 'plugin.json'),
            JSON.stringify({ name: 'claude-ext', version: '1.0.0' }),
          );
          fs.mkdirSync(path.join(destination, 'hooks'));
          fs.writeFileSync(
            path.join(destination, 'README.md'),
            '${CLAUDE_PLUGIN_ROOT}/scripts/setup.sh',
          );
        },
      );
      const manager = createExtensionManager();

      const extension = await manager.installExtension(
        { type: 'local', source: archivePath },
        async () => {},
      );

      expect(
        path.normalize(
          fs.readFileSync(path.join(extension.path, 'README.md'), 'utf8'),
        ),
      ).toBe(path.join(extension.path, 'scripts', 'setup.sh'));
    });

    it('does not report a temp cleanup warning when an immediate retry succeeds', async () => {
      const archivePath = path.join(tempWorkspaceDir, 'cleanup-warning.zip');
      fs.writeFileSync(archivePath, 'archive');
      mockExtractArchiveFile.mockImplementation(
        async (_source: string, destination: string) => {
          writeExtractedExtension(destination, 'cleanup-warning');
        },
      );
      const manager = createExtensionManager();
      await manager.refreshCache();
      const rm = fs.promises.rm.bind(fs.promises);
      const deniedOnce = new Set<string>();
      vi.spyOn(fs.promises, 'rm').mockImplementation(
        async (target, options) => {
          const targetPath = String(target);
          if (
            /^qwen-extension[A-Za-z0-9]{6}$/.test(path.basename(targetPath)) &&
            !deniedOnce.has(targetPath)
          ) {
            deniedOnce.add(targetPath);
            throw new Error('cleanup denied');
          }
          return await rm(target, options);
        },
      );

      // installExtension throws on any commit warning, including
      // extension_temp_cleanup_failed.
      const extension = await manager.installExtension(
        { type: 'local', source: archivePath },
        async () => {},
      );

      expect(extension.name).toBe('cleanup-warning');
      expect(deniedOnce.size).toBeGreaterThan(0);
      for (const target of deniedOnce) {
        expect(fs.existsSync(target)).toBe(false);
      }
    });

    it('surfaces committed runtime refresh warnings after install reloads', async () => {
      const archivePath = path.join(tempWorkspaceDir, 'refresh-warning.zip');
      fs.writeFileSync(archivePath, 'archive');
      mockExtractArchiveFile.mockImplementation(
        async (_source: string, destination: string) => {
          writeExtractedExtension(destination, 'refresh-warning');
        },
      );
      const manager = createExtensionManager();
      await manager.refreshCache();
      vi.spyOn(manager, 'refreshTools').mockRejectedValueOnce(
        new Error('runtime stale'),
      );

      await expect(
        manager.installExtension(
          { type: 'local', source: archivePath },
          async () => {},
        ),
      ).rejects.toMatchObject({
        code: 'extension_committed_with_warnings',
        committed: true,
        identity: { name: 'refresh-warning' },
        warnings: [
          {
            code: 'extension_runtime_refresh_failed',
            error: 'runtime stale',
          },
        ],
      });
    });

    it('should install an extension from a local archive', async () => {
      const archivePath = path.join(tempWorkspaceDir, 'local-extension.zip');
      fs.writeFileSync(archivePath, 'not used by mocked extractor');
      mockExtractArchiveFile.mockImplementation(
        async (_source: string, destination: string) => {
          writeExtractedExtension(destination, 'local-archive-extension');
        },
      );

      const manager = createExtensionManager();
      await manager.refreshCache();

      const extension = await manager.installExtension(
        {
          source: archivePath,
          type: 'local',
        },
        async () => {},
      );

      expect(mockExtractArchiveFile).toHaveBeenCalledWith(
        archivePath,
        expect.any(String),
        undefined,
      );
      expect(extension.name).toBe('local-archive-extension');
      expect(extension.installMetadata).toMatchObject({
        source: archivePath,
        type: 'local',
      });
    });

    it('should install a Qoder plugin with skills and system context', async () => {
      const sourcePath = path.join(tempWorkspaceDir, 'sample-qoder-plugin');
      fs.mkdirSync(path.join(sourcePath, '.qoder-plugin'), {
        recursive: true,
      });
      fs.writeFileSync(
        path.join(sourcePath, '.qoder-plugin', 'plugin.json'),
        JSON.stringify({ name: 'sample-qoder-plugin', version: '1.0.0' }),
      );
      fs.writeFileSync(
        path.join(sourcePath, 'system-prompt.md'),
        '# System context',
      );
      const skillPath = path.join(sourcePath, 'skills', 'sample-skill');
      fs.mkdirSync(skillPath, { recursive: true });
      fs.writeFileSync(
        path.join(skillPath, 'SKILL.md'),
        '---\nname: sample-skill\ndescription: Synthetic skill\n---\n',
      );
      const commandsPath = path.join(sourcePath, 'commands');
      fs.mkdirSync(commandsPath, { recursive: true });
      fs.writeFileSync(
        path.join(commandsPath, 'sample.md'),
        '# Command\n${CLAUDE_PLUGIN_ROOT}/scripts/run.sh',
      );
      const hooksPath = path.join(sourcePath, 'hooks');
      fs.mkdirSync(hooksPath, { recursive: true });
      fs.writeFileSync(path.join(hooksPath, 'hooks.json'), '{}');
      const requestConsent = vi.fn(async () => {});
      const manager = createExtensionManager();
      await manager.refreshCache();

      const extension = await manager.installExtension(
        { source: sourcePath, type: 'local' },
        requestConsent,
      );

      expect(extension.installMetadata).toMatchObject({
        source: sourcePath,
        type: 'local',
        originSource: 'Qoder',
      });
      expect(extension.contextFiles).toEqual([
        path.join(extension.path, 'system-prompt.md'),
      ]);
      expect(extension.skills?.map((skill) => skill.name)).toEqual([
        'sample-skill',
      ]);
      expect(
        fs.readFileSync(
          path.join(extension.path, 'commands', 'sample.md'),
          'utf-8',
        ),
      ).toContain(`${extension.path}/scripts/run.sh`);
      expect(requestConsent).toHaveBeenCalledWith(
        expect.objectContaining({ originSource: 'Qoder' }),
      );
    });

    it('should install a Qoder plugin from a local archive', async () => {
      const resolvedInstallMetadata = {
        type: 'local' as const,
        source: path.join(tempWorkspaceDir, 'sample-qoder-plugin.zip'),
      };
      fs.writeFileSync(resolvedInstallMetadata.source, 'synthetic archive');
      mockExtractArchiveFile.mockImplementation(
        async (_source: string, destination: string) => {
          writeQoderPlugin(destination);
        },
      );
      const manager = createExtensionManager();
      await manager.refreshCache();

      const extension = await manager.installExtension(
        resolvedInstallMetadata,
        async () => {},
      );

      expect(extension.name).toBe('sample-qoder-plugin');
      expect(extension.installMetadata?.originSource).toBe('Qoder');
      expect(extension.contextFiles).toEqual([
        path.join(extension.path, 'system-prompt.md'),
      ]);
    });

    it('should emit mutation lifecycle events around install', async () => {
      const archivePath = path.join(tempWorkspaceDir, 'local-extension.zip');
      fs.writeFileSync(archivePath, 'not used by mocked extractor');
      mockExtractArchiveFile.mockImplementation(
        async (_source: string, destination: string) => {
          writeExtractedExtension(destination, 'local-archive-extension');
        },
      );

      const manager = createExtensionManager();
      const events: ExtensionMutationEvent[] = [];
      manager.addMutationListener((event) => events.push(event));
      await manager.refreshCache();

      await manager.installExtension(
        {
          source: archivePath,
          type: 'local',
        },
        async () => {},
      );

      expect(events).toEqual([
        { id: 1, phase: 'start', operation: 'installExtension' },
        { id: 1, phase: 'end', operation: 'installExtension' },
      ]);
    });

    it('should clean up converted temp dir for local archive installs', async () => {
      const archivePath = path.join(tempWorkspaceDir, 'gemini-extension.zip');
      fs.writeFileSync(archivePath, 'not used by mocked extractor');
      const tempDirs: string[] = [];
      vi.spyOn(ExtensionStorage, 'createTmpDir').mockImplementation(
        async () => {
          const tempDir = fs.mkdtempSync(
            path.join(tempHomeDir, 'tracked-extension-'),
          );
          tempDirs.push(tempDir);
          return tempDir;
        },
      );
      mockExtractArchiveFile.mockImplementation(
        async (_source: string, destination: string) => {
          fs.mkdirSync(destination, { recursive: true });
          fs.writeFileSync(
            path.join(destination, 'gemini-extension.json'),
            JSON.stringify({
              name: 'gemini-archive-extension',
              version: '1.0.0',
            }),
          );
        },
      );

      const manager = createExtensionManager();
      await manager.refreshCache();

      const extension = await manager.installExtension(
        {
          source: archivePath,
          type: 'local',
        },
        async () => {},
      );

      expect(extension.name).toBe('gemini-archive-extension');
      expect(tempDirs).toHaveLength(2);
      expect(fs.existsSync(tempDirs[0])).toBe(false);
      expect(fs.existsSync(tempDirs[1])).toBe(false);
      expect(
        fs.existsSync(
          path.join(
            userExtensionsDir,
            'gemini-archive-extension',
            EXTENSIONS_CONFIG_FILENAME,
          ),
        ),
      ).toBe(true);
    });

    it('should clean up the temp dir when local archive extraction fails', async () => {
      const archivePath = path.join(tempWorkspaceDir, 'local-extension.zip');
      fs.writeFileSync(archivePath, 'not used by mocked extractor');
      let tempDir: string | undefined;
      mockExtractArchiveFile.mockImplementation(
        async (_source: string, destination: string) => {
          tempDir = destination;
          throw new Error('extract failed');
        },
      );

      const manager = createExtensionManager();
      await manager.refreshCache();

      await expect(
        manager.installExtension(
          {
            source: archivePath,
            type: 'local',
          },
          async () => {},
        ),
      ).rejects.toThrow('extract failed');

      expect(tempDir).toBeDefined();
      expect(fs.existsSync(tempDir!)).toBe(false);
    });
  });

  describe('uninstallExtension', () => {
    it('returns a committed warning when preference cleanup fails', async () => {
      createExtension({
        extensionsDir: userExtensionsDir,
        name: 'my-extension',
        version: '1.0.0',
        installMetadata: {
          type: 'local',
          source: tempWorkspaceDir,
          originSource: 'QwenCode',
        },
      });
      const manager = createExtensionManager();
      await manager.refreshCache();
      vi.spyOn(ExtensionPreferencesStore.prototype, 'clear').mockImplementation(
        () => {
          throw new Error('cleanup failed');
        },
      );

      const result = await manager.uninstallExtension('my-extension');

      expect(result.warnings).toEqual([
        {
          code: 'extension_preferences_cleanup_failed',
          error: 'cleanup failed',
        },
      ]);
    });

    it('returns a committed warning when uninstall runtime refresh fails', async () => {
      createExtension({
        extensionsDir: userExtensionsDir,
        name: 'my-extension',
        version: '1.0.0',
        installMetadata: {
          type: 'local',
          source: tempWorkspaceDir,
          originSource: 'QwenCode',
        },
      });
      const manager = createExtensionManager();
      await manager.refreshCache();
      vi.spyOn(manager, 'refreshTools').mockRejectedValue(
        new Error('refresh failed'),
      );

      const result = await manager.uninstallExtension('my-extension');

      expect(result.warnings).toEqual([
        {
          code: 'extension_runtime_refresh_failed',
          error: 'refresh failed',
        },
      ]);
    });

    it('should emit mutation lifecycle events around uninstall', async () => {
      createExtension({
        extensionsDir: userExtensionsDir,
        name: 'my-extension',
        version: '1.0.0',
        installMetadata: {
          type: 'local',
          source: tempWorkspaceDir,
          originSource: 'QwenCode',
        },
      });

      const manager = createExtensionManager();
      const events: ExtensionMutationEvent[] = [];
      manager.addMutationListener((event) => events.push(event));
      await manager.refreshCache();

      await manager.uninstallExtension('my-extension');

      expect(events).toEqual([
        { id: 1, phase: 'start', operation: 'uninstallExtension' },
        { id: 1, phase: 'end', operation: 'uninstallExtension' },
      ]);
    });
  });

  describe('loadExtension', () => {
    it('uses the injected extension store root for discovery', async () => {
      const customExtensionsDir = path.join(tempHomeDir, 'custom-extensions');
      createExtension({
        extensionsDir: customExtensionsDir,
        name: 'custom-root-extension',
      });
      const manager = createExtensionManager({
        extensionStore: new ExtensionStore({
          extensionsDir: customExtensionsDir,
        }),
      });

      await manager.refreshCache();

      expect(manager.getLoadedExtensions()).toHaveLength(1);
      expect(manager.getLoadedExtensions()[0]?.path).toBe(
        path.join(customExtensionsDir, 'custom-root-extension'),
      );
    });

    it('should include extension path in loaded extension', async () => {
      const extensionDir = path.join(userExtensionsDir, 'test-extension');
      fs.mkdirSync(extensionDir, { recursive: true });

      createExtension({
        extensionsDir: userExtensionsDir,
        name: 'test-extension',
        version: '1.0.0',
      });

      const manager = createExtensionManager();
      await manager.refreshCache();
      const extensions = manager.getLoadedExtensions();

      expect(extensions).toHaveLength(1);
      expect(extensions[0].path).toBe(extensionDir);
      expect(extensions[0].config.name).toBe('test-extension');
    });

    it('should load context file path when QWEN.md is present', async () => {
      createExtension({
        extensionsDir: userExtensionsDir,
        name: 'ext1',
        version: '1.0.0',
        addContextFile: true,
      });
      createExtension({
        extensionsDir: userExtensionsDir,
        name: 'ext2',
        version: '2.0.0',
      });

      const manager = createExtensionManager();
      await manager.refreshCache();
      const extensions = manager.getLoadedExtensions();

      expect(extensions).toHaveLength(2);
      const ext1 = extensions.find((e) => e.config.name === 'ext1');
      const ext2 = extensions.find((e) => e.config.name === 'ext2');
      expect(ext1?.contextFiles).toEqual([
        path.join(userExtensionsDir, 'ext1', 'QWEN.md'),
      ]);
      expect(ext2?.contextFiles).toEqual([]);
    });

    it('should load context file path from the extension config', async () => {
      createExtension({
        extensionsDir: userExtensionsDir,
        name: 'ext1',
        version: '1.0.0',
        addContextFile: false,
        contextFileName: 'my-context-file.md',
      });

      const manager = createExtensionManager();
      await manager.refreshCache();
      const extensions = manager.getLoadedExtensions();

      expect(extensions).toHaveLength(1);
      const ext1 = extensions.find((e) => e.config.name === 'ext1');
      expect(ext1?.contextFiles).toEqual([
        path.join(userExtensionsDir, 'ext1', 'my-context-file.md'),
      ]);
    });

    it('should use default QWEN.md when contextFileName is empty array', async () => {
      const extDir = path.join(userExtensionsDir, 'ext-empty-context');
      fs.mkdirSync(extDir, { recursive: true });
      fs.writeFileSync(
        path.join(extDir, EXTENSIONS_CONFIG_FILENAME),
        JSON.stringify({
          name: 'ext-empty-context',
          version: '1.0.0',
          contextFileName: [],
        }),
      );
      fs.writeFileSync(path.join(extDir, 'QWEN.md'), 'context content');

      const manager = createExtensionManager();
      await manager.refreshCache();
      const extensions = manager.getLoadedExtensions();

      expect(extensions).toHaveLength(1);
      const ext = extensions.find((e) => e.config.name === 'ext-empty-context');
      expect(ext?.contextFiles).toEqual([
        path.join(userExtensionsDir, 'ext-empty-context', 'QWEN.md'),
      ]);
    });

    it('should skip extensions with invalid JSON and log a warning', async () => {
      // Good extension
      createExtension({
        extensionsDir: userExtensionsDir,
        name: 'good-ext',
        version: '1.0.0',
      });

      // Bad extension
      const badExtDir = path.join(userExtensionsDir, 'bad-ext');
      fs.mkdirSync(badExtDir);
      const badConfigPath = path.join(badExtDir, EXTENSIONS_CONFIG_FILENAME);
      fs.writeFileSync(badConfigPath, '{ "name": "bad-ext"'); // Malformed

      const manager = createExtensionManager();
      await manager.refreshCache();
      const extensions = manager.getLoadedExtensions();

      expect(extensions).toHaveLength(1);
      expect(extensions[0].config.name).toBe('good-ext');
    });

    it('should skip extensions with invalid setting environment variable names', async () => {
      const extensionDir = path.join(userExtensionsDir, 'bad-setting');
      fs.mkdirSync(extensionDir);
      fs.writeFileSync(
        path.join(extensionDir, EXTENSIONS_CONFIG_FILENAME),
        JSON.stringify({
          name: 'bad-setting',
          version: '1.0.0',
          settings: [
            {
              name: 'API key',
              description: 'API key',
              envVar: 'API_KEY\nforged',
            },
          ],
        }),
      );

      const manager = createExtensionManager();
      await manager.refreshCache();

      expect(manager.getLoadedExtensions()).toEqual([]);
    });

    it('should skip extensions with missing name and log a warning', async () => {
      // Good extension
      createExtension({
        extensionsDir: userExtensionsDir,
        name: 'good-ext',
        version: '1.0.0',
      });

      // Bad extension
      const badExtDir = path.join(userExtensionsDir, 'bad-ext-no-name');
      fs.mkdirSync(badExtDir);
      const badConfigPath = path.join(badExtDir, EXTENSIONS_CONFIG_FILENAME);
      fs.writeFileSync(badConfigPath, JSON.stringify({ version: '1.0.0' }));

      const manager = createExtensionManager();
      await manager.refreshCache();
      const extensions = manager.getLoadedExtensions();

      expect(extensions).toHaveLength(1);
      expect(extensions[0].config.name).toBe('good-ext');
    });

    it('should filter trust out of mcp servers', async () => {
      createExtension({
        extensionsDir: userExtensionsDir,
        name: 'test-extension',
        version: '1.0.0',
        mcpServers: {
          'test-server': {
            command: 'node',
            args: ['server.js'],
            trust: true,
          } as MCPServerConfig,
        },
      });

      const manager = createExtensionManager();
      await manager.refreshCache();
      const extensions = manager.getLoadedExtensions();

      expect(extensions).toHaveLength(1);
      // trust should be filtered from extension.mcpServers (not config.mcpServers)
      expect(extensions[0].mcpServers?.['test-server']?.trust).toBeUndefined();
      // config.mcpServers should still have trust (original config)
      expect(extensions[0].config.mcpServers?.['test-server']?.trust).toBe(
        true,
      );
    });

    it('should only load explicitly named extensions when refreshCache is filtered', async () => {
      createExtension({
        extensionsDir: userExtensionsDir,
        name: 'ext1',
        version: '1.0.0',
      });
      createExtension({
        extensionsDir: userExtensionsDir,
        name: 'ext2',
        version: '1.0.0',
      });

      const manager = createExtensionManager();
      await manager.refreshCache({ names: ['ext2'] });
      const extensions = manager.getLoadedExtensions();

      expect(extensions).toHaveLength(1);
      expect(extensions[0].name).toBe('ext2');
    });

    it('keeps the previous cache when refreshCache fails before replacement', async () => {
      createExtension({
        extensionsDir: userExtensionsDir,
        name: 'stable-ext',
        version: '1.0.0',
      });

      const manager = createExtensionManager();
      await manager.refreshCache();
      expect(manager.getLoadedExtensions().map((ext) => ext.name)).toEqual([
        'stable-ext',
      ]);

      const internals = manager as unknown as {
        loadExtensionsFromExtensionsDir: () => Promise<Extension[]>;
      };
      internals.loadExtensionsFromExtensionsDir = vi
        .fn()
        .mockRejectedValue(new Error('refresh failed'));

      await expect(manager.refreshCache()).rejects.toThrow('refresh failed');
      expect(manager.getLoadedExtensions().map((ext) => ext.name)).toEqual([
        'stable-ext',
      ]);
    });

    describe('command discovery', () => {
      it('should discover .md command files', async () => {
        const extDir = createExtension({
          extensionsDir: userExtensionsDir,
          name: 'md-commands-ext',
          version: '1.0.0',
        });
        const commandsDir = path.join(extDir, 'commands');
        fs.mkdirSync(commandsDir, { recursive: true });
        fs.writeFileSync(path.join(commandsDir, 'greet.md'), 'Hello!');
        fs.writeFileSync(path.join(commandsDir, 'farewell.md'), 'Bye!');

        const manager = createExtensionManager();
        await manager.refreshCache();
        const extensions = manager.getLoadedExtensions();

        const ext = extensions.find((e) => e.config.name === 'md-commands-ext');
        expect(ext?.commands).toEqual(
          expect.arrayContaining(['greet', 'farewell']),
        );
        expect(ext?.commands).toHaveLength(2);
      });

      it('should discover .toml command files', async () => {
        const extDir = createExtension({
          extensionsDir: userExtensionsDir,
          name: 'toml-commands-ext',
          version: '1.0.0',
        });
        const commandsDir = path.join(extDir, 'commands');
        fs.mkdirSync(commandsDir, { recursive: true });
        fs.writeFileSync(
          path.join(commandsDir, 'caveman.toml'),
          'prompt = "Talk like caveman"\ndescription = "Caveman mode"',
        );

        const manager = createExtensionManager();
        await manager.refreshCache();
        const extensions = manager.getLoadedExtensions();

        const ext = extensions.find(
          (e) => e.config.name === 'toml-commands-ext',
        );
        expect(ext?.commands).toEqual(['caveman']);
      });

      it('should discover both .md and .toml command files', async () => {
        const extDir = createExtension({
          extensionsDir: userExtensionsDir,
          name: 'mixed-commands-ext',
          version: '1.0.0',
        });
        const commandsDir = path.join(extDir, 'commands');
        fs.mkdirSync(commandsDir, { recursive: true });
        fs.writeFileSync(path.join(commandsDir, 'greet.md'), 'Hello!');
        fs.writeFileSync(
          path.join(commandsDir, 'caveman.toml'),
          'prompt = "Talk like caveman"',
        );

        const manager = createExtensionManager();
        await manager.refreshCache();
        const extensions = manager.getLoadedExtensions();

        const ext = extensions.find(
          (e) => e.config.name === 'mixed-commands-ext',
        );
        expect(ext?.commands).toEqual(
          expect.arrayContaining(['greet', 'caveman']),
        );
        expect(ext?.commands).toHaveLength(2);
      });

      it('should list both entries when .md and .toml exist for same command name', async () => {
        const extDir = createExtension({
          extensionsDir: userExtensionsDir,
          name: 'dedup-commands-ext',
          version: '1.0.0',
        });
        const commandsDir = path.join(extDir, 'commands');
        fs.mkdirSync(commandsDir, { recursive: true });
        fs.writeFileSync(path.join(commandsDir, 'greet.md'), 'Hello!');
        fs.writeFileSync(
          path.join(commandsDir, 'greet.toml'),
          'prompt = "Hello!"',
        );

        const manager = createExtensionManager();
        await manager.refreshCache();
        const extensions = manager.getLoadedExtensions();

        const ext = extensions.find(
          (e) => e.config.name === 'dedup-commands-ext',
        );
        // No dedup at discovery level — both entries surface so the consent
        // UI shows the true count; downstream CommandService handles conflicts.
        expect(ext?.commands).toEqual(['greet', 'greet']);
      });

      it('should discover nested .toml command files with colon-separated names', async () => {
        const extDir = createExtension({
          extensionsDir: userExtensionsDir,
          name: 'nested-toml-ext',
          version: '1.0.0',
        });
        const nestedDir = path.join(extDir, 'commands', 'caveman');
        fs.mkdirSync(nestedDir, { recursive: true });
        fs.writeFileSync(
          path.join(nestedDir, 'intensity.toml'),
          'prompt = "Switch intensity"',
        );

        const manager = createExtensionManager();
        await manager.refreshCache();
        const extensions = manager.getLoadedExtensions();

        const ext = extensions.find((e) => e.config.name === 'nested-toml-ext');
        expect(ext?.commands).toEqual(['caveman:intensity']);
      });

      it('should replace colons in path segments with underscores', async () => {
        if (process.platform !== 'linux') return; // colons forbidden in filenames on macOS/Windows
        const extDir = createExtension({
          extensionsDir: userExtensionsDir,
          name: 'colon-name-ext',
          version: '1.0.0',
        });
        const commandsDir = path.join(extDir, 'commands');
        fs.mkdirSync(commandsDir, { recursive: true });
        fs.writeFileSync(path.join(commandsDir, 'foo:bar.md'), 'content');

        const manager = createExtensionManager();
        await manager.refreshCache();
        const extensions = manager.getLoadedExtensions();
        const ext = extensions.find((e) => e.config.name === 'colon-name-ext');
        expect(ext?.commands).toEqual(['foo_bar']);
      });

      it('should return empty commands when commands directory does not exist', async () => {
        createExtension({
          extensionsDir: userExtensionsDir,
          name: 'no-cmd-dir-ext',
          version: '1.0.0',
        });
        const manager = createExtensionManager();
        await manager.refreshCache();
        const extensions = manager.getLoadedExtensions();
        const ext = extensions.find((e) => e.config.name === 'no-cmd-dir-ext');
        expect(ext?.commands).toEqual([]);
      });

      it('should return empty commands when no .md or .toml files exist', async () => {
        const extDir = createExtension({
          extensionsDir: userExtensionsDir,
          name: 'no-commands-ext',
          version: '1.0.0',
        });
        const commandsDir = path.join(extDir, 'commands');
        fs.mkdirSync(commandsDir, { recursive: true });
        fs.writeFileSync(path.join(commandsDir, 'readme.txt'), 'not a cmd');

        const manager = createExtensionManager();
        await manager.refreshCache();
        const extensions = manager.getLoadedExtensions();

        const ext = extensions.find((e) => e.config.name === 'no-commands-ext');
        expect(ext?.commands).toEqual([]);
      });
    });
  });

  describe('enableExtension / disableExtension', () => {
    it('changes activation scope in one policy mutation', async () => {
      createExtension({
        extensionsDir: userExtensionsDir,
        name: 'my-extension',
        version: '1.0.0',
      });
      const manager = createExtensionManager();
      await manager.refreshCache();
      const extension = manager.getLoadedExtensions()[0]!;

      const workspaceSnapshot = await manager.setExtensionActivationScope(
        extension.id,
        {
          scope: 'workspace',
          workspacePath: tempWorkspaceDir,
        },
      );
      const snapshot = await manager.setExtensionActivationScope(extension.id, {
        scope: 'user',
      });

      expect(snapshot.generation).toBe(workspaceSnapshot.generation + 1);
      expect(snapshot.extensions[extension.id]).toMatchObject({
        defaultActivation: 'enabled',
        workspaceOverrides: {},
      });
    });

    it('refreshes runtime tools and emits mutation events for an activation scope change', async () => {
      createExtension({
        extensionsDir: userExtensionsDir,
        name: 'my-extension',
        version: '1.0.0',
      });
      const manager = createExtensionManager();
      const events: ExtensionMutationEvent[] = [];
      manager.addMutationListener((event) => events.push(event));
      await manager.refreshCache();
      const extension = manager.getLoadedExtensions()[0]!;
      const refreshTools = vi
        .spyOn(manager, 'refreshTools')
        .mockResolvedValue();

      await manager.setExtensionActivationScope(extension.id, {
        scope: 'workspace',
        workspacePath: tempWorkspaceDir,
      });

      expect(refreshTools).toHaveBeenCalledTimes(1);
      expect(events).toEqual([
        { id: 1, phase: 'start', operation: 'setExtensionActivationScope' },
        { id: 1, phase: 'end', operation: 'setExtensionActivationScope' },
      ]);
    });

    it('returns a committed warning when activation runtime refresh fails', async () => {
      createExtension({
        extensionsDir: userExtensionsDir,
        name: 'my-extension',
        version: '1.0.0',
      });
      const manager = createExtensionManager();
      await manager.refreshCache();
      const extension = manager.getLoadedExtensions()[0]!;
      vi.spyOn(manager, 'refreshTools').mockRejectedValue(
        new Error('refresh failed'),
      );

      const result = await manager.disableExtension(
        extension.name,
        SettingScope.User,
      );

      expect(result.warnings).toEqual([
        {
          code: 'extension_runtime_refresh_failed',
          error: 'refresh failed',
        },
      ]);
      expect(manager.getLoadedExtensions()[0]?.isActive).toBe(false);
    });

    it('keeps the V2 state in sync after a legacy scope mutation', async () => {
      createExtension({
        extensionsDir: userExtensionsDir,
        name: 'my-extension',
        version: '1.0.0',
      });

      const manager = createExtensionManager();
      await manager.refreshCache();
      const extension = manager.getLoadedExtensions()[0]!;

      await manager.disableExtension(extension.name, SettingScope.Workspace);

      const activation = await readActivation(extension);
      expect(activation).toMatchObject({
        effective: 'disabled',
        source: 'workspace_override',
      });
    });

    it('keeps other workspace overrides during a legacy workspace mutation', async () => {
      createExtension({
        extensionsDir: userExtensionsDir,
        name: 'my-extension',
        version: '1.0.0',
      });
      const manager = createExtensionManager();
      await manager.refreshCache();
      const extension = manager.getLoadedExtensions()[0]!;
      const otherWorkspace = path.join(os.tmpdir(), 'other-workspace');
      await new ExtensionStore({
        extensionsDir: userExtensionsDir,
      }).setWorkspaceActivation(extension, otherWorkspace, 'enabled');

      await manager.disableExtension(extension.name, SettingScope.Workspace);

      const snapshot = await readStoreSnapshot();
      expect(snapshot.extensions[extension.id]?.workspaceOverrides).toEqual({
        [otherWorkspace]: 'enabled',
        [fs.realpathSync.native(tempWorkspaceDir)]: 'disabled',
      });
    });

    it('clears only child workspace overrides during a legacy user mutation', async () => {
      createExtension({
        extensionsDir: userExtensionsDir,
        name: 'my-extension',
        version: '1.0.0',
      });
      const manager = createExtensionManager();
      await manager.refreshCache();
      const extension = manager.getLoadedExtensions()[0]!;
      const outsideWorkspace = path.join(os.tmpdir(), 'outside-workspace');
      const store = new ExtensionStore({ extensionsDir: userExtensionsDir });
      await store.setWorkspaceActivation(
        extension,
        tempWorkspaceDir,
        'enabled',
      );
      await store.setWorkspaceActivation(
        extension,
        outsideWorkspace,
        'disabled',
      );

      await manager.disableExtension(extension.name, SettingScope.User);

      const snapshot = await readStoreSnapshot();
      expect(snapshot.extensions[extension.id]?.workspaceOverrides).toEqual({
        [outsideWorkspace]: 'disabled',
      });
    });

    it('should emit mutation lifecycle events around extension changes', async () => {
      createExtension({
        extensionsDir: userExtensionsDir,
        name: 'my-extension',
        version: '1.0.0',
      });

      const manager = createExtensionManager();
      const events: ExtensionMutationEvent[] = [];
      manager.addMutationListener((event) => events.push(event));
      await manager.refreshCache();

      await manager.disableExtension('my-extension', SettingScope.User);

      expect(events).toEqual([
        { id: 1, phase: 'start', operation: 'disableExtension' },
        { id: 1, phase: 'end', operation: 'disableExtension' },
      ]);
    });

    it('should not emit mutation lifecycle events when validation fails', async () => {
      const manager = createExtensionManager();
      const events: ExtensionMutationEvent[] = [];
      manager.addMutationListener((event) => events.push(event));

      await expect(
        manager.disableExtension('missing-extension', SettingScope.User),
      ).rejects.toThrow(
        'Extension with name missing-extension does not exist.',
      );

      await expect(
        manager.enableExtension('missing-extension', SettingScope.User),
      ).rejects.toThrow(
        'Extension with name missing-extension does not exist.',
      );

      expect(events).toEqual([]);
    });

    it('should disable an extension at the user scope', async () => {
      createExtension({
        extensionsDir: userExtensionsDir,
        name: 'my-extension',
        version: '1.0.0',
      });

      const manager = createExtensionManager();
      await manager.refreshCache();

      await manager.disableExtension('my-extension', SettingScope.User);
      expect(manager.isEnabled('my-extension', tempWorkspaceDir)).toBe(false);
    });

    it('should disable an extension at the workspace scope', async () => {
      createExtension({
        extensionsDir: userExtensionsDir,
        name: 'my-extension',
        version: '1.0.0',
      });

      const manager = createExtensionManager();
      await manager.refreshCache();

      await manager.disableExtension('my-extension', SettingScope.Workspace);

      expect(manager.isEnabled('my-extension', tempHomeDir)).toBe(true);
      expect(manager.isEnabled('my-extension', tempWorkspaceDir)).toBe(false);
    });

    it('should handle disabling the same extension twice', async () => {
      createExtension({
        extensionsDir: userExtensionsDir,
        name: 'my-extension',
        version: '1.0.0',
      });

      const manager = createExtensionManager();
      await manager.refreshCache();

      await manager.disableExtension('my-extension', SettingScope.User);
      await manager.disableExtension('my-extension', SettingScope.User);
      expect(manager.isEnabled('my-extension', tempWorkspaceDir)).toBe(false);
    });

    it('should throw an error if you request system scope', async () => {
      createExtension({
        extensionsDir: userExtensionsDir,
        name: 'my-extension',
        version: '1.0.0',
      });

      const manager = createExtensionManager();
      await manager.refreshCache();

      await expect(
        manager.disableExtension('my-extension', SettingScope.System),
      ).rejects.toThrow('System and SystemDefaults scopes are not supported.');
    });

    it('should enable an extension at the user scope', async () => {
      createExtension({
        extensionsDir: userExtensionsDir,
        name: 'ext1',
        version: '1.0.0',
      });

      const manager = createExtensionManager();
      await manager.refreshCache();

      await manager.disableExtension('ext1', SettingScope.User);
      expect(manager.isEnabled('ext1')).toBe(false);

      await manager.enableExtension('ext1', SettingScope.User);
      expect(manager.isEnabled('ext1')).toBe(true);
    });

    it('should enable an extension at the workspace scope', async () => {
      createExtension({
        extensionsDir: userExtensionsDir,
        name: 'ext1',
        version: '1.0.0',
      });

      const manager = createExtensionManager();
      await manager.refreshCache();

      await manager.disableExtension('ext1', SettingScope.Workspace);
      expect(manager.isEnabled('ext1', tempWorkspaceDir)).toBe(false);

      await manager.enableExtension('ext1', SettingScope.Workspace);
      expect(manager.isEnabled('ext1', tempWorkspaceDir)).toBe(true);
    });
  });

  describe('preference-only operations', () => {
    it('should not emit mutation lifecycle events for preference changes', () => {
      const manager = createExtensionManager();
      const events: ExtensionMutationEvent[] = [];
      manager.addMutationListener((event) => events.push(event));

      expect(manager.toggleFavorite('my-extension')).toBe(true);

      expect(events).toEqual([]);
    });
  });

  describe('updateExtension', () => {
    it('keeps workspace-scoped settings out of user scope across an update', async () => {
      const sourcePath = path.join(tempWorkspaceDir, 'settings-source');
      const writeSource = (version: string) => {
        fs.mkdirSync(sourcePath, { recursive: true });
        fs.writeFileSync(
          path.join(sourcePath, EXTENSIONS_CONFIG_FILENAME),
          JSON.stringify({
            name: 'settings-ext',
            version,
            settings: [
              { name: 'Endpoint', description: 'd', envVar: 'ENDPOINT' },
            ],
          }),
        );
      };
      writeSource('1.0.0');
      const projectEnv = path.join(tempWorkspaceDir, '.env');
      fs.writeFileSync(projectEnv, 'ENDPOINT=from-project\n');
      const manager = createExtensionManager();
      await manager.refreshCache();
      const installed = await manager.installExtension(
        { type: 'local', source: sourcePath },
        async () => {},
        async () => 'user-value',
      );
      await updateSetting(
        installed.config,
        installed.id,
        'ENDPOINT',
        async () => 'workspace-value',
        ExtensionSettingScope.WORKSPACE,
      );

      writeSource('1.0.1');
      const updateInfo = await manager.updateExtension(
        installed,
        ExtensionUpdateState.UPDATE_AVAILABLE,
        () => {},
      );

      expect(updateInfo?.updatedVersion).toBe('1.0.1');
      const updated = manager
        .getLoadedExtensions()
        .find((extension) => extension.id === installed.id)!;
      await expect(
        getScopedEnvContents(
          updated.config,
          updated.id,
          ExtensionSettingScope.USER,
        ),
      ).resolves.toEqual({ ENDPOINT: 'user-value' });
      await expect(
        getScopedEnvContents(
          updated.config,
          updated.id,
          ExtensionSettingScope.WORKSPACE,
        ),
      ).resolves.toEqual({ ENDPOINT: 'workspace-value' });
      expect(fs.readFileSync(projectEnv, 'utf8')).toBe(
        'ENDPOINT=from-project\n',
      );
    });

    it('rejects a stale update after the artifact changes', async () => {
      const archivePath = path.join(tempWorkspaceDir, 'stale-update.zip');
      fs.writeFileSync(archivePath, 'archive');
      const writeExtension = (destination: string, version: string) => {
        fs.mkdirSync(destination, { recursive: true });
        fs.writeFileSync(
          path.join(destination, EXTENSIONS_CONFIG_FILENAME),
          JSON.stringify({ name: 'my-extension', version }),
        );
      };
      mockExtractArchiveFile.mockImplementation(
        async (_source: string, destination: string) => {
          writeExtension(destination, '1.0.0');
        },
      );
      const manager = createExtensionManager();
      await manager.refreshCache();
      const metadata = { type: 'local' as const, source: archivePath };
      const installed = await manager.installExtension(
        metadata,
        async () => {},
      );
      const concurrentStore = new ExtensionStore();
      mockExtractArchiveFile.mockImplementation(
        async (_source: string, destination: string) => {
          writeExtension(destination, '2.0.0');
          const before = await concurrentStore.readSnapshot();
          const staging = await concurrentStore.createStagingDirectory();
          writeExtension(staging, 'concurrent');
          await concurrentStore.commitArtifact({
            operation: 'update',
            identity: { id: installed.id, name: installed.name },
            stagingDirectory: staging,
            destinationDirectory: installed.path,
            expectedArtifactGeneration:
              before.extensions[installed.id]!.artifactGeneration,
          });
        },
      );

      await expect(
        manager.updateExtension(
          installed,
          ExtensionUpdateState.UPDATE_AVAILABLE,
          () => {},
        ),
      ).rejects.toMatchObject({ code: 'extension_conflict' });
      expect(
        JSON.parse(
          fs.readFileSync(
            path.join(installed.path, EXTENSIONS_CONFIG_FILENAME),
            'utf8',
          ),
        ),
      ).toMatchObject({ version: 'concurrent' });
    });

    it('reports a committed update reload failure as needing restart', async () => {
      const archivePath = path.join(tempWorkspaceDir, 'reload-failure.zip');
      fs.writeFileSync(archivePath, 'archive');
      createExtension({
        extensionsDir: userExtensionsDir,
        name: 'my-extension',
        version: '1.0.0',
        installMetadata: {
          type: 'local',
          source: archivePath,
          originSource: 'QwenCode',
        },
      });
      mockExtractArchiveFile.mockImplementation(
        async (_source: string, destination: string) => {
          fs.mkdirSync(destination, { recursive: true });
          fs.writeFileSync(
            path.join(destination, EXTENSIONS_CONFIG_FILENAME),
            JSON.stringify({ name: 'my-extension', version: '2.0.0' }),
          );
        },
      );
      const manager = createExtensionManager();
      await manager.refreshCache();
      const extension = manager.getLoadedExtensions()[0]!;
      const updatedExtension = {
        ...extension,
        version: '2.0.0',
        config: { ...extension.config, version: '2.0.0' },
      };
      vi.spyOn(manager, 'loadExtension')
        .mockResolvedValueOnce(updatedExtension)
        .mockResolvedValueOnce(null);
      const callback = vi.fn();

      await expect(
        manager.updateExtension(
          extension,
          ExtensionUpdateState.UPDATE_AVAILABLE,
          callback,
        ),
      ).resolves.toEqual({
        name: 'my-extension',
        originalVersion: '1.0.0',
        updatedVersion: '2.0.0',
        warnings: [
          {
            code: 'extension_reload_failed',
            error: 'Extension not found after commit.',
          },
        ],
      });

      expect(callback).toHaveBeenLastCalledWith(
        'my-extension',
        ExtensionUpdateState.UPDATED_NEEDS_RESTART,
      );
      expect(manager.getLoadedExtensions()).toEqual([]);
    });

    it('reports a committed update runtime warning as needing restart', async () => {
      const archivePath = path.join(tempWorkspaceDir, 'refresh-update.zip');
      fs.writeFileSync(archivePath, 'archive');
      createExtension({
        extensionsDir: userExtensionsDir,
        name: 'my-extension',
        version: '1.0.0',
        installMetadata: {
          type: 'local',
          source: archivePath,
          originSource: 'QwenCode',
        },
      });
      mockExtractArchiveFile.mockImplementation(
        async (_source: string, destination: string) => {
          fs.mkdirSync(destination, { recursive: true });
          fs.writeFileSync(
            path.join(destination, EXTENSIONS_CONFIG_FILENAME),
            JSON.stringify({ name: 'my-extension', version: '2.0.0' }),
          );
        },
      );
      const manager = createExtensionManager();
      await manager.refreshCache();
      const extension = manager.getLoadedExtensions()[0]!;
      vi.spyOn(manager, 'refreshTools').mockRejectedValueOnce(
        new Error('runtime stale'),
      );
      const callback = vi.fn();

      await manager.updateExtension(
        extension,
        ExtensionUpdateState.UPDATE_AVAILABLE,
        callback,
      );

      expect(callback).toHaveBeenLastCalledWith(
        'my-extension',
        ExtensionUpdateState.UPDATED_NEEDS_RESTART,
      );
    });

    it('surfaces a committed settings compatibility warning distinctly', async () => {
      const archivePath = path.join(tempWorkspaceDir, 'settings-update.zip');
      fs.writeFileSync(archivePath, 'archive');
      createExtension({
        extensionsDir: userExtensionsDir,
        name: 'my-extension',
        version: '1.0.0',
        installMetadata: {
          type: 'local',
          source: archivePath,
          originSource: 'QwenCode',
        },
      });
      mockExtractArchiveFile.mockImplementation(
        async (_source: string, destination: string) => {
          fs.mkdirSync(destination, { recursive: true });
          fs.writeFileSync(
            path.join(destination, EXTENSIONS_CONFIG_FILENAME),
            JSON.stringify({ name: 'my-extension', version: '2.0.0' }),
          );
        },
      );
      const manager = createExtensionManager();
      await manager.refreshCache();
      const extension = manager.getLoadedExtensions()[0]!;
      const internals = manager as unknown as {
        prepareExtensionUpdateFromState(
          extension: Extension,
        ): Promise<PreparedExtensionMutation>;
      };
      const prepared =
        await internals.prepareExtensionUpdateFromState(extension);
      Object.defineProperty(prepared, 'commitSettings', {
        value: vi.fn().mockRejectedValue(new Error('legacy sync unavailable')),
      });
      vi.spyOn(
        internals,
        'prepareExtensionUpdateFromState',
      ).mockResolvedValueOnce(prepared);
      const callback = vi.fn();

      await expect(
        manager.updateExtension(
          extension,
          ExtensionUpdateState.UPDATE_AVAILABLE,
          callback,
        ),
      ).resolves.toMatchObject({
        warnings: [
          {
            code: 'extension_settings_legacy_sync_failed',
            error: 'legacy sync unavailable',
          },
        ],
      });
      expect(callback).toHaveBeenLastCalledWith(
        'my-extension',
        ExtensionUpdateState.UPDATED_WITH_WARNINGS,
      );
    });

    it('should end mutation lifecycle events when temp directory creation fails', async () => {
      const archivePath = path.join(tempWorkspaceDir, 'update.zip');
      fs.writeFileSync(archivePath, 'archive');
      const extensionPath = createExtension({
        extensionsDir: userExtensionsDir,
        name: 'my-extension',
        version: '1.0.0',
        installMetadata: {
          type: 'local',
          source: archivePath,
          originSource: 'QwenCode',
        },
      });
      const manager = createExtensionManager();
      const events: ExtensionMutationEvent[] = [];
      const callback = vi.fn();
      manager.addMutationListener((event) => events.push(event));
      await manager.refreshCache();
      const extension = manager
        .getLoadedExtensions()
        .find((entry) => entry.path === extensionPath);
      vi.spyOn(ExtensionStorage, 'createTmpDir').mockRejectedValueOnce(
        new Error('disk full'),
      );

      await expect(
        manager.updateExtension(
          extension!,
          ExtensionUpdateState.UPDATE_AVAILABLE,
          callback,
        ),
      ).rejects.toThrow('disk full');

      expect(events).toEqual([
        { id: 1, phase: 'start', operation: 'updateExtension' },
        { id: 1, phase: 'end', operation: 'updateExtension' },
      ]);
      expect(callback).toHaveBeenCalledWith(
        'my-extension',
        ExtensionUpdateState.ERROR,
      );
    });
  });

  describe('enabledExtensionOverrides', () => {
    it('should mark all extensions as active if no enabled extensions are provided', async () => {
      createExtension({
        extensionsDir: userExtensionsDir,
        name: 'ext1',
        version: '1.0.0',
      });
      createExtension({
        extensionsDir: userExtensionsDir,
        name: 'ext2',
        version: '1.0.0',
      });

      const manager = createExtensionManager();
      await manager.refreshCache();
      const extensions = manager.getLoadedExtensions();

      expect(extensions).toHaveLength(2);
      expect(extensions.every((e) => e.isActive)).toBe(true);
    });

    it('should mark only the enabled extensions as active', async () => {
      createExtension({
        extensionsDir: userExtensionsDir,
        name: 'ext1',
        version: '1.0.0',
      });
      createExtension({
        extensionsDir: userExtensionsDir,
        name: 'ext2',
        version: '1.0.0',
      });
      createExtension({
        extensionsDir: userExtensionsDir,
        name: 'ext3',
        version: '1.0.0',
      });

      const manager = createExtensionManager({
        enabledExtensionOverrides: ['ext1', 'ext3'],
      });
      await manager.refreshCache();
      const extensions = manager.getLoadedExtensions();

      expect(extensions.find((e) => e.name === 'ext1')?.isActive).toBe(true);
      expect(extensions.find((e) => e.name === 'ext2')?.isActive).toBe(false);
      expect(extensions.find((e) => e.name === 'ext3')?.isActive).toBe(true);
    });

    it('should mark all extensions as inactive when "none" is provided', async () => {
      createExtension({
        extensionsDir: userExtensionsDir,
        name: 'ext1',
        version: '1.0.0',
      });
      createExtension({
        extensionsDir: userExtensionsDir,
        name: 'ext2',
        version: '1.0.0',
      });

      const manager = createExtensionManager({
        enabledExtensionOverrides: ['none'],
      });
      await manager.refreshCache();
      const extensions = manager.getLoadedExtensions();

      expect(extensions.every((e) => !e.isActive)).toBe(true);
    });

    it('should treat "none" as disabling all only when it is the sole override', async () => {
      createExtension({
        extensionsDir: userExtensionsDir,
        name: 'ext1',
        version: '1.0.0',
      });
      createExtension({
        extensionsDir: userExtensionsDir,
        name: 'ext2',
        version: '1.0.0',
      });

      const manager = createExtensionManager({
        enabledExtensionOverrides: ['none', 'ext1'],
      });
      await manager.refreshCache();
      const extensions = manager.getLoadedExtensions();

      expect(manager.isEnabled('ext1')).toBe(true);
      expect(extensions.find((e) => e.name === 'ext1')?.isActive).toBe(true);
      expect(extensions.find((e) => e.name === 'ext2')?.isActive).toBe(false);
    });

    it('should handle case-insensitivity', async () => {
      createExtension({
        extensionsDir: userExtensionsDir,
        name: 'ext1',
        version: '1.0.0',
      });

      const manager = createExtensionManager({
        enabledExtensionOverrides: ['EXT1'],
      });
      await manager.refreshCache();
      const extensions = manager.getLoadedExtensions();

      expect(extensions.find((e) => e.name === 'ext1')?.isActive).toBe(true);
    });
  });

  describe('loadExtensionConfig', () => {
    it('should resolve environment variables in extension configuration', async () => {
      process.env['TEST_API_KEY'] = 'test-api-key-123';
      process.env['TEST_DB_URL'] = 'postgresql://localhost:5432/testdb';

      try {
        const extDir = path.join(userExtensionsDir, 'test-extension');
        fs.mkdirSync(extDir);

        const extensionConfig = {
          name: 'test-extension',
          version: '1.0.0',
          mcpServers: {
            'test-server': {
              command: 'node',
              args: ['server.js'],
              env: {
                API_KEY: '$TEST_API_KEY',
                DATABASE_URL: '${TEST_DB_URL}',
                STATIC_VALUE: 'no-substitution',
              },
            },
          },
        };
        fs.writeFileSync(
          path.join(extDir, EXTENSIONS_CONFIG_FILENAME),
          JSON.stringify(extensionConfig),
        );

        const manager = createExtensionManager();
        await manager.refreshCache();
        const extensions = manager.getLoadedExtensions();

        expect(extensions).toHaveLength(1);
        const extension = extensions[0];
        expect(extension.config.name).toBe('test-extension');
        expect(extension.config.mcpServers).toBeDefined();

        const serverConfig = extension.config.mcpServers?.['test-server'];
        expect(serverConfig).toBeDefined();
        expect(serverConfig?.env).toBeDefined();
        expect(serverConfig?.env?.['API_KEY']).toBe('test-api-key-123');
        expect(serverConfig?.env?.['DATABASE_URL']).toBe(
          'postgresql://localhost:5432/testdb',
        );
        expect(serverConfig?.env?.['STATIC_VALUE']).toBe('no-substitution');
      } finally {
        delete process.env['TEST_API_KEY'];
        delete process.env['TEST_DB_URL'];
      }
    });

    it('should handle missing environment variables gracefully', async () => {
      const extDir = path.join(userExtensionsDir, 'test-extension');
      fs.mkdirSync(extDir);

      const extensionConfig = {
        name: 'test-extension',
        version: '1.0.0',
        mcpServers: {
          'test-server': {
            command: 'node',
            args: ['server.js'],
            env: {
              MISSING_VAR: '$UNDEFINED_ENV_VAR',
              MISSING_VAR_BRACES: '${ALSO_UNDEFINED}',
            },
          },
        },
      };

      fs.writeFileSync(
        path.join(extDir, EXTENSIONS_CONFIG_FILENAME),
        JSON.stringify(extensionConfig),
      );

      const manager = createExtensionManager();
      await manager.refreshCache();
      const extensions = manager.getLoadedExtensions();

      expect(extensions).toHaveLength(1);
      const extension = extensions[0];
      const serverConfig = extension.config.mcpServers!['test-server'];
      expect(serverConfig.env).toBeDefined();
      expect(serverConfig.env!['MISSING_VAR']).toBe('$UNDEFINED_ENV_VAR');
      expect(serverConfig.env!['MISSING_VAR_BRACES']).toBe('${ALSO_UNDEFINED}');
    });
    describe('refreshTools', () => {
      it('refreshTools should return early if config is not set', async () => {
        const manager = createExtensionManager();
        // Should not throw when config is undefined
        await expect(manager.refreshTools()).resolves.not.toThrow();
      });

      it('refreshTools should call all refresh methods', async () => {
        const mockRefreshCache = vi.fn();
        const mockReinitializeMcpServers = vi.fn();
        const mockReloadHooks = vi.fn();
        const mockRefreshHierarchicalMemory = vi.fn();
        const mockSettingsMcpServers = { server: { command: 'cmd' } };

        const mockConfig = {
          getLlmClient: () => ({
            isInitialized: () => false,
            setTools: vi.fn(),
          }),
          getSettingsMcpServers: () => mockSettingsMcpServers,
          reinitializeMcpServers: mockReinitializeMcpServers,
          getSkillManager: () => ({
            refreshCache: mockRefreshCache,
          }),
          getSubagentManager: () => ({
            refreshCache: mockRefreshCache,
          }),
          getHookSystem: () => ({
            reload: mockReloadHooks,
          }),
          refreshHierarchicalMemory: mockRefreshHierarchicalMemory,
        };

        const manager = createExtensionManager();
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (manager as any).config = mockConfig;

        await manager.refreshTools();

        expect(mockReinitializeMcpServers).toHaveBeenCalledOnce();
        expect(mockReinitializeMcpServers).toHaveBeenCalledWith(
          mockSettingsMcpServers,
        );
        expect(mockRefreshCache).toHaveBeenCalledTimes(2); // skillManager and subagentManager
        expect(mockReloadHooks).toHaveBeenCalledOnce();
        expect(mockRefreshHierarchicalMemory).toHaveBeenCalledOnce();
      });
    });
  });

  describe('extensionManager utility functions', () => {
    describe('validateName', () => {
      it('should accept valid extension names', () => {
        expect(() => validateName('my-extension')).not.toThrow();
        expect(() => validateName('Extension123')).not.toThrow();
        expect(() => validateName('test-ext-1')).not.toThrow();
        expect(() => validateName('UPPERCASE')).not.toThrow();
      });

      it('should accept names with underscores and dots', () => {
        expect(() => validateName('my_extension')).not.toThrow();
        expect(() => validateName('my.extension')).not.toThrow();
        expect(() => validateName('my_ext.v1')).not.toThrow();
        expect(() => validateName('ext_1.2.3')).not.toThrow();
      });

      it('should reject names with invalid characters', () => {
        expect(() => validateName('my extension')).toThrow(
          'Invalid extension name',
        );
        expect(() => validateName('my@ext')).toThrow('Invalid extension name');
      });

      it('should reject empty names', () => {
        expect(() => validateName('')).toThrow('Invalid extension name');
      });
    });

    describe('hashValue', () => {
      it('should generate consistent hash for same input', () => {
        const hash1 = hashValue('test-input');
        const hash2 = hashValue('test-input');
        expect(hash1).toBe(hash2);
      });

      it('should generate different hashes for different inputs', () => {
        const hash1 = hashValue('input-1');
        const hash2 = hashValue('input-2');
        expect(hash1).not.toBe(hash2);
      });

      it('should generate a valid SHA256 hash', () => {
        const hash = hashValue('test');
        expect(hash).toMatch(/^[a-f0-9]{64}$/);
      });
    });

    describe('getExtensionId', () => {
      it('should use hashed name when no install metadata', () => {
        const config: ExtensionConfig = { name: 'test-ext', version: '1.0.0' };
        const id = getExtensionId(config);
        expect(id).toBe(hashValue('test-ext'));
      });

      it('should use hashed source for local install', () => {
        const config: ExtensionConfig = { name: 'test-ext', version: '1.0.0' };
        const metadata = { type: 'local' as const, source: '/path/to/ext' };
        const id = getExtensionId(config, metadata);
        expect(id).toBe(hashValue('/path/to/ext'));
      });

      it('gives same-named uploads distinct ids', () => {
        const config: ExtensionConfig = { name: 'test-ext', version: '1.0.0' };
        const first = getExtensionId(config, {
          type: 'local',
          source: 'upload:v1:first:extension.zip',
        });
        const second = getExtensionId(config, {
          type: 'local',
          source: 'upload:v1:second:extension.zip',
        });

        expect(first).not.toBe(second);
      });

      it('gives plugins from the same marketplace distinct ids (#7568)', () => {
        const metadataFor = (pluginName: string) => ({
          type: 'local' as const,
          source: '/path/to/skills',
          pluginName,
        });
        const dotnetId = getExtensionId(
          { name: 'dotnet', version: '1.0.0' },
          metadataFor('dotnet'),
        );
        const dotnetTestId = getExtensionId(
          { name: 'dotnet-test', version: '1.0.0' },
          metadataFor('dotnet-test'),
        );

        expect(dotnetId).toBe(hashValue('/path/to/skills:dotnet'));
        expect(dotnetTestId).toBe(hashValue('/path/to/skills:dotnet-test'));
        expect(dotnetId).not.toBe(dotnetTestId);
      });

      it('keeps the source-only id when no plugin name is recorded', () => {
        const config: ExtensionConfig = { name: 'solo-ext', version: '1.0.0' };
        const metadata = {
          type: 'local' as const,
          source: '/path/to/solo',
        };
        expect(getExtensionId(config, metadata)).toBe(
          hashValue('/path/to/solo'),
        );
      });
    });
  });

  describe('hooks loading and processing', () => {
    it('should load hooks from qwen-extension.json', async () => {
      const extensionDir = path.join(userExtensionsDir, 'hooks-extension');
      fs.mkdirSync(extensionDir, { recursive: true });

      // Create qwen-extension.json with hooks
      const configWithHooks = {
        name: 'hooks-extension',
        version: '1.0.0',
        hooks: {
          PreToolUse: [
            {
              description: 'Run before tool start',
              hooks: [
                {
                  type: 'command',
                  command: 'echo "hello"',
                },
              ],
            },
          ],
        },
      };

      fs.writeFileSync(
        path.join(extensionDir, EXTENSIONS_CONFIG_FILENAME),
        JSON.stringify(configWithHooks),
      );

      const manager = createExtensionManager();
      await manager.refreshCache();
      const extensions = manager.getLoadedExtensions();

      expect(extensions).toHaveLength(1);
      expect(extensions[0].hooks).toBeDefined();
      expect(extensions[0].hooks!['PreToolUse']).toHaveLength(1);
      expect(
        (
          extensions[0].hooks!['PreToolUse']![0].hooks![0] as {
            command: string;
          }
        ).command,
      ).toBe('echo "hello"');
    });

    it('should load hooks from hooks/hooks.json when not in main config', async () => {
      const extensionDir = path.join(
        userExtensionsDir,
        'hooks-from-file-extension',
      );
      fs.mkdirSync(extensionDir, { recursive: true });

      // Create qwen-extension.json without hooks
      const configWithoutHooks = {
        name: 'hooks-from-file-extension',
        version: '1.0.0',
      };

      fs.writeFileSync(
        path.join(extensionDir, EXTENSIONS_CONFIG_FILENAME),
        JSON.stringify(configWithoutHooks),
      );

      // Create hooks directory and hooks.json
      const hooksDir = path.join(extensionDir, 'hooks');
      fs.mkdirSync(hooksDir, { recursive: true });

      const hooksJson = {
        PostToolUse: [
          {
            description: 'Run after install',
            hooks: [
              {
                type: 'command',
                command: `echo "installed in ${extensionDir}"`,
              },
            ],
          },
        ],
      };

      fs.writeFileSync(
        path.join(hooksDir, 'hooks.json'),
        JSON.stringify(hooksJson),
      );

      const manager = createExtensionManager();
      await manager.refreshCache();
      const extensions = manager.getLoadedExtensions();

      expect(extensions).toHaveLength(1);
      expect(extensions[0].hooks).toBeDefined();
      expect(extensions[0].hooks!['PostToolUse']).toHaveLength(1);
      expect(
        (
          extensions[0].hooks!['PostToolUse']![0].hooks![0] as {
            command: string;
          }
        ).command,
      ).toBe(`echo "installed in ${extensionDir}"`);
    });

    it('should substitute ${CLAUDE_PLUGIN_ROOT} variable in hooks', async () => {
      const extensionDir = path.join(userExtensionsDir, 'hooks-var-extension');
      fs.mkdirSync(extensionDir, { recursive: true });

      // Create qwen-extension.json with hooks using ${CLAUDE_PLUGIN_ROOT}
      const configWithHooks = {
        name: 'hooks-var-extension',
        version: '1.0.0',
        hooks: {
          PreToolUse: [
            {
              description: 'Run before start with var',
              hooks: [
                {
                  type: 'command',
                  command: '${CLAUDE_PLUGIN_ROOT}/scripts/setup.sh',
                },
              ],
            },
          ],
        },
      };

      fs.writeFileSync(
        path.join(extensionDir, EXTENSIONS_CONFIG_FILENAME),
        JSON.stringify(configWithHooks),
      );

      const manager = createExtensionManager();
      await manager.refreshCache();
      const extensions = manager.getLoadedExtensions();

      expect(extensions).toHaveLength(1);
      expect(extensions[0].hooks).toBeDefined();
      expect(extensions[0].hooks!['PreToolUse']).toHaveLength(1);
      expect(
        (
          extensions[0].hooks!['PreToolUse']![0].hooks![0] as {
            command: string;
          }
        ).command,
      ).toBe(`${extensionDir}/scripts/setup.sh`);
    });

    it('should load hooks from config.hooks string path', async () => {
      const extensionDir = path.join(
        userExtensionsDir,
        'hooks-from-config-path',
      );
      fs.mkdirSync(extensionDir, { recursive: true });

      // Create custom hooks directory and hooks file
      const customHooksDir = path.join(extensionDir, 'custom-hooks');
      fs.mkdirSync(customHooksDir, { recursive: true });

      const hooksJson = {
        PreToolUse: [
          {
            description: 'Run from custom path',
            hooks: [
              {
                type: 'command',
                command: 'echo "custom hooks path"',
              },
            ],
          },
        ],
      };

      fs.writeFileSync(
        path.join(customHooksDir, 'hooks.json'),
        JSON.stringify(hooksJson),
      );

      // Create qwen-extension.json with hooks as string path
      const configWithHooksPath = {
        name: 'hooks-from-config-path',
        version: '1.0.0',
        hooks: 'custom-hooks/hooks.json',
      };

      fs.writeFileSync(
        path.join(extensionDir, EXTENSIONS_CONFIG_FILENAME),
        JSON.stringify(configWithHooksPath),
      );

      const manager = createExtensionManager();
      await manager.refreshCache();
      const extensions = manager.getLoadedExtensions();

      expect(extensions).toHaveLength(1);
      expect(extensions[0].hooks).toBeDefined();
      expect(extensions[0].hooks!['PreToolUse']).toHaveLength(1);
      expect(
        (
          extensions[0].hooks!['PreToolUse']![0].hooks![0] as {
            command: string;
          }
        ).command,
      ).toBe('echo "custom hooks path"');
    });

    it('should prefer config.hooks string path over hooks/hooks.json', async () => {
      const extensionDir = path.join(
        userExtensionsDir,
        'hooks-prefer-config-path',
      );
      fs.mkdirSync(extensionDir, { recursive: true });

      // Create hooks/hooks.json
      const hooksDir = path.join(extensionDir, 'hooks');
      fs.mkdirSync(hooksDir, { recursive: true });
      fs.writeFileSync(
        path.join(hooksDir, 'hooks.json'),
        JSON.stringify({
          PreToolUse: [
            {
              description: 'From hooks directory',
              hooks: [{ type: 'command', command: 'echo "hooks dir"' }],
            },
          ],
        }),
      );

      // Create custom hooks file
      const customHooksDir = path.join(extensionDir, 'custom');
      fs.mkdirSync(customHooksDir, { recursive: true });
      fs.writeFileSync(
        path.join(customHooksDir, 'my-hooks.json'),
        JSON.stringify({
          PreToolUse: [
            {
              description: 'From config path',
              hooks: [{ type: 'command', command: 'echo "config path"' }],
            },
          ],
        }),
      );

      // Create qwen-extension.json with hooks as string path
      fs.writeFileSync(
        path.join(extensionDir, EXTENSIONS_CONFIG_FILENAME),
        JSON.stringify({
          name: 'hooks-prefer-config-path',
          version: '1.0.0',
          hooks: 'custom/my-hooks.json',
        }),
      );

      const manager = createExtensionManager();
      await manager.refreshCache();
      const extensions = manager.getLoadedExtensions();

      expect(extensions).toHaveLength(1);
      expect(extensions[0].hooks).toBeDefined();
      expect(
        (
          extensions[0].hooks!['PreToolUse']![0].hooks![0] as {
            command: string;
          }
        ).command,
      ).toBe('echo "config path"');
    });

    it('should substitute ${CLAUDE_PLUGIN_ROOT} in hooks file from config.hooks string path', async () => {
      const extensionDir = path.join(
        userExtensionsDir,
        'hooks-var-from-config-path',
      );
      fs.mkdirSync(extensionDir, { recursive: true });

      const customHooksDir = path.join(extensionDir, 'my-hooks');
      fs.mkdirSync(customHooksDir, { recursive: true });

      const hooksJson = {
        PreToolUse: [
          {
            description: 'Run with variable',
            hooks: [
              {
                type: 'command',
                command: '${CLAUDE_PLUGIN_ROOT}/scripts/setup.sh',
              },
            ],
          },
        ],
      };

      fs.writeFileSync(
        path.join(customHooksDir, 'hooks.json'),
        JSON.stringify(hooksJson),
      );

      const configWithHooksPath = {
        name: 'hooks-var-from-config-path',
        version: '1.0.0',
        hooks: 'my-hooks/hooks.json',
      };

      fs.writeFileSync(
        path.join(extensionDir, EXTENSIONS_CONFIG_FILENAME),
        JSON.stringify(configWithHooksPath),
      );

      const manager = createExtensionManager();
      await manager.refreshCache();
      const extensions = manager.getLoadedExtensions();

      expect(extensions).toHaveLength(1);
      expect(extensions[0].hooks).toBeDefined();
      expect(extensions[0].hooks!['PreToolUse']).toHaveLength(1);
      expect(
        (
          extensions[0].hooks!['PreToolUse']![0].hooks![0] as {
            command: string;
          }
        ).command,
      ).toBe(`${extensionDir}/scripts/setup.sh`);
    });
  });
});
