/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/** Environment variable read for the API key when no envKey is configured. */
export const DEFAULT_API_KEY_ENV_VAR = 'OPENAI_API_KEY';
/** Environment variable read for the model id when none is configured. */
export const DEFAULT_MODEL_ENV_VAR = 'OPENAI_MODEL';

export abstract class ModelConfigError extends Error {
  abstract readonly code: string;

  protected constructor(message: string) {
    super(message);
    this.name = new.target.name;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

export class StrictMissingCredentialsError extends ModelConfigError {
  readonly code = 'STRICT_MISSING_CREDENTIALS';

  constructor(
    authType: string | undefined,
    model: string | undefined,
    envKey?: string,
  ) {
    const providerKey = authType || '(unknown)';
    const modelName = model || '(unknown)';
    super(
      `Missing credentials for modelProviders model '${modelName}'. ` +
        (envKey
          ? `Current configured envKey: '${envKey}'. Set that environment variable, or update modelProviders.${providerKey}[].envKey.`
          : `Configure modelProviders.${providerKey}[].envKey and set that environment variable.`),
    );
  }
}

export class StrictMissingModelIdError extends ModelConfigError {
  readonly code = 'STRICT_MISSING_MODEL_ID';

  constructor(authType: string | undefined) {
    super(
      `Missing model id for strict modelProviders resolution (authType: ${authType}).`,
    );
  }
}

export class MissingApiKeyError extends ModelConfigError {
  readonly code = 'MISSING_API_KEY';

  constructor(params: {
    authType: string | undefined;
    model: string | undefined;
    baseUrl: string | undefined;
    envKey: string;
  }) {
    super(
      `Missing API key for ${params.authType} auth. ` +
        `Current model: '${params.model || '(unknown)'}', baseUrl: '${params.baseUrl || '(none)'}'. ` +
        `Provide an API key via settings (security.auth.apiKey), ` +
        `or set the environment variable '${params.envKey}'.`,
    );
  }
}

export class MissingModelError extends ModelConfigError {
  readonly code = 'MISSING_MODEL';

  constructor(params: { authType: string | undefined; envKey: string }) {
    super(
      `Missing model for ${params.authType} auth. ` +
        `Set the environment variable '${params.envKey}'.`,
    );
  }
}

/**
 * The model server base URL is missing or does not point at the loopback
 * interface. The message comes from {@link getLocalBaseUrlError}.
 */
export class InvalidBaseUrlError extends ModelConfigError {
  readonly code = 'INVALID_BASE_URL';

  constructor(message: string) {
    super(message);
  }
}
