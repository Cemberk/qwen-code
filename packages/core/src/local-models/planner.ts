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
import type { SpeculationAdvice } from './bench.js';

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
  /** What /models bench measured about speculative decoding here, and whether it is on. */
  speculation?: { advice?: SpeculationAdvice; enabled: boolean };
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
  }
  if (gpu?.othersBytes !== undefined && gpu.othersBytes > GIB) {
    notes.push(
      `Other programs hold ${(gpu.othersBytes / 1e9).toFixed(1)} GB of the GPU's shared memory now, leaving ${(gpu.limit / 1e9).toFixed(1)} GB for the model; close some to run more of it on the GPU.`,
    );
  }
  if (gpu === undefined || 'problem' in fit) {
    // said above
  } else if (fit.partial) {
    notes.push(
      gpu.unified
        ? `Too big for the GPU: the experts of ${fit.cpuMoeLayers} layer(s) run on the CPU.`
        : 'Too big for VRAM: llama.cpp places what does not fit in RAM (--fit).',
    );
  } else {
    const spare = gpu.limit - input.bytes - GPU_HEADROOM_BYTES;
    // Larger batches sped prompts up on discrete GPUs (Strata, Radeon R9700);
    // on a Radeon 780M, which shares RAM, they read prompts no faster than
    // the default 512 and generated a little slower.
    if (gpu.unified) {
      notes.push(
        'Fits the GPU, which shares system memory: prompts are read in default batches, which measured as fast as larger ones there.',
      );
    } else if (spare >= LARGE_BATCH_SPARE_BYTES) {
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

  // The fork's MoE cache keeps the experts a session uses in VRAM. It pays
  // only where VRAM is separate from RAM: on a Radeon 780M, whose "VRAM" is
  // the same RAM, every cache configuration ran slower than none.
  const moeCacheOn = wantsMoeCache(input.userArgs);
  if (gpu && 'cpuMoeLayers' in fit && model && model.experts > 0) {
    if (gpu.unified && moeCacheOn) {
      notes.push(
        'The MoE cache (--moe-cache-mib) only adds copies on a GPU that shares system memory, and measured slower than none there: consider removing it from localModelEngineArgs.',
      );
    } else if (!gpu.unified && fit.partial && !moeCacheOn) {
      notes.push(
        'Experts run from RAM: the MoE cache can keep the ones this session uses in VRAM. Try localModelEngineArgs ["--moe-cache-mib", "<MiB of spare VRAM>", "--moe-cache-hybrid"] and compare with /models bench.',
      );
    }
  }

  const advice = input.speculation?.advice;
  if (advice && input.speculation) {
    const measured = `measured on this machine (/models bench compare): ${advice.ratio.toFixed(2)}x generation speed`;
    if (advice.advice === 'off' && input.speculation.enabled) {
      notes.push(
        `Speculative decoding costs more than it saves here, ${measured}: turn it off with /models speculation off.`,
      );
    } else if (advice.advice === 'on' && !input.speculation.enabled) {
      notes.push(
        `Speculative decoding pays here, ${measured}: turn it on with /models speculation on.`,
      );
    } else if (advice.advice !== 'either') {
      notes.push(
        `Speculative decoding is ${input.speculation.enabled ? 'on' : 'off'}, as ${measured} advises.`,
      );
    }
  }

  if (input.userArgs && input.userArgs.length > 0) {
    args.push(...input.userArgs);
    notes.push(`Your localModelEngineArgs: ${input.userArgs.join(' ')}`);
  }
  return { args, notes };
}

/** Whether the user's options turn the fork's MoE cache on. */
export function wantsMoeCache(args: readonly string[] | undefined): boolean {
  return (args ?? []).some((arg) => arg.split('=')[0] === '--moe-cache-mib');
}

/**
 * Whether the engine should keep a MoE cache profile for the project:
 * the user turned the fork's MoE cache on (--moe-cache-mib) without naming a
 * profile of their own.
 */
export function wantsMoeProfile(args: readonly string[] | undefined): boolean {
  const options = (args ?? []).map((arg) => arg.split('=')[0]);
  return (
    options.includes('--moe-cache-mib') &&
    !options.includes('--moe-cache-profile')
  );
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
