/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { accessSync, constants, statSync } from 'node:fs';
import path from 'node:path';

/**
 * An executable named `name` in an absolute `PATH` entry. On Windows, `name`
 * without an extension also matches `name.exe`.
 */
export function findExecutable(
  name: string,
  searchPath: string = process.env['PATH'] ?? '',
  platform: NodeJS.Platform = process.platform,
): string | undefined {
  const names =
    platform === 'win32' && !path.extname(name)
      ? [`${name}.exe`, name]
      : [name];
  for (const dir of searchPath.split(path.delimiter)) {
    // A relative entry would resolve against the workspace.
    if (!path.isAbsolute(dir)) continue;
    for (const candidate of names.map((n) => path.join(dir, n))) {
      if (isExecutableFile(candidate)) return candidate;
    }
  }
  return undefined;
}

/** Whether `file` is a file this process may run. */
export function isExecutableFile(file: string): boolean {
  try {
    accessSync(file, constants.X_OK);
    return statSync(file).isFile();
  } catch {
    return false;
  }
}
