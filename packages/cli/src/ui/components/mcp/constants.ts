/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * MCP management constants
 */
/**
 * Max number of tools shown in the visible area of the tool list
 */
export const VISIBLE_TOOLS_COUNT = 10;

/**
 * Max number of resources shown in the visible area of the resource list
 */
export const VISIBLE_RESOURCES_COUNT = 10;

export const SOURCE_ORDER = [
  'user',
  'project',
  'workspace',
  'system',
  'extension',
] as const;
