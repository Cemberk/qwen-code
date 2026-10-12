/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Child-process entry that runs one workflow script in QuickJS (WASM).
 *
 * The parent (`workflow-sandbox.ts`) spawns this with a stripped environment
 * and talks to it over length-prefixed JSON frames. The script never shares a
 * realm, an object, or a call stack with the parent: the only host function
 * the guest can reach is `post`, which takes a string, and everything the
 * parent sends back is parsed by the guest from JSON. A script that escapes
 * its own semantics can at worst crash or hang this process, which the parent
 * kills.
 */

import variant from '@jitl/quickjs-singlefile-mjs-release-sync';
import {
  newQuickJSWASMModuleFromVariant,
  type QuickJSContext,
  type QuickJSHandle,
  type QuickJSRuntime,
} from 'quickjs-emscripten-core';
import {
  encodeWorkflowFrame,
  WORKFLOW_SCRIPT_FILENAME,
  WorkflowFrameDecoder,
  wrapWorkflowBody,
  type WorkflowStartMessage,
} from './workflow-protocol.js';
import { WORKFLOW_GUEST_PRELUDE } from './workflow-guest.js';

const MEMORY_LIMIT_BYTES = 512 * 1024 * 1024;
// Below the point where the WebAssembly frames exhaust Node's own stack, so
// runaway recursion is a catchable error in the script (~1,500 frames deep)
// instead of a failure of the host.
const STACK_LIMIT_BYTES = 256 * 1024;

let runtime: QuickJSRuntime | undefined;
let vm: QuickJSContext | undefined;
let receive: QuickJSHandle | undefined;
let syncTimeoutMs = 0;
let deadline = Infinity;
let interrupted = false;
let failed = false;
let ready = false;
const queued: string[] = [];
let outgoing: Buffer[] = [];

// Frames posted during one burst go out in one write, so the parent sees
// together what the script issued together — a fan-out's requests reach its
// dispatch gates in the same tick, as they did when the script ran in-process.
function write(body: string): void {
  outgoing.push(encodeWorkflowFrame(body));
}

function flush(): void {
  if (outgoing.length === 0) return;
  process.stdout.write(Buffer.concat(outgoing));
  outgoing = [];
}

function errorText(value: unknown): string {
  if (value && typeof value === 'object') {
    const message = (value as { message?: unknown }).message;
    if (typeof message === 'string') return message;
  }
  return String(value);
}

function fail(error: unknown): void {
  if (failed) return;
  failed = true;
  const message = interrupted
    ? `Script execution timed out after ${syncTimeoutMs}ms`
    : errorText(error);
  write(JSON.stringify({ type: 'error', message }));
  flush();
}

function unwrap(
  context: QuickJSContext,
  result: { value: QuickJSHandle } | { error: QuickJSHandle },
): QuickJSHandle {
  if ('error' in result) {
    const dumped: unknown = context.dump(result.error);
    result.error.dispose();
    throw new Error(errorText(dumped));
  }
  return result.value;
}

/**
 * Run guest code, then every job it queued, under the synchronous-evaluation
 * deadline. Each burst gets the full deadline; time spent waiting on the
 * parent between bursts is never counted.
 */
function burst(work: (context: QuickJSContext) => void): void {
  if (failed || !vm || !runtime) return;
  deadline = Date.now() + syncTimeoutMs;
  try {
    work(vm);
    const jobs = runtime.executePendingJobs();
    if ('error' in jobs && jobs.error) {
      const dumped: unknown = jobs.error.context.dump(jobs.error);
      jobs.error.dispose();
      throw new Error(errorText(dumped));
    }
  } catch (error) {
    fail(error);
  } finally {
    deadline = Infinity;
  }
  if (interrupted) fail(undefined);
  flush();
}

function deliver(body: string): void {
  burst((context) => {
    const text = context.newString(body);
    try {
      unwrap(
        context,
        context.callFunction(receive!, context.undefined, text),
      ).dispose();
    } finally {
      text.dispose();
    }
  });
}

async function start(message: WorkflowStartMessage): Promise<void> {
  syncTimeoutMs = message.syncTimeoutMs;
  const quickjs = await newQuickJSWASMModuleFromVariant(variant);
  runtime = quickjs.newRuntime();
  runtime.setMemoryLimit(MEMORY_LIMIT_BYTES);
  runtime.setMaxStackSize(STACK_LIMIT_BYTES);
  runtime.setInterruptHandler(() => {
    if (Date.now() < deadline) return false;
    interrupted = true;
    return true;
  });
  vm = runtime.newContext();
  const post = vm.newFunction('post', (bodyHandle) => {
    // After an interrupt the guest is being torn down; nothing it says counts.
    if (interrupted) return;
    if (vm!.typeof(bodyHandle) !== 'string') {
      throw new TypeError('post expects a string.');
    }
    write(vm!.getString(bodyHandle));
  });
  vm.setProp(vm.global, '__wfPost', post);
  post.dispose();
  write(JSON.stringify({ type: 'ready' }));
  flush();
  burst((context) => {
    const prelude = unwrap(
      context,
      context.evalCode(WORKFLOW_GUEST_PRELUDE, 'workflow-prelude.js'),
    );
    const config = context.newString(
      JSON.stringify({
        args: message.args,
        workflow: message.workflow,
        budget: message.budget,
        maxLogLines: message.maxLogLines,
      }),
    );
    const api = unwrap(
      context,
      context.callFunction(prelude, context.undefined, config),
    );
    config.dispose();
    prelude.dispose();
    receive = context.getProp(api, 'receive');
    const watch = context.getProp(api, 'watch');
    api.dispose();
    const main = unwrap(
      context,
      context.evalCode(
        wrapWorkflowBody(message.source),
        WORKFLOW_SCRIPT_FILENAME,
      ),
    );
    unwrap(
      context,
      context.callFunction(watch, context.undefined, main),
    ).dispose();
    main.dispose();
    watch.dispose();
  });
  ready = true;
  for (const body of queued.splice(0)) deliver(body);
}

const decoder = new WorkflowFrameDecoder();
let started = false;
process.stdin.on('data', (chunk: Buffer) => {
  let bodies: string[];
  try {
    bodies = decoder.push(chunk);
  } catch (error) {
    fail(error);
    return;
  }
  for (const body of bodies) {
    if (!started) {
      started = true;
      void start(JSON.parse(body) as WorkflowStartMessage).catch(fail);
    } else if (!ready) {
      queued.push(body);
    } else {
      deliver(body);
    }
  }
});
// The parent owns this process: when it goes away, so does the script.
process.stdin.on('end', () => process.exit(0));
process.stdout.on('error', () => process.exit(0));
