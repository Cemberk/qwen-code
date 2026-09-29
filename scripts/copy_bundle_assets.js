/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     http://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.

import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, basename, resolve } from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { glob } from 'glob';
import fs from 'node:fs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const defaultRoot = join(__dirname, '..');
const BUNDLED_SKILL_TEST_FILE_RE =
  /\.(?:test|spec)\.(?:d\.)?[cm]?[jt]sx?(?:\.map)?$/;

/**
 * Whether this host's Node.js links against musl rather than glibc. The
 * report header only carries `glibcVersionRuntime` on a glibc runtime.
 */
function hostUsesMusl() {
  if (process.platform !== 'linux') return false;
  try {
    return !process.report?.getReport?.()?.header?.glibcVersionRuntime;
  } catch {
    return false;
  }
}

/**
 * Whether an `@opentui/core-*` package holds a native library this host
 * cannot load: the Linux packages ship one library per libc, and npm
 * installs both flavors on a glibc host because only `libc` (not `os`/`cpu`)
 * separates them.
 *
 * Shipping the foreign one is not merely dead weight. Both are ELF files, so
 * AppImage packaging walks them with `ldd` while deploying dependencies; the
 * musl library needs `libc.so`, which no glibc system resolves, so `ldd`
 * exits non-zero and aborts linuxdeploy. That is what broke the Linux job of
 * desktop release 0.2.3-preview.0, which bundles this dist tree verbatim.
 */
function isForeignLibcPackage(entry, musl = hostUsesMusl()) {
  if (!entry.startsWith('core-linux-')) return false;
  return entry.endsWith('-musl') !== musl;
}

/**
 * OpenTUI renderer runtime assets (tree-sitter grammars, the parser worker,
 * `web-tree-sitter` runtime and the native render library) relocated next to
 * the bundle.
 *
 * In the esbuild single-file bundle @opentui/core's package-relative asset
 * fallback (`new URL('./assets/…', import.meta.url)`) points into `dist/`
 * and misses, so code-block syntax highlighting degrades to single color.
 * The runtime (`packages/cli/src/ui/opentui/opentui-assets.ts`) therefore
 * points `OTUI_ASSET_ROOT` at `dist/opentui-assets/` — but only when the tree
 * there is complete, because @opentui/core throws on any missing key under a
 * configured root (including the native library). This copier writes the
 * assets under exactly the keys that module checks:
 *
 *   opentui-assets/@opentui/core/parser.worker.js
 *   opentui-assets/@opentui/core/assets/<lang>/<file>
 *   opentui-assets/@opentui/core-<platform>-<arch>[ -musl]/libopentui.*
 *   opentui-assets/web-tree-sitter/tree-sitter.wasm
 *
 * Returns the list of destination-relative keys copied (empty on skip) so
 * callers/tests can assert on it. Never fails the bundle: a missing
 * @opentui/core (e.g. an install without the renderer) only warns.
 */
