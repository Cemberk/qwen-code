/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as os from 'node:os';
import * as fs from 'node:fs/promises';
import * as fsSync from 'node:fs';
import * as path from 'node:path';
import { randomBytes } from 'node:crypto';
import * as tar from 'tar';
import * as archiver from 'archiver';
import {
  extractArchiveFile,
  extractFile,
  isSupportedArchivePath,
} from './archive-extraction.js';
import { EXTENSIONS_CONFIG_FILENAME } from './variables.js';
import { QODER_PLUGIN_MANIFEST } from './qoder-converter.js';
import { assertTarArchiveLinksAreSafe } from './archive-safety.js';
import { AGENT_PLUGIN_SCHEMA } from './agent-plugins-v1/index.js';

async function createZipBuffer(
  tempDir: string,
  entries: Array<{ name: string; content: string }>,
): Promise<Buffer> {
  const archivePath = path.join(tempDir, `archive-${Date.now()}.zip`);
  const output = fsSync.createWriteStream(archivePath);
  const archive = archiver.create('zip');
  const streamFinished = new Promise((resolve, reject) => {
    output.on('close', () => resolve(null));
    archive.on('error', reject);
  });

  archive.pipe(output);
  for (const entry of entries) {
    archive.append(entry.content, { name: entry.name });
  }
  await archive.finalize();
  await streamFinished;
  return fs.readFile(archivePath);
}

