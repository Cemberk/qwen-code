/**
 * @license
 * Copyright 2025 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * The only supported model protocol: an OpenAI-compatible Chat Completions
 * server on the loopback interface (Ollama, LM Studio, vLLM, llama.cpp, ...).
 */
export enum AuthType {
  USE_OPENAI = 'openai',
}
