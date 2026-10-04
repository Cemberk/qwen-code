/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { createDebugLogger } from '../../utils/debugLogger.js';
import type { Config } from '../../config/config.js';
import { InProcessBackend } from './InProcessBackend.js';
import { type Backend, DISPLAY_MODE } from './types.js';

const debugLogger = createDebugLogger('BACKEND_DETECT');

export interface DetectBackendResult {
  backend: Backend;
  warning?: string;
}

/**
 * Detect and create the appropriate Backend.
 *
 * Only the in-process backend exists; any other display preference falls
 * back to it with a warning.
 *
 * @param preference - Optional display mode preference (an unchecked
 *   settings value)
 * @param runtimeContext - Runtime config for in-process fallback
 */
export async function detectBackend(
  preference: string | undefined,
  runtimeContext: Config,
): Promise<DetectBackendResult> {
  const warning =
    preference && preference !== DISPLAY_MODE.IN_PROCESS
      ? `Display mode "${preference}" is not currently supported. Using in-process mode instead.`
      : undefined;
  debugLogger.info('Using InProcessBackend');
  return { backend: new InProcessBackend(runtimeContext), warning };
}
