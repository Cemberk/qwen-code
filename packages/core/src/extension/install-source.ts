/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type { ExtensionInstallMetadata } from '../config/config.js';
import type { ClaudeMarketplaceConfig } from './claude-converter.js';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { stat } from 'node:fs/promises';

/**
 * Parse the install source string into a local path and optional pluginName.
 * Format: <path>:<pluginName> where pluginName is optional. A colon at index
 * 1 is a Windows drive letter, not a pluginName delimiter.
 */
function parseSourceAndPluginName(source: string): {
  repo: string;
  pluginName?: string;
} {
  const lastColonIndex = source.lastIndexOf(':');
  if (lastColonIndex > 1) {
    return {
      repo: source.substring(0, lastColonIndex),
      pluginName: source.substring(lastColonIndex + 1),
    };
  }
  return { repo: source };
}

/**
 * Read marketplace config from local path
 */
async function readLocalMarketplaceConfig(
  localPath: string,
): Promise<ClaudeMarketplaceConfig | null> {
  const marketplaceConfigPath = path.join(
    localPath,
    '.claude-plugin',
    'marketplace.json',
  );
  try {
    const content = await fs.promises.readFile(marketplaceConfigPath, 'utf-8');
    return JSON.parse(content) as ClaudeMarketplaceConfig;
  } catch {
    return null;
  }
}

/**
 * Resolves an install source to install metadata. Only local paths
 * (directories or .zip / .tar.gz archives) are supported.
 */
export async function parseInstallSource(
  source: string,
): Promise<ExtensionInstallMetadata> {
  const { repo, pluginName } = parseSourceAndPluginName(source);

  try {
    await stat(repo);
  } catch {
    throw new Error(
      `Install source not found: ${repo}. Only local paths are supported.`,
    );
  }

  const installMetadata: ExtensionInstallMetadata = {
    source: repo,
    type: 'local',
    pluginName,
  };

  const marketplaceConfig = await readLocalMarketplaceConfig(repo);
  if (marketplaceConfig) {
    installMetadata.marketplaceConfig = marketplaceConfig;
    installMetadata.originSource = 'Claude';
  }

  return installMetadata;
}
