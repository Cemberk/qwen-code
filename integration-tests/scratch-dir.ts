/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { rm } from 'node:fs/promises';

export async function removeScratchDir(dir: string): Promise<void> {
  try {
    // A CLI child outliving its test keeps writing under its scratch dir, so
    // the removal walk can reach a directory that refills before the rmdir —
    // retries absorb that. The catch is what matters: a cleanup that cannot
    // finish must not turn an all-green run red, the way the memory-file
    // restore did in #10325.
    await rm(dir, {
      recursive: true,
      force: true,
      maxRetries: 5,
      retryDelay: 200,
    });
  } catch (e) {
    console.error(`Warning: could not remove ${dir}:`, e);
  }
}
