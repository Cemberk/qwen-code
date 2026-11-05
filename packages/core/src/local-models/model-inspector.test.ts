/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import {
  describeCapabilities,
  inspectModel,
  modelCapabilities,
} from './model-inspector.js';

describe('modelCapabilities', () => {
  it('reads a hybrid mixture-of-experts model', () => {
    const model = modelCapabilities(
      new Map<string, number | string | number[]>([
        ['general.architecture', 'qwen35moe'],
        ['qwen35moe.block_count', 40],
        ['qwen35moe.expert_count', 256],
        ['qwen35moe.expert_used_count', 8],
        ['qwen35moe.context_length', 262144],
        ['qwen35moe.full_attention_interval', 4],
        ['qwen35moe.ssm.conv_kernel', 4],
      ]),
    );
    expect(model).toEqual({
      architecture: 'qwen35moe',
      layers: 40,
      experts: 256,
      expertsUsed: 8,
      nextnLayers: 0,
      recurrent: true,
      trainedContext: 262144,
    });
    expect(describeCapabilities(model)).toBe(
      'qwen35moe, 40 layers, mixture of experts, 8 of 256 per token, recurrent layers beside attention, trained for 262144 tokens',
    );
  });

  it('reads a dense model with sliding-window attention and MTP layers', () => {
    const model = modelCapabilities(
      new Map<string, number | string | number[]>([
        ['general.architecture', 'gemma4'],
        ['gemma4.block_count', 48],
        ['gemma4.attention.sliding_window', 1024],
        ['gemma4.nextn_predict_layers', 1],
      ]),
    );
    expect(model).toMatchObject({
      experts: 0,
      recurrent: false,
      slidingWindow: 1024,
      nextnLayers: 1,
    });
    expect(describeCapabilities(model)).toBe(
      'gemma4, 48 layers, dense, sliding window of 1024, 1 built-in MTP layer(s)',
    );
  });

  it('is undefined for a file it cannot read', () => {
    expect(inspectModel('/no/such/model.gguf')).toBeUndefined();
  });
});
