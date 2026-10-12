/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import type { Message } from './types.js';
import { safeJsonStringify } from '../utils/safeJsonStringify.js';
import { createDebugLogger } from '../utils/debugLogger.js';

const debugLogger = createDebugLogger('TRUSTED_HOOKS');

export class MessageBus extends EventEmitter {
  constructor(private readonly debug = false) {
    super();
    this.debug = debug;
  }

  private isValidMessage(message: Message): boolean {
    return Boolean(message && message.type);
  }

  private emitMessage(message: Message): void {
    this.emit(message.type, message);
  }

  async publish(message: Message): Promise<void> {
    if (this.debug) {
      debugLogger.debug(`[MESSAGE_BUS] publish: ${safeJsonStringify(message)}`);
    }
    try {
      if (!this.isValidMessage(message)) {
        throw new Error(
          `Invalid message structure: ${safeJsonStringify(message)}`,
        );
      }

      this.emitMessage(message);
    } catch (error) {
      this.emit('error', error);
    }
  }

  subscribe<T extends Message>(
    type: T['type'],
    listener: (message: T) => void,
  ): void {
    this.on(type, listener);
  }

  unsubscribe<T extends Message>(
    type: T['type'],
    listener: (message: T) => void,
  ): void {
    this.off(type, listener);
  }

  /**
   * Request-response pattern: Publish a message and wait for a correlated response
   * This enables synchronous-style communication over the async MessageBus
   * The correlation ID is generated internally and added to the request
   */
  async request<TRequest extends Message, TResponse extends Message>(
    request: Omit<TRequest, 'correlationId'>,
    responseType: TResponse['type'],
    timeoutMs: number = 60000,
    signal?: AbortSignal,
  ): Promise<TResponse> {
    const correlationId = randomUUID();

    return new Promise<TResponse>((resolve, reject) => {
      // Check if already aborted
      if (signal?.aborted) {
        reject(new Error('Request aborted'));
        return;
      }

      const timeoutId = setTimeout(() => {
        cleanup();
        reject(new Error(`Request timed out waiting for ${responseType}`));
      }, timeoutMs);

      const cleanup = () => {
        clearTimeout(timeoutId);
        this.unsubscribe(responseType, responseHandler);
        if (signal) {
          signal.removeEventListener('abort', abortHandler);
        }
      };

      const abortHandler = () => {
        cleanup();
        reject(new Error('Request aborted'));
      };

      if (signal) {
        signal.addEventListener('abort', abortHandler, { once: true });
      }

      const responseHandler = (response: TResponse) => {
        // Check if this response matches our request
        if (
          'correlationId' in response &&
          response.correlationId === correlationId
        ) {
          cleanup();
          resolve(response);
        }
      };

      // Subscribe to responses
      this.subscribe<TResponse>(responseType, responseHandler);

      // Publish the request with correlation ID
      this.publish({ ...request, correlationId } as TRequest);
    });
  }
}
