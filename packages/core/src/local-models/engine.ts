/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, statSync } from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import type { LocalModelConfig } from './local-models.js';
import { DEFAULT_LOCAL_MODEL_CONTEXT_SIZE } from './local-models.js';
import { resolveLocalModelPath } from './hf-cache.js';
import { engineStateKey } from './prompt-cache.js';
import { findExecutable, isExecutableFile } from './executables.js';
import { inspectModel, type ModelCapabilities } from './model-inspector.js';
import { planEngine, type EnginePlan } from './planner.js';
import {
  confinedCommand,
  getConfinement,
  type Confinement,
} from './confinement.js';
import {
  fitModel,
  gpuBudget,
  type ModelFit,
  localModelBytes,
  localModelExpertBytes,
  systemMemoryBytes,
} from './gpu-memory.js';

const READY_TIMEOUT_MS = 5 * 60_000;
const READY_POLL_MS = 250;
const STOP_GRACE_MS = 1500;
const MAX_OUTPUT_CHARS = 4000;
/** Saving or restoring a long conversation writes or reads gigabytes. */
const SLOT_TIMEOUT_MS = 60_000;

const LLAMA_SERVER = 'llama-server';

/** Qwen3's recommended sampling, used when a request does not set its own. */
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
 * Seatbelt profile for llama-server on macOS. Network traffic may only go to
 * this machine (Seatbelt's "localhost" covers loopback and the machine's own
 * addresses), name lookups are blocked, and files may only be written in
 * temporary and cache directories, so a model file that exploits the engine
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
  /**
   * The Unix socket that reaches `baseUrl`, when the engine runs without
   * network access (Linux) and listens on one.
   */
  readonly socketPath?: string;
  readonly alive: boolean;
  /**
   * Identifies the model file, draft, context size and speculation setup:
   * a saved prompt state is only restored into an engine with the same key.
   */
  readonly stateKey: string;
  /**
   * Save the processed prompt to, or restore it from, `filename` in the
   * prompt cache folder. Only available when the engine was started with
   * one; resolves to whether it worked.
   */
  slot(action: 'save' | 'restore', filename: string): Promise<boolean>;
  /** Stop the engine: SIGTERM, then SIGKILL after a grace period. */
  stop(): Promise<void>;
}

/** Files an engine is started with, beside the model itself. */
export interface EngineLaunch {
  /** Draft model for speculative decoding. */
  draftPath?: string;
  /** Folder for saved prompt states (`--slot-save-path`). */
  promptCacheDir?: string;
  /** Layers whose experts stay in system memory (`--n-cpu-moe`). */
  cpuMoeLayers?: number;
  /** Listen on this Unix socket instead of loopback TCP. */
  socketPath?: string;
  /** Run the engine without network access (Linux). */
  confinement?: Confinement;
  /** Options from the planner (see planner.ts), the user's last. */
  planArgs?: string[];
}

/** Where the engine listens: a loopback port, or a Unix socket. */
export type EngineAddress = { port: number } | { socketPath: string };

function connectOptions(address: EngineAddress): http.RequestOptions {
  return 'socketPath' in address
    ? { socketPath: address.socketPath }
    : { host: '127.0.0.1', port: address.port };
}

/** Tokens the draft model proposes per step (`--spec-draft-n-max`). */
export const DRAFT_TOKENS = 6;

/** With a prompt cache, the conversation runs in this slot (`id_slot`). */
export const CONVERSATION_SLOT = 0;
/** Side queries (memory, summaries, subagents) run in this slot. */
export const SIDE_QUERY_SLOT = 1;

/** Engine settings the user can change; changing one restarts the engine. */
export interface LocalModelEngineOptions {
  /** N-gram speculative decoding (`--spec-type ngram-simple`). */
  speculation: boolean;
  /**
   * The llama-server to run (`localModelEngine`); otherwise the first
   * llama-server on PATH.
   */
  enginePath?: string;
  /** `localModelEngineArgs`: the user's own llama-server options. */
  extraArgs?: string[];
}

