/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { spawn } from 'node:child_process';
import { appendFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { Storage } from '@qwen-code/qwen-code-core/config/storage.js';
import {
  runBench,
  type BenchResult,
} from '@qwen-code/qwen-code-core/local-models/bench.js';
import {
  findExecutable,
  planLocalModel,
  resolveDraftPath,
} from '@qwen-code/qwen-code-core/local-models/engine.js';
import { describeCapabilities } from '@qwen-code/qwen-code-core/local-models/model-inspector.js';
import {
  getConfinement,
  type Confinement,
} from '@qwen-code/qwen-code-core/local-models/confinement.js';
import { engineSetup } from '@qwen-code/qwen-code-core/local-models/engine-setup.js';
import {
  downloadSizeProblem,
  fitModel,
  gpuBudget,
  localModelBytes,
  localModelExpertBytes,
  systemMemoryBytes,
} from '@qwen-code/qwen-code-core/local-models/gpu-memory.js';
import {
  describeHardware,
  getHardwareProfile,
} from '@qwen-code/qwen-code-core/local-models/hardware.js';
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

function hfInstallHint(platform: NodeJS.Platform = process.platform): string {
  return platform === 'darwin'
    ? 'Install it with: brew install huggingface-cli'
    : 'Install it with: pip install -U "huggingface_hub[cli]"';
}

/** Run the user's `hf` tool without their token or telemetry. */
function runHf(args: string[]): Promise<{ ok: boolean; output: string }> {
  const hf = findExecutable('hf');
  if (!hf) {
    return Promise.resolve({
      ok: false,
      output: `The hf tool was not found on PATH. ${hfInstallHint()}`,
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

    // Refuse a file too big for this machine's memory before downloading
    // it. hf reports the size without downloading; if its output cannot be
    // read, the check after the download still catches it. Whether a file too
    // big for the GPU can run partly on the CPU depends on its layers, which
    // are only known after the download.
    const gpu = gpuBudget();
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
    const problem = bytes
      ? downloadSizeProblem(model, bytes, gpu, systemMemoryBytes())
      : undefined;
    if (problem) {
      return error(`Not downloaded. ${problem}`);
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
    if (model.draft) {
      context.ui.addItem(
        {
          type: MessageType.INFO,
          text: `Running: hf download ${model.draft.repo} ${model.draft.file}`,
        },
        Date.now(),
      );
      const draft = await runHf([
        'download',
        model.draft.repo,
        model.draft.file,
      ]);
      if (!draft.ok) {
        return error(
          `Downloaded ${model.name ?? model.id}, but its draft model failed; it runs without it:\n${draft.output.trim()}`,
        );
      }
    }
    let fit: ReturnType<typeof fitModel> = { cpuMoeLayers: 0 };
    try {
      fit = fitModel(
        model,
        localModelBytes(model),
        () => localModelExpertBytes(model),
        gpu,
        systemMemoryBytes(),
      );
    } catch {
      // Not all of it is in the cache (e.g. other parts of a split file).
    }
    if ('problem' in fit) {
      return error(
        `Downloaded, but it cannot run on this machine. ${fit.problem}`,
      );
    }
    return {
      type: 'message',
      messageType: 'info',
      content:
        `Downloaded ${model.name ?? model.id}. Switch to it with /model ${model.id}.` +
        (gpu === undefined
          ? ' No GPU was found, so it runs on the CPU.'
          : fit.cpuMoeLayers && process.platform === 'darwin'
            ? ` It is too big for the GPU, so the experts of ${fit.cpuMoeLayers} of its layers run on the CPU, which makes it slower.`
            : fit.partial
              ? ' It is too big for the GPU, so part of it runs on the CPU, which makes it slower.'
              : ''),
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

/** How the engine is kept off the network on this machine. */
export function networkConfinement(
  platform: NodeJS.Platform,
  confinement: () => Confinement,
): string {
  if (platform === 'darwin') {
    return 'a Seatbelt sandbox lets the engine reach only this machine.';
  }
  if (platform === 'linux') {
    const found = confinement();
    return found.kind === 'none'
      ? 'the engine listens on loopback only. Install bubblewrap (bwrap) to run it without network access; this system refused an unprivileged network namespace or has neither bwrap nor unshare.'
      : `the engine runs without network access (${found.kind}), reached through a Unix socket.`;
  }
  return 'the engine listens on loopback only and runs with --offline.';
}

/**
 * The local model named by `args`, else the session's model when it is a
 * local one, else the first in the list.
 */
function pickLocalModel(
  context: CommandContext,
  args: string,
): LocalModelConfig | string {
  const models = localModels(context.services.settings);
  const wanted = args.trim() || context.services.config?.getModel?.() || '';
  const model =
    models.find((candidate) => candidate.id === wanted) ??
    (args.trim() ? undefined : models[0]);
  if (!model) {
    return args.trim()
      ? `${args.trim()} is not a local model; /models lists them.`
      : 'There are no local models; see /models.';
  }
  return model;
}

const planCommand: SlashCommand = {
  name: 'plan',
  get description() {
    return t('Show how a local model runs on this machine: /models plan [id]');
  },
  kind: CommandKind.BUILT_IN,
  supportedModes: ['interactive'] as const,
  action: (context: CommandContext, args: string): MessageActionReturn => {
    const model = pickLocalModel(context, args);
    if (typeof model === 'string') return error(model);
    let planned: ReturnType<typeof planLocalModel>;
    try {
      planned = planLocalModel(model, getLocalModelServer().getEngineOptions());
    } catch (err) {
      return error(err instanceof Error ? err.message : String(err));
    }
    return {
      type: 'message',
      messageType: 'info',
      content: [
        `${model.name ?? model.id} (${(planned.bytes / 1e9).toFixed(1)} GB)`,
        planned.capabilities
          ? `  ${describeCapabilities(planned.capabilities)}`
          : '  Its GGUF metadata could not be read.',
        '',
        ...planned.plan.notes.map((note) => `- ${note}`),
        '',
        `Planned options: ${planned.plan.args.join(' ') || '(llama.cpp defaults)'}`,
        'Add your own with localModelEngineArgs in your user settings; measure with /models bench.',
      ].join('\n'),
    };
  },
};

/** Where /models bench appends its results, one JSON object per line. */
export function benchLogFile(): string {
  return path.join(Storage.getGlobalQwenDir(), 'local-model-bench.jsonl');
}

const benchCommand: SlashCommand = {
  name: 'bench',
  get description() {
    return t(
      'Measure prompt and generation speed of a local model: /models bench [id]',
    );
  },
  kind: CommandKind.BUILT_IN,
  supportedModes: ['interactive'] as const,
  action: async (
    context: CommandContext,
    args: string,
  ): Promise<MessageActionReturn> => {
    const model = pickLocalModel(context, args);
    if (typeof model === 'string') return error(model);
    const server = getLocalModelServer();
    let planned: ReturnType<typeof planLocalModel>;
    try {
      planned = planLocalModel(model, server.getEngineOptions());
    } catch (err) {
      return error(err instanceof Error ? err.message : String(err));
    }
    context.ui.addItem(
      {
        type: MessageType.INFO,
        text: `Measuring ${model.id}: a 4K-token prompt, then 128 tokens. Starting the engine if needed takes longer.`,
      },
      Date.now(),
    );
    let result: BenchResult;
    const lease = await server.acquire(model.id);
    try {
      result = await runBench(lease);
    } catch (err) {
      return error(
        `The benchmark failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    } finally {
      lease.release();
    }
    const profile = getHardwareProfile();
    const record = {
      date: new Date().toISOString(),
      model: model.id,
      file: `${model.repo}/${model.file}`,
      hardware: describeHardware(profile),
      engine:
        server.getEnginePath() ?? findExecutable('llama-server') ?? 'unknown',
      options: planned.plan.args,
      speculation: server.isSpeculationEnabled(),
      ...result,
    };
    try {
      mkdirSync(path.dirname(benchLogFile()), { recursive: true });
      appendFileSync(benchLogFile(), JSON.stringify(record) + '\n');
    } catch {
      // The result is still shown.
    }
    return {
      type: 'message',
      messageType: 'info',
      content: [
        `${model.id}: prompt ${result.promptPerSecond.toFixed(1)} tok/s (${result.promptTokens} tokens), generation ${result.generatedPerSecond.toFixed(1)} tok/s (${result.generatedTokens} tokens).`,
        `Options: ${planned.plan.args.join(' ') || '(llama.cpp defaults)'}; speculative decoding ${server.isSpeculationEnabled() ? 'on' : 'off'}.`,
        ...(result.draftAcceptance !== undefined
          ? [
              `Drafted tokens accepted: ${(100 * result.draftAcceptance).toFixed(1)}%.`,
            ]
          : []),
        ...(result.moeCacheHitRate !== undefined
          ? [
              `MoE cache hit rate: ${(100 * result.moeCacheHitRate).toFixed(1)}%.`,
            ]
          : []),
        `Saved to ${benchLogFile()}.`,
      ].join('\n'),
    };
  },
};

const setupCommand: SlashCommand = {
  name: 'setup',
  get description() {
    return t(
      'Show the GPUs of this machine and how to build the local model engine for them',
    );
  },
  kind: CommandKind.BUILT_IN,
  supportedModes: ['interactive'] as const,
  action: (): MessageActionReturn => {
    const profile = getHardwareProfile();
    const setup = engineSetup(profile);
    const enginePath = getLocalModelServer().getEnginePath();
    const engine =
      enginePath ??
      findExecutable('llama-server') ??
      'none (not on PATH, and localModelEngine is not set)';
    return {
      type: 'message',
      messageType: 'info',
      content: [
        'This machine:',
        ...describeHardware(profile).map((line) => `  ${line}`),
        '',
        `Engine: ${engine}`,
        `Network: ${networkConfinement(profile.platform, () => getConfinement())}`,
        '',
        ...setup.lines,
      ].join('\n'),
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
        `${isDownloaded(model) ? '✓' : ' '} ${model.id}  ${model.repo}/${model.file}` +
        (model.draft
          ? `\n      draft ${model.draft.repo}/${model.draft.file}${resolveDraftPath(model) ? ' ✓' : ' (not downloaded)'}`
          : ''),
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
        'See the GPUs of this machine and how to build the engine with /models setup.',
      ].join('\n'),
    };
  },
  subCommands: [
    downloadCommand,
    removeCommand,
    speculationCommand,
    setupCommand,
    planCommand,
    benchCommand,
  ],
};
