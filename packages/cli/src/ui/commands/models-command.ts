/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { spawn } from 'node:child_process';
import { findExecutable } from '@qwen-code/qwen-code-core/local-models/engine.js';
import {
  appleGpuMemoryLimit,
  localModelBytes,
  modelSizeProblem,
} from '@qwen-code/qwen-code-core/local-models/gpu-memory.js';
import { resolveLocalModelPath } from '@qwen-code/qwen-code-core/local-models/hf-cache.js';
import { getLocalModelServer } from '@qwen-code/qwen-code-core/local-models/local-model-server.js';
import {
  BUILT_IN_LOCAL_MODELS,
  isHuggingFaceRepo,
  validateLocalModels,
  withLocalModelProviders,
  type LocalModelConfig,
} from '@qwen-code/qwen-code-core/local-models/local-models.js';
import { SettingScope, type LoadedSettings } from '../../config/settings.js';
import { t } from '../../i18n/index.js';
import { MessageType } from '../types.js';
import {
  CommandKind,
  type CommandContext,
  type MessageActionReturn,
  type SlashCommand,
} from './types.js';

function localModels(settings: LoadedSettings): LocalModelConfig[] {
  return validateLocalModels(
    settings.merged.localModels ?? BUILT_IN_LOCAL_MODELS,
  );
}

function isDownloaded(model: LocalModelConfig): boolean {
  try {
    resolveLocalModelPath(model);
    return true;
  } catch {
    return false;
  }
}

