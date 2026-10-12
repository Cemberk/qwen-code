#!/usr/bin/env npx tsx
/**
 * Browser-free capture of the real SkillReviewDialog render,
 * using ink-testing-library so it works without Playwright/Chromium. Prints the
 * literal rendered frames — the actual TUI output the component produces.
 *
 * Runs from SOURCE — no build needed. CLI source imports
 * `@qwen-code/qwen-code-core`, which normally resolves through the package's
 * built `dist` (absent on a fresh clone, and stale whenever core src moves
 * ahead of the last build). To avoid both, this registers an ESM loader hook
 * (same idea as scripts/dev.js) that redirects root and subpath specifiers to
 * `packages/core` source, then imports the core-dependent modules
 * DYNAMICALLY so they resolve through the hook. Type-only imports below are
 * erased at runtime and never trigger core resolution.
 */
import React from 'react';
import { render } from 'ink-testing-library';
import { Text } from 'ink';
import { register } from 'node:module';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import type { Config } from '@qwen-code/qwen-code-core';
import type { LoadedSettings } from '../../../packages/cli/src/config/settings.js';
import type { PendingSkillView } from '../../../packages/cli/src/ui/contexts/UIStateContext.js';

const ALPHA = `---
name: run-e2e-headless
description: Run the Qwen CLI headlessly against a mock model and inspect API traffic.
---

# Run E2E headless

1. Build the bundle: npm run build && npm run bundle.
2. Start the fake OpenAI server on a free port.
3. Point OPENAI_BASE_URL at it and run node dist/cli.js -p "<prompt>" --yolo.
4. Assert on the captured request/response JSON.
`;

const BETA = `---
name: vitest-mock-hoisting
description: Hoist vi.mock factories in CLI tests so mocks apply at load time.
---

# Vitest mock hoisting

- Use vi.hoisted() for values referenced inside a vi.mock() factory.
- The factory runs before the test body, so plain const refs are undefined.
`;

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Poll the current frame until it contains `needle`, so captures are taken only
 * once the (async) preview has actually rendered — a fixed delay races the
 * fs.readFile and can capture a stale "Loading preview…" frame.
 */
async function waitForFrame(
  getFrame: () => string | undefined,
  needle: string,
  timeoutMs = 5000,
) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if ((getFrame() ?? '').includes(needle)) return;
    await delay(50);
  }
  throw new Error(
    `Timed out (${timeoutMs}ms) waiting for frame to contain ${JSON.stringify(needle)}`,
  );
}

function banner(title: string) {
  const bar = '═'.repeat(74);
  console.log(`\n${bar}\n  ${title}\n${bar}`);
}

const noop = () => {};

