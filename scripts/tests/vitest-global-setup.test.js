/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { spawnSync } from 'node:child_process';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import checkUnitTestPrerequisites, {
  DIST_PREREQUISITES,
  GENERATED_PREREQUISITES,
  aliasedSpecifiers,
  checkAndReport,
  findMissingPrerequisites,
  formatPrerequisiteMessage,
  normalizePackageKey,
} from '../vitest-global-setup.js';

const guardUrl = new URL('../vitest-global-setup.js', import.meta.url);

// Mirrors the real manifest shape: web-templates/core declare their
// entry via exports['.'].import.
function manifestFor(rel) {
  return {
    name: `fake-${path.basename(rel)}`,
    exports: {
      '.': { types: './dist/index.d.ts', import: './dist/index.js' },
    },
  };
}

function buildFixtureRoot() {
  const root = mkdtempSync(path.join(tmpdir(), 'vitest-prereq-'));
  for (const deps of Object.values(DIST_PREREQUISITES)) {
    for (const rel of deps) {
      mkdirSync(path.join(root, rel, 'dist'), { recursive: true });
      writeFileSync(
        path.join(root, rel, 'package.json'),
        JSON.stringify(manifestFor(rel)),
      );
      writeFileSync(path.join(root, rel, 'dist', 'index.js'), '');
    }
  }
  for (const files of Object.values(GENERATED_PREREQUISITES)) {
    for (const rel of files) {
      mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
      writeFileSync(path.join(root, rel), '');
    }
  }
  return root;
}

describe('normalizePackageKey', () => {
  it('maps win32 backslash separators onto the forward-slash keys', () => {
    expect(normalizePackageKey('packages\\cli')).toBe('packages/cli');
    expect(normalizePackageKey('packages/cli')).toBe('packages/cli');
    expect(normalizePackageKey('packages\\cli\\')).toBe('packages/cli');
  });
});

describe('vitest-global-setup prerequisite guard', () => {
  let root;
  afterEach(() => {
    if (root) rmSync(root, { recursive: true, force: true });
    root = undefined;
    vi.restoreAllMocks();
  });

  it('reports nothing when every prerequisite exists', () => {
    root = buildFixtureRoot();
    expect(findMissingPrerequisites('packages/cli', root)).toEqual([]);
    expect(findMissingPrerequisites('packages/core', root)).toEqual([]);
  });

  it('accepts a win32-style relative key', () => {
    root = buildFixtureRoot();
    expect(findMissingPrerequisites('packages\\cli', root)).toEqual([]);
  });

  it('reports an unbuilt workspace package and a missing generated file', () => {
    root = buildFixtureRoot();
    rmSync(path.join(root, 'packages/web-templates/dist/index.js'));
    rmSync(path.join(root, 'packages/cli/src/generated/git-commit.ts'));

    const missing = findMissingPrerequisites('packages/cli', root);
    expect(missing).toHaveLength(2);
    expect(missing[0]).toContain('packages/web-templates');
    expect(missing[0]).toContain('has not been built');
    expect(missing[1]).toContain('packages/cli/src/generated/git-commit.ts');
  });

  it('reports a missing package directory instead of throwing', () => {
    root = buildFixtureRoot();
    rmSync(path.join(root, 'packages/web-templates'), { recursive: true });

    const missing = findMissingPrerequisites('packages/cli', root);
    expect(missing).toHaveLength(1);
    expect(missing[0]).toContain('packages/web-templates');
    expect(missing[0]).toContain('missing/unreadable');
  });

  it('skips packages without known prerequisites', () => {
    root = buildFixtureRoot();
    expect(findMissingPrerequisites('packages/web-templates', root)).toEqual(
      [],
    );
  });

  it('reports an unbuilt packages/core dist for core tests', () => {
    root = buildFixtureRoot();
    rmSync(path.join(root, 'packages/core/dist/index.js'));

    const missing = findMissingPrerequisites('packages/core', root);
    expect(missing).toHaveLength(1);
    expect(missing[0]).toContain('packages/core');
    expect(missing[0]).toContain('has not been built');
  });

  it('names the fix command and the git-commit remedy only when applicable', () => {
    const withGenerated = formatPrerequisiteMessage([
      '  - packages/cli/src/generated/git-commit.ts: generated file does not exist',
    ]);
    expect(withGenerated).toContain('npm run build');
    expect(withGenerated).toContain('npm run generate');

    const distOnly = formatPrerequisiteMessage([
      '  - packages/x: workspace package "x" has not been built (missing packages/x/dist/index.js)',
    ]);
    expect(distOnly).toContain('npm run build');
    expect(distOnly).not.toContain('npm run generate');
  });

  it('flags a stale probe line with its own remedy note', () => {
    const message = formatPrerequisiteMessage([
      '  - packages/x: package.json exposes no dist/ entry files to check (guard probe may be stale)',
    ]);
    expect(message).toContain('npm run build');
    expect(message).toContain('guard itself');
    expect(message).toContain('will not clear it');
  });
});

