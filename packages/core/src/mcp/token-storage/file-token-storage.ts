/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import * as crypto from 'node:crypto';
import { Mutex } from 'async-mutex';
import { Storage } from '../../config/storage.js';
import { atomicWriteFile } from '../../utils/atomicFileWrite.js';

// Secrets are keyed by service name so a single encrypted file can hold secrets
// for many callers.
type SecretFileContents = Record<string, Record<string, string>>;

// Every service shares one file, so concurrent read-modify-write cycles in this
// process must not interleave or one writer drops the other's secrets.
const secretFileLock = new Mutex();

export class FileTokenStorage {
  private readonly serviceName: string;
  private readonly secretFilePath: string;
  private readonly encryptionKey: Buffer;

  constructor(serviceName: string) {
    this.serviceName = serviceName;
    this.secretFilePath = path.join(
      Storage.getGlobalQwenDir(),
      'extension-secrets-v1.json',
    );
    this.encryptionKey = this.deriveEncryptionKey();
  }

  // The password and salt must stay as-is so existing secret files decrypt.
  private deriveEncryptionKey(): Buffer {
    const salt = `${os.hostname()}-${os.userInfo().username}-qwen-code`;
    return crypto.scryptSync('qwen-code-oauth', salt, 32);
  }

  private encrypt(text: string): string {
    const iv = crypto.randomBytes(16);
    const cipher = crypto.createCipheriv('aes-256-gcm', this.encryptionKey, iv);

    let encrypted = cipher.update(text, 'utf8', 'hex');
    encrypted += cipher.final('hex');

    const authTag = cipher.getAuthTag();

    return iv.toString('hex') + ':' + authTag.toString('hex') + ':' + encrypted;
  }

  private decrypt(encryptedData: string): string {
    const parts = encryptedData.split(':');
    if (parts.length !== 3) {
      throw new Error('Invalid encrypted data format');
    }

    const iv = Buffer.from(parts[0], 'hex');
    const authTag = Buffer.from(parts[1], 'hex');
    const encrypted = parts[2];

    const decipher = crypto.createDecipheriv(
      'aes-256-gcm',
      this.encryptionKey,
      iv,
    );
    decipher.setAuthTag(authTag);

    let decrypted = decipher.update(encrypted, 'hex', 'utf8');
    decrypted += decipher.final('utf8');

    return decrypted;
  }

  private async loadSecrets(): Promise<SecretFileContents> {
    try {
      const data = await fs.readFile(this.secretFilePath, 'utf-8');
      return JSON.parse(this.decrypt(data)) as SecretFileContents;
    } catch (error: unknown) {
      const err = error as NodeJS.ErrnoException;
      if (err.code === 'ENOENT') {
        return {};
      }
      throw error;
    }
  }

  private async saveSecrets(secrets: SecretFileContents): Promise<void> {
    await fs.mkdir(path.dirname(this.secretFilePath), {
      recursive: true,
      mode: 0o700,
    });
    const encrypted = this.encrypt(JSON.stringify(secrets));
    await atomicWriteFile(this.secretFilePath, encrypted, {
      mode: 0o600,
      forceMode: true,
      noFollow: true,
    });
  }

  async setSecret(key: string, value: string): Promise<void> {
    await secretFileLock.runExclusive(async () => {
      const secrets = await this.loadSecrets();
      (secrets[this.serviceName] ??= {})[key] = value;
      await this.saveSecrets(secrets);
    });
  }

  async getSecret(key: string): Promise<string | null> {
    const secrets = await this.loadSecrets();
    return secrets[this.serviceName]?.[key] ?? null;
  }

  // Idempotent: deleting a missing secret is a no-op.
  async deleteSecret(key: string): Promise<void> {
    await secretFileLock.runExclusive(async () => {
      const secrets = await this.loadSecrets();
      const bucket = secrets[this.serviceName];
      if (!bucket || !(key in bucket)) {
        return;
      }
      delete bucket[key];
      if (Object.keys(bucket).length === 0) {
        delete secrets[this.serviceName];
      }
      await this.saveSecrets(secrets);
    });
  }

  async listSecrets(): Promise<string[]> {
    const secrets = await this.loadSecrets();
    return Object.keys(secrets[this.serviceName] ?? {});
  }
}
