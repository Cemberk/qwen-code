/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  GPU_HEADROOM_BYTES,
  type GpuBudget,
  type ModelFit,
} from './gpu-memory.js';
import type { ModelCapabilities } from './model-inspector.js';

const GIB = 1024 ** 3;

/**
 * GPU memory left beside the model before prompts are read in larger
 * batches: the compute buffer grows with the batch.
 */
export const LARGE_BATCH_SPARE_BYTES = 2 * GIB;

/** Tokens per prompt batch when the GPU has room (`-b`, `-ub`). */
export const LARGE_BATCH_TOKENS = 2048;

/** How the engine runs a model on this machine, and why. */
export interface EnginePlan {
  /** llama-server options beside the ones every engine gets. */
  args: string[];
  /** One line per decision, for /models plan. */
  notes: string[];
}

export interface PlanInput {
  /** Bytes of the model's files (and its draft). */
  bytes: number;
  gpu: GpuBudget | undefined;
  fit: ModelFit;
  /** Undefined when the file could not be read. */
  model?: ModelCapabilities;
  /** The model has a draft file configured and downloaded. */
  hasDraft: boolean;
  /** `localModelEngineArgs`: the user's own options, applied last. */
  userArgs?: readonly string[];
  /** The llama-server build has no GPU backend, but this machine has a GPU. */
  cpuOnlyBuild?: boolean;
}

/**
 * Plan the engine options from the machine and the model. Rules only add
 * what has a known benefit; llama.cpp's own defaults (threads from the
 * physical cores, --fit placement) stay otherwise.
 */
export function planEngine(input: PlanInput): EnginePlan {
  const args: string[] = [];
  const notes: string[] = [];
  const { gpu, fit, model } = input;

  if (gpu === undefined) {
    notes.push(
      input.cpuOnlyBuild
        ? 'This llama-server has no GPU backend, so the model runs on the CPU although this machine has a GPU. /models setup shows how to build it for the GPU.'
        : 'No GPU: the model runs on the CPU.',
    );
  } else if ('problem' in fit) {
    notes.push(fit.problem);
  } else if (fit.partial) {
    notes.push(
      gpu.unified
        ? `Too big for the GPU: the experts of ${fit.cpuMoeLayers} layer(s) run on the CPU.`
        : 'Too big for VRAM: llama.cpp places what does not fit in RAM (--fit).',
    );
  } else {
    const spare = gpu.limit - input.bytes - GPU_HEADROOM_BYTES;
    if (spare >= LARGE_BATCH_SPARE_BYTES) {
      const tokens = String(LARGE_BATCH_TOKENS);
      args.push('-b', tokens, '-ub', tokens);
      notes.push(
        `Fits the GPU with ${(spare / GIB).toFixed(1)} GiB to spare: prompts are read ${tokens} tokens at a time (-ub ${tokens}).`,
      );
    } else {
      notes.push(
        'Fits the GPU with little to spare: prompts are read in default batches.',
      );
    }
  }

  if (model?.recurrent) {
    notes.push(
      'Recurrent layers: a prompt that changes before its end is read again from the last saved turn.',
    );
  }
  if (model && model.nextnLayers > 0 && !input.hasDraft) {
    notes.push(
      'The model has built-in MTP layers; give it an MTP draft file (localModels draft) to draft with them.',
    );
  }

  if (input.userArgs && input.userArgs.length > 0) {
    args.push(...input.userArgs);
    notes.push(`Your localModelEngineArgs: ${input.userArgs.join(' ')}`);
  }
  return { args, notes };
}

/**
 * Options `localModelEngineArgs` may not set: qwen chooses where the engine
 * listens, its key, the model and where it saves prompts, and the engine
 * must never download.
 */
const RESERVED_ARGS = [
  '-m',
  '--model',
  '--host',
  '--port',
  '--api-key',
  '--api-key-file',
  '--alias',
  '-a',
  '--slot-save-path',
  '-hf',
  '-hfr',
  '--hf-repo',
  '-hff',
  '--hf-file',
  '-hft',
  '--hf-token',
  '-hfd',
  '-hfrd',
  '--hf-repo-draft',
  '--spec-draft-hf',
  '-mu',
  '--model-url',
  '-mmu',
  '--mmproj-url',
  '-dr',
  '--docker-repo',
];

/**
 * Validate `localModelEngineArgs`.
 *
 * @throws Error naming the first option qwen controls itself.
 */
export function validateEngineArgs(value: unknown): string[] {
  if (
    !Array.isArray(value) ||
    !value.every((item) => typeof item === 'string')
  ) {
    throw new Error(
      'localModelEngineArgs must be a list of llama-server options, such as ["-ub", "1024"].',
    );
  }
  for (const item of value as string[]) {
    const option = item.split('=')[0];
    if (
      RESERVED_ARGS.includes(option) ||
      option.startsWith('--hf-') ||
      option.startsWith('--spec-draft-hf')
    ) {
      throw new Error(
        `localModelEngineArgs cannot set ${option}: qwen sets it itself, or it would let the engine download.`,
      );
    }
  }
  return value as string[];
}
