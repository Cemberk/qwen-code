/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

// File for 'qwen mcp add' command
import type { CommandModule } from 'yargs';
import { loadSettings, SettingScope } from '../../config/settings.js';
import { writeStdoutLine, writeStderrLine } from '../../utils/stdioHelpers.js';
import type { MCPServerConfig } from '@qwen-code/qwen-code-core';

async function addMcpServer(
  name: string,
  command: string,
  args: Array<string | number> | undefined,
  options: {
    scope: string;
    env: string[] | undefined;
    timeout?: number;
    trust?: boolean;
    description?: string;
    includeTools?: string[];
    excludeTools?: string[];
  },
) {
  const {
    scope,
    env,
    timeout,
    trust,
    description,
    includeTools,
    excludeTools,
  } = options;

  const settings = loadSettings(process.cwd());
  const inHome = settings.workspace.path === settings.user.path;

  if (scope === 'project' && inHome) {
    writeStderrLine(
      'Error: Please use --scope user to edit settings in the home directory.',
    );
    process.exit(1);
  }

  const settingsScope =
    scope === 'user' ? SettingScope.User : SettingScope.Workspace;

  const newServer: Partial<MCPServerConfig> = {
    command,
    args: args?.map(String),
    env: env?.reduce(
      (acc, curr) => {
        const separator = curr.indexOf('=');
        if (separator === -1) {
          return acc;
        }
        const key = curr.slice(0, separator);
        const value = curr.slice(separator + 1);
        if (key && value) {
          acc[key] = value;
        }
        return acc;
      },
      {} as Record<string, string>,
    ),
    timeout,
    trust,
    description,
    includeTools,
    excludeTools,
  };

  const existingSettings = settings.forScope(settingsScope).settings;
  const mcpServers = existingSettings.mcpServers || {};

  const isExistingServer = !!mcpServers[name];
  if (isExistingServer) {
    writeStdoutLine(
      `MCP server "${name}" is already configured within ${scope} settings.`,
    );
  }

  mcpServers[name] = newServer as MCPServerConfig;

  settings.setValue(settingsScope, 'mcpServers', mcpServers);

  if (isExistingServer) {
    writeStdoutLine(`MCP server "${name}" updated in ${scope} settings.`);
  } else {
    writeStdoutLine(`MCP server "${name}" added to ${scope} settings.`);
  }
}

export const addCommand: CommandModule = {
  command: 'add <name> <command> [args...]',
  describe: 'Add a server',
  builder: (yargs) =>
    yargs
      .usage('Usage: qwen mcp add [options] <name> <command> [args...]')
      .parserConfiguration({
        'unknown-options-as-args': true, // Pass unknown options as server args
        'populate--': true, // Populate server args after -- separator
      })
      .positional('name', {
        describe: 'Name of the server',
        type: 'string',
        demandOption: true,
      })
      .positional('command', {
        describe: 'Command that starts the stdio server',
        type: 'string',
        demandOption: true,
      })
      .option('scope', {
        alias: 's',
        describe: 'Configuration scope (user or project)',
        type: 'string',
        default: 'user',
        choices: ['user', 'project'],
      })
      .option('env', {
        alias: 'e',
        describe: 'Set environment variables (e.g. -e KEY=value)',
        type: 'array',
        string: true,
        nargs: 1,
      })
      .option('timeout', {
        describe: 'Set connection timeout in milliseconds',
        type: 'number',
      })
      .option('trust', {
        describe:
          'Trust the server (bypass its tool call confirmations in a trusted workspace)',
        type: 'boolean',
      })
      .option('description', {
        describe: 'Set the description for the server',
        type: 'string',
      })
      .option('include-tools', {
        describe: 'A comma-separated list of tools to include',
        type: 'array',
        string: true,
      })
      .option('exclude-tools', {
        describe: 'A comma-separated list of tools to exclude',
        type: 'array',
        string: true,
      })
      .middleware((argv) => {
        // Handle -- separator args as server args if present
        if (argv['--']) {
          const existingArgs = (argv['args'] as Array<string | number>) || [];
          argv['args'] = [...existingArgs, ...(argv['--'] as string[])];
        }
      }),
  handler: async (argv) => {
    await addMcpServer(
      argv['name'] as string,
      argv['command'] as string,
      argv['args'] as Array<string | number>,
      {
        scope: argv['scope'] as string,
        env: argv['env'] as string[],
        timeout: argv['timeout'] as number | undefined,
        trust: argv['trust'] as boolean | undefined,
        description: argv['description'] as string | undefined,
        includeTools: argv['includeTools'] as string[] | undefined,
        excludeTools: argv['excludeTools'] as string[] | undefined,
      },
    );
  },
};