export function copyOpenTuiAssets({
  root = defaultRoot,
  distDir,
  musl = hostUsesMusl(),
} = {}) {
  distDir ??= join(root, 'dist');
  const destRoot = join(distDir, 'opentui-assets');
  // Start from a clean tree: the runtime gate below checks key existence
  // only, so a tree left by an earlier bundle would still satisfy it and
  // ship stale native libraries after the installed platform set changed.
  fs.rmSync(destRoot, { recursive: true, force: true });

  // @opentui/core may sit in the root node_modules or be hoisted into
  // packages/cli/node_modules (it is a cli dependency); try both anchors.
  const anchors = [
    join(root, 'package.json'),
    join(root, 'packages', 'cli', 'package.json'),
  ];
  let coreEntry;
  for (const anchor of anchors) {
    if (!existsSync(anchor)) continue;
    try {
      coreEntry = createRequire(anchor).resolve('@opentui/core');
      break;
    } catch {
      // try the next anchor
    }
  }
  if (!coreEntry) {
    console.warn(
      'Warning: @opentui/core is not resolvable; skipped OpenTUI assets',
    );
    return [];
  }
  const coreDir = dirname(coreEntry);
  const coreRequire = createRequire(join(coreDir, 'package.json'));

  const copied = [];
  const copyToKey = (source, key) => {
    if (!existsSync(source) || !statSync(source).isFile()) {
      console.warn(`Warning: OpenTUI asset missing at ${source}; skipped`);
      return;
    }
    const destPath = join(destRoot, key);
    mkdirSync(dirname(destPath), { recursive: true });
    copyFileSync(source, destPath);
    copied.push(key);
  };

  // 1. The tree-sitter parser worker (self-contained bundle).
  copyToKey(
    join(coreDir, 'parser.worker.js'),
    '@opentui/core/parser.worker.js',
  );

  // 2. Grammar assets: assets/<lang>/{highlights.scm,injections.scm,*.wasm}.
  const assetsDir = join(coreDir, 'assets');
  if (existsSync(assetsDir)) {
    for (const lang of fs.readdirSync(assetsDir)) {
      const langDir = join(assetsDir, lang);
      if (!statSync(langDir).isDirectory()) continue;
      for (const file of fs.readdirSync(langDir)) {
        copyToKey(join(langDir, file), `@opentui/core/assets/${lang}/${file}`);
      }
    }
  } else {
    console.warn(`Warning: OpenTUI grammar assets not found at ${assetsDir}`);
  }

  // 3. The web-tree-sitter runtime wasm (peer dependency of @opentui/core).
  let wasmSource;
  try {
    wasmSource = coreRequire.resolve('web-tree-sitter/tree-sitter.wasm');
  } catch {
    try {
      wasmSource = join(
        dirname(coreRequire.resolve('web-tree-sitter')),
        'tree-sitter.wasm',
      );
    } catch {
      wasmSource = undefined;
    }
  }
  if (wasmSource) {
    copyToKey(wasmSource, 'web-tree-sitter/tree-sitter.wasm');
  } else {
    console.warn(
      'Warning: web-tree-sitter is not resolvable; skipped its wasm asset',
    );
  }

  // 4. Native render libraries for every installed @opentui platform package
  //    (core-darwin-arm64, core-win32-x64, …), minus the Linux packages built
  //    for the other libc (see isForeignLibcPackage). The runtime only needs
  //    the current platform's, but shipping the rest of the installed set
  //    keeps the completeness check satisfiable wherever the bundle runs
  //    next. The platform packages live beside @opentui/core or hoisted at
  //    the repo root; scan both scope directories.
  const scopeDirs = [dirname(coreDir), join(root, 'node_modules', '@opentui')];
  const seenPackages = new Set();
  for (const scopeDir of scopeDirs) {
    if (!existsSync(scopeDir)) continue;
    for (const entry of fs.readdirSync(scopeDir)) {
      if (!entry.startsWith('core-') || seenPackages.has(entry)) continue;
      if (isForeignLibcPackage(entry, musl)) continue;
      const packageDir = join(scopeDir, entry);
      if (!statSync(packageDir).isDirectory()) continue;
      let copiedFromPackage = false;
      for (const file of fs.readdirSync(packageDir)) {
        if (!/\.(dylib|so|dll)$/.test(file)) continue;
        copyToKey(join(packageDir, file), `@opentui/${entry}/${file}`);
        copiedFromPackage = true;
      }
      if (copiedFromPackage) seenPackages.add(entry);
    }
  }

  if (copied.length > 0) {
    console.log(
      `Copied ${copied.length} OpenTUI runtime assets to dist/opentui-assets/`,
    );
  } else {
    console.warn('Warning: no OpenTUI runtime assets were copied');
  }
  return copied;
}

