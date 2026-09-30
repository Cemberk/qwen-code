/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { randomBytes } from 'node:crypto';
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as tar from 'tar';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { assertTarArchiveLinksAreSafe } from './archive-safety.js';

// Passthrough wrapper around `fs.createReadStream` that tests can hook to
// observe how much of the archive the scan actually reads.
const streamProbe = vi.hoisted(() => ({
  onReadStream: undefined as
    | ((
        filePath: unknown,
        options: unknown,
        original: (
          filePath: unknown,
          options: unknown,
        ) => NodeJS.ReadableStream,
      ) => NodeJS.ReadableStream)
    | undefined,
}));

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return {
    ...actual,
    createReadStream: (filePath: unknown, options: unknown) => {
      const original = (
        actual.createReadStream as (
          filePath: unknown,
          options: unknown,
        ) => NodeJS.ReadableStream
      ).bind(actual);
      if (streamProbe.onReadStream) {
        return streamProbe.onReadStream(filePath, options, original);
      }
      return original(filePath, options);
    },
  };
});

// Builds a ustar header for a zero-content entry. `tar.t` parses headers via
// `onReadEntry` without requiring entry content.
function createTarFileHeader(
  name: string,
  size: number,
  type = '0',
  linkPath?: string,
): Buffer {
  const header = Buffer.alloc(512);
  header.write(name, 0, 100, 'utf8');
  header.write('0000644\0', 100, 8); // mode
  header.write('0000000\0', 108, 8); // uid
  header.write('0000000\0', 116, 8); // gid
  header.write(`${size.toString(8).padStart(11, '0')}\0`, 124, 12);
  header.write('14763423360\0', 136, 12); // mtime
  header.write('        ', 148, 8); // checksum placeholder (spaces)
  header.write(type, 156, 1);
  if (linkPath) header.write(linkPath, 157, 100, 'utf8');
  header.write('ustar\0', 257, 6);
  header.write('00', 263, 2);
  let checksum = 0;
  for (const byte of header) {
    checksum += byte;
  }
  header.write(`${checksum.toString(8).padStart(6, '0')}\0 `, 148, 8);
  return header;
}

const TAR_TRAILER = Buffer.alloc(1024);

async function writeCraftedTar(
  archive: string,
  headers: Buffer[],
): Promise<void> {
  await fs.writeFile(archive, Buffer.concat([...headers, TAR_TRAILER]));
}

describe('assertTarArchiveLinksAreSafe', () => {
  let root: string;

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'qwen-tar-safety-'));
  });

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  it.runIf(process.platform !== 'win32')(
    'rejects a large link set without throwing outside the promise',
    async () => {
      const links = Array.from({ length: 101 }, (_, index) => `link-${index}`);
      await Promise.all(
        links.map(async (link) => {
          await fs.symlink('missing-target', path.join(root, link));
        }),
      );
      const archive = path.join(root, 'links.tar');
      await tar.c({ cwd: root, file: archive }, links);

      await expect(assertTarArchiveLinksAreSafe(archive)).rejects.toThrow(
        'more than 100 unsupported link entries',
      );
    },
  );

  it.runIf(process.platform !== 'win32')(
    'stops reading the archive as soon as validation fails',
    async () => {
      const links = Array.from({ length: 101 }, (_, index) => `link-${index}`);
      await Promise.all(
        links.map(async (link) => {
          await fs.symlink('missing-target', path.join(root, link));
        }),
      );
      // A large trailing entry that a scan-to-end implementation would still
      // consume after the link limit trips; an early abort never reaches it.
      const tailBytes = 20 * 1024 * 1024;
      await fs.writeFile(path.join(root, 'tail.bin'), randomBytes(tailBytes));
      const archive = path.join(root, 'abort-links.tar');
      await tar.c({ cwd: root, file: archive }, [...links, 'tail.bin']);

      let bytesRead = 0;
      streamProbe.onReadStream = (filePath, options, original) => {
        const stream = original(filePath, options);
        stream.on('data', (chunk) => {
          bytesRead += chunk.length;
        });
        return stream;
      };

      try {
        await expect(assertTarArchiveLinksAreSafe(archive)).rejects.toThrow(
          'more than 100 unsupported link entries',
        );
      } finally {
        streamProbe.onReadStream = undefined;
      }

      // Without the early abort the scan would read the whole ~20 MB tail.
      expect(bytesRead).toBeLessThan(tailBytes / 2);
    },
  );

  it('rejects a pre-aborted signal without opening the archive stream', async () => {
    const controller = new AbortController();
    const abortReason = new Error('install cancelled');
    controller.abort(abortReason);
    let createReadStreamCalls = 0;
    streamProbe.onReadStream = (filePath, options, original) => {
      createReadStreamCalls += 1;
      const stream = original(filePath, options);
      // If the regression returns, the abandoned stream would emit an
      // unhandled ENOENT 'error' event; swallow it so the assertion below
      // fails the test cleanly instead of crashing the worker.
      stream.on('error', () => {});
      return stream;
    };

    try {
      await expect(
        assertTarArchiveLinksAreSafe(
          path.join(root, 'missing.tar'),
          controller.signal,
        ),
      ).rejects.toBe(abortReason);
    } finally {
      streamProbe.onReadStream = undefined;
    }

    expect(createReadStreamCalls).toBe(0);
  });

  it.runIf(process.platform !== 'win32')(
    'rejects a symlink entry',
    async () => {
      await fs.writeFile(path.join(root, 'CLAUDE.md'), '# guide\n');
      await fs.symlink('CLAUDE.md', path.join(root, 'AGENTS.md'));
      const archive = path.join(root, 'default.tar');
      await tar.c({ cwd: root, file: archive }, ['CLAUDE.md', 'AGENTS.md']);

      await expect(assertTarArchiveLinksAreSafe(archive)).rejects.toThrow(
        'unsupported link entry',
      );
    },
  );

  it('rejects a hard link entry', async () => {
    const archive = path.join(root, 'hard.tar');
    await writeCraftedTar(archive, [
      createTarFileHeader('original.txt', 0),
      createTarFileHeader('hard.txt', 0, '1', 'original.txt'),
    ]);

    await expect(assertTarArchiveLinksAreSafe(archive)).rejects.toThrow(
      'unsupported link entry',
    );
  });

  it('accepts an archive without link entries', async () => {
    const archive = path.join(root, 'plain.tar');
    await writeCraftedTar(archive, [createTarFileHeader('file.txt', 0)]);

    await expect(
      assertTarArchiveLinksAreSafe(archive),
    ).resolves.toBeUndefined();
  });
});
