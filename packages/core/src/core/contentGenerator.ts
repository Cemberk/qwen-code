/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type {
  EmbedContentParameters,
  EmbedContentResponse,
  GenerateContentParameters,
  GenerateContentResponse,
} from '@google/genai';
import type { Config } from '../config/config.js';
import type {
  ConfigSource,
  ConfigSourceKind,
  ConfigSources,
} from '../utils/configResolver.js';
import {
  DEFAULT_API_KEY_ENV_VAR,
  DEFAULT_MODEL_ENV_VAR,
  InvalidBaseUrlError,
  MissingApiKeyError,
  MissingModelError,
  StrictMissingCredentialsError,
  StrictMissingModelIdError,
} from '../models/modelConfigErrors.js';
import { getLocalBaseUrlError } from '../utils/local-base-url.js';
import { PROVIDER_SOURCED_FIELDS } from '../models/constants.js';
import { preloadRuntimeFetchModule } from '../utils/runtimeFetchOptions.js';
import type { ReasoningEffort } from './reasoning-effort.js';

/**
 * Interface abstracting the core content generation functionality.
 */
export interface ContentGenerator {
  generateContent(
    request: GenerateContentParameters,
    userPromptId: string,
  ): Promise<GenerateContentResponse>;

  generateContentStream(
    request: GenerateContentParameters,
    userPromptId: string,
  ): Promise<AsyncGenerator<GenerateContentResponse>>;

  embedContent(request: EmbedContentParameters): Promise<EmbedContentResponse>;
}

import { AuthType } from '../utils/auth-type.js';
export { AuthType };

export type PromptCacheSharingParameters = GenerateContentParameters & {
  /**
   * Marks reusable history before a non-reusable trailing directive. The
   * final message is deliberately excluded from cache breakpoints.
   */
  promptCacheSharing?: boolean;
  /**
   * Local control signal, never sent on the wire: true when a streaming send
   * is a transport-continuation attempt resuming an answer whose prefix was
   * already delivered (LlmChat's transportContinuationPrefix). The OpenAI
   * pipeline seeds its per-stream delivered-content flag from it, because
   * with a continuation in flight the turn's replay gate is already shut by
   * the accumulated prefix — so a parked tool-call finish must be released
   * rather than withheld for a replay that can no longer happen.
   */
  continuationInFlight?: boolean;
};

/**
 * Supported input modalities for a model.
 * Omitted or false fields mean the model does not support that input type.
 */
export type InputModalities = {
  image?: boolean;
  pdf?: boolean;
  audio?: boolean;
  video?: boolean;
};