export function copyBundleAssets({ root = defaultRoot } = {}) {
  const distDir = join(root, 'dist');
  const coreVendorDir = join(root, 'packages', 'core', 'vendor');

  // Create the dist directory if it doesn't exist
  if (!existsSync(distDir)) {
    mkdirSync(distDir);
  }

  // Find and copy all .sb files from packages to the root of the dist directory
  const sbFiles = glob.sync('packages/**/*.sb', { cwd: root });
  for (const file of sbFiles) {
    copyFileSync(join(root, file), join(distDir, basename(file)));
  }

  console.log('Copied sandbox profiles to dist/');

  // Copy vendor directory (contains ripgrep binaries)
  console.log('Copying vendor directory...');
  if (existsSync(coreVendorDir)) {
    const destVendorDir = join(distDir, 'vendor');
    copyRecursiveSync(coreVendorDir, destVendorDir);
    console.log('Copied vendor directory to dist/');
  } else {
    console.warn(`Warning: Vendor directory not found at ${coreVendorDir}`);
  }

  // Copy bundled skills (e.g. /review) so they are available at runtime.
  // In the esbuild bundle, import.meta.url resolves to dist/cli.js, so
  // SkillManager looks for bundled skills at dist/bundled/.
  const bundledSkillsDir = join(
    root,
    'packages',
    'core',
    'src',
    'skills',
    'bundled',
  );
  if (existsSync(bundledSkillsDir)) {
    const destBundledDir = join(distDir, 'bundled');
    fs.rmSync(destBundledDir, { recursive: true, force: true });
    copyRecursiveSync(bundledSkillsDir, destBundledDir, {
      // DESIGN.md files are maintainer design narratives, not runtime inputs;
      // shipping one would hand a review a ~125 KB read_file target that
      // outweighs the context the slimmed skill saves.
      skipEntry: (entry) =>
        isBundledSkillTestFile(entry) || entry === 'DESIGN.md',
    });
    console.log('Copied bundled skills to dist/bundled/');
  } else {
    console.warn(
      `Warning: Bundled skills directory not found at ${bundledSkillsDir}`,
    );
  }

  // Copy user docs into qc-helper bundled skill so it can reference them at runtime.
  // The qc-helper skill reads docs from a `docs/` subdirectory relative to its own
  // directory. In the esbuild bundle this becomes dist/bundled/qc-helper/docs/.
  const userDocsDir = join(root, 'docs', 'users');
  if (existsSync(userDocsDir)) {
    const destDocsDir = join(distDir, 'bundled', 'qc-helper', 'docs');
    copyRecursiveSync(userDocsDir, destDocsDir);
    console.log('Copied docs/users/ to dist/bundled/qc-helper/docs/');
  } else {
    console.warn(`Warning: User docs directory not found at ${userDocsDir}`);
  }

  // Copy builtin locales so bundled dist/cli.js can load UI translations at runtime.
  // Published packages already include these via prepare-package.js; bundle output
  // should mirror that behavior for local `node dist/cli.js` runs.
  const localesDir = join(root, 'packages', 'cli', 'src', 'i18n', 'locales');
  if (existsSync(localesDir)) {
    const destLocalesDir = join(distDir, 'locales');
    copyRecursiveSync(localesDir, destLocalesDir);
    console.log('Copied builtin locales to dist/locales/');
  } else {
    console.warn(`Warning: Locales directory not found at ${localesDir}`);
  }

  // Copy the OpenTUI renderer's runtime assets (tree-sitter grammars, parser
  // worker, web-tree-sitter wasm, native render library) so the bundled
  // renderer can point OTUI_ASSET_ROOT at dist/opentui-assets/ and keep
  // code-block syntax highlighting. Warn-and-skip when unavailable.
  copyOpenTuiAssets({ root, distDir });

  // Copy extension templates so bundled dist/cli.js can scaffold
  // `/extensions new` from the runtime examples directory.
  const extensionExamplesDir = join(
    root,
    'packages',
    'cli',
    'src',
    'commands',
    'extensions',
    'examples',
  );
  if (existsSync(extensionExamplesDir)) {
    const destExtensionExamplesDir = join(distDir, 'examples');
    copyRecursiveSync(extensionExamplesDir, destExtensionExamplesDir);
    console.log('Copied extension examples to dist/examples/');
  } else {
    console.warn(
      `Warning: Extension examples directory not found at ${extensionExamplesDir}`,
    );
  }

  // Make dist/cli.js directly executable: shellContextEnv blanks a
  // QWEN_CODE_CLI whose entry a POSIX shell cannot exec (no shebang, or no
  // execute bit), and the `"${QWEN_CODE_CLI:-qwen}"` fallback then silently
  // runs whatever `qwen` the PATH resolves — a different install for every
  // subcommand of a session launched from this bundle.
  const cliEntry = join(distDir, 'cli.js');
  if (existsSync(cliEntry)) {
    const source = readFileSync(cliEntry, 'utf8');
    if (!source.startsWith('#!')) {
      writeFileSync(cliEntry, `#!/usr/bin/env node\n${source}`);
    }
    // Outside the guard: a bundle that already carries a shebang may still
    // arrive without the exec bit.
    fs.chmodSync(cliEntry, 0o755);
  }

  console.log('\n✅ All bundle assets copied to dist/');
}

if (isDirectRun()) {
  copyBundleAssets();
}

function isDirectRun() {
  return process.argv[1]
    ? fileURLToPath(import.meta.url) === resolve(process.argv[1])
    : false;
}

/**
 * Recursively copy directory
 */
function copyRecursiveSync(src, dest, options = {}) {
  if (!existsSync(src)) {
    return;
  }

  const stats = statSync(src);

  if (stats.isDirectory()) {
    if (!existsSync(dest)) {
      mkdirSync(dest, { recursive: true });
    }

    const entries = fs.readdirSync(src);
    for (const entry of entries) {
      const srcPath = join(src, entry);
      if (entry === '.DS_Store' || options.skipEntry?.(entry, srcPath)) {
        continue;
      }

      const destPath = join(dest, entry);
      copyRecursiveSync(srcPath, destPath, options);
    }
  } else {
    copyFileSync(src, dest);
    // Preserve execute permissions for binaries
    const srcStats = statSync(src);
    if (srcStats.mode & 0o111) {
      fs.chmodSync(dest, srcStats.mode);
    }
  }
}

function isBundledSkillTestFile(fileName) {
  return BUNDLED_SKILL_TEST_FILE_RE.test(fileName);
}
