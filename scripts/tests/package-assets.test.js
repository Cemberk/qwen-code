/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  truncateSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import { copyBundleAssets } from '../copy_bundle_assets.js';
import { copyFiles } from '../copy_files.js';
import { preparePackage } from '../prepare-package.js';

describe('package asset scripts', () => {
  const tempDirs = [];

  afterEach(() => {
    vi.restoreAllMocks();
    for (const tempDir of tempDirs.splice(0)) {
      rmSync(tempDir, { force: true, recursive: true });
    }
  });

  it('emits an executable dist/cli.js — shebang plus the exec bit, once', () => {
    // shellContextEnv blanks a QWEN_CODE_CLI a POSIX shell cannot exec (no
    // shebang, or no exec bit), and `"${QWEN_CODE_CLI:-qwen}"` then silently
    // runs whatever `qwen` the PATH resolves — a different install for every
    // subcommand of a session launched off the bundle. Deleting the block,
    // dropping the chmod, or dropping the already-has-a-shebang guard must not
    // stay green.
    const rootDir = createFixtureRoot();
    writeFile(rootDir, 'dist/cli.js', 'console.log("bundle");\n');
    const cliEntry = path.join(rootDir, 'dist', 'cli.js');
    stubConsole();

    copyBundleAssets({ root: rootDir });

    const once = readFileSync(cliEntry, 'utf8');
    expect(once.startsWith('#!/usr/bin/env node\n')).toBe(true);
    expect(once).toContain('console.log("bundle");');
    if (process.platform !== 'win32') {
      // Windows has no POSIX exec bit for chmod to set; the shebang half
      // still holds there.
      expect(fs.statSync(cliEntry).mode & 0o777).toBe(0o755);
    }

    // Re-running the bundle step must not stack a second shebang — and must
    // still set the exec bit on a file that already carries one (an entry
    // arriving with a shebang but mode 0644 is exactly the shape that blanks
    // QWEN_CODE_CLI; demoting the chmod inside the shebang guard must fail).
    if (process.platform !== 'win32') {
      fs.chmodSync(cliEntry, 0o644);
    }
    copyBundleAssets({ root: rootDir });
    expect(readFileSync(cliEntry, 'utf8')).toBe(once);
    if (process.platform !== 'win32') {
      expect(fs.statSync(cliEntry).mode & 0o777).toBe(0o755);
    }
  });

  it('copies extension examples into the bundled runtime dist', () => {
    const rootDir = createFixtureRoot();
    writeFile(
      rootDir,
      'packages/cli/src/commands/extensions/examples/mcp-server/keep.test.js',
      'console.log("example test fixture");\n',
    );
    stubConsole();

    copyBundleAssets({ root: rootDir });

    expect(readdirSync(path.join(rootDir, 'dist', 'examples')).sort()).toEqual([
      'agent',
      'commands',
      'context',
      'mcp-server',
      'skills',
    ]);
    expect(
      existsSync(
        path.join(rootDir, 'dist', 'examples', 'mcp-server', 'package.json'),
      ),
    ).toBe(true);
    expect(
      existsSync(
        path.join(rootDir, 'dist', 'examples', 'mcp-server', 'keep.test.js'),
      ),
    ).toBe(true);
  });

  it.each([
    'execution-worker.js',
    'sandboxBwrapRelay.js',
    'sandboxLandlockRelay.js',
    'sandboxFileWorker.js',
    'codeModeHost.js',
    'workflowHost.js',
  ])('fails packaging when the published %s is missing', (missingArtifact) => {
    const rootDir = createFixtureRoot();
    createBundleArtifacts(rootDir);
    rmSync(path.join(rootDir, 'dist', missingArtifact));
    stubConsole();
    vi.spyOn(console, 'error').mockImplementation(() => {});
    // verifyBundleArtifacts reports with console.error + process.exit(1), not a
    // throw, so the exit has to become one to keep the rest of the suite alive.
    const exit = vi.spyOn(process, 'exit').mockImplementation(() => {
      throw new Error('process.exit(1)');
    });

    expect(() => preparePackage({ rootDir })).toThrow('process.exit(1)');
    expect(exit).toHaveBeenCalledWith(1);
    expect(
      console.error.mock.calls
        .map(([message]) => String(message))
        .some(
          (message) =>
            message.includes('Required package artifact not found') &&
            message.includes(missingArtifact),
        ),
    ).toBe(true);
  });

  it('copies Computer Use platform references to both CLI and core distributions', () => {
    const rootDir = createFixtureRoot();
    const coreDir = path.join(rootDir, 'packages', 'core');
    const resources = [
      'SKILL.md',
      'references/macos.md',
      'references/windows-linux.md',
    ];
    for (const resource of resources) {
      writeFile(
        rootDir,
        `packages/core/src/skills/bundled/computer-use/${resource}`,
        resource,
      );
    }
    stubConsole();
    copyBundleAssets({ root: rootDir });
    copyFiles({ root: coreDir });
    for (const resource of resources) {
      expect(
        readFileSync(
          path.join(rootDir, 'dist/bundled/computer-use', resource),
          'utf8',
        ),
      ).toBe(resource);
      expect(
        readFileSync(
          path.join(coreDir, 'dist/src/skills/bundled/computer-use', resource),
          'utf8',
        ),
      ).toBe(resource);
    }
  });

  it('copies bundled skill scripts and references into the runtime dist', () => {
    const rootDir = createFixtureRoot();
    writeFile(
      rootDir,
      'packages/core/src/skills/bundled/dataviz/SKILL.md',
      '---\nname: dataviz\ndescription: Chart guidance\n---\nBody\n',
    );
    writeFile(
      rootDir,
      'packages/core/src/skills/bundled/dataviz/scripts/validate_palette.js',
      'console.log("ok");\n',
    );
    writeFile(
      rootDir,
      'packages/core/src/skills/bundled/dataviz/scripts/validate_palette.test.js',
      'import { it } from "vitest";\n',
    );
    writeFile(
      rootDir,
      'packages/core/src/skills/bundled/dataviz/scripts/validate_palette.test.d.ts',
      'export {};\n',
    );
    writeFile(
      rootDir,
      'packages/core/src/skills/bundled/dataviz/scripts/validate_palette.test.js.map',
      '{}\n',
    );
    writeFile(
      rootDir,
      'packages/core/src/skills/bundled/dataviz/scripts/chart.spec.tsx',
      'export {};\n',
    );
    writeFile(
      rootDir,
      'packages/core/src/skills/bundled/dataviz/scripts/font-test-regular.woff2',
      'font\n',
    );
    writeFile(
      rootDir,
      'packages/core/src/skills/bundled/dataviz/references/palette.md',
      '# Palette\n',
    );
    writeFile(
      rootDir,
      'packages/core/src/skills/bundled/dataviz/DESIGN.md',
      '# Design notes\n',
    );
    writeFile(rootDir, 'dist/bundled/dataviz/scripts/stale.test.js', 'stale\n');
    writeFile(
      rootDir,
      'packages/core/src/skills/bundled/dataviz/.DS_Store',
      'finder droppings\n',
    );
    stubConsole();

    copyBundleAssets({ root: rootDir });

    expect(
      existsSync(
        path.join(
          rootDir,
          'dist',
          'bundled',
          'dataviz',
          'scripts',
          'validate_palette.js',
        ),
      ),
    ).toBe(true);
    expect(
      existsSync(
        path.join(
          rootDir,
          'dist',
          'bundled',
          'dataviz',
          'scripts',
          'validate_palette.test.js',
        ),
      ),
    ).toBe(false);
    expect(
      existsSync(
        path.join(
          rootDir,
          'dist',
          'bundled',
          'dataviz',
          'scripts',
          'validate_palette.test.d.ts',
        ),
      ),
    ).toBe(false);
    expect(
      existsSync(
        path.join(
          rootDir,
          'dist',
          'bundled',
          'dataviz',
          'scripts',
          'validate_palette.test.js.map',
        ),
      ),
    ).toBe(false);
    expect(
      existsSync(
        path.join(
          rootDir,
          'dist',
          'bundled',
          'dataviz',
          'scripts',
          'chart.spec.tsx',
        ),
      ),
    ).toBe(false);
    expect(
      existsSync(
        path.join(
          rootDir,
          'dist',
          'bundled',
          'dataviz',
          'scripts',
          'stale.test.js',
        ),
      ),
    ).toBe(false);
    expect(
      existsSync(
        path.join(
          rootDir,
          'dist',
          'bundled',
          'dataviz',
          'scripts',
          'font-test-regular.woff2',
        ),
      ),
    ).toBe(true);
    expect(
      existsSync(
        path.join(
          rootDir,
          'dist',
          'bundled',
          'dataviz',
          'references',
          'palette.md',
        ),
      ),
    ).toBe(true);
    expect(
      existsSync(path.join(rootDir, 'dist', 'bundled', 'dataviz', 'DESIGN.md')),
    ).toBe(false);
    // The copier's `.DS_Store` skip, pinned by the copier's own output.
    expect(
      existsSync(path.join(rootDir, 'dist', 'bundled', 'dataviz', '.DS_Store')),
    ).toBe(false);
  });

  it('keeps bundled-skill DESIGN.md out of the per-package dist/src copy', () => {
    const rootDir = createFixtureRoot();
    writeFile(
      rootDir,
      'packages/core/src/skills/bundled/review/SKILL.md',
      '---\nname: review\ndescription: Review changes\n---\nBody\n',
    );
    writeFile(
      rootDir,
      'packages/core/src/skills/bundled/review/DESIGN.md',
      '# Design notes\n',
    );
    writeFile(rootDir, 'packages/core/src/notes/DESIGN.md', '# Keep\n');
    stubConsole();

    copyFiles({ root: path.join(rootDir, 'packages', 'core') });

    const distSrc = path.join(rootDir, 'packages', 'core', 'dist', 'src');
    expect(
      existsSync(path.join(distSrc, 'skills', 'bundled', 'review', 'SKILL.md')),
    ).toBe(true);
    expect(
      existsSync(
        path.join(distSrc, 'skills', 'bundled', 'review', 'DESIGN.md'),
      ),
    ).toBe(false);
    expect(existsSync(path.join(distSrc, 'notes', 'DESIGN.md'))).toBe(true);
  });

  it('includes extension examples in the prepared dist package', () => {
    const rootDir = createFixtureRoot();
    createBundleArtifacts(rootDir);
    stubConsole();

    preparePackage({ rootDir });

    const distPackageJson = JSON.parse(
      readFileSync(path.join(rootDir, 'dist', 'package.json'), 'utf8'),
    );

    expect(distPackageJson.files).toContain('examples');
    expect(distPackageJson.private).not.toBe(true);
    expect(distPackageJson.bundledDependencies).toBeUndefined();
    expect(distPackageJson.optionalDependencies.sharp).toBe('0.35.4');
    expect(
      existsSync(
        path.join(rootDir, 'dist', 'examples', 'mcp-server', 'package.json'),
      ),
    ).toBe(true);
  });

  it('falls back to the hoisted sharp when core has no nested copy', () => {
    const rootDir = createFixtureRoot();
    rmSync(path.join(rootDir, 'packages/core/node_modules'), {
      recursive: true,
      force: true,
    });
    writeFile(
      rootDir,
      'packages/core/package.json',
      JSON.stringify(
        {
          name: '@qwen-code/qwen-code-core',
          version: '0.17.0',
          dependencies: {
            sharp: '^0.35.0',
          },
        },
        null,
        2,
      ),
    );
    createBundleArtifacts(rootDir);
    stubConsole();

    preparePackage({ rootDir });

    const distPackageJson = JSON.parse(
      readFileSync(path.join(rootDir, 'dist', 'package.json'), 'utf8'),
    );
    expect(distPackageJson.optionalDependencies.sharp).toBe('0.35.3');
  });

  it('derives every published node-pty pin from the core manifest', () => {
    const rootDir = createFixtureRoot();
    const corePath = path.join(rootDir, 'packages/core/package.json');
    const core = JSON.parse(readFileSync(corePath, 'utf8'));
    const pins = Object.fromEntries(
      Object.entries(
        JSON.parse(
          readFileSync(
            new URL('../../packages/core/package.json', import.meta.url),
            'utf8',
          ),
        ).optionalDependencies,
      )
        .filter(([name]) => name.startsWith('@lydell/node-pty'))
        .map(([name]) => [name, '1.2.0-test-pin']),
    );
    // The pin *count* is owned by conpty-host.test.ts as a deliberate human
    // re-check tripwire; here a non-empty guard keeps `toEqual(pins)` honest
    // without duplicating a number that fails before the code under test runs.
    expect(Object.keys(pins).length).toBeGreaterThan(0);
    core.optionalDependencies = pins;
    writeFileSync(corePath, JSON.stringify(core));
    createBundleArtifacts(rootDir);
    stubConsole();

    preparePackage({ rootDir });

    const published = JSON.parse(
      readFileSync(path.join(rootDir, 'dist/package.json'), 'utf8'),
    );
    expect(
      Object.fromEntries(
        Object.entries(published.optionalDependencies).filter(([name]) =>
          name.startsWith('@lydell/node-pty'),
        ),
      ),
    ).toEqual(pins);
  });

  it('rejects a locked sharp version outside the core declaration', () => {
    const rootDir = createFixtureRoot();
    writeFile(
      rootDir,
      'packages/core/package.json',
      JSON.stringify({ dependencies: { sharp: '^0.34.0' } }),
    );
    createBundleArtifacts(rootDir);
    stubConsole();

    expect(() => preparePackage({ rootDir })).toThrow(
      /installed 0\.35\.4, packages\/core declares \^0\.34\.0/,
    );
  });

  it('omits browser MCP install hooks and deps from the prepared dist package', () => {
    const rootDir = createFixtureRoot();
    createBundleArtifacts(rootDir);
    stubConsole();
    const browserMcpPackageName = ['chrome', 'devtools', 'mcp'].join('-');
    const browserAutomationPackageName = ['puppeteer', 'core'].join('-');
    const installScriptFile = ['postinstall', 'js'].join('.');
    const browserMcpPatchFile = `${browserMcpPackageName}+1.4.0.patch`;

    preparePackage({ rootDir });

    const distDir = path.join(rootDir, 'dist');
    const distPackageJson = JSON.parse(
      readFileSync(path.join(distDir, 'package.json'), 'utf8'),
    );

    expect(distPackageJson.files).not.toEqual(
      expect.arrayContaining(['patches', installScriptFile]),
    );
    expect(distPackageJson.scripts).toBeUndefined();
    expect(distPackageJson.dependencies).toEqual({});
    expect(distPackageJson.optionalDependencies).not.toHaveProperty(
      browserMcpPackageName,
    );
    expect(distPackageJson.optionalDependencies).not.toHaveProperty(
      browserAutomationPackageName,
    );
    expect(existsSync(path.join(distDir, installScriptFile))).toBe(false);
    expect(existsSync(path.join(distDir, 'patches'))).toBe(false);
    expect(existsSync(path.join(distDir, 'patches', browserMcpPatchFile))).toBe(
      false,
    );
  });

  it.each([
    ['dist/vendor/icon.svg', '<svg>chrome-devtools-mcp</svg>\n'],
    ['dist/chunks/server.js.map', '{"sources":["Chrome-Devtools-MCP"]}\n'],
  ])(
    'fails packaging when prepared dist contains scanner-sensitive literals in %s',
    (packagePath, contents) => {
      const rootDir = createFixtureRoot();
      createBundleArtifacts(rootDir);
      const browserMcpPackageName = ['chrome', 'devtools', 'mcp'].join('-');
      writeFile(rootDir, packagePath, contents);
      stubConsole();

      const expectedPath = path.relative(
        path.join(rootDir, 'dist'),
        path.join(rootDir, packagePath),
      );

      expect(() => preparePackage({ rootDir })).toThrow(
        `Prepared package contains forbidden string "${browserMcpPackageName}" in ${expectedPath}`,
      );
    },
  );

  it('fails packaging when prepared dist exceeds the unpacked size budget', () => {
    const rootDir = createFixtureRoot();
    createBundleArtifacts(rootDir);
    stubConsole();

    preparePackage({
      rootDir,
      maxPackageUnpackedBytes: 50_000,
    });

    const oversizedRootDir = createFixtureRoot();
    createBundleArtifacts(oversizedRootDir);
    writeFile(oversizedRootDir, 'dist/chunks/large.js', 'x'.repeat(64 * 1024));

    expect(() =>
      preparePackage({
        rootDir: oversizedRootDir,
        maxPackageUnpackedBytes: 50_000,
      }),
    ).toThrow(/Prepared package unpacked size \d+ bytes exceeds 50000 bytes/);
  });

  it('enforces a 128 MiB default unpacked size budget', () => {
    const rootDir = createFixtureRoot();
    createBundleArtifacts(rootDir);
    writeFile(rootDir, 'dist/chunks/large.bin', '');
    const largeFile = path.join(rootDir, 'dist', 'chunks', 'large.bin');
    truncateSync(largeFile, 127 * 1024 * 1024);
    stubConsole();

    expect(() =>
      preparePackage({
        rootDir,
      }),
    ).not.toThrow();

    truncateSync(largeFile, 128 * 1024 * 1024);

    expect(() =>
      preparePackage({
        rootDir,
      }),
    ).toThrow(
      /Prepared package unpacked size \d+ bytes exceeds 134217728 bytes/,
    );
  });

  function createFixtureRoot() {
    const rootDir = mkdtempSync(path.join(tmpdir(), 'qwen-package-assets-'));
    tempDirs.push(rootDir);

    writeFile(rootDir, 'README.md', '# Qwen Code\n');
    writeFile(rootDir, 'LICENSE', 'Apache-2.0\n');
    writeFile(
      rootDir,
      'package.json',
      JSON.stringify(
        {
          name: '@qwen-code/qwen-code',
          version: '0.17.0',
          description: 'Qwen Code',
          private: true,
          repository: {
            type: 'git',
            url: 'https://github.com/QwenLM/qwen-code.git',
          },
          config: {},
          engines: {
            node: '>=22.0.0',
          },
          devDependencies: {
            'patch-package': '^8.0.1',
          },
        },
        null,
        2,
      ),
    );

    writeFile(
      rootDir,
      'node_modules/sharp/package.json',
      JSON.stringify({ name: 'sharp', version: '0.35.3' }),
    );
    writeFile(
      rootDir,
      'packages/core/node_modules/sharp/package.json',
      JSON.stringify({ name: 'sharp', version: '0.35.4' }),
    );

    writeFile(
      rootDir,
      'packages/cli/src/i18n/locales/en.json',
      '{"hello":"world"}\n',
    );
    writeFile(
      rootDir,
      'packages/core/package.json',
      JSON.stringify(
        {
          name: '@qwen-code/qwen-code-core',
          version: '0.17.0',
          dependencies: {
            sharp: '^0.35.0',
          },
        },
        null,
        2,
      ),
    );
    for (const template of [
      'agent',
      'commands',
      'context',
      'mcp-server',
      'skills',
    ]) {
      writeFile(
        rootDir,
        `packages/cli/src/commands/extensions/examples/${template}/package.json`,
        '{}\n',
      );
    }

    return rootDir;
  }

  function createBundleArtifacts(rootDir) {
    writeFile(rootDir, 'dist/cli.js', '');
    writeFile(rootDir, 'dist/execution-worker.js', '');
    writeFile(rootDir, 'dist/sandboxBwrapRelay.js', '');
    writeFile(rootDir, 'dist/sandboxLandlockRelay.js', '');
    writeFile(rootDir, 'dist/sandboxFileWorker.js', '');
    writeFile(rootDir, 'dist/codeModeHost.js', '');
    writeFile(rootDir, 'dist/workflowHost.js', '');
    mkdirSync(path.join(rootDir, 'dist', 'vendor'), { recursive: true });
    mkdirSync(path.join(rootDir, 'dist', 'bundled', 'qc-helper', 'docs'), {
      recursive: true,
    });
  }

  function writeFile(rootDir, relativePath, content) {
    const filePath = path.join(rootDir, relativePath);
    mkdirSync(path.dirname(filePath), { recursive: true });
    writeFileSync(filePath, content);
  }

  function stubConsole() {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  }
});
