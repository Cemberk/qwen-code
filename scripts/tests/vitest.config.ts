/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { configDefaults, defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['scripts/tests/**/*.test.{js,ts}'],
    exclude: [...configDefaults.exclude],
    setupFiles: ['scripts/tests/test-setup.ts'],
    // release-versioning spawns the real `corepack pnpm`; it must use the
    // cached pinned pnpm and fail rather than download one.
    env: { COREPACK_ENABLE_NETWORK: '0' },
    // Several suites spawn real subprocesses and run about 5x slower on a
    // contended host than on a quiet one.
    // `||`, not `??`: `??` only catches `undefined`, and a workflow expression
    // such as `${{ cond && 'x' || '' }}` renders `''` when the condition is
    // false. `Number('')` is 0, and vitest reads 0 as "no timeout at all", so
    // the empty spelling would silently disarm every ceiling in this suite.
    // `NaN` from a typo falls back the same way.
    testTimeout: Number(process.env['QWEN_SCRIPTS_TEST_TIMEOUT_MS']) || 90_000,
    coverage: {
      provider: 'v8',
      reporter: ['text', 'lcov'],
    },
    // No poolOptions override: the fixed 8-16 worker floor it used to carry
    // oversubscribes the 3-core macOS runners. Vitest's default scales with
    // the host cores, which is what every other suite in this repository
    // uses.
    //
    // RPC-timeout exemption; see scripts/tests/unit-vitest-configs.test.ts.
    dangerouslyIgnoreUnhandledErrors: process.platform !== 'linux',
  },
});
