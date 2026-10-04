/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect } from 'vitest';
import { convertTomlToMarkdown } from './toml-to-markdown-converter.js';
import { parse as parseYaml } from './yaml-parser.js';

function readDescriptionFromFrontmatter(markdown: string): unknown {
  const match = markdown.match(/^---\n([\s\S]*?)\n---\n/);
  expect(match).not.toBeNull();
  return parseYaml(match![1])['description'];
}

describe('convertTomlToMarkdown', () => {
  it('should convert TOML with description to Markdown', () => {
    const tomlContent = `prompt = "This is a test prompt"
description = "Test command"`;

    const result = convertTomlToMarkdown(tomlContent);

    expect(result).toBe(`---
description: Test command
---

This is a test prompt
`);
  });

  it('should convert TOML without description to Markdown', () => {
    const tomlContent = `prompt = "Simple prompt"`;

    const result = convertTomlToMarkdown(tomlContent);

    expect(result).toBe('Simple prompt\n');
  });

  it('should handle multi-line prompts', () => {
    const tomlContent = `prompt = """
This is a multi-line
prompt with several
lines of text.
"""
description = "Multi-line test"`;

    const result = convertTomlToMarkdown(tomlContent);

    expect(result).toContain('This is a multi-line');
    expect(result).toContain('description: Multi-line test');
  });

  it('should throw error for invalid TOML', () => {
    const invalidToml = 'this is not valid toml {[}]';

    expect(() => convertTomlToMarkdown(invalidToml)).toThrow(
      'Failed to parse TOML',
    );
  });

  it('should throw error if prompt field is missing', () => {
    const tomlWithoutPrompt = 'description = "No prompt here"';

    expect(() => convertTomlToMarkdown(tomlWithoutPrompt)).toThrow(
      'TOML must contain a "prompt" field',
    );
  });

  it('should handle special characters in description', () => {
    const tomlContent = `prompt = "Test prompt"
description = "Command with: special, characters!"`;

    const result = convertTomlToMarkdown(tomlContent);

    expect(readDescriptionFromFrontmatter(result)).toBe(
      'Command with: special, characters!',
    );
  });

  it('should preserve YAML-like description strings as strings', () => {
    for (const description of ['false', '123', 'null', 'line one\nline two']) {
      const tomlContent = `prompt = "Test prompt"
description = ${JSON.stringify(description)}`;

      const result = convertTomlToMarkdown(tomlContent);

      expect(readDescriptionFromFrontmatter(result)).toBe(description);
    }
  });
});
