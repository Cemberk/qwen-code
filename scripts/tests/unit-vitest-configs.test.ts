/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';

import cliConfig from '../../packages/cli/vitest.config.js';
import coreConfig from '../../packages/core/vitest.config.js';
import { getTestCiWorkspacePackageJsonPaths } from '../workspaces.js';
import scriptsTestsConfig from './vitest.config.js';

// Every vitest project that `npm run test:ci` runs on the Windows/macOS
// platform lanes carries the off-Linux unhandled-error exemption: vitest's
// worker->main `onTaskUpdate` RPC has a fixed 60s budget, and under runner
// resource pressure a stall longer than that exits an all-green run red
// (the nightly failure class behind #10438 and its predecessors). This
// witness pins the flag in every guarded config so removing it from any
// one of them fails the scripts suite on every platform.
type ExemptionConfig = {
  test?: {
    dangerouslyIgnoreUnhandledErrors?: boolean;
    testTimeout?: number;
    pool?: 'threads' | 'forks' | 'vmThreads';
    poolOptions?: { threads?: { maxThreads?: number } };
  };
};

const configs: Record<string, ExemptionConfig> = {
  'packages/cli': cliConfig,
  'packages/core': coreConfig,
  'scripts/tests': scriptsTestsConfig,
};

describe('unhandled-error exemption on the platform lanes', () => {
  for (const [name, config] of Object.entries(configs)) {
    it(`keeps unhandled errors fatal only on Linux in ${name}`, () => {
      // toBe, not toBeFalsy: a deleted flag is `undefined` and must fail
      // this pin on every platform, including Linux where the value is false.
      expect(config.test?.dangerouslyIgnoreUnhandledErrors).toBe(
        process.platform !== 'linux',
      );
    });
  }
});

// Every workspace that `npm run test:ci --workspaces` runs lands on the same
// shared ECS pool, where the identical suite takes ~5x longer depending only on
// which host it draws (#10490). Five configs were given a raised ceiling there
// one at a time; the other fifteen were still on vitest's 5s default, so a
// contended host — not a defect — was enough to fail them. Tests that had
// already been hand-patched past 5s individually (auto-recall 12s) keep
// those patches: a
// per-test timeout outranks the config-level field and stays load-bearing off
// the pool, where the ternary deliberately yields `undefined` (vitest's 5s
// default), so this pin guards the config-level ceiling only. It sweeps the
// whole map so a new workspace cannot quietly join the lane on the 5s default.
const configModules: Record<
  string,
  () => Promise<{ default: ExemptionConfig }>
> = {
  'packages/cli': () => import('../../packages/cli/vitest.config.js'),
  'packages/core': () => import('../../packages/core/vitest.config.js'),
  'scripts/tests': () => import('./vitest.config.js'),
};