export const DEFAULT_ENGINE_OPTIONS: LocalModelEngineOptions = {
  speculation: true,
};

export interface EngineCommand {
  command: string;
  args: string[];
  env: NodeJS.ProcessEnv;
}

export { findExecutable } from './executables.js';

/**
 * Speculative decoding: the target model checks several drafted tokens in
 * one step, which does not change the output. A draft model guesses new
 * text too; without one, n-gram speculation drafts from text already in the
 * context, which an agent echoes when it edits files. llama.cpp reads the
 * draft's type (DFlash, DSpark or MTP) from its GGUF metadata.
 */
function speculationArgs(
  options: LocalModelEngineOptions,
  draftPath: string | undefined,
): string[] {
  if (!options.speculation) return [];
  if (!draftPath) return ['--spec-type', 'ngram-simple'];
  return [
    '--spec-draft-model',
    draftPath,
    '--spec-draft-n-max',
    String(DRAFT_TOKENS),
  ];
}

/**
 * The llama-server to run: `localModelEngine` when it is set, otherwise the
 * first on PATH.
 *
 * @throws Error saying how to set it up when there is none.
 */
function engineBinary(
  model: LocalModelConfig,
  options: LocalModelEngineOptions,
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform,
): string {
  const name = model.name ?? model.id;
  if (options.enginePath) {
    if (!path.isAbsolute(options.enginePath)) {
      throw new Error(
        `localModelEngine must be the full path of llama-server, not "${options.enginePath}".`,
      );
    }
    if (!isExecutableFile(options.enginePath)) {
      throw new Error(
        `localModelEngine is ${options.enginePath}, which is not a program qwen can run; ${name} needs it. Run /models setup to see how to build llama-server for this machine.`,
      );
    }
    return options.enginePath;
  }
  const binary = findExecutable(LLAMA_SERVER, env['PATH'] ?? '', platform);
  if (!binary) {
    throw new Error(
      `${LLAMA_SERVER} was not found on PATH, and localModelEngine is not set; ${name} needs it. Run /models setup to see how to build it for this machine.`,
    );
  }
  return binary;
}

/** Variables the engine keeps on every platform. */
const ENGINE_ENV = ['PATH', 'HOME', 'TMPDIR'];

/**
 * Variables Windows programs need: Winsock and driver DLLs fail to load
 * without SystemRoot, and temporary files go to TEMP and TMP.
 */
const WINDOWS_ENGINE_ENV = [
  'SystemRoot',
  'windir',
  'TEMP',
  'TMP',
  'USERPROFILE',
  'LOCALAPPDATA',
  'APPDATA',
  'ProgramData',
  'PATHEXT',
  'NUMBER_OF_PROCESSORS',
  'PROCESSOR_ARCHITECTURE',
];

/** Shared libraries of CUDA or ROCm installed outside the system paths. */
const LINUX_ENGINE_ENV = ['LD_LIBRARY_PATH'];

/** Which GPUs the engine uses, and driver settings (ROCm, Vulkan). */
const GPU_ENGINE_ENV = [
  'CUDA_VISIBLE_DEVICES',
  'CUDA_PATH',
  'HIP_PATH',
  'HIP_VISIBLE_DEVICES',
  'ROCR_VISIBLE_DEVICES',
  'HSA_OVERRIDE_GFX_VERSION',
  'VK_ICD_FILENAMES',
  'VK_DRIVER_FILES',
];

/**
 * The engine's environment. It gets no credentials or settings from qwen's
 * environment: variables such as LLAMA_ARG_HF_REPO or HF_TOKEN would make it
 * download. ggml's own tuning variables (GGML_*) pass through.
 */
