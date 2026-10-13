/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { spawn } from 'node:child_process';
import { accessSync, constants, statSync } from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import type { LocalModelConfig } from './local-models.js';
import { DEFAULT_LOCAL_MODEL_CONTEXT_SIZE } from './local-models.js';
import { resolveLocalModelPath } from './hf-cache.js';

const READY_TIMEOUT_MS = 5 * 60_000;
const READY_POLL_MS = 250;
const STOP_GRACE_MS = 1500;
const MAX_OUTPUT_CHARS = 4000;

const ENGINES = {
  mlx: { binary: 'mlx_lm.server', install: 'uv tool install mlx-lm' },
  gguf: { binary: 'llama-server', install: 'brew install llama.cpp' },
} as const;

/**
 * Qwen3's recommended sampling, used when a request does not set its own.
 * mlx_lm.server would otherwise decode greedily, which Qwen3 advises against.
 */
const SAMPLING_ARGS = [
  '--temp',
  '0.6',
  '--top-p',
  '0.95',
  '--top-k',
  '20',
  '--min-p',
  '0',
];

/**
 * Seatbelt profile for engines on macOS. Network traffic may only go to this
 * machine (Seatbelt's "localhost" covers loopback and the machine's own
 * addresses), name lookups are blocked, and files may only be written in
 * temporary and cache directories, so a model file that exploits an engine
 * cannot plant anything that runs later.
 */
const ENGINE_PROFILE = `(version 1)
(allow default)
(deny network-outbound)
(allow network-outbound (remote ip "localhost:*"))
(allow network-outbound (remote unix-socket))
(deny network-outbound (remote unix-socket (path-literal "/private/var/run/mDNSResponder")))
(deny file-write*)
(allow file-write*
  (subpath "/private/var/folders")
  (subpath "/private/tmp")
  (subpath (string-append (param "HOME") "/Library/Caches"))
  (literal "/dev/null")
  (literal "/dev/tty")
  (literal "/dev/dtracehelper"))`;

/** A running engine serving one model on loopback. */
export interface LocalModelEngine {
  readonly model: LocalModelConfig;
  /** The engine's OpenAI-compatible `/v1` root. */
  readonly baseUrl: string;
  /** The `model` value requests must carry, when it differs from the model's id. */
  readonly requestModel?: string;
  readonly alive: boolean;
  /** Stop the engine: SIGTERM, then SIGKILL after a grace period. */
  stop(): Promise<void>;
}

export interface EngineCommand {
  command: string;
  args: string[];
  env: NodeJS.ProcessEnv;
  /** The `model` value requests must carry, when it differs from the model's id. */
  requestModel?: string;
}

function findExecutable(name: string, searchPath: string): string | undefined {
  for (const dir of searchPath.split(path.delimiter)) {
    // A relative entry would resolve against the workspace.
    if (!path.isAbsolute(dir)) continue;
    const candidate = path.join(dir, name);
    try {
      accessSync(candidate, constants.X_OK);
      if (statSync(candidate).isFile()) return candidate;
    } catch {
      // Not here.
    }
  }
  return undefined;
}

/** The command that runs `model` from `modelPath` on `127.0.0.1:port`. */
export function engineCommand(
  model: LocalModelConfig,
  modelPath: string,
  port: number,
  apiKey: string,
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): EngineCommand {
  const engine = ENGINES[model.format];
  const binary = findExecutable(engine.binary, env['PATH'] ?? '');
  if (!binary) {
    throw new Error(
      `${engine.binary} was not found on PATH; ${model.name ?? model.id} needs it. ` +
        `Install it with:\n  ${engine.install}`,
    );
  }
  // Engines get no credentials or engine settings from qwen's environment:
  // variables such as LLAMA_ARG_HF_REPO or HF_TOKEN would make them download.
  const childEnv: NodeJS.ProcessEnv = {};
  for (const name of ['PATH', 'HOME', 'TMPDIR']) {
    if (env[name] !== undefined) childEnv[name] = env[name];
  }
  let args: string[];
  let requestModel: string | undefined;
  if (model.format === 'gguf') {
    args = [
      '--model',
      modelPath,
      '--host',
      '127.0.0.1',
      '--port',
      String(port),
      '--ctx-size',
      String(model.contextSize ?? DEFAULT_LOCAL_MODEL_CONTEXT_SIZE),
      '--alias',
      model.id,
      '--jinja',
      '--offline',
      '--no-webui',
      '--no-slots',
      ...SAMPLING_ARGS,
    ];
    childEnv['LLAMA_API_KEY'] = apiKey;
  } else {
    args = [
      '--model',
      modelPath,
      '--host',
      '127.0.0.1',
      '--port',
      String(port),
      // No web page's origin is "none", so browsers cannot read responses.
      '--allowed-origins',
      'none',
      ...SAMPLING_ARGS,
    ];
    childEnv['HF_HUB_OFFLINE'] = '1';
    childEnv['HF_HUB_DISABLE_TELEMETRY'] = '1';
    // mlx_lm.server loads whatever model a request names; this name is the
    // one it was started with.
    requestModel = 'default_model';
  }
  // Inside qwen's own Seatbelt sandbox the engine inherits that sandbox;
  // sandboxes cannot nest.
  if (platform === 'darwin' && env['SANDBOX'] !== 'sandbox-exec') {
    return {
      command: '/usr/bin/sandbox-exec',
      args: [
        '-D',
        `HOME=${env['HOME'] ?? os.homedir()}`,
        '-p',
        ENGINE_PROFILE,
        binary,
        ...args,
      ],
      env: childEnv,
      requestModel,
    };
  }
  return { command: binary, args, env: childEnv, requestModel };
}

