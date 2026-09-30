/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { pipeline } from 'node:stream/promises';
import * as tar from 'tar';
import { getErrorMessage } from '../utils/errors.js';
import { SUPPORTED_EXTENSION_MANIFESTS } from './extension-converter.js';
import {
  AGENT_PLUGIN_MANIFEST,
  getAgentPluginSchemaStatus,
} from './agent-plugins-v1/manifest.js';
import { assertTarArchiveLinksAreSafe } from './archive-safety.js';
import { extractZipArchive } from './zip-extraction.js';

const SUPPORTED_ARCHIVE_EXTENSIONS = ['.tar.gz', '.zip'] as const;

export function isSupportedArchivePath(source: string): boolean {
  const normalized = source.toLowerCase();
  return SUPPORTED_ARCHIVE_EXTENSIONS.some((extension) =>
    normalized.endsWith(extension),
  );
}

export async function extractArchiveFile(
  archivePath: string,
  destination: string,
  signal?: AbortSignal,
): Promise<void> {
  signal?.throwIfAborted();
  if (!isSupportedArchivePath(archivePath)) {
    throw new Error(
      `Unsupported archive file for extension install: ${archivePath}`,
    );
  }
  try {
    await extractFile(archivePath, destination, signal);
    signal?.throwIfAborted();
    await flattenSingleExtensionDirectory(destination);
  } catch (error) {
    signal?.throwIfAborted();
    throw new Error(
      'Extension archive could not be extracted. Make sure it is a valid ' +
        `.zip or .tar.gz file. ${getErrorMessage(error)}`,
    );
  }
  signal?.throwIfAborted();
  assertExtractedArchiveContainsExtensionSource(destination);
}

export async function extractFile(
  file: string,
  dest: string,
  signal?: AbortSignal,
): Promise<void> {
  signal?.throwIfAborted();
  if (file.endsWith('.tar.gz')) {
    await assertTarArchiveLinksAreSafe(file, signal);
    signal?.throwIfAborted();
    try {
      await pipeline(fs.createReadStream(file), tar.x({ cwd: dest }), {
        signal,
      });
    } catch (error) {
      signal?.throwIfAborted();
      throw error;
    }
  } else if (file.endsWith('.zip')) {
    await extractZipArchive(file, dest, signal);
  } else {
    throw new Error(`Unsupported file extension for extraction: ${file}`);
  }
  signal?.throwIfAborted();
}

async function flattenSingleExtensionDirectory(destination: string) {
  // Many archives wrap content in a single top-level directory. Flatten only
  // when that directory looks like a valid extension root or a compatible
  // source that can be converted later.
  const entries = await fs.promises.readdir(destination, {
    withFileTypes: true,
  });
  if (hasSupportedExtensionSourceManifest(destination)) {
    return;
  }
  if (entries.length > 2) {
    return;
  }

  const lonelyDir = entries.find((entry) => entry.isDirectory());
  if (!lonelyDir) {
    return;
  }

  const rootPath = path.join(destination, lonelyDir.name);
  if (!hasSupportedExtensionSourceManifest(rootPath)) {
    return;
  }

  const extractedDirFiles = await fs.promises.readdir(rootPath);
  for (const file of extractedDirFiles) {
    const destinationPath = path.join(destination, file);
    if (fs.existsSync(destinationPath)) {
      throw new Error(
        `Extension archive cannot be flattened because "${file}" exists at both the archive root and inside "${lonelyDir.name}".`,
      );
    }
  }
  for (const file of extractedDirFiles) {
    const destinationPath = path.join(destination, file);
    await fs.promises.rename(path.join(rootPath, file), destinationPath);
  }
  await fs.promises.rmdir(rootPath);
}

function getSupportedManifestList(): string {
  return [
    ...SUPPORTED_EXTENSION_MANIFESTS,
    `${AGENT_PLUGIN_MANIFEST} (Agent Plugins)`,
  ].join(', ');
}

function hasSupportedExtensionSourceManifest(rootPath: string): boolean {
  return (
    getAgentPluginSchemaStatus(rootPath) !== 'unrelated' ||
    SUPPORTED_EXTENSION_MANIFESTS.some((manifestPath) =>
      fs.existsSync(path.join(rootPath, manifestPath)),
    )
  );
}

function assertExtractedArchiveContainsExtensionSource(
  destination: string,
): void {
  if (hasSupportedExtensionSourceManifest(destination)) {
    return;
  }

  throw new Error(
    'Extension archive is missing a supported extension manifest. ' +
      `Expected one of: ${getSupportedManifestList()} at the archive root, ` +
      'or inside a single top-level extension directory.',
  );
}
