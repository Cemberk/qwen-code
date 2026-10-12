/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

// Unset NO_COLOR environment variable to ensure consistent theme behavior between local and CI test runs
if (process.env['NO_COLOR'] !== undefined) {
  delete process.env['NO_COLOR'];
}

import {
  mkdir,
  readdir,
  rm,
  readFile,
  stat,
  writeFile,
  unlink,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { DEFAULT_CONTEXT_FILENAME, Storage } from '@qwen-code/qwen-code-core';

import { removeScratchDir } from './scratch-dir.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const rootDir = join(__dirname, '..');
const integrationTestsDir = join(rootDir, '.integration-tests');
let runDir = ''; // Make runDir accessible in teardown
let sdkE2eRunDir = ''; // SDK E2E test run directory

// These suites spawn the real CLI, which reads the global qwen dir for
// settings, saved memories, tool-usage history, and extensions. Inherited
// from the host, that dir is live user state and the run is only as
// reproducible as whatever happens to sit in it. Hosted runners have an empty
// `~/.qwen` and never noticed; the persistent pool (#10085) does not, and
// there a populated `~/.qwen/memories` made managed auto-memory recall issue
// its own model request ahead of the agent's first turn. The SDK suites
// script the fake OpenAI server by `requestIndex`, so that extra request
// shifted every index: each scripted tool call landed on the recall selector
// and the turn under test got the trailing text instead — 42 reds across
// permission-control and tool-control that no hosted runner could reproduce.
//
// Give the run its own empty global qwen dir. Nothing is copied from the
// host's, so the host's settings and credentials never reach the temp dir;
// suites that need a model point the CLI at the fake OpenAI server or take it
// from the environment. A caller that pins QWEN_HOME — globalSetup.test.ts,
// or someone reproducing against real state — keeps it, and owns its
// lifecycle.
const HERMETIC_HOME_PREFIX = 'qwen-e2e-home-';
const hermeticQwenHome = join(
  tmpdir(),
  `${HERMETIC_HOME_PREFIX}${process.pid}-${Date.now()}`,
);
const ownsQwenHome = !process.env['QWEN_HOME'];
if (ownsQwenHome) {
  process.env['QWEN_HOME'] = hermeticQwenHome;
}

// Read after the redirect so the save/restore below, the spawned CLIs, and
// the tests all agree on one global qwen dir.
const memoryFilePath = join(
  Storage.getGlobalQwenDir(),
  DEFAULT_CONTEXT_FILENAME,
);
let originalMemoryContent: string | null = null;

/**
 * Removes scratch homes an earlier run could not. Teardown's cleanup is
 * best-effort by design, so on a persistent runner the ones it gives up on
 * would otherwise pile up forever. The age floor keeps this clear of any run
 * in flight on the same host: a full E2E run finishes well inside it.
 */
async function sweepLeakedQwenHomes() {
  const cutoff = Date.now() - 24 * 60 * 60 * 1000;
  try {
    const entries = await readdir(tmpdir());
    await Promise.all(
      entries
        .filter(
          (entry) =>
            entry.startsWith(HERMETIC_HOME_PREFIX) &&
            join(tmpdir(), entry) !== hermeticQwenHome,
        )
        .map(async (entry) => {
          const dir = join(tmpdir(), entry);
          try {
            if ((await stat(dir)).mtimeMs < cutoff) {
              await rm(dir, { recursive: true, force: true, maxRetries: 3 });
            }
          } catch {
            // Raced with the run that owns it, or still not removable.
          }
        }),
    );
  } catch {
    // Housekeeping must never fail a run.
  }
}

export async function setup() {
  if (ownsQwenHome) {
    await mkdir(hermeticQwenHome, { recursive: true });
    await sweepLeakedQwenHomes();
  }

  try {
    originalMemoryContent = await readFile(memoryFilePath, 'utf-8');
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw e;
    }
    // File doesn't exist, which is fine.
  }

  // Setup for CLI integration tests
  runDir = join(integrationTestsDir, `${Date.now()}`);
  await mkdir(runDir, { recursive: true });

  // Setup for SDK E2E tests (separate directory with prefix)
  sdkE2eRunDir = join(integrationTestsDir, `sdk-e2e-${Date.now()}`);
  await mkdir(sdkE2eRunDir, { recursive: true });

  // Clean up old test runs, but keep the latest few for debugging
  try {
    const testRuns = await readdir(integrationTestsDir);

    // Clean up old CLI integration test runs (without sdk-e2e- prefix)
    const cliTestRuns = testRuns.filter((run) => !run.startsWith('sdk-e2e-'));
    if (cliTestRuns.length > 5) {
      const oldRuns = cliTestRuns.sort().slice(0, cliTestRuns.length - 5);
      await Promise.all(
        oldRuns.map((oldRun) =>
          rm(join(integrationTestsDir, oldRun), {
            recursive: true,
            force: true,
          }),
        ),
      );
    }

    // Clean up old SDK E2E test runs (with sdk-e2e- prefix)
    const sdkTestRuns = testRuns.filter((run) => run.startsWith('sdk-e2e-'));
    if (sdkTestRuns.length > 5) {
      const oldRuns = sdkTestRuns.sort().slice(0, sdkTestRuns.length - 5);
      await Promise.all(
        oldRuns.map((oldRun) =>
          rm(join(integrationTestsDir, oldRun), {
            recursive: true,
            force: true,
          }),
        ),
      );
    }
  } catch (e) {
    console.error('Error cleaning up old test runs:', e);
  }

  // Environment variables for CLI integration tests
  process.env['INTEGRATION_TEST_FILE_DIR'] = runDir;
  process.env['QWEN_CODE_INTEGRATION_TEST'] = 'true';
  process.env['TELEMETRY_LOG_FILE'] = join(runDir, 'telemetry.log');

  // Environment variables for SDK E2E tests
  process.env['E2E_TEST_FILE_DIR'] = sdkE2eRunDir;
  process.env['TEST_CLI_PATH'] = join(rootDir, 'dist/cli.js');

  if (process.env['KEEP_OUTPUT']) {
    console.log(`Keeping output for test run in: ${runDir}`);
    console.log(`Keeping output for SDK E2E test run in: ${sdkE2eRunDir}`);
  }
  process.env['VERBOSE'] = process.env['VERBOSE'] ?? 'false';

  console.log(`\nIntegration test output directory: ${runDir}`);
  console.log(`SDK E2E test output directory: ${sdkE2eRunDir}`);
  console.log(`CLI path: ${process.env['TEST_CLI_PATH']}`);
}