function freeLoopbackPort(): Promise<number> {
  // Bound and closed at once; nothing is ever accepted on it.
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address() as net.AddressInfo;
      probe.close(() => resolve(port));
    });
  });
}

function answers(url: string): Promise<boolean> {
  return new Promise((resolve) => {
    const request = http.get(url, { timeout: 2000 }, (response) => {
      response.resume();
      resolve(response.statusCode === 200);
    });
    request.on('timeout', () => request.destroy());
    request.on('error', () => resolve(false));
  });
}

/**
 * Start an engine for `model` and wait until it serves requests.
 *
 * @throws Error when the model is not downloaded, the engine is missing, or
 *   the engine exits or does not answer in time; the message carries the end
 *   of the engine's output.
 */
export async function startLocalModelEngine(
  model: LocalModelConfig,
  apiKey: string,
): Promise<LocalModelEngine> {
  const modelPath = resolveLocalModelPath(model);
  const port = await freeLoopbackPort();
  const command = engineCommand(model, modelPath, port, apiKey);
  const child = spawn(command.command, command.args, {
    stdio: ['ignore', 'pipe', 'pipe'],
    env: command.env,
  });
  let output = '';
  const collect = (chunk: Buffer) => {
    output = (output + chunk.toString('utf8')).slice(-MAX_OUTPUT_CHARS);
  };
  child.stdout.on('data', collect);
  child.stderr.on('data', collect);

  let exitDetail: string | undefined;
  const exited = new Promise<void>((resolve) => {
    child.once('error', (error) => {
      exitDetail ??= error.message;
      resolve();
    });
    child.once('close', (code, signal) => {
      exitDetail ??= signal ? `signal ${signal}` : `code ${code}`;
      resolve();
    });
  });
  // qwen must not leave an engine behind, including on process.exit().
  const killOnExit = () => child.kill('SIGKILL');
  process.once('exit', killOnExit);
  void exited.then(() => process.removeListener('exit', killOnExit));

  const name = model.name ?? model.id;
  const failure = (reason: string) =>
    new Error(
      `${name} failed to start: ${reason}.` +
        (output.trim() ? `\n${output.trim()}` : ''),
    );
  const deadline = Date.now() + READY_TIMEOUT_MS;
  // Both engines answer 200 here once they accept requests.
  const readyUrl = `http://127.0.0.1:${port}/health`;
  for (;;) {
    if (exitDetail) throw failure(`the engine exited (${exitDetail})`);
    if (await answers(readyUrl)) break;
    if (Date.now() > deadline) {
      child.kill('SIGKILL');
      throw failure('the engine did not answer within 5 minutes');
    }
    await new Promise((resolve) => setTimeout(resolve, READY_POLL_MS));
  }

  return {
    model,
    baseUrl: `http://127.0.0.1:${port}/v1`,
    requestModel: command.requestModel,
    get alive() {
      return exitDetail === undefined;
    },
    async stop() {
      if (exitDetail !== undefined) return;
      child.kill('SIGTERM');
      const grace = setTimeout(() => child.kill('SIGKILL'), STOP_GRACE_MS);
      await exited;
      clearTimeout(grace);
    },
  };
}
