/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import type {
  ContentGenerator,
  ContentGeneratorConfig,
} from '../contentGenerator.js';
import type { Config } from '../../config/config.js';
import { OpenAIContentGenerator } from './openaiContentGenerator.js';
import { DefaultOpenAICompatibleProvider } from './provider/index.js';

export { OpenAIContentGenerator } from './openaiContentGenerator.js';
export { ContentGenerationPipeline } from './pipeline.js';
export type { ErrorHandler, PipelineConfig, RequestContext } from './types.js';

export type { OpenAICompatibleProvider } from './provider/index.js';

export { OpenAIContentConverter } from './converter.js';

/**
 * Create the OpenAI-compatible content generator for the local model server.
 */
export function createOpenAIContentGenerator(
  contentGeneratorConfig: ContentGeneratorConfig,
  cliConfig: Config,
): ContentGenerator {
  return new OpenAIContentGenerator(
    contentGeneratorConfig,
    cliConfig,
    new DefaultOpenAICompatibleProvider(contentGeneratorConfig, cliConfig),
  );
}

export { EnhancedErrorHandler } from './errorHandler.js';
