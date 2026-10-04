/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Converts TOML command files to Markdown format.
 */

import toml from '@iarna/toml';
import { stringify as stringifyYaml } from './yaml-parser.js';

/**
 * Converts a TOML command content to Markdown format.
 * @param tomlContent The TOML file content
 * @returns The equivalent Markdown content
 * @throws Error if TOML parsing fails
 */
export function convertTomlToMarkdown(tomlContent: string): string {
  let parsed: unknown;
  try {
    parsed = toml.parse(tomlContent);
  } catch (error) {
    throw new Error(
      `Failed to parse TOML: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  if (typeof parsed !== 'object' || parsed === null) {
    throw new Error('TOML content must be an object');
  }

  const obj = parsed as Record<string, unknown>;

  if (typeof obj['prompt'] !== 'string') {
    throw new Error('TOML must contain a "prompt" field');
  }

  const prompt = obj['prompt'];
  const description =
    typeof obj['description'] === 'string' ? obj['description'] : undefined;

  // Generate Markdown
  if (description) {
    const frontmatter = stringifyYaml(
      { description },
      { lineWidth: 0 },
    ).trimEnd();

    return `---
${frontmatter}
---

${prompt}
`;
  } else {
    // No frontmatter if no description
    return `${prompt}\n`;
  }
}