describe('subpath exports entries are probed', () => {
  let root;
  afterEach(() => {
    if (root) rmSync(root, { recursive: true, force: true });
    root = undefined;
  });

  it('probes main entries spelled without a leading ./', () => {
    root = buildFixtureRoot();
    writeFileSync(
      path.join(root, 'packages/core', 'package.json'),
      JSON.stringify({ name: 'fake-core', main: 'dist/index.js' }),
    );
    rmSync(path.join(root, 'packages/core/dist/index.js'));

    const missing = findMissingPrerequisites('packages/core', root);
    expect(missing).toHaveLength(1);
    expect(missing[0]).toContain('has not been built');
  });

  it('skips wildcard pattern entries instead of treating them as files', () => {
    root = buildFixtureRoot();
    writeFileSync(
      path.join(root, 'packages/core', 'package.json'),
      JSON.stringify({
        name: 'fake-core',
        exports: {
          '.': { import: './dist/index.js' },
          './dist/*': './dist/*',
          './src/*': './src/*',
        },
      }),
    );
    expect(findMissingPrerequisites('packages/core', root)).toEqual([]);
  });

  it('flags a missing subpath dist file even when the . entry exists', () => {
    root = buildFixtureRoot();
    const templatesDir = path.join(root, 'packages/web-templates');
    writeFileSync(
      path.join(templatesDir, 'package.json'),
      JSON.stringify({
        name: 'fake-web-templates',
        exports: {
          '.': { import: './dist/index.js' },
          './status': {
            import: './dist/status.js',
          },
        },
      }),
    );
    // dist/index.js exists; the subpath target does not.
    const missing = findMissingPrerequisites('packages/cli', root);
    expect(missing).toHaveLength(1);
    expect(missing[0]).toContain('status.js');
  });

  it('does not probe dist targets the consumer aliases to source', () => {
    root = buildFixtureRoot();
    const templatesDir = path.join(root, 'packages/web-templates');
    writeFileSync(
      path.join(templatesDir, 'package.json'),
      JSON.stringify({
        name: 'fake-web-templates',
        exports: {
          '.': { import: './dist/index.js' },
          './aliasedSubpath': { import: './dist/aliased-subpath.js' },
          './plainSubpath': { import: './dist/plain-subpath.js' },
        },
      }),
    );
    writeFileSync(
      path.join(root, 'packages/cli', 'vitest.config.ts'),
      [
        "import { defineConfig } from 'vitest/config';",
        'export default defineConfig({',
        '  resolve: {',
        '    alias: {',
        "      'fake-web-templates/aliasedSubpath': '../web-templates/src/aliased-subpath.ts',",
        '    },',
        '  },',
        '});',
        '',
      ].join('\n'),
    );

    // Both subpath dist files are missing, but only the unaliased one may
    // block: the aliased specifier resolves from source during collection.
    const missing = findMissingPrerequisites('packages/cli', root);
    expect(missing).toHaveLength(1);
    expect(missing[0]).toContain('plain-subpath.js');
    expect(missing[0]).not.toContain('aliased-subpath.js');
  });

  it('reads the consumer alias set from its vitest config', () => {
    root = buildFixtureRoot();
    const configPath = path.join(root, 'packages/cli', 'vitest.config.ts');
    writeFileSync(
      configPath,
      [
        "alias: { '@qwen-code/web-templates/status': 'x', '@qwen-code/qwen-code-core/goalWire': 'y' }",
        "// '@qwen-code/web-templates/commented': 'x'",
        "/* '@qwen-code/web-templates/blocked': 'x' */",
      ].join('\n'),
    );
    const aliases = aliasedSpecifiers(configPath);
    expect(aliases.has('@qwen-code/web-templates/status')).toBe(true);
    expect(aliases.has('@qwen-code/qwen-code-core/goalWire')).toBe(true);
    expect(aliases.has('@qwen-code/web-templates/commented')).toBe(false);
    expect(aliases.has('@qwen-code/web-templates/blocked')).toBe(false);
    // A missing config yields an empty set rather than throwing.
    expect(aliasedSpecifiers(path.join(root, 'nope.ts'))).toEqual(new Set());
  });
});