export async function teardown() {
  // Cleanup the CLI test run directory unless KEEP_OUTPUT is set
  if (process.env['KEEP_OUTPUT'] !== 'true' && runDir) {
    await rm(runDir, { recursive: true, force: true });
  }

  // Cleanup the SDK E2E test run directory unless KEEP_OUTPUT is set
  if (process.env['KEEP_OUTPUT'] !== 'true' && sdkE2eRunDir) {
    await rm(sdkE2eRunDir, { recursive: true, force: true });
  }

  // Only when the memory file is the host's. Under a hermetic home it sits in
  // the scratch dir removed just below, so there is nothing to put back.
  if (!ownsQwenHome) {
    await restoreMemoryFile();
  }

  // Not gated on KEEP_OUTPUT: this is a scratch dir rather than a test
  // artifact.
  if (ownsQwenHome) {
    await removeScratchDir(hermeticQwenHome);
  }
}

async function restoreMemoryFile() {
  if (originalMemoryContent !== null) {
    try {
      await mkdir(dirname(memoryFilePath), { recursive: true });
      await writeFile(memoryFilePath, originalMemoryContent, 'utf-8');
    } catch (e) {
      // Best-effort restore: on the persistent pool runners a privileged job
      // can leave a readable-but-unwritable QWEN.md behind, and the throw
      // turned every all-green E2E run on that host red with no failing test
      // ('Startup Error: EACCES'; #10325). Keep the warning visible so the
      // poisoned host is still diagnosable.
      console.error(`Warning: could not restore ${memoryFilePath}:`, e);
    }
  } else {
    try {
      await unlink(memoryFilePath);
    } catch {
      // File might not exist if the test failed before creating it.
    }
  }
}