describe('shared-pool test timeout', () => {
  // 60s is the ceiling the five already-raised configs settled on. Assert a
  // floor rather than equality so the config that legitimately sits higher
  // (scripts/tests at 90s) passes without pinning its own number here.
  const POOL_FLOOR_MS = 60_000;
  // Two names that share only the documented prefix: a gate narrowed past
  // `ecs-qwen-` (e.g. to the first stub itself) passes one name and fails the
  // other. Real pool runners look like `ecs-qwen-runner-64c-23`.
  const POOL_RUNNER_NAMES = ['ecs-qwen-parity', 'ecs-qwen-hk1-01'] as const;

  for (const [name, load] of Object.entries(configModules)) {
    it(`raises the ceiling on the shared pool in ${name}`, async () => {
      for (const runnerName of POOL_RUNNER_NAMES) {
        // The configs read RUNNER_NAME at import time and the static imports
        // at the top of this file already resolved the off-pool branch, so
        // stub first and re-import. scripts/tests derives its ceiling from an
        // ambient env knob rather than a literal, so pin that too — the test
        // must read the configs' logic, not whatever the surrounding
        // environment happens to carry. `?? 90_000` makes '' read as 0, so
        // stub a real number at the documented default.
        vi.stubEnv('RUNNER_NAME', runnerName);
        vi.stubEnv('QWEN_SCRIPTS_TEST_TIMEOUT_MS', '90000');
        vi.resetModules();
        try {
          const mod = await load();
          expect(
            mod.default.test?.testTimeout,
            `${name} (${runnerName})`,
          ).toBeGreaterThanOrEqual(POOL_FLOOR_MS);
        } finally {
          vi.unstubAllEnvs();
        }
      }
    });
  }

  // cli and core gate the same way but pin 15s off the pool instead of the
  // default. Naming the value is what stops either ternary being flattened to
  // the pool number: the floor above passes on 60_000, so without this a real
  // hang off CI would surface at 60s instead of 15s and nothing would go red.
  const OFF_POOL_PINNED: Readonly<Record<string, number>> = {
    'packages/cli': 15_000,
    'packages/core': 15_000,
  };

  async function expectOffPoolCeilings() {
    for (const [name, ms] of Object.entries(OFF_POOL_PINNED)) {
      const mod = await configModules[name]!();
      expect(mod.default.test?.testTimeout, name).toBe(ms);
    }
  }

  it('leaves the off-pool default alone', async () => {
    // The point of the ternary is that only the pool lane moves. Off it these
    // configs must stay on vitest's own default, so a hang on a developer
    // machine still fails in 5s rather than 60s. Sample every gated ternary:
    // a flat `testTimeout: 60_000` in any of them must fail here. The rest of
    // the map stays out on purpose: cli/core pin a lower off-pool value and
    // `expectOffPoolCeilings` asserts it, and scripts/tests carries a flat
    // ceiling.
    vi.stubEnv('RUNNER_NAME', 'ubuntu-latest-runner');
    vi.resetModules();
    try {
      await expectOffPoolCeilings();
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it('leaves the default alone when RUNNER_NAME is unset', async () => {
    // Developer machines run with RUNNER_NAME unset, and no CI lane produces
    // that state naturally (GitHub Actions sets it), so this arm creates it. In vitest 3.2.7 stubbing `undefined` deletes the variable
    // even when the ambient environment sets it, and unstubAllEnvs below
    // restores the ambient value. A ternary refactored to treat a missing
    // variable as pool (`?? true`, or `=== undefined || startsWith(...)`)
    // passes the on-pool floor and the foreign-string off-pool sample above;
    // it must fail here, on the state the configs actually see off CI.
    vi.stubEnv('RUNNER_NAME', undefined);
    vi.resetModules();
    try {
      await expectOffPoolCeilings();
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it('registers every guarded config in exactly one off-pool arm', () => {
    // OFF_POOL_PINNED and FLAT_CEILING_CONFIGS are hand-maintained: dropping a
    // name from either removes its off-pool assertion and nothing else goes
    // red — a ternary flattened to `testTimeout: 60_000` still passes the
    // on-pool floor above. Pin the partition instead: every configModules
    // entry must sit in exactly one arm and every arm entry must exist in
    // the map, so a dropped or double-registered name fails here first.
    // No gated ternary, hence no off-pool branch to sample: scripts/tests
    // carries a flat literal.
    const FLAT_CEILING_CONFIGS = ['scripts/tests'];
    const arms = [...Object.keys(OFF_POOL_PINNED), ...FLAT_CEILING_CONFIGS];
    expect(new Set(arms).size, 'one off-pool arm per workspace').toBe(
      arms.length,
    );
    expect(
      [...arms].sort(),
      'every configModules entry in exactly one off-pool arm',
    ).toEqual(Object.keys(configModules).sort());
  });

  it('covers every workspace that runs on the shared pool', () => {
    // configModules is hand-maintained, while `npm run test:ci --workspaces`
    // runs whatever the root glob resolves. Without this cross-check a
    // follow-up adding a workspace with a test:ci script and a bare vitest
    // config joins the pool lane on vitest's 5s default — the #10490 flake
    // class this pin exists to kill — with every test above still green.
    // One-directional on purpose: scripts/tests is in the map without being a
    // workspace. The selection itself lives in scripts/workspaces.js.
    const repoRoot = fileURLToPath(new URL('../../', import.meta.url));
    const missing = getTestCiWorkspacePackageJsonPaths(repoRoot)
      .map((packageJsonPath) =>
        packageJsonPath.slice(0, -'/package.json'.length),
      )
      .filter((name) => !(name in configModules));
    expect(
      missing,
      'runs test:ci but has no entry in configModules above',
    ).toEqual([]);
  });
});

describe('scripts suite timeout', () => {
  it('gives the scripts suite room for a contended host, and a knob', async () => {
    // The `''` arm is the one that matters and the one this pin used to
    // discard: it stubbed the empty string and then immediately called
    // `vi.unstubAllEnvs()`, so the assertion that followed measured the unset
    // path twice and never saw an empty value at all. `''` is not a hypothetical
    // spelling — `${{ cond && 'x' || '' }}` renders exactly that whenever the
    // condition is false, so a workflow wiring this knob that way would ship 0
    // here, and vitest reads 0 as no timeout at all.
    for (const [stub, expected] of [
      [undefined, 90_000],
      ['', 90_000],
      ['abc', 90_000],
      ['0', 90_000],
      ['5000', 5_000],
    ] as const) {
      vi.stubEnv('QWEN_SCRIPTS_TEST_TIMEOUT_MS', stub);
      vi.resetModules();
      const mod = await import('./vitest.config.js');
      expect(
        mod.default.test?.testTimeout,
        `stub=${stub === undefined ? '<unset>' : JSON.stringify(stub)}`,
      ).toBe(expected);
      vi.unstubAllEnvs();
    }
  });

  it('keeps the floor the config sets unlowered by any file in the suite', () => {
    // The config above owns testTimeout; a per-file override of it can only
    // lower it.
    const tests = fileURLToPath(new URL('.', import.meta.url));
    for (const file of readdirSync(tests)) {
      if (!/\.test\.[jt]s$/.test(file)) continue;
      expect(
        readFileSync(join(tests, file), 'utf8'),
        `${file} overrides the suite testTimeout`,
      ).not.toMatch(/vi\.setConfig\(\{[^}]*testTimeout/);
    }
  });
});