export type ContentGeneratorConfig = {
  model: string;
  apiKey?: string;
  apiKeyEnvKey?: string;
  /**
   * Base URL of the local OpenAI-compatible server. Required; the host must
   * be 127.0.0.1, ::1 or localhost (see {@link validateModelConfig}).
   */
  baseUrl?: string;
  authType?: AuthType | undefined;
  enableOpenAILogging?: boolean;
  openAILoggingDir?: string;
  timeout?: number; // Timeout configuration in milliseconds
  // Inactivity timeout for streaming responses: if no chunk arrives for this
  // many ms, the request is aborted and surfaced as a retryable ETIMEDOUT.
  // The SDK `timeout` only covers connect + first response, so a stream that
  // returns 200 then goes silent is otherwise unbounded. `<= 0` disables it.
  streamIdleTimeoutMs?: number;
  // Total-lifetime cap for one streaming response, NOT refreshed by chunk
  // arrival: a drip-fed stream resets the idle watchdog forever while never
  // completing the message (issue #8597), so that shape needs a bound the
  // chunks cannot reset. `<= 0` disables it (issue #9005 finding 4).
  streamMaxLifetimeMs?: number;
  maxRetries?: number; // Maximum retries for rate-limit errors
  retryInitialDelayMs?: number; // Initial delay for stream rate-limit retries
  retryMaxDelayMs?: number; // Maximum delay for stream rate-limit retries
  retryErrorCodes?: number[]; // Additional error codes that trigger rate-limit retry
  // Let compaction side queries reuse the main conversation prefix so a
  // prefix-caching server can serve them from cache.
  enableCacheControl?: boolean;
  samplingParams?: {
    top_p?: number;
    top_k?: number;
    repetition_penalty?: number;
    presence_penalty?: number;
    frequency_penalty?: number;
    temperature?: number;
    max_tokens?: number;
    // Additional provider-specific keys pass through verbatim
    // (e.g. `max_completion_tokens` for GPT-5 / o-series, `reasoning_effort`).
    [key: string]: unknown;
  };
  reasoningSnapshot?: import('./reasoning-overrides.js').ReasoningSnapshot;
  reasoningRouteBaseUrl?: string | null;
  reasoning?:
    | false
    | {
        // Unified reasoning-effort ladder (see core/reasoning-effort.ts),
        // clamped to the tiers the active model accepts.
        effort?: ReasoningEffort;
        budget_tokens?: number;
      };
  userAgent?: string;
  // Schema compliance mode for tool definitions
  schemaCompliance?: 'auto' | 'openapi_30';
  // Context window size override. If set to a positive number, it will override
  // the automatic detection. Leave undefined to use automatic detection.
  contextWindowSize?: number;
  // Custom HTTP headers to be sent with requests
  customHeaders?: Record<string, string>;
  // Extra body parameters to be merged into the request body
  extra_body?: Record<string, unknown>;
  // When true, the model rejects enable_thinking=false with a 400 error, so
  // thinking must never be disabled on the wire.
  thinkingMandatory?: boolean;
  // Supported input modalities. Unsupported media types are replaced with text
  // placeholders. Leave undefined to use automatic detection from model name.
  modalities?: InputModalities;
  // When true, media parts in tool responses (including the built-in read_file
  // and MCP tools) are split into a follow-up `role: "user"` message instead of
  // being embedded inside the `role: "tool"` message. The OpenAI Chat
  // Completions spec only permits string / text-part content on tool messages;
  // strict OpenAI-compatible servers (e.g. LM Studio) drop or
  // reject anything else (HTTP 400 "Invalid 'messages' in payload"), so an image
  // read via read_file never reaches the model. Default: true (spec-compliant
  // and safe for permissive providers); set false to restore the legacy
  // embed-in-tool-message behavior. See QwenLM/qwen-code#4876, #3616.
  splitToolMedia?: boolean;
  // OpenAI Chat Completions accepts tool result content as either a plain
  // string or an array of text content parts. Some older OpenAI-compatible
  // tool templates only read the string form, so this opt-in serializes
  // text-only tool results as strings while leaving the default spec-compliant
  // content-part shape unchanged.
  toolResultContentFormat?: 'parts' | 'string';
};

// Keep the public ContentGeneratorConfigSources API, but reuse the generic
// source-tracking types from utils/configResolver to avoid duplication.
export type ContentGeneratorConfigSourceKind = ConfigSourceKind;
export type ContentGeneratorConfigSource = ConfigSource;
export type ContentGeneratorConfigSources = ConfigSources;

export type ResolvedContentGeneratorConfig = {
  config: ContentGeneratorConfig;
  sources: ContentGeneratorConfigSources;
};

function setSource(
  sources: ContentGeneratorConfigSources,
  path: string,
  source: ContentGeneratorConfigSource,
): void {
  sources[path] = source;
}

function getSeedSource(
  seed: ContentGeneratorConfigSources | undefined,
  path: string,
): ContentGeneratorConfigSource | undefined {
  return seed?.[path];
}

/**
 * Resolve ContentGeneratorConfig while tracking the source of each effective field.
 *
 * This function now primarily validates and finalizes the configuration that has
 * already been resolved by ModelConfigResolver. The env fallback logic has been
 * moved to the unified resolver to eliminate duplication.
 *
 * Note: The generationConfig passed here should already be fully resolved with
 * proper source tracking from the caller (CLI/SDK layer).
 */
