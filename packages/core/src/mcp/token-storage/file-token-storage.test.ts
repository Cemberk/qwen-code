/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import { FileTokenStorage } from './file-token-storage.js';
import { atomicWriteFile } from '../../utils/atomicFileWrite.js';

vi.mock('node:fs', () => ({
  promises: {
    readFile: vi.fn(),
    mkdir: vi.fn(),
  },
}));

vi.mock('../../utils/atomicFileWrite.js', () => ({
  atomicWriteFile: vi.fn(),
}));

vi.mock('node:os', () => ({
  default: {
    homedir: vi.fn(() => '/home/test'),
    hostname: vi.fn(() => 'test-host'),
    userInfo: vi.fn(() => ({ username: 'test-user' })),
  },
  homedir: vi.fn(() => '/home/test'),
  hostname: vi.fn(() => 'test-host'),
  userInfo: vi.fn(() => ({ username: 'test-user' })),
}));

// `{"test-storage":{"API_KEY":"sk-123"}}` as written by earlier builds for
// host `test-host` and user `test-user`; existing secret files must keep
// decrypting.
const EXISTING_SECRET_FILE =
  '07070707070707070707070707070707:d3de0d94bb48ccd098fef15dcf589724:7de2769b9882b98075698f088a11f8c50a88c5f793c262a81817b9799d402f4df9ab3aaca3';

describe('FileTokenStorage', () => {
  let storage: FileTokenStorage;
  const mockFs = fs as unknown as {
    readFile: ReturnType<typeof vi.fn>;
    mkdir: ReturnType<typeof vi.fn>;
  };
  const secretFilePath = path.join(
    '/home/test',
    '.qwen',
    'extension-secrets-v1.json',
  );

  beforeEach(() => {
    vi.clearAllMocks();
    mockFs.mkdir.mockResolvedValue(undefined);
    vi.mocked(atomicWriteFile).mockResolvedValue(undefined);
    storage = new FileTokenStorage('test-storage');
  });

  it('returns null / empty when no secret file exists', async () => {
    mockFs.readFile.mockRejectedValue({ code: 'ENOENT' });

    await expect(storage.getSecret('API_KEY')).resolves.toBeNull();
    await expect(storage.listSecrets()).resolves.toEqual([]);
  });

  it('decrypts a secret file written by earlier builds', async () => {
    mockFs.readFile.mockResolvedValue(EXISTING_SECRET_FILE);

    await expect(storage.getSecret('API_KEY')).resolves.toBe('sk-123');
    expect(mockFs.readFile).toHaveBeenCalledWith(secretFilePath, 'utf-8');
  });

  it('persists a secret encrypted under the service name', async () => {
    mockFs.readFile.mockRejectedValue({ code: 'ENOENT' });

    await storage.setSecret('API_KEY', 'sk-123');

    expect(mockFs.mkdir).toHaveBeenCalledWith(
      path.join('/home/test', '.qwen'),
      {
        recursive: true,
        mode: 0o700,
      },
    );
    expect(atomicWriteFile).toHaveBeenCalledTimes(1);
    const [writtenPath, writtenData, writeOptions] =
      vi.mocked(atomicWriteFile).mock.calls[0];
    expect(writtenPath).toBe(secretFilePath);
    expect(writtenData).toMatch(/^[0-9a-f]+:[0-9a-f]+:[0-9a-f]+$/);
    expect(writeOptions).toEqual({
      mode: 0o600,
      forceMode: true,
      noFollow: true,
    });
    expect(JSON.parse(storage['decrypt'](writtenData as string))).toEqual({
      'test-storage': { API_KEY: 'sk-123' },
    });
  });

  it('keeps secrets of other services when writing', async () => {
    mockFs.readFile.mockResolvedValue(
      storage['encrypt'](
        JSON.stringify({ 'other-service': { API_KEY: 'sk-other' } }),
      ),
    );

    await storage.setSecret('API_KEY', 'sk-123');

    const [, writtenData] = vi.mocked(atomicWriteFile).mock.calls[0];
    expect(JSON.parse(storage['decrypt'](writtenData as string))).toEqual({
      'other-service': { API_KEY: 'sk-other' },
      'test-storage': { API_KEY: 'sk-123' },
    });
  });

  it('reads back a stored secret and ignores other keys and services', async () => {
    const encrypted = storage['encrypt'](
      JSON.stringify({
        'test-storage': { API_KEY: 'sk-123' },
        'other-service': { API_KEY: 'sk-other' },
      }),
    );
    mockFs.readFile.mockResolvedValue(encrypted);

    await expect(storage.getSecret('API_KEY')).resolves.toBe('sk-123');
    await expect(storage.getSecret('MISSING')).resolves.toBeNull();
    await expect(storage.listSecrets()).resolves.toEqual(['API_KEY']);
  });

  it('deletes a secret and drops the now-empty service bucket', async () => {
    const encrypted = storage['encrypt'](
      JSON.stringify({ 'test-storage': { API_KEY: 'sk-123' } }),
    );
    mockFs.readFile.mockResolvedValue(encrypted);

    await storage.deleteSecret('API_KEY');

    expect(atomicWriteFile).toHaveBeenCalledTimes(1);
    const [, writtenData] = vi.mocked(atomicWriteFile).mock.calls[0];
    expect(JSON.parse(storage['decrypt'](writtenData as string))).toEqual({});
  });

  it('deleting a missing secret is a no-op (no write, no throw)', async () => {
    mockFs.readFile.mockRejectedValue({ code: 'ENOENT' });

    await expect(storage.deleteSecret('API_KEY')).resolves.toBeUndefined();
    expect(atomicWriteFile).not.toHaveBeenCalled();
  });

  it('refuses to overwrite a corrupted secret file', async () => {
    mockFs.readFile.mockResolvedValue('corrupted-data');

    await expect(storage.setSecret('API_KEY', 'sk-123')).rejects.toThrow(
      'Invalid encrypted data format',
    );
    expect(atomicWriteFile).not.toHaveBeenCalled();
  });

  it('propagates atomicWriteFile failures', async () => {
    mockFs.readFile.mockRejectedValue({ code: 'ENOENT' });
    vi.mocked(atomicWriteFile).mockRejectedValueOnce(
      Object.assign(new Error('ENOSPC: no space left on device'), {
        code: 'ENOSPC',
      }) as NodeJS.ErrnoException,
    );

    await expect(storage.setSecret('API_KEY', 'sk-123')).rejects.toThrow(
      /ENOSPC/,
    );
  });

  describe('encryption', () => {
    it('should encrypt and decrypt data correctly', () => {
      const original = 'test-data-123';
      const encrypted = storage['encrypt'](original);
      const decrypted = storage['decrypt'](encrypted);

      expect(decrypted).toBe(original);
      expect(encrypted).not.toBe(original);
      expect(encrypted).toMatch(/^[0-9a-f]+:[0-9a-f]+:[0-9a-f]+$/);
    });

    it('should produce different encrypted output each time', () => {
      const original = 'test-data';
      const encrypted1 = storage['encrypt'](original);
      const encrypted2 = storage['encrypt'](original);

      expect(encrypted1).not.toBe(encrypted2);
      expect(storage['decrypt'](encrypted1)).toBe(original);
      expect(storage['decrypt'](encrypted2)).toBe(original);
    });

    it('should throw on invalid encrypted data format', () => {
      expect(() => storage['decrypt']('invalid-data')).toThrow(
        'Invalid encrypted data format',
      );
    });
  });
});
