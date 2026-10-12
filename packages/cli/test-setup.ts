/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

// Unset NO_COLOR environment variable to ensure consistent theme behavior between local and CI test runs
if (process.env['NO_COLOR'] !== undefined) {
  delete process.env['NO_COLOR'];
}

// Avoid writing per-session debug log files during CLI tests.
// Individual tests can still opt in by overriding this env var explicitly.
if (process.env['QWEN_DEBUG_LOG_FILE'] === undefined) {
  process.env['QWEN_DEBUG_LOG_FILE'] = '0';
}

delete process.env['SANDBOX_SET_UID_GID'];

import { configure } from '@testing-library/react';

import './src/test-utils/customMatchers.js';

// CI and the autofix verification gate run this suite on a shared,
// oversubscribed host, where the testing-library default 1s async budget is
// spent on neighbour load rather than on the code under test (the gate's
// 60s testTimeout cannot help: waitFor has its own default). Give async
// queries room there only — locally the 1s default keeps failures fast.
// Assertions are untouched: a condition that never holds still fails.
if (process.env['CI']) {
  configure({ asyncUtilTimeout: 10_000 });
}

// Lowlight is loaded asynchronously in production to keep it out of the
// startup-critical bundle chunk. Snapshot tests render synchronously via
// `lastFrame()` and would otherwise capture the plain-text fallback before
// the dynamic import resolves. Prime the cache once here so every test sees
// the fully-highlighted output. The loader is intentionally a tiny standalone
// module (no transitive imports of themeManager / settings / core) so this
// prime does not perturb any other test's module graph.
import { loadLowlight } from './src/ui/utils/lowlightLoader.js';
try {
  await loadLowlight();
} catch (err) {
  // Don't crash the entire test run if lowlight fails to import; snapshot
  // tests that hit a code block will then render the plain-text fallback.
  console.warn(
    '[test-setup] Failed to prime lowlight cache, snapshot tests may ' +
      'show plain-text fallback:',
    String(err),
  );
}