export function resolveContentGeneratorConfigWithSources(
  config: Config,
  authType: AuthType | undefined,
  generationConfig?: Partial<ContentGeneratorConfig>,
  seedSources?: ContentGeneratorConfigSources,
  options?: { strictModelProvider?: boolean },
): ResolvedContentGeneratorConfig {
  const sources: ContentGeneratorConfigSources = { ...(seedSources || {}) };
  const strictModelProvider = options?.strictModelProvider === true;

  // Build config with computed fields
  const newContentGeneratorConfig: Partial<ContentGeneratorConfig> = {
    ...(generationConfig || {}),
    authType,
    reasoningSnapshot:
      generationConfig?.reasoningSnapshot ?? config?.getReasoningSnapshot?.(),
    reasoningRouteBaseUrl:
      generationConfig && 'reasoningRouteBaseUrl' in generationConfig
        ? generationConfig.reasoningRouteBaseUrl
        : config?.getCurrentModelRegistryBaseUrl?.(),
  };

  // Set sources for computed fields
  setSource(sources, 'authType', {
    kind: 'computed',
    detail: 'provided by caller',
  });

  // Preserve seed sources for fields that were passed in
  const seedOrUnknown = (path: string): ContentGeneratorConfigSource =>
    getSeedSource(seedSources, path) ?? { kind: 'unknown' };

  for (const field of PROVIDER_SOURCED_FIELDS) {
    if (generationConfig && field in generationConfig && !sources[field]) {
      setSource(sources, field, seedOrUnknown(field));
    }
  }

  // Validate required fields based on authType. This does not perform any
  // fallback resolution (resolution is handled by ModelConfigResolver).
  const validation = validateModelConfig(
    newContentGeneratorConfig as ContentGeneratorConfig,
    strictModelProvider,
  );
  if (!validation.valid) {
    throw new Error(validation.errors.map((e) => e.message).join('\n'));
  }

  return {
    config: newContentGeneratorConfig as ContentGeneratorConfig,
    sources,
  };
}

export interface ModelConfigValidationResult {
  valid: boolean;
  errors: Error[];
}

/**
 * Validate a resolved model configuration.
 * This is the single validation entry point used across Core: every content
 * generator (main model, side models, subagents) is built from a config that
 * passed it, so model traffic can only reach a loopback base URL.
 */
export function validateModelConfig(
  config: ContentGeneratorConfig,
  isStrictModelProvider: boolean = false,
): ModelConfigValidationResult {
  const errors: Error[] = [];

  if (
    config.authType !== undefined &&
    config.authType !== AuthType.USE_OPENAI
  ) {
    errors.push(
      new Error(
        `Auth type '${String(config.authType)}' is not supported. ` +
          `Only a local OpenAI-compatible server ('${AuthType.USE_OPENAI}') is supported.`,
      ),
    );
  }

  if (!config.apiKey) {
    if (isStrictModelProvider) {
      errors.push(
        new StrictMissingCredentialsError(
          config.authType,
          config.model,
          config.apiKeyEnvKey,
        ),
      );
    } else {
      errors.push(
        new MissingApiKeyError({
          authType: config.authType,
          model: config.model,
          baseUrl: config.baseUrl,
          envKey: config.apiKeyEnvKey || DEFAULT_API_KEY_ENV_VAR,
        }),
      );
    }
  }

  // Model is required
  if (!config.model) {
    if (isStrictModelProvider) {
      errors.push(new StrictMissingModelIdError(config.authType));
    } else {
      errors.push(
        new MissingModelError({
          authType: config.authType,
          envKey: DEFAULT_MODEL_ENV_VAR,
        }),
      );
    }
  }

  // Base URL is required and must be on the loopback interface.
  const baseUrlError = getLocalBaseUrlError(config.baseUrl);
  if (baseUrlError) {
    errors.push(new InvalidBaseUrlError(baseUrlError));
  }

  return { valid: errors.length === 0, errors };
}