describe('extractArchiveFile', () => {
  let tempDir: string;
  let archiveDir: string;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(
      path.join(os.tmpdir(), 'extension-archive-test-'),
    );
    archiveDir = await fs.mkdtemp(
      path.join(os.tmpdir(), 'extension-archive-source-'),
    );
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
    await fs.rm(archiveDir, { recursive: true, force: true });
  });

  it('should explain when a local archive is missing an extension manifest', async () => {
    const invalidArchivePath = path.join(archiveDir, 'invalid.zip');
    const invalidArchive = await createZipBuffer(archiveDir, [
      { name: 'README.md', content: 'not an extension' },
    ]);
    await fs.writeFile(invalidArchivePath, invalidArchive);

    await expect(
      extractArchiveFile(invalidArchivePath, tempDir),
    ).rejects.toThrow(
      'Extension archive is missing a supported extension manifest.',
    );
  });

  it('should extract and flatten a tar.gz archive with a wrapped extension directory', async () => {
    const archivePath = path.join(archiveDir, 'wrapped-extension.tar.gz');
    const sourceRoot = path.join(archiveDir, 'tar-source');
    const wrappedDir = path.join(sourceRoot, 'wrapped-extension');
    await fs.mkdir(wrappedDir, { recursive: true });
    await fs.writeFile(
      path.join(wrappedDir, EXTENSIONS_CONFIG_FILENAME),
      JSON.stringify({
        name: 'tar-wrapped-extension',
        version: '1.0.0',
      }),
    );
    await tar.c(
      {
        cwd: sourceRoot,
        file: archivePath,
        gzip: true,
      },
      ['wrapped-extension'],
    );
    await fs.rm(sourceRoot, { recursive: true, force: true });

    await extractArchiveFile(archivePath, tempDir);

    await expect(
      fs.readFile(path.join(tempDir, EXTENSIONS_CONFIG_FILENAME), 'utf-8'),
    ).resolves.toContain('tar-wrapped-extension');
  });

  it('should extract and flatten a wrapped Qoder plugin archive', async () => {
    const archivePath = path.join(archiveDir, 'wrapped-qoder-plugin.zip');
    const archive = await createZipBuffer(archiveDir, [
      {
        name: `wrapped/${QODER_PLUGIN_MANIFEST}`,
        content: JSON.stringify({ name: 'sample-qoder-plugin' }),
      },
      {
        name: 'wrapped/system-prompt.md',
        content: '# System context',
      },
    ]);
    await fs.writeFile(archivePath, archive);

    await extractArchiveFile(archivePath, tempDir);

    await expect(
      fs.readFile(path.join(tempDir, QODER_PLUGIN_MANIFEST), 'utf-8'),
    ).resolves.toContain('sample-qoder-plugin');
    await expect(
      fs.readFile(path.join(tempDir, 'system-prompt.md'), 'utf-8'),
    ).resolves.toBe('# System context');
  });

  it('should extract and flatten a wrapped Agent Plugin archive', async () => {
    const archivePath = path.join(archiveDir, 'wrapped-agent-plugin.zip');
    const manifest = JSON.stringify({
      $schema: AGENT_PLUGIN_SCHEMA,
      name: 'portable-plugin',
    });
    const skill =
      '---\nname: direct\ndescription: Direct skill\n---\nPortable instructions.';
    const archive = await createZipBuffer(archiveDir, [
      { name: 'wrapped/plugin.json', content: manifest },
      { name: 'wrapped/skills/direct/SKILL.md', content: skill },
    ]);
    await fs.writeFile(archivePath, archive);

    await extractArchiveFile(archivePath, tempDir);

    await expect(
      fs.readFile(path.join(tempDir, 'plugin.json'), 'utf8'),
    ).resolves.toBe(manifest);
    await expect(
      fs.readFile(path.join(tempDir, 'skills', 'direct', 'SKILL.md'), 'utf8'),
    ).resolves.toBe(skill);
  });

  it('should not flatten when the archive root already has a manifest', async () => {
    const archivePath = path.join(archiveDir, 'root-and-wrapper.zip');
    const archive = await createZipBuffer(archiveDir, [
      {
        name: EXTENSIONS_CONFIG_FILENAME,
        content: JSON.stringify({
          name: 'root-extension',
          version: '1.0.0',
        }),
      },
      {
        name: `wrapped/${EXTENSIONS_CONFIG_FILENAME}`,
        content: JSON.stringify({
          name: 'wrapped-extension',
          version: '1.0.0',
        }),
      },
    ]);
    await fs.writeFile(archivePath, archive);

    await extractArchiveFile(archivePath, tempDir);

    await expect(
      fs.readFile(path.join(tempDir, EXTENSIONS_CONFIG_FILENAME), 'utf-8'),
    ).resolves.toContain('root-extension');
    await expect(
      fs.readFile(
        path.join(tempDir, 'wrapped', EXTENSIONS_CONFIG_FILENAME),
        'utf-8',
      ),
    ).resolves.toContain('wrapped-extension');
  });

  it('should reject flattening when wrapper contents collide with root files', async () => {
    const archivePath = path.join(archiveDir, 'colliding-wrapper.zip');
    const archiveBuildDir = path.join(archiveDir, 'collision-build');
    await fs.mkdir(archiveBuildDir);
    const archive = await createZipBuffer(archiveBuildDir, [
      {
        name: `wrapped/${EXTENSIONS_CONFIG_FILENAME}`,
        content: JSON.stringify({
          name: 'wrapped-extension',
          version: '1.0.0',
        }),
      },
      { name: 'wrapped/README.md', content: 'wrapped readme' },
      { name: 'README.md', content: 'root readme' },
    ]);
    await fs.rm(archiveBuildDir, { recursive: true, force: true });
    await fs.writeFile(archivePath, archive);

    await expect(extractArchiveFile(archivePath, tempDir)).rejects.toThrow(
      /Extension archive could not be extracted.*Extension archive cannot be flattened because "README.md" exists at both the archive root and inside "wrapped"\./,
    );
    await expect(
      fs.readFile(path.join(tempDir, 'README.md'), 'utf-8'),
    ).resolves.toBe('root readme');
    await expect(
      fs.readFile(
        path.join(tempDir, 'wrapped', EXTENSIONS_CONFIG_FILENAME),
        'utf-8',
      ),
    ).resolves.toContain('wrapped-extension');
  });

  it('should not flatten archives with multiple top-level entries', async () => {
    const archivePath = path.join(archiveDir, 'multiple-entries.zip');
    const archive = await createZipBuffer(archiveDir, [
      {
        name: `wrapped/${EXTENSIONS_CONFIG_FILENAME}`,
        content: JSON.stringify({
          name: 'wrapped-extension',
          version: '1.0.0',
        }),
      },
      { name: 'README.md', content: 'readme' },
      { name: 'LICENSE', content: 'license' },
    ]);
    await fs.writeFile(archivePath, archive);

    await expect(extractArchiveFile(archivePath, tempDir)).rejects.toThrow(
      'Extension archive is missing a supported extension manifest.',
    );
    await expect(
      fs.readFile(
        path.join(tempDir, 'wrapped', EXTENSIONS_CONFIG_FILENAME),
        'utf-8',
      ),
    ).resolves.toContain('wrapped-extension');
  });

  it('should not flatten archives without a top-level directory', async () => {
    const archivePath = path.join(archiveDir, 'files-only.zip');
    const archive = await createZipBuffer(archiveDir, [
      {
        name: EXTENSIONS_CONFIG_FILENAME,
        content: JSON.stringify({
          name: 'files-only-extension',
          version: '1.0.0',
        }),
      },
      { name: 'README.md', content: 'readme' },
    ]);
    await fs.writeFile(archivePath, archive);

    await extractArchiveFile(archivePath, tempDir);

    await expect(
      fs.readFile(path.join(tempDir, EXTENSIONS_CONFIG_FILENAME), 'utf-8'),
    ).resolves.toContain('files-only-extension');
  });

  it('should not flatten a top-level directory without a supported manifest', async () => {
    const archivePath = path.join(archiveDir, 'unsupported-wrapper.zip');
    const archive = await createZipBuffer(archiveDir, [
      { name: 'wrapped/README.md', content: 'not an extension' },
    ]);
    await fs.writeFile(archivePath, archive);

    await expect(extractArchiveFile(archivePath, tempDir)).rejects.toThrow(
      'Extension archive is missing a supported extension manifest.',
    );
    await expect(
      fs.readFile(path.join(tempDir, 'wrapped', 'README.md'), 'utf-8'),
    ).resolves.toBe('not an extension');
  });

  it('should identify supported archive paths', () => {
    expect(isSupportedArchivePath('/tmp/extension.zip')).toBe(true);
    expect(isSupportedArchivePath('/tmp/extension.tar.gz')).toBe(true);
    expect(isSupportedArchivePath('/tmp/extension.tgz')).toBe(false);
  });
});