export function engineEnv(
  apiKey: string,
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform,
): NodeJS.ProcessEnv {
  const childEnv: NodeJS.ProcessEnv = { LLAMA_API_KEY: apiKey };
  const names = [
    ...ENGINE_ENV,
    ...(platform === 'win32' ? WINDOWS_ENGINE_ENV : []),
    ...(platform === 'linux' ? LINUX_ENGINE_ENV : []),
    ...GPU_ENGINE_ENV,
  ];
  for (const name of names) {
    if (env[name] !== undefined) childEnv[name] = env[name];
  }
  for (const [name, value] of Object.entries(env)) {
    if (name.startsWith('GGML_') && value !== undefined) childEnv[name] = value;
  }
  return childEnv;
}

/**
 * The command that runs `model` from `modelPath` on `127.0.0.1:port`, or on
 * `launch.socketPath`.
 */
export function engineCommand(
  model: LocalModelConfig,
  modelPath: string,
  port: number,
  apiKey: string,
  options: LocalModelEngineOptions = DEFAULT_ENGINE_OPTIONS,
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
  launch: EngineLaunch = {},
): EngineCommand {
  const binary = engineBinary(model, options, env, platform);
  const childEnv = engineEnv(apiKey, env, platform);
  const args = [
    '--model',
    modelPath,
    '--host',
    // llama-server listens on a Unix socket when the host ends in .sock.
    launch.socketPath ?? '127.0.0.1',
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
    // Counters for /models bench: draft acceptance, MoE cache hits.
    '--metrics',
    ...SAMPLING_ARGS,
    ...speculationArgs(options, launch.draftPath),
    ...(launch.planArgs ?? []),
    // A mixture-of-experts model too big for the GPU runs the experts of
    // its first layers on the CPU. Read into memory rather than mapped from
    // the file, they read prompts faster and more steadily.
    ...(launch.cpuMoeLayers
      ? ['--n-cpu-moe', String(launch.cpuMoeLayers), '--load-mode', 'none']
      : []),
    // Slot 0 holds the conversation, so its state can be saved and restored
    // whole; side queries run beside it in slot 1. Both share one cache, so
    // either can use the whole context.
    ...(launch.promptCacheDir
      ? [
          '--parallel',
          '2',
          '--kv-unified',
          '--slot-save-path',
          launch.promptCacheDir.endsWith(path.sep)
            ? launch.promptCacheDir
            : launch.promptCacheDir + path.sep,
        ]
      : []),
  ];
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
    };
  }
  if (platform === 'linux' && launch.confinement) {
    return {
      ...confinedCommand(launch.confinement, binary, args),
      env: childEnv,
    };
  }
  return { command: binary, args, env: childEnv };
}

/** llama-server needs a port even when it listens on a socket. */
const SOCKET_PORT = 8080;

/**
 * Where the socket's private folder goes. A socket path must stay under
 * about 100 bytes, so a long TMPDIR falls back to /tmp.
 */
