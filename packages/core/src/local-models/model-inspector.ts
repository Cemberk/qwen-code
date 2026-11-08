/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { ggufMetadata, type GgufValue } from './gguf.js';

/**
 * What a model is, read from its GGUF metadata. A new kind of model shows up
 * here as a new field, and the planner decides what the engine does with it.
 */
export interface ModelCapabilities {
  /** `general.architecture`, such as `qwen35moe`. */
  architecture: string;
  /** Transformer blocks (`<arch>.block_count`). */
  layers: number;
  /** Experts per MoE layer, and how many each token uses; 0 for dense. */
  experts: number;
  expertsUsed: number;
  /** The context the model was trained for, when the file says. */
  trainedContext?: number;
  /** Built-in multi-token-prediction (MTP) layers that can draft tokens. */
  nextnLayers: number;
  /** Sliding-window attention width, when the model uses one. */
  slidingWindow?: number;
  /**
   * Has recurrent layers (Gated DeltaNet, Mamba) beside attention: their
   * state cannot be cut back to an earlier token, so a prompt that changes
   * before its end is read again from the last saved state.
   */
  recurrent: boolean;
  /**
   * Bytes the context cache takes per token of context at f16 (keys and
   * values of every attention layer), when the file says enough to tell.
   */
  contextBytesPerToken?: number;
}

/** Bytes of an f16 cache entry. */
const F16_BYTES = 2;

/**
 * Context cache bytes per token: for each attention layer, keys and values
 * of every KV head. Recurrent hybrids (`full_attention_interval`) have
 * attention in one layer of every few only.
 */
function contextBytesPerToken(
  key: (name: string) => GgufValue | undefined,
  layers: number,
): number | undefined {
  const heads = key('attention.head_count');
  const kvHeads = key('attention.head_count_kv') ?? heads;
  const embedding = number(key('embedding_length'));
  const maxHeads = number(heads);
  const keyLength =
    number(key('attention.key_length')) ??
    (embedding && maxHeads ? embedding / maxHeads : undefined);
  const valueLength = number(key('attention.value_length')) ?? keyLength;
  if (!layers || !keyLength || !valueLength || kvHeads === undefined) {
    return undefined;
  }
  const interval = number(key('full_attention_interval'));
  const isAttention = (layer: number) =>
    !interval || interval <= 1 || (layer + 1) % interval === 0;
  const perLayer = Array.isArray(kvHeads) ? kvHeads : undefined;
  const uniform = typeof kvHeads === 'number' ? kvHeads : undefined;
  let total = 0;
  for (let layer = 0; layer < layers; layer++) {
    if (!isAttention(layer)) continue;
    const count = perLayer ? (perLayer[layer] ?? 0) : (uniform ?? 0);
    total += count * (keyLength + valueLength) * F16_BYTES;
  }
  return total > 0 ? total : undefined;
}

function number(value: GgufValue | undefined): number | undefined {
  if (typeof value === 'number') return value;
  // Some models store a per-layer array; the largest entry is what matters.
  if (Array.isArray(value) && value.length > 0) return Math.max(...value);
  return undefined;
}

/** Capabilities from GGUF metadata. */
export function modelCapabilities(
  metadata: ReadonlyMap<string, GgufValue>,
): ModelCapabilities {
  const architecture = String(metadata.get('general.architecture') ?? '');
  const key = (name: string) => metadata.get(`${architecture}.${name}`);
  const recurrent = [...metadata.keys()].some(
    (name) =>
      name.startsWith(`${architecture}.ssm.`) ||
      name === `${architecture}.full_attention_interval`,
  );
  const slidingWindow = number(key('attention.sliding_window'));
  const trainedContext = number(key('context_length'));
  const layers = number(key('block_count')) ?? 0;
  const perToken = contextBytesPerToken(key, layers);
  return {
    architecture,
    layers,
    experts: number(key('expert_count')) ?? 0,
    expertsUsed: number(key('expert_used_count')) ?? 0,
    nextnLayers: number(key('nextn_predict_layers')) ?? 0,
    recurrent,
    ...(trainedContext ? { trainedContext } : {}),
    ...(slidingWindow ? { slidingWindow } : {}),
    ...(perToken ? { contextBytesPerToken: perToken } : {}),
  };
}

/**
 * Capabilities of a model file (the first part of a split model), or
 * undefined when it cannot be read.
 */
export function inspectModel(file: string): ModelCapabilities | undefined {
  try {
    return modelCapabilities(ggufMetadata(file));
  } catch {
    return undefined;
  }
}

/** One line for /models plan. */
export function describeCapabilities(model: ModelCapabilities): string {
  const parts = [
    model.architecture || 'unknown architecture',
    `${model.layers} layers`,
    model.experts > 0
      ? `mixture of experts, ${model.expertsUsed} of ${model.experts} per token`
      : 'dense',
  ];
  if (model.recurrent) parts.push('recurrent layers beside attention');
  if (model.slidingWindow) {
    parts.push(`sliding window of ${model.slidingWindow}`);
  }
  if (model.nextnLayers > 0) {
    parts.push(`${model.nextnLayers} built-in MTP layer(s)`);
  }
  if (model.trainedContext) {
    parts.push(`trained for ${model.trainedContext} tokens`);
  }
  return parts.join(', ');
}