/** Run the user's `hf` tool without their token or telemetry. */
function runHf(args: string[]): Promise<{ ok: boolean; output: string }> {
  const hf = findExecutable('hf');
  if (!hf) {
    return Promise.resolve({
      ok: false,
      output:
        'The hf tool was not found on PATH. Install it with: brew install huggingface-cli',
    });
  }
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    HF_HUB_DISABLE_IMPLICIT_TOKEN: '1',
    HF_HUB_DISABLE_TELEMETRY: '1',
    HF_HUB_DISABLE_PROGRESS_BARS: '1',
  };
  delete env['HF_TOKEN'];
  return new Promise((resolve) => {
    const child = spawn(hf, args, {
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    const collect = (chunk: Buffer) => {
      output = (output + chunk.toString('utf8')).slice(-2000);
    };
    child.stdout.on('data', collect);
    child.stderr.on('data', collect);
    child.on('error', (error) => resolve({ ok: false, output: error.message }));
    child.on('close', (code) => resolve({ ok: code === 0, output }));
  });
}

const error = (content: string): MessageActionReturn => ({
  type: 'message',
  messageType: 'error',
  content,
});

/** Bytes `hf download --dry-run` would download, from its summary line. */
function dryRunBytes(output: string): number | undefined {
  const match = /totalling\s+(\d+(?:\.\d+)?)([KMGTPEZY]?)/.exec(output);
  if (!match) return undefined;
  const power = match[2] ? 'KMGTPEZY'.indexOf(match[2]) + 1 : 0;
  return Number(match[1]) * 1000 ** power;
}

const downloadCommand: SlashCommand = {
  name: 'download',
  get description() {
    return t(
      'Download a local model: /models download <id>, or <repo> <file> to add one',
    );
  },
  kind: CommandKind.BUILT_IN,
  supportedModes: ['interactive'] as const,
  action: async (
    context: CommandContext,
    args: string,
  ): Promise<MessageActionReturn> => {
    const parts = args.trim().split(/\s+/).filter(Boolean);
    const { settings } = context.services;
    const models = localModels(settings);
    let model =
      parts.length === 1
        ? models.find((candidate) => candidate.id === parts[0])
        : models.find(
            (candidate) =>
              candidate.repo === parts[0] && candidate.file === parts[1],
          );
    let added: LocalModelConfig | undefined;
    if (!model && parts.length === 2) {
      const [repo, file] = parts;
      added = {
        id: file.replace(/\.gguf$/i, '').toLowerCase(),
        repo,
        file,
      };
      try {
        validateLocalModels([...models, added]);
      } catch (err) {
        return error(err instanceof Error ? err.message : String(err));
      }
      model = added;
    }
    if (!model || parts.length === 0 || parts.length > 2) {
      return error(
        'Usage: /models download <id>, or /models download <repo> <file.gguf>',
      );
    }

    // On Apple silicon, refuse a file too big for the GPU before downloading
    // it. hf reports the size without downloading; if its output cannot be
    // read, the check after the download still catches it.
    const limit = appleGpuMemoryLimit();
    if (limit !== undefined) {
      context.ui.addItem(
        {
          type: MessageType.INFO,
          text: `Checking the size: hf download ${model.repo} ${model.file} --dry-run`,
        },
        Date.now(),
      );
      const dryRun = await runHf([
        'download',
        model.repo,
        model.file,
        '--dry-run',
      ]);
      const bytes = dryRun.ok ? dryRunBytes(dryRun.output) : undefined;
      const problem = bytes ? modelSizeProblem(model, bytes, limit) : undefined;
      if (problem) {
        return error(`Not downloaded. ${problem}`);
      }
    }

    if (added) {
      // Listed so /model can switch to it once it is downloaded.
      settings.setValue(SettingScope.User, 'localModels', [...models, added]);
      // The settings watcher skips the CLI's own writes, so apply the new
      // list to this session here, as /auth does for its providers.
      const listed = localModels(settings);
      getLocalModelServer().setModels(listed);
      context.services.config?.reloadModelProvidersConfig(
        withLocalModelProviders(settings.merged.modelProviders, listed),
      );
    }
    context.ui.addItem(
      {
        type: MessageType.INFO,
        text: `Running: hf download ${model.repo} ${model.file}`,
      },
      Date.now(),
    );
    const { ok, output } = await runHf(['download', model.repo, model.file]);
    if (!ok) {
      return error(`hf download failed:\n${output.trim()}`);
    }
    let problem: string | undefined;
    if (limit !== undefined) {
      try {
        problem = modelSizeProblem(model, localModelBytes(model), limit);
      } catch {
        // Not all of it is in the cache (e.g. other parts of a split file).
      }
    }
    return problem
      ? error(`Downloaded, but it cannot run on this Mac. ${problem}`)
      : {
          type: 'message',
          messageType: 'info',
          content: `Downloaded ${model.name ?? model.id}. Switch to it with /model ${model.id}.`,
        };
  },
};

const removeCommand: SlashCommand = {
  name: 'remove',
  get description() {
    return t('Delete a local model from disk: /models remove <id or repo>');
  },
  kind: CommandKind.BUILT_IN,
  supportedModes: ['interactive'] as const,
  action: async (
    context: CommandContext,
    args: string,
  ): Promise<MessageActionReturn> => {
    const target = args.trim();
    const repo =
      localModels(context.services.settings).find(
        (candidate) => candidate.id === target,
      )?.repo ?? target;
    if (!isHuggingFaceRepo(repo)) {
      return error('Usage: /models remove <id>, or /models remove <repo>');
    }
    context.ui.addItem(
      {
        type: MessageType.INFO,
        text: `Running: hf cache rm model/${repo} -y`,
      },
      Date.now(),
    );
    const { ok, output } = await runHf(['cache', 'rm', `model/${repo}`, '-y']);
    return ok
      ? {
          type: 'message',
          messageType: 'info',
          content: `Removed ${repo} from the Hugging Face cache.`,
        }
      : error(`hf cache rm failed:\n${output.trim()}`);
  },
};

const speculationState = () =>
  getLocalModelServer().isSpeculationEnabled() ? 'on' : 'off';

/** Save `speculativeDecoding` in the user settings and apply it. */
function setSpeculation(
  context: CommandContext,
  enabled: boolean,
): MessageActionReturn {
  const { settings } = context.services;
  settings.setValue(SettingScope.User, 'speculativeDecoding', enabled);
  const applied = settings.merged.speculativeDecoding !== false;
  getLocalModelServer().setSpeculation(applied);
  if (applied !== enabled) {
    return error(
      `Your system settings set speculativeDecoding, so speculative decoding stays ${speculationState()}.`,
    );
  }
  return {
    type: 'message',
    messageType: 'info',
    content: `Speculative decoding is ${speculationState()}. If the local model engine is running, it restarts at your next prompt, so that reply takes longer.`,
  };
}

const speculationCommand: SlashCommand = {
  name: 'speculation',
  get description() {
    return t('Show or switch speculative decoding: /models speculation on|off');
  },
  kind: CommandKind.BUILT_IN,
  supportedModes: ['interactive'] as const,
  subCommands: [
    {
      name: 'on',
      get description() {
        return t('Turn speculative decoding on');
      },
      kind: CommandKind.BUILT_IN,
      supportedModes: ['interactive'] as const,
      action: (context: CommandContext) => setSpeculation(context, true),
    },
    {
      name: 'off',
      get description() {
        return t('Turn speculative decoding off');
      },
      kind: CommandKind.BUILT_IN,
      supportedModes: ['interactive'] as const,
      action: (context: CommandContext) => setSpeculation(context, false),
    },
  ],
  action: (_context: CommandContext, args: string): MessageActionReturn => {
    if (args.trim()) {
      return error(
        'Usage: /models speculation, /models speculation on or /models speculation off',
      );
    }
    return {
      type: 'message',
      messageType: 'info',
      content: `Speculative decoding is ${speculationState()}. When it is on, the local model engine drafts tokens from text already in the conversation, which speeds up file edits without changing what the model writes. Switch it with /models speculation on or /models speculation off.`,
    };
  },
};

export const modelsCommand: SlashCommand = {
  name: 'models',
  get description() {
    return t('List, download or remove local models');
  },
  kind: CommandKind.BUILT_IN,
  supportedModes: ['interactive'] as const,
  action: (context: CommandContext): MessageActionReturn => {
    const lines = localModels(context.services.settings).map(
      (model) =>
        `${isDownloaded(model) ? '✓' : ' '} ${model.id}  ${model.repo}/${model.file}`,
    );
    return {
      type: 'message',
      messageType: 'info',
      content: [
        'Local models (✓ = downloaded):',
        ...lines,
        '',
        'Switch with /model <id>. Download with /models download <id> (or <repo> <file> to add one). Delete with /models remove <id>.',
        `Speculative decoding is ${speculationState()}; switch it with /models speculation on or off.`,
      ].join('\n'),
    };
  },
  subCommands: [downloadCommand, removeCommand, speculationCommand],
};