describe('checkAndReport', () => {
  let root;
  afterEach(() => {
    if (root) rmSync(root, { recursive: true, force: true });
    root = undefined;
    vi.restoreAllMocks();
  });

  it('returns 0 and prints nothing when prerequisites are satisfied', () => {
    root = buildFixtureRoot();
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const cwd = path.join(root, 'packages/cli');
    expect(checkAndReport({ cwd, root })).toBe(0);
    expect(errSpy).not.toHaveBeenCalled();
  });

  it('returns 1 and prints the actionable message when prerequisites are missing', () => {
    root = buildFixtureRoot();
    rmSync(path.join(root, 'packages/web-templates/dist/index.js'));
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const cwd = path.join(root, 'packages/cli');
    expect(checkAndReport({ cwd, root })).toBe(1);
    expect(errSpy).toHaveBeenCalledTimes(1);
    const printed = errSpy.mock.calls[0][0];
    expect(printed).toContain('npm run build');
    expect(printed).toContain('packages/web-templates');
  });

  it('yields silently when cwd matches the repo root (no known package key)', () => {
    root = buildFixtureRoot();
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    // cwd equal to the repo root yields no known package key, so the guard
    // yields silently by design.
    expect(checkAndReport({ cwd: root, root })).toBe(0);
    expect(errSpy).not.toHaveBeenCalled();
  });
});

describe('vitest configs stay wired to the guard', () => {
  it.each(['packages/cli', 'packages/core'])(
    '%s/vitest.config.ts wires the globalSetup guard',
    (pkg) => {
      const configPath = fileURLToPath(
        new URL(`../../${pkg}/vitest.config.ts`, import.meta.url),
      );
      const source = readFileSync(configPath, 'utf8');
      // The guard must be anchored to the config file via path.resolve so it
      // loads regardless of vitest's root/cwd; a bare relative string would
      // only resolve when vitest runs from inside the package directory.
      // Checked as two substrings so the assertion is robust to prettier's
      // line-wrapping of the path.resolve(...) call.
      expect(source).toContain('globalSetup: path.resolve(');
      expect(source).toContain("'../../scripts/vitest-global-setup.js'");
    },
  );
});

describe('guard probe edge cases (round 3)', () => {
  let root;
  afterEach(() => {
    if (root) rmSync(root, { recursive: true, force: true });
    root = undefined;
    vi.restoreAllMocks();
  });

  it('reports a package whose manifest exposes no dist entry to probe', () => {
    root = buildFixtureRoot();
    writeFileSync(
      path.join(root, 'packages/core', 'package.json'),
      JSON.stringify({
        name: 'fake-core',
        exports: { '.': { require: './dist/index.cjs' } },
      }),
    );

    const missing = findMissingPrerequisites('packages/core', root);
    expect(missing).toHaveLength(1);
    expect(missing[0]).toContain('exposes no dist/ entry files to check');
  });

  it('distinguishes a partial build from an unbuilt package', () => {
    root = buildFixtureRoot();
    writeFileSync(
      path.join(root, 'packages/core', 'package.json'),
      JSON.stringify({
        name: 'fake-core',
        exports: {
          '.': { import: './dist/index.js' },
          './stale': { import: './dist/stale.js' },
        },
      }),
    );

    const missing = findMissingPrerequisites('packages/core', root);
    expect(missing).toHaveLength(1);
    expect(missing[0]).toContain('build output is');
    expect(missing[0]).toContain('stale.js');
    expect(missing[0]).toContain("check the package's exports entries");
    expect(missing[0]).not.toContain('has not been built');
  });

  it('derives the package key when cwd reaches the root through a symlink', () => {
    root = buildFixtureRoot();
    rmSync(path.join(root, 'packages/web-templates/dist/index.js'));
    const link = `${root}-link`;
    symlinkSync(root, link);
    try {
      const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      expect(
        checkAndReport({ cwd: path.join(link, 'packages/cli'), root }),
      ).toBe(1);
      expect(errSpy.mock.calls[0][0]).toContain('packages/web-templates');
    } finally {
      rmSync(link);
    }
  });
});