function socketParent(): string {
  const tmp = os.tmpdir();
  return path.join(tmp.length > 60 ? '/tmp' : tmp, 'qwen-engine-');
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

/** A two-token completion; resolves to the engine's error, or undefined. */
function tryCompletion(
  address: EngineAddress,
  apiKey: string,
): Promise<string | undefined> {
  const body = JSON.stringify({
    messages: [{ role: 'user', content: 'Reply with OK.' }],
    max_tokens: 2,
  });
  return new Promise((resolve) => {
    const request = http.request(
      {
        ...connectOptions(address),
        path: '/v1/chat/completions',
        method: 'POST',
        timeout: SLOT_TIMEOUT_MS,
        headers: {
          authorization: `Bearer ${apiKey}`,
          'content-type': 'application/json',
          'content-length': Buffer.byteLength(body),
        },
      },
      (response) => {
        let text = '';
        response.on('data', (chunk) => (text += chunk));
        response.on('end', () => {
          if (response.statusCode === 200) return resolve(undefined);
          let message = `HTTP ${response.statusCode}`;
          try {
            message = JSON.parse(text).error?.message ?? message;
          } catch {
            // Keep the status code.
          }
          resolve(message);
        });
      },
    );
    request.on('timeout', () => request.destroy(new Error('timed out')));
    request.on('error', (error) => resolve(error.message));
    request.end(body);
  });
}

/** POST `/slots/<conversation>?action=<action>`; resolves to whether the engine did it. */
function slotAction(
  address: EngineAddress,
  apiKey: string,
  action: 'save' | 'restore',
  filename: string,
): Promise<boolean> {
  const body = JSON.stringify({ filename });
  return new Promise((resolve) => {
    const request = http.request(
      {
        ...connectOptions(address),
        path: `/slots/${CONVERSATION_SLOT}?action=${action}`,
        method: 'POST',
        timeout: SLOT_TIMEOUT_MS,
        headers: {
          authorization: `Bearer ${apiKey}`,
          'content-type': 'application/json',
          'content-length': Buffer.byteLength(body),
        },
      },
      (response) => {
        response.resume();
        resolve(response.statusCode === 200);
      },
    );
    request.on('timeout', () => request.destroy());
    request.on('error', () => resolve(false));
    request.end(body);
  });
}

function answers(address: EngineAddress, urlPath: string): Promise<boolean> {
  return new Promise((resolve) => {
    const options = {
      ...connectOptions(address),
      path: urlPath,
      timeout: 2000,
    };
    const request = http.get(options, (response) => {
      response.resume();
      resolve(response.statusCode === 200);
    });
    request.on('timeout', () => request.destroy());
    request.on('error', () => resolve(false));
  });
}

/** The downloaded draft of `model`, if it has one and it is in the cache. */
export function resolveDraftPath(model: LocalModelConfig): string | undefined {
  if (!model.draft) return undefined;
  try {
    return resolveLocalModelPath({
      id: `${model.id} draft`,
      repo: model.draft.repo,
      file: model.draft.file,
    });
  } catch {
    return undefined;
  }
}

/**
 * Start an engine for `model` and wait until it serves requests. With a
 * downloaded draft, it also answers one short request first. A
 * mixture-of-experts model too big for the GPU runs partly on the CPU.
 *
 * @throws Error when the model is not downloaded, cannot fit this machine's GPU
 *   and memory (see fitModel), the engine is missing, or the engine exits or does
 *   not answer in time; the message carries the end of the engine's output.
 *   Also when the engine cannot answer with its draft model.
 */
/** How a downloaded model runs on this machine. */
export interface LocalModelPlan {
  modelPath: string;
  draftPath?: string;
  bytes: number;
  fit: ModelFit;
  capabilities?: ModelCapabilities;
  plan: EnginePlan;
}

/**
 * Fit and plan a downloaded model for this machine, as the engine will run
 * it.
 *
 * @throws Error when the model is not downloaded.
 */
export function planLocalModel(
  model: LocalModelConfig,
  options: LocalModelEngineOptions = DEFAULT_ENGINE_OPTIONS,
): LocalModelPlan {
  const modelPath = resolveLocalModelPath(model);
  // Without a downloaded draft the engine falls back to n-gram drafting.
  const draftPath = options.speculation ? resolveDraftPath(model) : undefined;
  const bytes =
    localModelBytes(model) + (draftPath ? statSync(draftPath).size : 0);
  const gpu = gpuBudget();
  const fit = fitModel(
    model,
    bytes,
    () => localModelExpertBytes(model),
    gpu,
    systemMemoryBytes(),
  );
  const capabilities = inspectModel(modelPath);
  const plan = planEngine({
    bytes,
    gpu,
    fit,
    hasDraft: draftPath !== undefined,
    ...(capabilities ? { model: capabilities } : {}),
    ...(options.extraArgs ? { userArgs: options.extraArgs } : {}),
  });
  return {
    modelPath,
    ...(draftPath ? { draftPath } : {}),
    bytes,
    fit,
    ...(capabilities ? { capabilities } : {}),
    plan,
  };
}

export async function startLocalModelEngine(
  model: LocalModelConfig,
  apiKey: string,
  options: LocalModelEngineOptions = DEFAULT_ENGINE_OPTIONS,
  promptCacheDir?: string,
): Promise<LocalModelEngine> {
  // Past the GPU limit a model runs at a fraction of its speed, or fails
  // mid-request.
  const { modelPath, draftPath, fit, plan } = planLocalModel(model, options);
  if ('problem' in fit) {
    throw new Error(fit.problem);
  }
  // On Linux the engine runs in an empty network namespace where possible,
  // reached only through a Unix socket in a private folder.
  const confinement =
    process.platform === 'linux' ? getConfinement() : { kind: 'none' as const };
  const socketDir =
    confinement.kind === 'none' ? undefined : mkdtempSync(socketParent());
  const socketPath = socketDir && path.join(socketDir, 'engine.sock');
  const removeSocketDir = () => {
    if (socketDir) rmSync(socketDir, { recursive: true, force: true });
  };
  // A socket ignores the port, but llama-server wants one.
  const port = socketPath ? SOCKET_PORT : await freeLoopbackPort();
  const address: EngineAddress = socketPath ? { socketPath } : { port };
  const command = engineCommand(
    model,
    modelPath,
    port,
    apiKey,
    options,
    process.env,
    process.platform,
    {
      draftPath,
      promptCacheDir,
      // Elsewhere llama.cpp's --fit (on by default) measures each device's
      // free memory and places what does not fit itself.
      cpuMoeLayers: process.platform === 'darwin' ? fit.cpuMoeLayers : 0,
      ...(socketPath ? { socketPath, confinement } : {}),
      planArgs: plan.args,
    },
  );
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
  const killOnExit = () => {
    child.kill('SIGKILL');
    removeSocketDir();
  };
  process.once('exit', killOnExit);
  void exited.then(() => {
    process.removeListener('exit', killOnExit);
    removeSocketDir();
  });

  const name = model.name ?? model.id;
  const failure = (reason: string) =>
    new Error(
      `${name} failed to start: ${reason}.` +
        (output.trim() ? `\n${output.trim()}` : ''),
    );
  const deadline = Date.now() + READY_TIMEOUT_MS;
  // llama-server answers 200 here once the model is loaded.
  for (;;) {
    if (exitDetail) throw failure(`the engine exited (${exitDetail})`);
    if (await answers(address, '/health')) break;
    if (Date.now() > deadline) {
      child.kill('SIGKILL');
      throw failure('the engine did not answer within 5 minutes');
    }
    await new Promise((resolve) => setTimeout(resolve, READY_POLL_MS));
  }

  // A draft that does not fit the GPU passes startup and then fails every
  // request, so try one before handing the engine out.
  if (draftPath) {
    const problem = await tryCompletion(address, apiKey);
    if (problem) {
      child.kill('SIGKILL');
      throw new Error(
        `${name} failed with its draft model (${problem}). The draft needs GPU memory beside the model: lower the model's contextSize, remove its draft, or turn speculative decoding off with /models speculation off.`,
      );
    }
  }

  return {
    model,
    // With a socket, the URL only names the API; the socket carries it.
    baseUrl: socketPath ? 'http://localhost/v1' : `http://127.0.0.1:${port}/v1`,
    ...(socketPath ? { socketPath } : {}),
    stateKey: engineStateKey([
      modelPath,
      draftPath ?? '',
      String(model.contextSize ?? DEFAULT_LOCAL_MODEL_CONTEXT_SIZE),
      String(options.speculation),
      // Another build may not read the states this one saved.
      options.enginePath ?? '',
      plan.args.join(' '),
    ]),
    get alive() {
      return exitDetail === undefined;
    },
    slot: (action, filename) =>
      promptCacheDir && exitDetail === undefined
        ? slotAction(address, apiKey, action, filename)
        : Promise.resolve(false),
    async stop() {
      if (exitDetail !== undefined) return;
      child.kill('SIGTERM');
      const grace = setTimeout(() => child.kill('SIGKILL'), STOP_GRACE_MS);
      await exited;
      clearTimeout(grace);
    },
  };
}
