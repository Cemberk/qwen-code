/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Valid project-memory partitioning modes. Exported so CLI yargs choices,
 * type declarations, and runtime guards share one source of truth.
 */
export const MEMORY_PROJECT_SCOPES = ['git-root', 'workspace'] as const;
export type MemoryProjectScope = (typeof MEMORY_PROJECT_SCOPES)[number];
