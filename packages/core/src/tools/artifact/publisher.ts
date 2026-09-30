/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { createHash } from 'node:crypto';
import path from 'node:path';

/**
 * Contract for publishing an artifact. The local backend writes to disk and
 * returns a file:// URL. The {@link ArtifactTool} depends only on this
 * interface so tests can inject a publisher.
 */
export type ArtifactPublisherKind = 'local';

export interface ArtifactPublisher {
  /** Backend identifier, e.g. 'local'. */
  readonly kind: ArtifactPublisherKind;
  /**
   * Publishes (or redeploys) the document. Implementations MUST be idempotent
   * for a given {@link PublishArtifactInput.id}: the same id redeploys to the
   * same destination/URL.
   */
  publish(
    input: PublishArtifactInput,
    signal?: AbortSignal,
  ): Promise<PublishedArtifact>;
}

export interface PublishArtifactInput {
  /** Stable identity for this artifact (see {@link artifactIdFromPath}). */
  id: string;
  /** Human-readable title (already sanitized). */
  title: string;
  /** The full, wrapped, self-contained HTML document to publish. */
  html: string;
}

export interface PublishedArtifact {
  /** Stable artifact id (echoes the input id). */
  id: string;
  /** Address to open or share the artifact. */
  url: string;
  /** Absolute path of the published document, when the backend writes to disk. */
  filePath?: string;
}

/**
 * Derives a stable artifact id from the source fragment's file path. Identity
 * is keyed by path so re-publishing an edited file redeploys to the same URL;
 * a different path mints a new artifact.
 */
export function artifactIdFromPath(filePath: string): string {
  const normalized = path.resolve(filePath);
  return createHash('sha1').update(normalized).digest('hex').slice(0, 16);
}
