/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

// Packages esbuild.config.js leaves to runtime resolution instead of bundling.
export const external = [
  '@lydell/node-pty',
  '@lydell/node-pty-darwin-arm64',
  '@lydell/node-pty-darwin-x64',
  '@lydell/node-pty-linux-arm64',
  '@lydell/node-pty-linux-x64',
  '@lydell/node-pty-win32-arm64',
  '@lydell/node-pty-win32-x64',
  'sharp',
  // Only @modelcontextprotocol/client's private-key JWT auth imports it, and
  // the bundle tree-shakes that; bundled, it would still be emitted as an
  // orphan chunk carrying jose's remote JWKS fetcher.
  'jose',
];
