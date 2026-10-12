/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { resolveBundleDir } from '../../utils/bundlePaths.js';
import {
  encodeWorkflowFrame,
  WorkflowFrameDecoder,
  type WorkflowParentMessage,
} from './workflow-protocol.js';

const MAX_STDERR_CHARS = 8192;

/** The parent's end of one workflow host process. */
export interface WorkflowHostConnection {
  /** Writes one message; throws when it exceeds the frame size limit. */
  send(message: WorkflowParentMessage | string): void;
  /** SIGKILLs the process. Idempotent. */
  kill(): void;
  /** Stops the process and its pipes from keeping the parent alive. */
  unref(): void;
  /** False once the process was killed or has exited. */
  readonly alive: boolean;
}

export interface WorkflowHostHandlers {
  /** One frame body, as sent — untrusted JSON text. */
  onMessage(body: string): void;
  /** The process is gone (or could not start); `detail` says why. */
  onExit(detail: string): void;
}

function hostCommand(): { command: string; args: string[] } {
  const currentFile = fileURLToPath(import.meta.url);
  if (currentFile.endsWith('.ts')) {
    const require = createRequire(import.meta.url);
    return {
      command: process.execPath,
      args: [
        '--import',
        pathToFileURL(require.resolve('tsx')).href,
        path.join(path.dirname(currentFile), 'workflow-host.ts'),
      ],
    };
  }
  const sibling = path.join(path.dirname(currentFile), 'workflow-host.js');
  if (existsSync(sibling)) {
    return { command: process.execPath, args: [sibling] };
  }
  return {
    command: process.execPath,
    args: [path.join(resolveBundleDir(import.meta.url), 'workflowHost.js')],
  };
}

// The host needs nothing from the parent's environment beyond what Node and
// a temp directory need; credentials and settings never reach it.
function childEnvironment(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const name of [
    'PATH',
    'SystemRoot',
    'WINDIR',
    'TMPDIR',
    'TEMP',
    'TMP',
  ]) {
    const value = process.env[name];
    if (value !== undefined) env[name] = value;
  }
  return env;
}

export function startWorkflowHost(
  handlers: WorkflowHostHandlers,
): WorkflowHostConnection {
  const command = hostCommand();
  const child = spawn(command.command, command.args, {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: childEnvironment(),
  });
  const decoder = new WorkflowFrameDecoder();
  let stderr = '';
  let exited = false;
  let killed = false;

  const exit = (detail: string): void => {
    if (exited) return;
    exited = true;
    handlers.onExit(stderr ? `${detail}: ${stderr.trim()}` : detail);
  };
  const kill = (): void => {
    killed = true;
    if (child.exitCode === null && child.signalCode === null) {
      child.kill('SIGKILL');
    }
  };

  child.stderr.on('data', (chunk: Buffer) => {
    if (stderr.length < MAX_STDERR_CHARS) {
      stderr += chunk
        .toString('utf8')
        .slice(0, MAX_STDERR_CHARS - stderr.length);
    }
  });
  child.stdout.on('data', (chunk: Buffer) => {
    if (killed || exited) return;
    let bodies: string[];
    try {
      bodies = decoder.push(chunk);
    } catch (error) {
      kill();
      exit(error instanceof Error ? error.message : String(error));
      return;
    }
    for (const body of bodies) {
      if (killed || exited) return;
      handlers.onMessage(body);
    }
  });
  // A write racing the process's death is not an error worth surfacing; the
  // exit handler reports what happened.
  child.stdin.on('error', () => {});
  child.on('error', (error) => exit(`Workflow host failed: ${error.message}`));
  child.on('close', (code, signal) =>
    exit(
      `Workflow host exited (${signal ? `signal ${signal}` : `code ${code}`})`,
    ),
  );

  return {
    send(message) {
      const body =
        typeof message === 'string' ? message : JSON.stringify(message);
      const frame = encodeWorkflowFrame(body);
      if (!killed && !exited && !child.stdin.destroyed) {
        child.stdin.write(frame);
      }
    },
    kill,
    unref() {
      child.unref();
      // The stdio pipes are sockets with their own event-loop references.
      for (const stream of [child.stdin, child.stdout, child.stderr]) {
        (stream as { unref?: () => void }).unref?.();
      }
    },
    get alive() {
      return !killed && !exited;
    },
  };
}