export function createContentGeneratorConfig(
  config: Config,
  authType: AuthType | undefined,
  generationConfig?: Partial<ContentGeneratorConfig>,
): ContentGeneratorConfig {
  return resolveContentGeneratorConfigWithSources(
    config,
    authType,
    generationConfig,
  ).config;
}

function getModuleNotFoundError(
  error: unknown,
): NodeJS.ErrnoException | undefined {
  let current = error;

  while (current instanceof Error) {
    if (
      'code' in current &&
      (current as NodeJS.ErrnoException).code === 'ERR_MODULE_NOT_FOUND'
    ) {
      return current as NodeJS.ErrnoException;
    }
    current = current.cause;
  }

  return undefined;
}

function wrapProviderLoadError(error: unknown): unknown {
  const moduleNotFoundError = getModuleNotFoundError(error);
  if (!moduleNotFoundError) {
    return error;
  }

  return new Error(
    `Qwen Code was updated in the background and needs to be restarted.\n` +
      `Please exit and restart Qwen Code.`,
    { cause: moduleNotFoundError },
  );
}

class LazyContentGenerator implements ContentGenerator {
  private generatorPromise?: Promise<ContentGenerator>;
  private preloadedOnly = false;

  constructor(private readonly loader: () => Promise<ContentGenerator>) {}

  private getGenerator(): Promise<ContentGenerator> {
    this.generatorPromise ??= this.loader();
    return this.generatorPromise;
  }

  private getGeneratorForUse(): Promise<ContentGenerator> {
    this.preloadedOnly = false;
    return this.getGenerator();
  }

  preload(): Promise<ContentGenerator> {
    if (!this.generatorPromise) {
      this.preloadedOnly = true;
    }
    return this.getGenerator();
  }

  resetPreload(): void {
    if (!this.preloadedOnly) return;
    this.preloadedOnly = false;
    this.generatorPromise = undefined;
  }

  async generateContent(
    request: GenerateContentParameters,
    userPromptId: string,
  ): Promise<GenerateContentResponse> {
    return (await this.getGeneratorForUse()).generateContent(
      request,
      userPromptId,
    );
  }

  async generateContentStream(
    request: GenerateContentParameters,
    userPromptId: string,
  ): Promise<AsyncGenerator<GenerateContentResponse>> {
    return (await this.getGeneratorForUse()).generateContentStream(
      request,
      userPromptId,
    );
  }

  async embedContent(
    request: EmbedContentParameters,
  ): Promise<EmbedContentResponse> {
    return (await this.getGeneratorForUse()).embedContent(request);
  }
}

/** @internal */
export async function preloadContentGenerator(
  generator: ContentGenerator,
): Promise<void> {
  if (generator instanceof LazyContentGenerator) {
    await generator.preload();
  }
}

/** @internal */
export function resetPreloadedContentGenerator(
  generator: ContentGenerator | undefined,
): void {
  if (generator instanceof LazyContentGenerator) {
    generator.resetPreload();
  }
}

export async function createContentGenerator(
  generatorConfig: ContentGeneratorConfig,
  config: Config,
): Promise<ContentGenerator> {
  const validation = validateModelConfig(generatorConfig, false);
  if (!validation.valid) {
    throw new Error(validation.errors.map((e) => e.message).join('\n'));
  }

  // The provider constructor below synchronously builds undici-backed fetch
  // options; load undici here so it stays out of the eager startup closure
  // (issue #7264).
  await preloadRuntimeFetchModule();

  return new LazyContentGenerator(async () => {
    try {
      const [{ createOpenAIContentGenerator }, { LoggingContentGenerator }] =
        await Promise.all([
          import('./openaiContentGenerator/index.js'),
          import('./loggingContentGenerator/index.js'),
        ]);
      return new LoggingContentGenerator(
        createOpenAIContentGenerator(generatorConfig, config),
        config,
        generatorConfig,
      );
    } catch (error) {
      throw wrapProviderLoadError(error);
    }
  });
}
