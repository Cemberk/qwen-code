/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

// Every pnpm workspace member name, so any spelling of an internal
// dependency (file:, an exact release version, or *) rewrites to
// workspace:*. scripts/tests/package-scripts.test.js pins this set against
// the workspace manifests, so a newly added package fails that test until
// it is listed here.
export const workspacePackageNames = new Set([
  '@qwen-code/acp-bridge',
  '@qwen-code/qwen-code',
  '@qwen-code/qwen-code-core',
  '@qwen-code/web-templates',
]);

const dependencyFields = [
  'dependencies',
  'devDependencies',
  'optionalDependencies',
];

export const hooks = {
  readPackage(packageJson) {
    for (const field of dependencyFields) {
      const dependencies = packageJson[field];
      if (!dependencies) continue;

      for (const name of Object.keys(dependencies)) {
        if (workspacePackageNames.has(name)) {
          dependencies[name] = 'workspace:*';
        }
      }
    }

    return packageJson;
  },
};
