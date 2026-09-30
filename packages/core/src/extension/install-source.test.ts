/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { parseInstallSource } from './install-source.js';
import * as fs from 'node:fs/promises';
import * as fsSync from 'node:fs';

vi.mock('node:fs/promises', () => ({
  stat: vi.fn(),
}));

vi.mock('node:fs', () => ({
  promises: {
    readFile: vi.fn(),
  },
}));

describe('parseInstallSource', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(fsSync.promises.readFile).mockRejectedValue(new Error('ENOENT'));
  });

  describe('local path parsing', () => {
    it('should parse relative path with ../ correctly', async () => {
      vi.mocked(fs.stat).mockResolvedValueOnce({} as never);

      const result = await parseInstallSource('../claude-code');

      expect(result.source).toBe('../claude-code');
      expect(result.type).toBe('local');
      expect(result.pluginName).toBeUndefined();
    });

    it('should parse relative path with ./../ correctly', async () => {
      vi.mocked(fs.stat).mockResolvedValueOnce({} as never);

      const result = await parseInstallSource('./../claude-code');

      expect(result.source).toBe('./../claude-code');
      expect(result.type).toBe('local');
      expect(result.pluginName).toBeUndefined();
    });

    it('should parse relative path with ./ correctly', async () => {
      vi.mocked(fs.stat).mockResolvedValueOnce({} as never);

      const result = await parseInstallSource('./my-extension');

      expect(result.source).toBe('./my-extension');
      expect(result.type).toBe('local');
      expect(result.pluginName).toBeUndefined();
    });

    it('should parse local path without plugin name', async () => {
      vi.mocked(fs.stat).mockResolvedValueOnce({} as never);

      const result = await parseInstallSource('/path/to/extension');

      expect(result.source).toBe('/path/to/extension');
      expect(result.type).toBe('local');
      expect(result.pluginName).toBeUndefined();
    });

    it('should parse local path with plugin name', async () => {
      vi.mocked(fs.stat).mockResolvedValueOnce({} as never);

      const result = await parseInstallSource('/path/to/extension:my-plugin');

      expect(result.source).toBe('/path/to/extension');
      expect(result.type).toBe('local');
      expect(result.pluginName).toBe('my-plugin');
    });

    it('should reject a non-existent path that looks like owner/repo', async () => {
      vi.mocked(fs.stat).mockRejectedValueOnce(new Error('ENOENT'));

      await expect(parseInstallSource('some-org/some-repo')).rejects.toThrow(
        'Install source not found: some-org/some-repo. Only local paths are supported.',
      );
    });

    it('should reject remote URLs', async () => {
      vi.mocked(fs.stat).mockRejectedValueOnce(new Error('ENOENT'));

      await expect(
        parseInstallSource('https://github.com/owner/repo'),
      ).rejects.toThrow('Only local paths are supported.');
    });

    it('should throw error for non-existent path that is not valid format', async () => {
      vi.mocked(fs.stat).mockRejectedValueOnce(new Error('ENOENT'));

      await expect(
        parseInstallSource('invalid-format-no-slash'),
      ).rejects.toThrow('Install source not found: invalid-format-no-slash');
    });

    it('should handle Windows drive letter correctly', async () => {
      vi.mocked(fs.stat).mockResolvedValueOnce({} as never);

      const result = await parseInstallSource('C:\\path\\to\\extension');

      expect(result.source).toBe('C:\\path\\to\\extension');
      expect(result.type).toBe('local');
      // The colon after C should not be treated as plugin separator
      expect(result.pluginName).toBeUndefined();
    });
  });

  describe('marketplace config detection', () => {
    it('should detect a local marketplace config', async () => {
      vi.mocked(fs.stat).mockResolvedValueOnce({} as never);
      const mockMarketplaceConfig = {
        name: 'test-marketplace',
        owner: { name: 'Test Owner' },
        plugins: [{ name: 'plugin1' }],
      };
      vi.mocked(fsSync.promises.readFile).mockResolvedValueOnce(
        JSON.stringify(mockMarketplaceConfig),
      );

      const result = await parseInstallSource('/path/to/marketplace:plugin1');

      expect(result.type).toBe('local');
      expect(result.pluginName).toBe('plugin1');
      expect(result.originSource).toBe('Claude');
      expect(result.marketplaceConfig).toEqual(mockMarketplaceConfig);
    });

    it('should not set a marketplace config when none exists', async () => {
      vi.mocked(fs.stat).mockResolvedValueOnce({} as never);

      const result = await parseInstallSource('/path/to/extension');

      expect(result.marketplaceConfig).toBeUndefined();
      expect(result.originSource).toBeUndefined();
    });
  });
});