// The default export is what vitest actually invokes. These tests drive it
// against a hermetic fixture checkout (via QWEN_VITEST_GUARD_ROOT) instead of
// the real repository state, so they hold on an unbuilt worktree too — the
// exact scenario the guard targets.
describe('default export (the vitest globalSetup entry)', () => {
  let root;
  afterEach(() => {
    if (root) rmSync(root, { recursive: true, force: true });
    root = undefined;
    delete process.env['QWEN_VITEST_GUARD_ROOT'];
    vi.restoreAllMocks();
  });

  it('uses the vitest project root and exits 1 when prerequisites are missing', () => {
    root = buildFixtureRoot();
    rmSync(path.join(root, 'packages/web-templates/dist/index.js'));
    process.env['QWEN_VITEST_GUARD_ROOT'] = root;
    const exitSpy = vi
      .spyOn(process, 'exit')
      .mockImplementation(() => undefined);
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    checkUnitTestPrerequisites({
      config: { root: path.join(root, 'packages/cli') },
    });
    expect(exitSpy).toHaveBeenCalledWith(1);
    expect(errSpy.mock.calls[0][0]).toContain('packages/web-templates');
  });

  it('does not exit when the hermetic checkout is ready', () => {
    root = buildFixtureRoot();
    process.env['QWEN_VITEST_GUARD_ROOT'] = root;
    const exitSpy = vi
      .spyOn(process, 'exit')
      .mockImplementation(() => undefined);
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    checkUnitTestPrerequisites({
      config: { root: path.join(root, 'packages/cli') },
    });
    expect(exitSpy).not.toHaveBeenCalled();
    expect(errSpy).not.toHaveBeenCalled();
  });

  it('falls back to process.cwd() when invoked without a project', () => {
    root = buildFixtureRoot();
    process.env['QWEN_VITEST_GUARD_ROOT'] = root;
    vi.spyOn(process, 'cwd').mockReturnValue(path.join(root, 'packages/cli'));
    const exitSpy = vi
      .spyOn(process, 'exit')
      .mockImplementation(() => undefined);
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    checkUnitTestPrerequisites(undefined);
    expect(exitSpy).not.toHaveBeenCalled();
    expect(errSpy).not.toHaveBeenCalled();
  });

  // Subprocess-level coverage: a real `node` process runs the default export
  // end to end, so neutralizing `process.exit` or breaking the root
  // derivation flips the observable exit status.
  function runGuardSubprocess(cwd) {
    return spawnSync(
      process.execPath,
      [
        '--input-type=module',
        '-e',
        `import guard from ${JSON.stringify(guardUrl.href)}; guard();`,
      ],
      {
        cwd,
        encoding: 'utf8',
        env: { ...process.env, QWEN_VITEST_GUARD_ROOT: root },
      },
    );
  }

  it('subprocess: exits 1 and prints the fix command on a broken checkout', () => {
    root = buildFixtureRoot();
    rmSync(path.join(root, 'packages/web-templates/dist/index.js'));
    const res = runGuardSubprocess(path.join(root, 'packages/cli'));
    expect(res.status).toBe(1);
    expect(res.stderr).toContain('npm run build');
    expect(res.stderr).toContain('packages/web-templates');
  });

  it('subprocess: exits 0 silently on a ready checkout', () => {
    root = buildFixtureRoot();
    const res = runGuardSubprocess(path.join(root, 'packages/cli'));
    expect(res.status).toBe(0);
    expect(res.stderr).toBe('');
  });
});