describe('extractFile', () => {
  let tempDir: string;

  async function getFileSize(filePath: string): Promise<number> {
    try {
      return (await fs.stat(filePath)).size;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 0;
      throw error;
    }
  }

  async function waitForFileData(filePath: string): Promise<void> {
    // Poll on a real wall-clock budget (~10s), not a fixed iteration count:
    // setImmediate turns are sub-millisecond, so 1_000 of them could elapse
    // in <100ms while the tar extraction I/O is still catching up on a
    // contended runner — the source of the "Timed out waiting for extracted
    // data" flake. Stays well under the 15s per-test ceiling.
    for (let attempt = 0; attempt < 2_000; attempt += 1) {
      if ((await getFileSize(filePath)) > 0) return;
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    throw new Error(`Timed out waiting for extracted data at ${filePath}`);
  }

  async function waitForStableFileSize(filePath: string): Promise<number> {
    let previousSize = -1;
    let stableChecks = 0;
    for (let attempt = 0; attempt < 100; attempt += 1) {
      await new Promise((resolve) => setImmediate(resolve));
      const size = await getFileSize(filePath);
      if (size === previousSize) {
        stableChecks += 1;
        if (stableChecks === 3) return size;
      } else {
        previousSize = size;
        stableChecks = 0;
      }
    }
    throw new Error(`Extracted data did not stop changing at ${filePath}`);
  }

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'gemini-test-'));
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it('should extract a .tar.gz file', async () => {
    const archivePath = path.join(tempDir, 'test.tar.gz');
    const extractionDest = path.join(tempDir, 'extracted');
    await fs.mkdir(extractionDest);

    // Create a dummy file to be archived
    const dummyFilePath = path.join(tempDir, 'test.txt');
    await fs.writeFile(dummyFilePath, 'hello tar');

    // Create the tar.gz file
    await tar.c(
      {
        gzip: true,
        file: archivePath,
        cwd: tempDir,
      },
      ['test.txt'],
    );

    await extractFile(archivePath, extractionDest);

    const extractedFilePath = path.join(extractionDest, 'test.txt');
    const content = await fs.readFile(extractedFilePath, 'utf-8');
    expect(content).toBe('hello tar');
  });

  it('should cancel while scanning a tar archive', async () => {
    const archivePath = path.join(tempDir, 'scan-cancel.tar.gz');
    const sourcePath = path.join(tempDir, 'large.bin');
    await fs.writeFile(sourcePath, randomBytes(16 * 1024 * 1024));
    await tar.c({ gzip: true, file: archivePath, cwd: tempDir }, ['large.bin']);

    const controller = new AbortController();
    const abortReason = new Error('cancel tar scan');
    const scan = assertTarArchiveLinksAreSafe(archivePath, controller.signal);
    setImmediate(() => controller.abort(abortReason));
    await expect(scan).rejects.toBe(abortReason);
  });

  it('should cancel while extracting a tar archive', async () => {
    const archivePath = path.join(tempDir, 'extract-cancel.tar.gz');
    const extractionDest = path.join(tempDir, 'extracted');
    const sourcePath = path.join(tempDir, 'large.bin');
    const extractedFilePath = path.join(extractionDest, 'large.bin');
    const content = randomBytes(32 * 1024 * 1024);
    await fs.mkdir(extractionDest);
    await fs.writeFile(sourcePath, content);
    await tar.c({ gzip: true, file: archivePath, cwd: tempDir }, ['large.bin']);

    const controller = new AbortController();
    const abortReason = new Error('cancel tar extraction');
    const extraction = extractFile(
      archivePath,
      extractionDest,
      controller.signal,
    );
    try {
      await waitForFileData(extractedFilePath);
    } catch (error) {
      controller.abort(error);
      await extraction.catch(() => undefined);
      throw error;
    }
    controller.abort(abortReason);
    await expect(extraction).rejects.toBe(abortReason);
    expect(await waitForStableFileSize(extractedFilePath)).toBeLessThan(
      content.length,
    );
  });

  it.skipIf(process.platform === 'win32')(
    'should reject symlink entries in tar archives',
    async () => {
      const archivePath = path.join(tempDir, 'symlink.tar.gz');
      const extractionDest = path.join(tempDir, 'extracted');
      const sourceDir = path.join(tempDir, 'source');
      const outsideDir = path.join(tempDir, 'outside');
      await fs.mkdir(extractionDest);
      await fs.mkdir(sourceDir);
      await fs.mkdir(outsideDir);
      await fs.symlink(outsideDir, path.join(sourceDir, 'escape-link'));

      await tar.c(
        {
          gzip: true,
          file: archivePath,
          cwd: sourceDir,
        },
        ['escape-link'],
      );

      await expect(extractFile(archivePath, extractionDest)).rejects.toThrow(
        'Tar archive contains unsupported link entry: escape-link',
      );

      await expect(
        fs.lstat(path.join(extractionDest, 'escape-link')),
      ).rejects.toThrow();
    },
  );

  it('should extract a .zip file', async () => {
    const archivePath = path.join(tempDir, 'test.zip');
    const extractionDest = path.join(tempDir, 'extracted');
    await fs.mkdir(extractionDest);

    // Create a dummy file to be archived
    const dummyFilePath = path.join(tempDir, 'test.txt');
    await fs.writeFile(dummyFilePath, 'hello zip');

    // Create the zip file
    const output = fsSync.createWriteStream(archivePath);
    const archive = archiver.create('zip');

    const streamFinished = new Promise((resolve, reject) => {
      output.on('close', () => resolve(null));
      archive.on('error', reject);
    });

    archive.pipe(output);
    archive.file(dummyFilePath, { name: 'test.txt' });
    await archive.finalize();
    await streamFinished;

    await extractFile(archivePath, extractionDest);

    const extractedFilePath = path.join(extractionDest, 'test.txt');
    const content = await fs.readFile(extractedFilePath, 'utf-8');
    expect(content).toBe('hello zip');
  });

  it('should cancel while extracting a zip archive', async () => {
    const archivePath = path.join(tempDir, 'extract-cancel.zip');
    const extractionDest = path.join(tempDir, 'extracted');
    const extractedFilePath = path.join(extractionDest, 'large.bin');
    const content = Buffer.alloc(64 * 1024 * 1024, 0x61);
    await fs.mkdir(extractionDest);

    const output = fsSync.createWriteStream(archivePath);
    const archive = archiver.create('zip');
    const streamFinished = new Promise((resolve, reject) => {
      output.on('close', () => resolve(null));
      archive.on('error', reject);
    });
    archive.pipe(output);
    archive.append(content, { name: 'large.bin' });
    await archive.finalize();
    await streamFinished;

    const controller = new AbortController();
    const abortReason = new Error('cancel zip extraction');
    const extraction = extractFile(
      archivePath,
      extractionDest,
      controller.signal,
    );
    try {
      await waitForFileData(extractedFilePath);
    } catch (error) {
      controller.abort(error);
      await extraction.catch(() => undefined);
      throw error;
    }
    controller.abort(abortReason);
    await expect(extraction).rejects.toBe(abortReason);
    expect(await waitForStableFileSize(extractedFilePath)).toBeLessThan(
      content.length,
    );
  });

  it('should reject symlink entries in zip archives', async () => {
    const archivePath = path.join(tempDir, 'symlink.zip');
    const extractionDest = path.join(tempDir, 'extracted');
    await fs.mkdir(extractionDest);

    const output = fsSync.createWriteStream(archivePath);
    const archive = archiver.create('zip');

    const streamFinished = new Promise((resolve, reject) => {
      output.on('close', () => resolve(null));
      archive.on('error', reject);
    });

    archive.pipe(output);
    archive.symlink('escape-link', '/tmp/outside-target');
    await archive.finalize();
    await streamFinished;

    await expect(extractFile(archivePath, extractionDest)).rejects.toThrow(
      'Zip archive contains unsupported symbolic link entry: escape-link',
    );
    await expect(
      fs.lstat(path.join(extractionDest, 'escape-link')),
    ).rejects.toThrow();
  });

  it.skipIf(process.platform === 'win32')(
    'should reject zip extraction through an existing symlink',
    async () => {
      const archivePath = path.join(tempDir, 'existing-symlink.zip');
      const extractionDest = path.join(tempDir, 'extracted');
      const outsideDir = path.join(tempDir, 'outside');
      await fs.mkdir(extractionDest);
      await fs.mkdir(outsideDir);
      await fs.symlink(outsideDir, path.join(extractionDest, 'escape'));

      const output = fsSync.createWriteStream(archivePath);
      const archive = archiver.create('zip');
      const streamFinished = new Promise((resolve, reject) => {
        output.on('close', () => resolve(null));
        archive.on('error', reject);
      });
      archive.pipe(output);
      archive.append('outside write', { name: 'escape/file.txt' });
      await archive.finalize();
      await streamFinished;

      await expect(extractFile(archivePath, extractionDest)).rejects.toThrow(
        'Refusing to extract through non-directory path',
      );
      await expect(
        fs.lstat(path.join(outsideDir, 'file.txt')),
      ).rejects.toThrow();
    },
  );

  it('should throw an error for unsupported file types', async () => {
    const unsupportedFilePath = path.join(tempDir, 'test.txt');
    await fs.writeFile(unsupportedFilePath, 'some content');
    const extractionDest = path.join(tempDir, 'extracted');
    await fs.mkdir(extractionDest);

    await expect(
      extractFile(unsupportedFilePath, extractionDest),
    ).rejects.toThrow('Unsupported file extension for extraction:');
  });
});
