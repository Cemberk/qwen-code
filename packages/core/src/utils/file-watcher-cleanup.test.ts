/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

describe('file watcher cleanup', () => {
  const platform = process.platform;

  beforeEach(() => {
    vi.resetModules();
    Object.defineProperty(process, 'platform', { value: 'darwin' });
  });

  afterEach(() => {
    Object.defineProperty(process, 'platform', { value: platform });
  });

  it('closes watchers normally before final process exit', async () => {
    const { closeFileWatcher } = await import('./file-watcher-cleanup.js');
    let finish!: () => void;
    const closed = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const watcher = Object.assign(new EventEmitter(), {
      close: vi.fn(() => closed),
    });

    expect(closeFileWatcher(watcher)).toBe(closed);
    expect(watcher.close).toHaveBeenCalledOnce();
    finish();
    await closed;
  });

  it('preserves normal close failures and accepts an uninitialized watcher', async () => {
    const { closeFileWatcher } = await import('./file-watcher-cleanup.js');
    await expect(closeFileWatcher(undefined)).resolves.toBeUndefined();
    const error = new Error('Close failed');
    const watcher = Object.assign(new EventEmitter(), {
      close: vi.fn<() => void | Promise<void>>(() => {
        throw error;
      }),
    });
    expect(() => closeFileWatcher(watcher)).toThrow(error);
    watcher.close.mockImplementation(() => Promise.reject(error));
    await expect(closeFileWatcher(watcher)).rejects.toBe(error);
  });
});
