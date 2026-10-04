/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */
/* global setTimeout, clearTimeout, console, process */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { startFakeOpenAIServer } from './fake-openai-server.ts';
const bundle = resolve('dist/cli.js');
const deadline = setTimeout(() => {
  for (const child of children) child.kill('SIGTERM');
  throw new Error('E2E timed out');
}, 180000);
const root = await mkdtemp(join(tmpdir(), 'qwen-reasoning-v2-'));
const children = new Set();
const requests = [];
const chat = await startFakeOpenAIServer(async ({ body }) => {
  requests.push(body);
  return { content: 'REASONING_OK' };
});
const tiered = (profile, defaultEffort = 'medium') => ({
  profile,
  efforts: ['low', 'medium', 'high'],
  defaultEffort,
});
const model = (id, reasoning, baseUrl = chat.baseUrl) => ({
  id,
  baseUrl,
  envKey: 'REASONING_TEST_KEY',
  capabilities: { reasoning },
});
async function fixture(name, auth, models) {
  const cwd = join(root, name),
    home = join(cwd, 'config');
  await mkdir(home, { recursive: true });
  const settings = {
    $version: 4,
    security: { auth: { selectedType: auth } },
    model: { name: models[0].id },
    modelProviders: { [auth]: models },
    telemetry: { enabled: false },
  };
  const file = join(home, 'settings.json');
  await writeFile(file, JSON.stringify(settings));
  const env = {
    ...process.env,
    QWEN_HOME: home,
    QWEN_RUNTIME_DIR: join(cwd, 'runtime'),
    REASONING_TEST_KEY: 'dummy',
    HTTP_PROXY: '',
    HTTPS_PROXY: '',
    ALL_PROXY: '',
    http_proxy: '',
    https_proxy: '',
    NO_PROXY: '127.0.0.1,localhost',
  };
  return { cwd, file, settings, env };
}
function start(f, args) {
  const child = spawn(process.execPath, [bundle, ...args], {
    cwd: f.cwd,
    env: f.env,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let stderr = '';
  child.stderr.on('data', (chunk) => (stderr += chunk));
  children.add(child);
  return { child, error: () => stderr };
}
async function headless(f) {
  const { child, error } = start(f, [
    ...'--approval-mode yolo --output-format json'.split(' '),
    ...'--max-wall-time 30s'.split(' '),
    '-p',
    'Say REASONING_OK',
  ]);
  let output = '';
  child.stdout.on('data', (chunk) => (output += chunk));
  child.stdin.end();
  const code = await new Promise((done) => child.on('close', done));
  assert.equal(code, 0, error());
  assert.match(output, /REASONING_OK/);
}
const cases = [
  ['openai', 'openai-effort', 'reasoning_effort', 'medium'],
  ['openai', 'openai-reasoning', 'reasoning.effort', 'medium'],
  ['openai', 'deepseek-openai', 'thinking.type', 'enabled'],
  [
    'openai',
    'qwen-chat-template',
    'chat_template_kwargs.enable_thinking',
    true,
  ],
];
try {
  for (const [auth, profile, field, expected] of cases) {
    if (process.argv[2] && !profile.includes(process.argv[2])) continue;
    const declaration =
      profile === 'qwen-chat-template' ? { profile } : tiered(profile);
    const f = await fixture(profile + auth, auth, [
      model('company-alias', declaration),
    ]);
    const before = requests.length;
    await headless(f);
    const body = requests.slice(before)[0];
    assert.equal(
      field.split('.').reduce((value, key) => value?.[key], body),
      expected,
    );
    console.log('PASS wire', auth, profile);
  }
} finally {
  clearTimeout(deadline);
  await writeFile(join(root, 'requests.json'), JSON.stringify(requests));
  for (const child of children) child.kill('SIGTERM');
  await chat.close();
  console.log('ARTIFACT', root);
}
