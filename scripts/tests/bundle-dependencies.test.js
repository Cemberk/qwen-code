/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { build, buildSync } from 'esbuild';
import { describe, expect, it } from 'vitest';

import { external } from '../esbuild-externals.js';

const root = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../..',
);
const require = createRequire(import.meta.url);

function inputsFrom(metafile, packageName) {
  return Object.keys(metafile.inputs)
    .map((input) => input.replace(/\\/g, '/'))
    .filter((input) => input.includes(`node_modules/${packageName}/`));
}

describe('third-party code in the bundle', () => {
  it('patches out the ink DevTools hook and does not declare react-devtools-core', () => {
    const { parsePatchFile } = require('patch-package/dist/patch/parse.js');
    const effects = parsePatchFile(
      readFileSync(path.join(root, 'patches', 'ink+7.0.3.patch'), 'utf8'),
    );
    const deletedFiles = effects
      .filter((effect) => effect.type === 'file deletion')
      .map((effect) => effect.path);
    const deletedLines = effects
      .filter((effect) => effect.type === 'patch')
      .flatMap((effect) => effect.hunks)
      .flatMap((hunk) => hunk.parts)
      .filter((part) => part.type === 'deletion')
      .flatMap((part) => part.lines.map((line) => line.trim()));

    expect(deletedFiles).toEqual(
      expect.arrayContaining([
        'node_modules/ink/build/devtools.js',
        'node_modules/ink/build/devtools-window-polyfill.js',
      ]),
    );
    expect(deletedLines).toEqual(
      expect.arrayContaining([
        "await import('./devtools.js');",
        'reconciler.injectIntoDevTools();',
      ]),
    );

    const manifest = JSON.parse(
      readFileSync(path.join(root, 'package.json'), 'utf8'),
    );
    for (const field of [
      'dependencies',
      'devDependencies',
      'optionalDependencies',
    ]) {
      expect(manifest[field] ?? {}).not.toHaveProperty('react-devtools-core');
    }
  });

  it('keeps jose out of the bundle without leaving a runtime import of it', async () => {
    // Bundles the packages that core's MCP client modules import, split the
    // way the CLI bundle is; the repository's own files stay external.
    const result = await build({
      absWorkingDir: root,
      entryPoints: [
        'packages/core/src/tools/mcp-client.ts',
        'packages/core/src/tools/sdk-control-client-transport.ts',
      ],
      bundle: true,
      splitting: true,
      outdir: path.join(root, 'dist'),
      format: 'esm',
      platform: 'node',
      write: false,
      metafile: true,
      logLevel: 'silent',
      external,
      plugins: [
        {
          name: 'repository-files-external',
          setup(pluginBuild) {
            pluginBuild.onResolve({ filter: /^\./ }, (args) =>
              args.kind === 'entry-point' ||
              args.importer.includes('node_modules')
                ? undefined
                : { path: args.path, external: true },
            );
          },
        },
      ],
    });

    expect(inputsFrom(result.metafile, 'jose')).toEqual([]);
    // An external that the bundle still imports would fail at runtime, since
    // the published package does not ship jose.
    for (const file of result.outputFiles) {
      expect(file.text).not.toMatch(
        /import\(\s*["']jose["']\s*\)|from\s*["']jose["']/,
      );
    }
  });

  it('bundles the file crawler without a runtime require from outside the bundle', () => {
    const result = buildSync({
      absWorkingDir: root,
      entryPoints: ['packages/core/src/utils/filesearch/crawler.ts'],
      bundle: true,
      format: 'esm',
      platform: 'node',
      write: false,
      metafile: true,
      logLevel: 'silent',
      external,
    });

    // fdir resolved `picomatch` through createRequire at module load, from
    // whatever node_modules or NODE_PATH lies around the installed bundle.
    expect(inputsFrom(result.metafile, 'fdir')).toEqual([]);
    expect(result.outputFiles[0].text).not.toContain('createRequire');
  });
});
