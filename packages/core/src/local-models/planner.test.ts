/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import { planEngine, validateEngineArgs } from './planner.js';
import type { ModelCapabilities } from './model-inspector.js';

const GIB = 1024 ** 3;

const qwen36: ModelCapabilities = {
  architecture: 'qwen35moe',
  layers: 40,
  experts: 256,
  expertsUsed: 8,
  nextnLayers: 0,
  recurrent: true,
};

describe('planEngine', () => {
  it('reads prompts in large batches when the model fits the GPU with room to spare', () => {
    const plan = planEngine({
      bytes: 14 * GIB,
      gpu: { limit: 24 * GIB, unified: false },
      fit: { cpuMoeLayers: 0 },
      model: qwen36,
      hasDraft: false,
    });
    expect(plan.args).toEqual(['-b', '2048', '-ub', '2048']);
    expect(plan.notes[0]).toMatch(/9\.0 GiB to spare/);
    expect(plan.notes[1]).toMatch(/Recurrent layers/);
  });

  it('keeps default batches when the GPU is nearly full or the model spills to the CPU', () => {
    expect(
      planEngine({
        bytes: 14 * GIB,
        gpu: { limit: 16 * GIB, unified: true },
        fit: { cpuMoeLayers: 0 },
        hasDraft: false,
      }).args,
    ).toEqual([]);
    const spilled = planEngine({
      bytes: 30 * GIB,
      gpu: { limit: 16 * GIB, unified: false },
      fit: { cpuMoeLayers: 40, partial: true },
      hasDraft: false,
    });
    expect(spilled.args).toEqual([]);
    expect(spilled.notes).toEqual([
      'Too big for VRAM: llama.cpp places what does not fit in RAM (--fit).',
    ]);
  });

  it('says how a model without a GPU runs, and points at built-in MTP layers', () => {
    const plan = planEngine({
      bytes: 5 * GIB,
      gpu: undefined,
      fit: { cpuMoeLayers: 0, partial: true },
      model: { ...qwen36, recurrent: false, nextnLayers: 1 },
      hasDraft: false,
    });
    expect(plan.notes).toEqual([
      'No GPU: the model runs on the CPU.',
      'The model has built-in MTP layers; give it an MTP draft file (localModels draft) to draft with them.',
    ]);
  });

  it('applies the user options last', () => {
    const plan = planEngine({
      bytes: 14 * GIB,
      gpu: { limit: 24 * GIB, unified: false },
      fit: { cpuMoeLayers: 0 },
      hasDraft: false,
      userArgs: ['-ub', '1024'],
    });
    expect(plan.args).toEqual(['-b', '2048', '-ub', '2048', '-ub', '1024']);
    expect(plan.notes.at(-1)).toBe('Your localModelEngineArgs: -ub 1024');
  });
});

describe('validateEngineArgs', () => {
  it('accepts tuning options', () => {
    expect(
      validateEngineArgs([
        '-ub',
        '1024',
        '--moe-cache-mib=4096',
        '-ctk',
        'q8_0',
      ]),
    ).toEqual(['-ub', '1024', '--moe-cache-mib=4096', '-ctk', 'q8_0']);
  });

  it.each([
    ['--host', '0.0.0.0'],
    ['--port=80'],
    ['-hf', 'someone/model'],
    ['--hf-repo-draft', 'x/y'],
    ['--model-url', 'https://example.com/m.gguf'],
    ['--api-key', 'k'],
    ['-m', '/other.gguf'],
  ])('refuses %s', (...args) => {
    expect(() => validateEngineArgs(args)).toThrow(/cannot set/);
  });

  it('refuses anything but a list of strings', () => {
    expect(() => validateEngineArgs('-ub 1024')).toThrow(/must be a list/);
    expect(() => validateEngineArgs([1024])).toThrow(/must be a list/);
  });
});

describe('planEngine with a build that has no GPU backend', () => {
  it('says the machine has a GPU the build cannot use', () => {
    const plan = planEngine({
      bytes: 5 * GIB,
      gpu: undefined,
      fit: { cpuMoeLayers: 0, partial: true },
      hasDraft: false,
      cpuOnlyBuild: true,
    });
    expect(plan.notes[0]).toMatch(/no GPU backend[\s\S]*\/models setup/);
  });
});
