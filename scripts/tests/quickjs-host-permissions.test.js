/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { build } from 'esbuild';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { quickjsHostSpawnArgs } from '../../packages/core/src/utils/quickjs-host-permissions.ts';

const root = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../..',
);

// Same options as the host entries in esbuild.config.js.
async function bundleHost(entry, outfile) {
  await build({
    entryPoints: [path.join(root, entry)],
    bundle: true,
    outfile,
    platform: 'node',
    format: 'esm',
    target: 'node22',
    packages: 'bundle',
    inject: [path.join(root, 'scripts/esbuild-shims.js')],
    banner: { js: `"use strict";` },
    write: true,
    keepNames: true,
    logLevel: 'silent',
  });
}

function frame(message) {
  const body = Buffer.from(JSON.stringify(message));
  const out = Buffer.alloc(body.length + 4);
  out.writeUInt32BE(body.length);
  body.copy(out, 4);
  return out;
}

// Starts `host` the way the CLI starts its bundled hosts, sends `first`, and
// answers each message with `reply` until it returns 'stop'.
function drive(host, first, reply) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, quickjsHostSpawnArgs(host), {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { PATH: process.env.PATH },
    });
    const seen = [];
    let buffer = Buffer.alloc(0);
    let stderr = '';
    child.stderr.on('data', (chunk) => (stderr += chunk));
    child.on('error', reject);
    child.on('exit', () => resolve({ seen, stderr }));
    child.stdout.on('data', (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      while (
        buffer.length >= 4 &&
        buffer.length >= buffer.readUInt32BE(0) + 4
      ) {
        const length = buffer.readUInt32BE(0);
        const message = JSON.parse(buffer.subarray(4, 4 + length).toString());
        buffer = buffer.subarray(4 + length);
        seen.push(message);
        const answer = reply(message);
        if (answer === 'stop') child.kill('SIGKILL');
        else if (answer) child.stdin.write(frame(answer));
      }
    });
    child.stdin.write(frame(first));
  });
}

describe('bundled QuickJS hosts under the Node permission model', () => {
  let dir;
  beforeAll(async () => {
    dir = mkdtempSync(path.join(os.tmpdir(), 'quickjs-hosts-'));
    await Promise.all([
      bundleHost(
        'packages/core/src/agents/runtime/workflow-host.ts',
        path.join(dir, 'workflowHost.mjs'),
      ),
      bundleHost(
        'packages/core/src/code-mode/host.ts',
        path.join(dir, 'codeModeHost.mjs'),
      ),
    ]);
  });
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it('runs a workflow script', async () => {
    const { seen, stderr } = await drive(
      path.join(dir, 'workflowHost.mjs'),
      {
        type: 'start',
        source:
          "log(typeof process); const a = await agent('q'); return [a, 2];",
        args: null,
        workflow: false,
        budget: null,
        maxLogLines: 100,
        syncTimeoutMs: 30000,
      },
      (message) => {
        if (message.type === 'agent') {
          return { type: 'settle', id: message.id, ok: true, value: 'answer' };
        }
        if (message.type === 'done') return { type: 'flush' };
        if (message.type === 'flushed' || message.type === 'error') {
          return 'stop';
        }
        return undefined;
      },
    );
    expect({
      types: seen.map((message) => message.type),
      stderr,
    }).toMatchObject({
      types: ['ready', 'log', 'agent', 'done', 'flushed'],
    });
    expect(seen[1]).toMatchObject({ line: 'undefined' });
    expect(seen[3]).toMatchObject({ ok: true });
  });

  it('runs a code-mode script', async () => {
    const { seen, stderr } = await drive(
      path.join(dir, 'codeModeHost.mjs'),
      {
        type: 'execute',
        source: 'return await tools.ping({});',
        tools: [
          {
            name: 'ping',
            jsName: 'ping',
            description: 'ping',
            deferred: false,
          },
        ],
        timeoutMs: 10000,
        maxOutputChars: 1000,
      },
      (message) => {
        if (message.type === 'tool_call') {
          return {
            type: 'tool_result',
            id: message.id,
            ok: true,
            result: { content: [{ type: 'text', text: 'pong' }] },
          };
        }
        return 'stop';
      },
    );
    expect({
      types: seen.map((message) => message.type),
      stderr,
    }).toMatchObject({
      types: ['tool_call', 'complete'],
    });
    expect(seen[1]).toMatchObject({
      value: { content: [{ type: 'text', text: 'pong' }] },
    });
  });
});