async function main() {
  const mode = process.argv[2] ?? 'all';
  const shouldPrint = (name: string) => mode === 'all' || mode === name;

  // Redirect @qwen-code/qwen-code-core to its TypeScript source so the harness
  // runs without a build and can never pick up a stale dist. Registered before
  // the dynamic imports below, which is what routes them through the hook.
  //
  // No CI test executes this loader: the harness is exercised manually only,
  // via the skill-review-dialog terminal-capture scenario. Keep
  // the `named` map in sync with the named entries in the exports map of
  // packages/core/package.json; scripts/check-core-subpath-exports.mjs gates
  // the real (compiled) resolution path in CI.
  const repoRoot = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    '../../..',
  );
  const coreSrcUrl = pathToFileURL(
    path.join(repoRoot, 'packages', 'core', 'index.ts'),
  ).href;
  const coreModulesUrl = pathToFileURL(
    path.join(repoRoot, 'packages', 'core', 'src') + '/',
  ).href;
  const loader = `
    import { existsSync } from 'node:fs';
    const prefix = '@qwen-code/qwen-code-core/';
    const named = new Map([
      ['transcriptRecords', 'utils/transcript-records.ts'], ['envVarResolver', 'utils/envVarResolver.ts'],
      ['shellResult', 'utils/shell-result.ts'],
      ['goalWire', 'goals/goal-wire.ts'],
      ['storage', 'config/storage.ts'], ['atomicFileWrite', 'utils/atomicFileWrite.ts'],
      ['debugLogger', 'utils/debugLogger.ts'], ['board', 'board.ts'],
    ]);
    export function resolve(specifier, context, nextResolve) {
      if (specifier === '@qwen-code/qwen-code-core') {
        return { shortCircuit: true, url: '${coreSrcUrl}', format: 'module' };
      }
      if (specifier.startsWith(prefix)) {
        const subpath = specifier.slice(prefix.length);
        const namedPath = named.get(subpath);
        if (namedPath) return { shortCircuit: true, url: new URL(namedPath, '${coreModulesUrl}').href, format: 'module' };
        const stem = subpath.replace(/\\.js$/, '');
        for (const ext of ['.ts', '.tsx']) {
          const candidate = new URL(stem + ext, '${coreModulesUrl}');
          if (existsSync(candidate)) return { shortCircuit: true, url: candidate.href, format: 'module' };
        }
      }
      return nextResolve(specifier, context);
    }
  `;
  register(`data:text/javascript,${encodeURIComponent(loader)}`);

  // Import core-dependent modules ONLY after the loader is registered.
  const [
    { KeypressProvider },
    { ConfigContext },
    { SettingsContext },
    { SkillReviewDialog },
  ] = await Promise.all([
    import('../../../packages/cli/src/ui/contexts/KeypressContext.js'),
    import('../../../packages/cli/src/ui/contexts/ConfigContext.js'),
    import('../../../packages/cli/src/ui/contexts/SettingsContext.js'),
    import('../../../packages/cli/src/ui/components/SkillReviewDialog.js'),
  ]);

  const fakeConfig = {
    setAutoSkillEnabled: () => {},
    getBareMode: () => false,
    isSafeMode: () => false,
  } as unknown as Config;

  const fakeSettings = {
    setValue: () => {},
    merged: { general: {}, memory: { enableAutoSkill: true } },
  } as unknown as LoadedSettings;

  const wrap = (node: React.ReactNode) => (
    <KeypressProvider kittyProtocolEnabled={false}>
      <ConfigContext.Provider value={fakeConfig}>
        <SettingsContext.Provider value={fakeSettings}>
          {node}
        </SettingsContext.Provider>
      </ConfigContext.Provider>
    </KeypressProvider>
  );

  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'skill-textcap-'));
  // try/finally so a failed render or frame-wait doesn't leak the temp dir.
  try {
    const alphaPath = path.join(dir, 'run-e2e-headless', 'SKILL.md');
    const betaPath = path.join(dir, 'vitest-mock-hoisting', 'SKILL.md');
    await fs.mkdir(path.dirname(alphaPath), { recursive: true });
    await fs.mkdir(path.dirname(betaPath), { recursive: true });
    await fs.writeFile(alphaPath, ALPHA);
    await fs.writeFile(betaPath, BETA);

    const skills: PendingSkillView[] = [
      {
        name: 'run-e2e-headless',
        description:
          'Run the Qwen CLI headlessly against a mock model and inspect API traffic.',
        stagedManifestPath: alphaPath,
      },
      {
        name: 'vitest-mock-hoisting',
        description:
          'Hoist vi.mock factories in CLI tests so mocks apply at load time.',
        stagedManifestPath: betaPath,
      },
    ];

    function AfterHarness({
      dialogSkills,
    }: {
      dialogSkills: PendingSkillView[];
    }) {
      const [open, setOpen] = React.useState(true);
      if (!open) {
        return (
          <Text>
            Auto-skill turned off. Re-enable it any time from /memory.
          </Text>
        );
      }
      return (
        <SkillReviewDialog
          skills={dialogSkills}
          onAccept={noop}
          onReject={noop}
          onClose={() => setOpen(false)}
          onDismiss={() => setOpen(false)}
        />
      );
    }

    // The preview and turn-off frames showcase the COMMON single-skill case
    // (1/1, no bulk options); the advance frame needs a two-skill batch. They
    // use separate dialog instances so `all` can show both — a single-skill
    // dialog closes on its first decision and could never reach a second
    // skill (this exact mismatch once made default-mode runs time out).
    if (mode !== 'after-second') {
      const single = render(wrap(<AfterHarness dialogSkills={[skills[0]!]} />));
      // Wait for body-only text from the skill's preview (not its name or
      // description, which show before the async read resolves).
      await waitForFrame(() => single.lastFrame(), 'OPENAI_BASE_URL');
      if (shouldPrint('after-preview')) {
        banner(
          'AFTER — common 1/1 review with inline preview and visible turn-off option',
        );
        console.log(single.lastFrame());
      }
      if (shouldPrint('after-turn-off')) {
        // Select "Turn off auto-generated skills" — in the single-skill case
        // the options are keep / discard / turn-off, so numeric quick-select
        // "3" picks it.
        single.stdin.write('3');
        await waitForFrame(() => single.lastFrame(), 'turned off');
        banner(
          'AFTER — after selecting "Turn off auto-generated skills": batch closed',
        );
        console.log(single.lastFrame());
      }
      single.unmount();
    }

    if (shouldPrint('after-second')) {
      const batch = render(wrap(<AfterHarness dialogSkills={skills} />));
      await waitForFrame(() => batch.lastFrame(), 'OPENAI_BASE_URL');
      // Drive Enter (keep skill 1 → advance to skill 2), then wait for body-only
      // text from the SECOND skill's preview so we never capture "Loading preview…".
      batch.stdin.write('\r');
      await waitForFrame(() => batch.lastFrame(), 'vi.hoisted');
      banner('AFTER — 2/2 final batch item hides bulk options');
      console.log(batch.lastFrame());
      batch.unmount();
    }
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

void main().then(
  () => process.exit(0),
  (e) => {
    console.error(e);
    process.exit(1);
  },
);
