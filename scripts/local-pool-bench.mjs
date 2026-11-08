/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

// How well several agents share one engine through the local model pool:
// runs 1, 2, 4 ... conversations at once (each its own pool client, in its
// own slot) and reports the generation speed of each and of all together.
// With --separate it also runs that many independent engines side by side,
// the way qwens ran before the pool (each loads its own copy of the model).
//
//   npm run build
//   node scripts/local-pool-bench.mjs [--engine PATH] [--model ID] [--ctx TOKENS] [--agents 1,2,4] [--separate] [--workload prose|edit]
//
// --ctx  the context size, shared by all conversations (default: the model's)
//
// The pool runs in this process, in a temporary pool folder: the user's own
// pool is not touched.

import { mkdtempSync, rmSync } from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const load = (name) =>
  import(
    pathToFileURL(
      path.join(root, 'packages', 'core', 'dist', 'src', 'local-models', name),
    ).href
  );

const argv = process.argv.slice(2);
const option = (name) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : undefined;
};

let core;
try {
  core = {
    ...(await load('engine.js')),
    ...(await load('bench.js')),
    ...(await load('local-models.js')),
    ...(await load('local-model-server.js')),
    ...(await load('pool/daemon.js')),
    ...(await load('pool/client.js')),
  };
} catch (error) {
  console.error(
    `Cannot load packages/core/dist: run npm run build first.\n${error}`,
  );
  process.exit(1);
}

const id = option('model') ?? 'qwen3-4b';
const builtIn = core.BUILT_IN_LOCAL_MODELS.find((m) => m.id === id);
const model =
  builtIn && option('ctx')
    ? { ...builtIn, contextSize: Number(option('ctx')) }
    : builtIn;
if (!model) {
  console.error(`${id} is not a built-in local model.`);
  process.exit(1);
}
const counts = (option('agents') ?? '1,2,4').split(',').map(Number);
const workload = option('workload') ?? 'prose';
const enginePath = option('engine');
const options = {
  ...core.DEFAULT_ENGINE_OPTIONS,
  ...(enginePath ? { enginePath: path.resolve(enginePath) } : {}),
};

const fmt = (n) => n.toFixed(1);

/** Run one bench per lease at once; wall-clock tokens per second over all. */
/**
 * One short prompt and 128 generated tokens through a lease, so the time is
 * generation, not reading a prompt; resolves to the engine's own timings.
 */
function generate(lease) {
  const body = JSON.stringify({
    messages: [
      {
        role: 'user',
        content:
          workload === 'edit'
            ? 'Write a TypeScript function that parses an ISO date string, with tests.'
            : 'Write a short story about a lighthouse keeper.',
      },
    ],
    max_tokens: 128,
    temperature: 0,
    ignore_eos: true,
    cache_prompt: false,
    chat_template_kwargs: { enable_thinking: false },
  });
  const url = new URL(lease.baseUrl);
  return new Promise((resolve, reject) => {
    const request = http.request(
      {
        ...(lease.socketPath
          ? { socketPath: lease.socketPath }
          : { host: url.hostname, port: Number(url.port) }),
        path: `${url.pathname.replace(/\/$/, '')}/chat/completions`,
        method: 'POST',
        headers: {
          ...lease.headers,
          authorization: `Bearer ${lease.apiKey}`,
          'content-type': 'application/json',
          'content-length': Buffer.byteLength(body),
        },
      },
      (response) => {
        let text = '';
        response.on('data', (chunk) => (text += chunk));
        response.on('end', () => {
          if (response.statusCode !== 200) {
            reject(
              new Error(`HTTP ${response.statusCode}: ${text.slice(0, 200)}`),
            );
            return;
          }
          const json = JSON.parse(text);
          resolve({
            generatedTokens: json.usage?.completion_tokens ?? 0,
            generatedPerSecond: json.timings?.predicted_per_second ?? 0,
          });
        });
      },
    );
    request.on('error', reject);
    request.end(body);
  });
}

async function together(leases) {
  const started = performance.now();
  const results = await Promise.all(leases.map((lease) => generate(lease)));
  const seconds = (performance.now() - started) / 1000;
  const tokens = results.reduce((sum, r) => sum + r.generatedTokens, 0);
  return { results, total: tokens / seconds, seconds };
}

const dir = mkdtempSync(path.join(os.tmpdir(), 'qwen-pool-bench-'));
const report = [];
try {
  const daemon = await core.startPoolDaemon({ dir, idleExitMs: 60_000 });
  if (!daemon) throw new Error('could not start the pool');
  const fallback = new core.LocalModelServer(async () => {
    throw new Error('the pool must serve every client');
  });
  const max = Math.max(...counts);
  const clients = Array.from({ length: max }, (_, i) => {
    const client = new core.PoolClient({
      dir,
      spawnDaemon: () => {},
      fallback,
    });
    client.setModels([model]);
    client.setEnginePath(options.enginePath);
    client.setSpeculation(options.speculation);
    client.setPromptCache({
      directory: path.join(dir, 'prompts'),
      context: () => ({ project: '/bench', session: `agent-${i}` }),
    });
    return client;
  });

  console.log(`model ${model.id}, workload ${workload}, pool`);
  // Load the engine once before timing anything.
  const warm = await clients[0].acquire(model.id);
  await core.runBench(warm, workload);
  warm.release();

  for (const n of counts) {
    // As qwen does: hold a lease only for the request, so agents beyond what
    // the engine runs at once wait for one to end instead of deadlocking.
    const started = performance.now();
    const results = await Promise.all(
      clients.slice(0, n).map(async (client) => {
        const lease = await client.acquire(model.id);
        try {
          return await generate(lease);
        } finally {
          lease.release();
        }
      }),
    );
    const seconds = (performance.now() - started) / 1000;
    const total =
      results.reduce((sum, r) => sum + r.generatedTokens, 0) / seconds;
    const each = results.map((r) => fmt(r.generatedPerSecond));
    console.log(
      `  ${n} agent(s) on one engine: ${fmt(total)} tok/s together in ${fmt(seconds)} s; each ${each.join(', ')} tok/s`,
    );
    report.push({ mode: 'pool', agents: n, total, each: results });
  }
  for (const client of clients) await client.stop();
  await daemon.close();

  if (argv.includes('--separate')) {
    console.log('separate engines, one per agent');
    for (const n of counts.filter((c) => c > 1)) {
      const engines = [];
      try {
        for (let i = 0; i < n; i++) {
          engines.push(
            await core.startLocalModelEngine(model, `k${i}`, options),
          );
        }
      } catch (error) {
        console.log(
          `  ${n} engines: could not start them all (${error.message.split('\n')[0]})`,
        );
        await Promise.all(engines.map((e) => e.stop()));
        continue;
      }
      const leases = engines.map((engine, i) => ({
        baseUrl: engine.baseUrl,
        ...(engine.socketPath ? { socketPath: engine.socketPath } : {}),
        apiKey: `k${i}`,
        pinSlots: false,
        release() {},
      }));
      const { results, total, seconds } = await together(leases);
      await Promise.all(engines.map((e) => e.stop()));
      const each = results.map((r) => fmt(r.generatedPerSecond));
      console.log(
        `  ${n} engines: ${fmt(total)} tok/s together in ${fmt(seconds)} s; each ${each.join(', ')} tok/s`,
      );
      report.push({ mode: 'separate', agents: n, total, each: results });
    }
  }
} catch (error) {
  console.error(`failed: ${error instanceof Error ? error.message : error}`);
  process.exitCode = 1;
} finally {
  rmSync(dir, { recursive: true, force: true });
}
