/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

export function closeFileWatcher(
  watcher: { close(): void | Promise<void> } | undefined,
): Promise<void> {
  if (!watcher) return Promise.resolve();
  return Promise.resolve(watcher.close());
}
