/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { spawn } from 'node:child_process';
import { findExecutable } from '@qwen-code/qwen-code-core/local-models/engine.js';
import { resolveLocalModelPath } from '@qwen-code/qwen-code-core/local-models/hf-cache.js';
import {
  BUILT_IN_LOCAL_MODELS,
  isHuggingFaceRepo,
  validateLocalModels,
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
    if (!model && parts.length === 2) {
      const [repo, file] = parts;
      const added: LocalModelConfig = {
        id: file.replace(/\.gguf$/i, '').toLowerCase(),
        repo,
        file,
      };
      try {
        validateLocalModels([...models, added]);
      } catch (err) {
        return error(err instanceof Error ? err.message : String(err));
      }
      // Listed so /model can switch to it once it is downloaded.
      settings.setValue(SettingScope.User, 'localModels', [...models, added]);
      model = added;
    }
    if (!model || parts.length === 0 || parts.length > 2) {
      return error(
        'Usage: /models download <id>, or /models download <repo> <file.gguf>',
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
    return ok
      ? {
          type: 'message',
          messageType: 'info',
          content: `Downloaded ${model.name ?? model.id}. Switch to it with /model ${model.id}.`,
        }
      : error(`hf download failed:\n${output.trim()}`);
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
      ].join('\n'),
    };
  },
  subCommands: [downloadCommand, removeCommand],
};
