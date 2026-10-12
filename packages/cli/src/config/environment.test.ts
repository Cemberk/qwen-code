/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  hasLoadedEnvironmentValues,
  isFileSourcedEnvKey,
  loadEnvironment,
  resetEnvironmentTrackingForTesting,
  SETTINGS_DIRECTORY_NAME,
} from './environment.js';
import { PRIVATE_RELAUNCH_ENV_PROVENANCE } from './shared-env-keys.js';
import type { Settings } from './settingsSchema.js';
import {
  AGENT_EXECUTION_BACKEND_ENV,
  agentExecutionBackend,
} from './agent-execution.js';

const TRACKED_ENV = [
  AGENT_EXECUTION_BACKEND_ENV,
  'RUNTIME_DOTENV',
  'RUNTIME_EMPTY',
  'RUNTIME_EXCLUDED',
  'RUNTIME_PARENT',
  'RUNTIME_SETTINGS',
  'RUNTIME_SETTINGS_ONLY',
  'BASH_ENV',
  'ENV',
  'LD_PRELOAD',
  'NODE_OPTIONS',
  'NODE_PATH',
  'npm_config_node_options',
  'npm_config_node-options',
  'npm_config_userconfig',
  'NPM_CONFIG_NODE_OPTIONS',
  'Node_Options',
  'ZDOTDIR',
  'BASH_FUNC_id%%',
  'OPENSSL_CONF',
  'NODE_REPL_EXTERNAL_MODULE',
  'npm_config_node_gyp',
  'npm_config_init_module',
  'SSL_CERT_FILE',
  'GIT_SSH_COMMAND',
  'GIT_SSH',
  'GIT_CONFIG_COUNT',
  'GIT_CONFIG_PARAMETERS',
  'GIT_CONFIG_KEY_0',
  'GIT_CONFIG_VALUE_0',
  'GIT_EXEC_PATH',
  'GIT_TEMPLATE_DIR',
  'GIT_ASKPASS',
  'GIT_PROXY_COMMAND',
  'GIT_EDITOR',
  'GIT_SSL_CAPATH',
  'npm_config_cafile',
  'npm_config_ca',
  'npm_config_strict_ssl',
  'PIP_CERT',
  'PIP_CONFIG_FILE',
  'SSH_ASKPASS',
  'LESSOPEN',
  'LESSCLOSE',
  'CURL_HOME',
  'WGETRC',
  'HTTP_PROXY',
  'https_proxy',
  'ALL_PROXY',
  'no_proxy',
  'NODE_USE_ENV_PROXY',
  'PYTHON',
  'GIT_SEQUENCE_EDITOR',
  'XDG_CONFIG_HOME',
  'VISUAL',
  'EDITOR',
  'PYTHONSTARTUP',
  'BROWSER',
  'NODE_COMPILE_CACHE',
  'NODE_DISABLE_COMPILE_CACHE',
  'NODE_EXTRA_CA_CERTS',
  'node_extra_ca_certs',
  'Node_Extra_Ca_Certs',
  'QWEN_HOME',
  PRIVATE_RELAUNCH_ENV_PROVENANCE,
  PRIVATE_RELAUNCH_ENV_PROVENANCE.toLowerCase(),
  'QWEN_CODE_PENDING_COMPILE_CACHE',
  'QWEN_CODE_TRUSTED_FOLDERS_PATH',
  'QWEN_RUNTIME_DIR',
  'QWEN_SERVER_TOKEN',
  'qwen_server_token',
  'ld_library_path',
  // Every key a rejection test writes must be tracked, or a failing rejection
  // leaks into process.env and the afterEach restore misses it.
  'XDG_CACHE_HOME',
  'TMPDIR',
  'TMP',
  'TEMP',
  'QWEN_SANDBOX',
  'QWEN_SANDBOX_IMAGE',
  'QWEN_SANDBOX_NET',
  'OPENAI_API_KEY',
  'OPENAI_BASE_URL',
  'OPENAI_MODEL',
  'openai_base_url',
  'QWEN_MODEL',
  'QWEN_CUSTOM_API_KEY_OPENAI_TEST',
  'QWEN_TELEMETRY_OUTFILE',
  'QWEN_SYSTEM_MD',
  'SANDBOX_FLAGS',
  'SANDBOX_MOUNTS',
  'SEATBELT_PROFILE',
  'ANTHROPIC_API_KEY',
  'QWEN_TEST_PROVIDER_KEY',
  'DEMO_VAR',
] as const;

let tmpDirs: string[] = [];
const previousEnv = new Map<string, string | undefined>();

function makeWorkspace(): string {
  const dir = fs.realpathSync(
    fs.mkdtempSync(path.join(os.tmpdir(), 'qwen-runtime-env-')),
  );
  tmpDirs.push(dir);
  return dir;
}

// Most cases exercise key filtering in an unrestricted workspace, so folder
// trust (on by default) is turned off unless a case sets `security` itself.
function testSettings(partial: Partial<Settings>): Settings {
  return {
    security: { folderTrust: { enabled: false } },
    ...partial,
  } as Settings;
}

beforeEach(() => {
  previousEnv.clear();
  for (const key of TRACKED_ENV) {
    previousEnv.set(key, process.env[key]);
    delete process.env[key];
  }
  // Hermetic against the runner's real user-level .env files: findEnvFiles()
  // always discovers ~/.env and ~/.qwen/.env, and home scope deliberately
  // bypasses the hardcoded exclusions — so a dev machine with
  // NODE_OPTIONS in its home .env would both add warnings the
  // source-scoped counts never expect and apply keys the process.env
  // assertions require unset (CI runners have no home .env, so it ships
  // green and bites locally). Redirect HOME (USERPROFILE for Windows) to an
  // empty dir.
  previousEnv.set('HOME', process.env['HOME']);
  previousEnv.set('USERPROFILE', process.env['USERPROFILE']);
  const fakeHome = makeWorkspace();
  process.env['HOME'] = fakeHome;
  process.env['USERPROFILE'] = fakeHome;
});

afterEach(() => {
  for (const key of [...TRACKED_ENV, 'HOME', 'USERPROFILE']) {
    const value = previousEnv.get(key);
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
  for (const dir of tmpDirs) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  tmpDirs = [];
});

describe('operator container requirement across environment reload', () => {
  it('reports an excluded home settings.env requirement during load', () => {
    resetEnvironmentTrackingForTesting();
    const workspace = makeWorkspace();
    const key = AGENT_EXECUTION_BACKEND_ENV;
    const settingsFile = path.join(os.homedir(), '.qwen', 'settings.json');
    fs.mkdirSync(path.dirname(settingsFile), { recursive: true });
    fs.writeFileSync(
      settingsFile,
      JSON.stringify({
        env: { [key]: 'docker', RUNTIME_SETTINGS_ONLY: 'loaded' },
      }),
    );
    const settings = testSettings(
      JSON.parse(fs.readFileSync(settingsFile, 'utf8')),
    );
    const stderr = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
    try {
      loadEnvironment(settings, workspace);
      expect(process.env[key]).toBeUndefined();
      expect(process.env['RUNTIME_SETTINGS_ONLY']).toBe('loaded');
      expect(agentExecutionBackend()).toBeUndefined();
      expect(isFileSourcedEnvKey(key)).toBe(false);
      expect(stderr).toHaveBeenCalledWith(
        expect.stringContaining(
          'cannot set QWEN_AGENT_EXECUTION_BACKEND; ignored. Export it in the launch environment instead.',
        ),
      );
    } finally {
      stderr.mockRestore();
    }
  });

  it.each(
    ['.env', '.qwen/.env', 'settings.env'].flatMap((source) =>
      ['', 'docker', 'podman'].map((value) => ({ source, value })),
    ),
  )(
    'preserves the operator requirement with $source = $value',
    ({ source, value }) => {
      resetEnvironmentTrackingForTesting();
      const workspace = makeWorkspace();
      const key = AGENT_EXECUTION_BACKEND_ENV;
      process.env[key] = 'docker';
      const settings = testSettings({});
      if (source === 'settings.env') {
        settings.env = { [key]: value, RUNTIME_SETTINGS_ONLY: 'before' };
      } else {
        const file = path.join(workspace, source);
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, `${key}=${value}\nRUNTIME_DOTENV=before\n`);
      }
      loadEnvironment(settings, workspace);
      expect(process.env[key]).toBe('docker');
      expect(isFileSourcedEnvKey(key)).toBe(false);
      expect(agentExecutionBackend()).toBe('container');
    },
  );

  it.each(['.env', '.qwen/.env'])(
    'rejects the home %s requirement across relaunch',
    async (source) => {
      resetEnvironmentTrackingForTesting();
      const workspace = makeWorkspace();
      const file = path.join(os.homedir(), source);
      const key = AGENT_EXECUTION_BACKEND_ENV;
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, `${key}=podman\n`);
      loadEnvironment(testSettings({}), workspace);
      expect(process.env[key]).toBe('podman');
      expect(isFileSourcedEnvKey(key)).toBe(true);
      expect(() => agentExecutionBackend()).toThrow(
        'Export it in the launch environment instead',
      );
      fs.rmSync(file);
      vi.resetModules();
      const child = await import('./environment.js');
      const childExecution = await import('./agent-execution.js');
      child.loadEnvironment(testSettings({}), workspace);
      expect(process.env[key]).toBe('podman');
      expect(child.isFileSourcedEnvKey(key)).toBe(true);
      expect(() => childExecution.agentExecutionBackend()).toThrow(
        'Export it in the launch environment instead',
      );
      child.resetEnvironmentTrackingForTesting();
    },
  );

  it.each(['.env', '.qwen/.env', 'settings.env'])(
    'does not acquire a requirement from project %s',
    (source) => {
      resetEnvironmentTrackingForTesting();
      const workspace = makeWorkspace();
      const key = AGENT_EXECUTION_BACKEND_ENV;
      const settings = testSettings({});
      if (source === 'settings.env') settings.env = { [key]: 'docker' };
      else {
        const file = path.join(workspace, source);
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, `${key}=docker\n`);
      }
      loadEnvironment(settings, workspace);
      expect(process.env[key]).toBeUndefined();
      expect(agentExecutionBackend()).toBeUndefined();
    },
  );
});

describe('relaunch environment provenance', () => {
  beforeEach(() => resetEnvironmentTrackingForTesting());

  it('restores file provenance before loading files while preserving inherited values', async () => {
    vi.resetModules();
    const parent = await import('./environment.js');
    const workspace = makeWorkspace();
    fs.writeFileSync(path.join(workspace, '.env'), 'RUNTIME_DOTENV=file\n');
    process.env['RUNTIME_PARENT'] = 'operator';
    parent.loadEnvironment(
      testSettings({ env: { RUNTIME_SETTINGS: 'settings' } }),
      workspace,
    );
    // Ordinary child-process environment copies must carry provenance too.

    vi.resetModules();
    const child = await import('./environment.js');
    expect(process.env['RUNTIME_DOTENV']).toBe('file');
    expect(process.env['RUNTIME_SETTINGS']).toBe('settings');
    expect(process.env[PRIVATE_RELAUNCH_ENV_PROVENANCE]).toBe(
      child.getRelaunchEnvProvenance()[PRIVATE_RELAUNCH_ENV_PROVENANCE],
    );
    expect(child.isFileSourcedEnvKey('RUNTIME_DOTENV')).toBe(true);
    expect(child.isFileSourcedEnvKey('RUNTIME_SETTINGS')).toBe(true);
    expect(child.isFileSourcedEnvKey('RUNTIME_PARENT')).toBe(false);
    expect(child.getRelaunchEnvProvenance()).toEqual(
      parent.getRelaunchEnvProvenance(),
    );

    child.loadEnvironment(testSettings({}), workspace);
    vi.resetModules();
    const grandchild = await import('./environment.js');
    expect(grandchild.isFileSourcedEnvKey('RUNTIME_DOTENV')).toBe(true);
    expect(grandchild.isFileSourcedEnvKey('RUNTIME_SETTINGS')).toBe(true);
    grandchild.resetEnvironmentTrackingForTesting();
    child.resetEnvironmentTrackingForTesting();
  });

  it.each(['project .env', 'home .env', 'settings.env'])(
    'rejects forged provenance from %s on load',
    (source) => {
      const workspace = makeWorkspace();
      const keys = [
        PRIVATE_RELAUNCH_ENV_PROVENANCE,
        PRIVATE_RELAUNCH_ENV_PROVENANCE.toLowerCase(),
      ];
      const forged = JSON.stringify({ dotEnv: ['FORGED'], settingsEnv: [] });
      const values = Object.fromEntries(keys.map((key) => [key, forged]));
      const settings = testSettings({ advanced: { excludedEnvVars: [] } });
      if (source === 'settings.env') {
        settings.env = values;
      } else {
        fs.writeFileSync(
          path.join(source === 'home .env' ? os.homedir() : workspace, '.env'),
          keys.map((key) => `${key}=${forged}`).join('\n'),
        );
      }
      loadEnvironment(settings, workspace);
      expect(JSON.parse(process.env[PRIVATE_RELAUNCH_ENV_PROVENANCE]!)).toEqual(
        { dotEnv: [], settingsEnv: [] },
      );
      expect(process.env[keys[1]]).not.toBe(forged);
    },
  );

  it.each(['{', '{"dotEnv":[1],"settingsEnv":[]}'])(
    'rejects malformed inherited provenance instead of losing its trust boundary: %s',
    async (metadata) => {
      process.env[PRIVATE_RELAUNCH_ENV_PROVENANCE] = metadata;
      vi.resetModules();
      await expect(import('./environment.js')).rejects.toThrow();
      expect(process.env[PRIVATE_RELAUNCH_ENV_PROVENANCE]).toBeUndefined();
    },
  );
});

describe('loadEnvironment', () => {
  // T7: a cache directory of code the CLI loads is not a settings.env value.
  it('ignores a settings.env compile cache', () => {
    const workspace = makeWorkspace();
    process.env['QWEN_CODE_PENDING_COMPILE_CACHE'] = '/tmp/generated-cache';

    loadEnvironment(
      testSettings({
        env: {
          NODE_COMPILE_CACHE: '/tmp/repo-cache',
          QWEN_CODE_PENDING_COMPILE_CACHE: '/tmp/repo-cache',
        },
      }),
      workspace,
    );

    expect(process.env['NODE_COMPILE_CACHE']).toBe('/tmp/generated-cache');
    expect(process.env['QWEN_CODE_PENDING_COMPILE_CACHE']).toBeUndefined();
  });

  it('publishes the pending compile cache after environment loading', () => {
    const workspace = makeWorkspace();
    process.env['QWEN_CODE_PENDING_COMPILE_CACHE'] = '/tmp/generated-cache';

    loadEnvironment(testSettings({}), workspace);

    expect(process.env['NODE_COMPILE_CACHE']).toBe('/tmp/generated-cache');
    expect(process.env['QWEN_CODE_PENDING_COMPILE_CACHE']).toBeUndefined();
  });

  it('does not publish the pending compile cache when disabled by settings.env', () => {
    const workspace = makeWorkspace();
    process.env['QWEN_CODE_PENDING_COMPILE_CACHE'] = '/tmp/generated-cache';

    loadEnvironment(
      testSettings({
        env: {
          NODE_DISABLE_COMPILE_CACHE: '1',
        },
      }),
      workspace,
    );

    expect(process.env['NODE_COMPILE_CACHE']).toBeUndefined();
    expect(process.env['QWEN_CODE_PENDING_COMPILE_CACHE']).toBeUndefined();
  });

  it('filters reload-excluded keys from settings.env on initial load', () => {
    const workspace = makeWorkspace();

    loadEnvironment(
      testSettings({
        env: {
          RUNTIME_SETTINGS_ONLY: 'from-settings',
          BASH_ENV: '/tmp/bad-profile',
          NODE_OPTIONS: '--require ./bad.js',
          QWEN_SERVER_TOKEN: 'bad-token',
        },
      }),
      workspace,
    );

    expect(process.env['RUNTIME_SETTINGS_ONLY']).toBe('from-settings');
    expect(process.env['BASH_ENV']).toBeUndefined();
    expect(process.env['NODE_OPTIONS']).toBeUndefined();
    expect(process.env['QWEN_SERVER_TOKEN']).toBeUndefined();
  });

  // Regression for #8653: the daemon scrubs loader vars from process.env,
  // but daemon-side loadSettings() calls for trusted workspaces re-run the
  // initial .env load afterwards. That load must not refill the scrubbed
  // slots, or one workspace's .env loader hook reaches every other
  // workspace's session subprocesses through the shared daemon env.
  it('never applies loader-affecting keys from .env files, even on initial load', () => {
    const workspace = makeWorkspace();
    fs.writeFileSync(
      path.join(workspace, '.env'),
      [
        'NODE_OPTIONS=--import file:///workspace-a/harness.mjs',
        'npm_config_node_options=--import file:///workspace-a/hook.mjs',
        'NODE_PATH=/workspace-a/node_modules',
        'LD_PRELOAD=/workspace-a/hijack.so',
        'RUNTIME_DOTENV=allowed',
        '',
      ].join('\n'),
    );

    loadEnvironment(testSettings({}), workspace);

    expect(process.env['NODE_OPTIONS']).toBeUndefined();
    expect(process.env['npm_config_node_options']).toBeUndefined();
    expect(process.env['NODE_PATH']).toBeUndefined();
    expect(process.env['LD_PRELOAD']).toBeUndefined();
    expect(process.env['RUNTIME_DOTENV']).toBe('allowed');
  });

  // #8663 follow-up: pure-injection loader keys (dlopen/require/exec redirects)
  // join the scrubbed loader set and are rejected from every .env scope.
  it('never applies the follow-up code-injection loader keys from .env', () => {
    const workspace = makeWorkspace();
    fs.writeFileSync(
      path.join(workspace, '.env'),
      [
        'OPENSSL_CONF=/workspace-a/evil.cnf',
        'NODE_REPL_EXTERNAL_MODULE=/workspace-a/hook.js',
        'npm_config_node_gyp=/workspace-a/evil-gyp.js',
        'npm_config_init_module=/workspace-a/evil-init.js',
        'RUNTIME_DOTENV=allowed',
        '',
      ].join('\n'),
    );

    loadEnvironment(testSettings({}), workspace);

    expect(process.env['OPENSSL_CONF']).toBeUndefined();
    expect(process.env['NODE_REPL_EXTERNAL_MODULE']).toBeUndefined();
    expect(process.env['npm_config_node_gyp']).toBeUndefined();
    expect(process.env['npm_config_init_module']).toBeUndefined();
    expect(process.env['RUNTIME_DOTENV']).toBe('allowed');
  });

  it('never applies proxy routing from a project .env or settings.env', () => {
    const workspace = makeWorkspace();
    fs.writeFileSync(
      path.join(workspace, '.env'),
      [
        'HTTP_PROXY=http://proxy.example:3128',
        'https_proxy=http://proxy.example:3128',
        'NODE_USE_ENV_PROXY=1',
        'RUNTIME_DOTENV=allowed',
        '',
      ].join('\n'),
    );

    loadEnvironment(
      testSettings({
        env: {
          ALL_PROXY: 'socks5://proxy.example:1080',
          no_proxy: '*',
        },
      }),
      workspace,
    );

    for (const key of [
      'HTTP_PROXY',
      'https_proxy',
      'NODE_USE_ENV_PROXY',
      'ALL_PROXY',
      'no_proxy',
    ]) {
      expect.soft(process.env[key], key).toBeUndefined();
    }
    expect(process.env['RUNTIME_DOTENV']).toBe('allowed');
  });

  // #8663 follow-up: TLS trust anchors, the git command-exec family (incl.
  // numbered GIT_CONFIG_KEY_/VALUE_ pairs), and node-gyp interpreter selection
  // join the hardcoded reject-from-project-.env tier.
  it('never applies the follow-up TLS/git/interpreter keys from a project .env', () => {
    const workspace = makeWorkspace();
    fs.writeFileSync(
      path.join(workspace, '.env'),
      [
        'SSL_CERT_FILE=/workspace-a/evil-ca.pem',
        'GIT_SSH_COMMAND=/workspace-a/evil-ssh.sh',
        'GIT_SSH=/workspace-a/evil-legacy-ssh.sh',
        'GIT_CONFIG_COUNT=1',
        'GIT_CONFIG_PARAMETERS=core.hooksPath=/workspace-a/evil-hooks',
        'GIT_CONFIG_KEY_0=core.hooksPath',
        'GIT_CONFIG_VALUE_0=/workspace-a/evil-hooks',
        'GIT_EXEC_PATH=/workspace-a/evil-exec',
        'GIT_TEMPLATE_DIR=/workspace-a/evil-templates',
        'GIT_ASKPASS=/workspace-a/evil-askpass',
        'GIT_PROXY_COMMAND=/workspace-a/evil-proxy.sh',
        'GIT_EDITOR=/workspace-a/evil-editor.sh',
        'GIT_SSL_CAPATH=/workspace-a/evil-capath',
        'npm_config_cafile=/workspace-a/evil-ca.pem',
        'npm_config_ca=/workspace-a/evil-ca-inline',
        'npm_config_strict_ssl=false',
        'PIP_CERT=/workspace-a/evil-ca.pem',
        'CURL_HOME=/workspace-a',
        'WGETRC=/workspace-a/evil-wgetrc',
        'PYTHON=/workspace-a/evil-python',
        'RUNTIME_DOTENV=allowed',
        '',
      ].join('\n'),
    );

    loadEnvironment(testSettings({}), workspace);

    expect(process.env['SSL_CERT_FILE']).toBeUndefined();
    expect(process.env['GIT_SSH_COMMAND']).toBeUndefined();
    expect(process.env['GIT_SSH']).toBeUndefined();
    expect(process.env['GIT_CONFIG_COUNT']).toBeUndefined();
    expect(process.env['GIT_CONFIG_PARAMETERS']).toBeUndefined();
    expect(process.env['GIT_CONFIG_KEY_0']).toBeUndefined();
    expect(process.env['GIT_CONFIG_VALUE_0']).toBeUndefined();
    expect(process.env['GIT_EXEC_PATH']).toBeUndefined();
    expect(process.env['GIT_TEMPLATE_DIR']).toBeUndefined();
    expect(process.env['GIT_ASKPASS']).toBeUndefined();
    expect(process.env['GIT_PROXY_COMMAND']).toBeUndefined();
    expect(process.env['GIT_EDITOR']).toBeUndefined();
    expect(process.env['GIT_SSL_CAPATH']).toBeUndefined();
    expect(process.env['npm_config_cafile']).toBeUndefined();
    expect(process.env['npm_config_ca']).toBeUndefined();
    expect(process.env['npm_config_strict_ssl']).toBeUndefined();
    expect(process.env['PIP_CERT']).toBeUndefined();
    expect(process.env['CURL_HOME']).toBeUndefined();
    expect(process.env['WGETRC']).toBeUndefined();
    expect(process.env['PYTHON']).toBeUndefined();
    expect(process.env['RUNTIME_DOTENV']).toBe('allowed');
  });

  // #8663 review round: PIP_CONFIG_FILE redirects all of pip's configuration
  // (index-url / trusted-host / proxy / cert) at an attacker file, SSH_ASKPASS
  // is the askpass program git/ssh execute on an auth challenge, and LESSOPEN/
  // LESSCLOSE are run by `less` as input preprocessors. Each must be rejected
  // on every application boundary — initial load and reload alike.
  it('never applies pip config / ssh askpass / less preprocessor keys from a project .env', () => {
    resetEnvironmentTrackingForTesting();
    const workspace = makeWorkspace();
    const envPath = path.join(workspace, '.env');
    fs.writeFileSync(
      envPath,
      [
        'PIP_CONFIG_FILE=/workspace-a/pip.conf',
        'SSH_ASKPASS=/workspace-a/evil-askpass',
        'LESSOPEN=| /workspace-a/evil-lessopen.sh %s',
        'LESSCLOSE=/workspace-a/evil-lessclose.sh %s %s',
        'RUNTIME_DOTENV=allowed',
        '',
      ].join('\n'),
    );

    loadEnvironment(testSettings({}), workspace);
    expect(process.env['PIP_CONFIG_FILE']).toBeUndefined();
    expect(process.env['SSH_ASKPASS']).toBeUndefined();
    expect(process.env['LESSOPEN']).toBeUndefined();
    expect(process.env['LESSCLOSE']).toBeUndefined();
    expect(process.env['RUNTIME_DOTENV']).toBe('allowed');
  });

  // The settings.env application (load and reload) and the daemon's
  // per-workspace runtime env build consult the same hardcoded predicate.
  it('rejects pip config / ssh askpass / less preprocessor keys from settings.env', () => {
    resetEnvironmentTrackingForTesting();
    const workspace = makeWorkspace();
    const settings = testSettings({
      env: {
        PIP_CONFIG_FILE: '/workspace-a/pip.conf',
        SSH_ASKPASS: '/workspace-a/evil-askpass',
        LESSOPEN: '| /workspace-a/evil-lessopen.sh %s',
        RUNTIME_SETTINGS_ONLY: 'from-settings',
      },
    });

    loadEnvironment(settings, workspace);
    expect(process.env['PIP_CONFIG_FILE']).toBeUndefined();
    expect(process.env['SSH_ASKPASS']).toBeUndefined();
    expect(process.env['LESSOPEN']).toBeUndefined();
    expect(process.env['RUNTIME_SETTINGS_ONLY']).toBe('from-settings');
  });

  // #8663 round-4: git executes GIT_SEQUENCE_EDITOR on `git rebase -i` and
  // merges `$XDG_CONFIG_HOME/git/config` with `~/.gitconfig` (bypassing the
  // GIT_CONFIG_* blocks); $VISUAL/$EDITOR are git's editor fallback and the
  // CLI's own editor launch; CPython executes PYTHONSTARTUP at interactive
  // startup; the CLI execs $BROWSER via openBrowserSecurely.
  it('never applies the round-4 exec-redirect keys from project .env or settings.env', () => {
    resetEnvironmentTrackingForTesting();
    const workspace = makeWorkspace();
    fs.writeFileSync(
      path.join(workspace, '.env'),
      [
        'GIT_SEQUENCE_EDITOR=/workspace-a/evil-sequence.sh',
        'VISUAL=/workspace-a/evil-visual.sh',
        'EDITOR=/workspace-a/evil-editor.sh',
        'PYTHONSTARTUP=/workspace-a/evil-startup.py',
        'XDG_CONFIG_HOME=/workspace-a/.xdg',
        'BROWSER=/workspace-a/evil-browser.sh',
        'RUNTIME_DOTENV=allowed',
        '',
      ].join('\n'),
    );
    const settings = testSettings({
      env: {
        RUNTIME_SETTINGS_ONLY: 'from-settings',
      },
    });

    const expectRound4Rejected = (env: Readonly<NodeJS.ProcessEnv>) => {
      expect(env['GIT_SEQUENCE_EDITOR']).toBeUndefined();
      expect(env['VISUAL']).toBeUndefined();
      expect(env['EDITOR']).toBeUndefined();
      expect(env['PYTHONSTARTUP']).toBeUndefined();
      expect(env['XDG_CONFIG_HOME']).toBeUndefined();
      expect(env['BROWSER']).toBeUndefined();
    };

    loadEnvironment(settings, workspace);
    expectRound4Rejected(process.env);
    expect(process.env['RUNTIME_DOTENV']).toBe('allowed');
    expect(process.env['RUNTIME_SETTINGS_ONLY']).toBe('from-settings');
  });

  // The privileged <workspace>/.qwen/.env scope deliberately bypasses
  // excludedEnvVars and is discovered before the plain .env, so exempting it
  // from the loader denylist must not ship green.
  it('never applies loader-affecting keys from the .qwen/.env scope either', () => {
    const workspace = makeWorkspace();
    fs.mkdirSync(path.join(workspace, SETTINGS_DIRECTORY_NAME));
    fs.writeFileSync(
      path.join(workspace, SETTINGS_DIRECTORY_NAME, '.env'),
      [
        'NODE_OPTIONS=--import file:///workspace-a/harness.mjs',
        'NODE_PATH=/workspace-a/node_modules',
        'LD_PRELOAD=/workspace-a/hijack.so',
        'RUNTIME_DOTENV=allowed',
        '',
      ].join('\n'),
    );

    loadEnvironment(testSettings({}), workspace);

    expect(process.env['NODE_OPTIONS']).toBeUndefined();
    expect(process.env['NODE_PATH']).toBeUndefined();
    expect(process.env['LD_PRELOAD']).toBeUndefined();
    expect(process.env['RUNTIME_DOTENV']).toBe('allowed');
  });

  it('warns once per file+key when loader-affecting keys are rejected from .env', () => {
    resetEnvironmentTrackingForTesting();
    const workspace = makeWorkspace();
    const envPath = path.join(workspace, '.env');
    fs.writeFileSync(
      envPath,
      [
        'NODE_OPTIONS=--max-old-space-size=8192',
        'RUNTIME_DOTENV=allowed',
        '',
      ].join('\n'),
    );
    const stderrWrites: string[] = [];
    const stderrWrite = vi
      .spyOn(process.stderr, 'write')
      .mockImplementation((chunk) => {
        stderrWrites.push(String(chunk));
        return true;
      });

    try {
      loadEnvironment(testSettings({}), workspace);
      // Daemon-side loadSettings() re-runs loadEnvironment() for every
      // session; the warning must not repeat for the same file and key.
      loadEnvironment(testSettings({}), workspace);
    } finally {
      stderrWrite.mockRestore();
    }

    const warnings = stderrWrites.filter(
      (chunk) =>
        chunk.includes('cannot set loader-affecting env vars') &&
        chunk.includes(envPath),
    );
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain(envPath);
    expect(warnings[0]).toContain('NODE_OPTIONS');
    expect(process.env['RUNTIME_DOTENV']).toBe('allowed');
  });

  it('warns again only for new loader-affecting keys added to an already-warned file', () => {
    resetEnvironmentTrackingForTesting();
    const workspace = makeWorkspace();
    const envPath = path.join(workspace, '.env');
    fs.writeFileSync(
      envPath,
      ['NODE_OPTIONS=--max-old-space-size=8192', ''].join('\n'),
    );
    const stderrWrites: string[] = [];
    const stderrWrite = vi
      .spyOn(process.stderr, 'write')
      .mockImplementation((chunk) => {
        stderrWrites.push(String(chunk));
        return true;
      });

    try {
      loadEnvironment(testSettings({}), workspace);
      fs.writeFileSync(
        envPath,
        [
          'NODE_OPTIONS=--max-old-space-size=8192',
          'LD_PRELOAD=/workspace-a/hijack.so',
          '',
        ].join('\n'),
      );
      loadEnvironment(testSettings({}), workspace);
    } finally {
      stderrWrite.mockRestore();
    }

    const warnings = stderrWrites.filter(
      (chunk) =>
        chunk.includes('cannot set loader-affecting env vars') &&
        chunk.includes(envPath),
    );
    expect(warnings).toHaveLength(2);
    expect(warnings[0]).toContain('NODE_OPTIONS');
    // The second warning must cover only the delta — the already-warned key
    // stays rejected but is not reported again.
    expect(warnings[1]).toContain('LD_PRELOAD');
    expect(warnings[1]).not.toContain('NODE_OPTIONS');
  });

  // The loader gate runs before any scope check, and home-scoped files are
  // already exempt from PROJECT_ENV_HARDCODED_EXCLUSIONS — pin that a
  // home-scoped exemption mutant for loader keys cannot ship green.
  it('never applies loader-affecting keys from user-level .env files either', () => {
    const workspace = makeWorkspace();
    const qwenHome = makeWorkspace();
    process.env['QWEN_HOME'] = qwenHome;
    fs.writeFileSync(
      path.join(qwenHome, '.env'),
      [
        'NODE_OPTIONS=--import file:///workspace-a/harness.mjs',
        'npm_config_node_options=--import file:///workspace-a/hook.mjs',
        'RUNTIME_DOTENV=allowed',
        '',
      ].join('\n'),
    );

    loadEnvironment(testSettings({}), workspace);

    expect(process.env['NODE_OPTIONS']).toBeUndefined();
    expect(process.env['npm_config_node_options']).toBeUndefined();
    expect(process.env['RUNTIME_DOTENV']).toBe('allowed');
  });

  it('never applies loader-affecting keys from settings.env', () => {
    resetEnvironmentTrackingForTesting();
    const workspace = makeWorkspace();
    const settings = testSettings({
      env: {
        NODE_OPTIONS: '--import file:///workspace-a/harness.mjs',
        npm_config_node_options: '--import file:///workspace-a/hook.mjs',
        NPM_CONFIG_NODE_OPTIONS: '--import file:///workspace-a/upper.mjs',
        'npm_config_node-options': '--import file:///workspace-a/hyphen.mjs',
        RUNTIME_SETTINGS_ONLY: 'from-settings',
      },
    });
    const stderrWrites: string[] = [];
    const stderrWrite = vi
      .spyOn(process.stderr, 'write')
      .mockImplementation((chunk) => {
        stderrWrites.push(String(chunk));
        return true;
      });

    try {
      loadEnvironment(settings, workspace);
      expect(process.env['NODE_OPTIONS']).toBeUndefined();
      expect(process.env['npm_config_node_options']).toBeUndefined();
      expect(process.env['npm_config_node-options']).toBeUndefined();
      expect(process.env['NPM_CONFIG_NODE_OPTIONS']).toBeUndefined();
      expect(process.env['RUNTIME_SETTINGS_ONLY']).toBe('from-settings');
    } finally {
      stderrWrite.mockRestore();
    }

    // The settings.env application path warns.
    const warnings = stderrWrites.filter(
      (chunk) =>
        chunk.includes('cannot set loader-affecting env vars') &&
        chunk.includes(workspace),
    );
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('settings.env');
    expect(warnings[0]).toContain('NODE_OPTIONS');
    expect(warnings[0]).toContain('npm_config_node_options');
    expect(warnings[0]).toContain('npm_config_node-options');
    expect(warnings[0]).toContain('NPM_CONFIG_NODE_OPTIONS');
  });

  // npm applies npm_config_* env vars case-insensitively and Windows env
  // lookup is case-insensitive outright, so exact-case gates would let
  // variants like NPM_CONFIG_NODE_OPTIONS through on load and reload.
  it('rejects loader-affecting .env keys regardless of case', () => {
    const workspace = makeWorkspace();
    fs.writeFileSync(
      path.join(workspace, '.env'),
      [
        'NPM_CONFIG_NODE_OPTIONS=--import file:///workspace-a/hook.mjs',
        'Node_Options=--import file:///workspace-a/harness.mjs',
        'npm_config_node-options=--import file:///workspace-a/hyphen.mjs',
        'RUNTIME_DOTENV=allowed',
        '',
      ].join('\n'),
    );

    loadEnvironment(testSettings({}), workspace);
    expect(process.env['NPM_CONFIG_NODE_OPTIONS']).toBeUndefined();
    expect(process.env['Node_Options']).toBeUndefined();
    expect(process.env['npm_config_node-options']).toBeUndefined();
    expect(process.env['RUNTIME_DOTENV']).toBe('allowed');
  });

  // ENV is sourced by interactive and POSIX-mode sh, so like the other
  // shell-startup keys (SHELLOPTS, PS4, …) a project .env cannot set it.
  it('does not apply shell-startup or tool-redirect keys from a project .env', () => {
    resetEnvironmentTrackingForTesting();
    const workspace = makeWorkspace();
    const envPath = path.join(workspace, '.env');
    fs.writeFileSync(
      envPath,
      [
        'ENV=production',
        'SHELLOPTS=xtrace',
        'PS4=$(touch MARK)',
        'RIPGREP_CONFIG_PATH=./rg.cfg',
        'GIT_DIR=./.evil-git',
        'RUNTIME_DOTENV=allowed',
        '',
      ].join('\n'),
    );

    loadEnvironment(testSettings({}), workspace);
    for (const key of [
      'ENV',
      'SHELLOPTS',
      'PS4',
      'RIPGREP_CONFIG_PATH',
      'GIT_DIR',
    ]) {
      expect(process.env[key]).toBeUndefined();
    }
    expect(process.env['RUNTIME_DOTENV']).toBe('allowed');
  });

  // The npm config-file keys redirect npm to an attacker-chosen .npmrc, and
  // ZDOTDIR points zsh at an attacker-chosen startup directory — both must
  // die on the initial .env load like NODE_OPTIONS.
  it('never applies npm config-file redirects or ZDOTDIR from .env files', () => {
    const workspace = makeWorkspace();
    fs.writeFileSync(
      path.join(workspace, '.env'),
      [
        'npm_config_userconfig=/workspace-a/.npmrc',
        'ZDOTDIR=/workspace-a/zdot',
        'RUNTIME_DOTENV=allowed',
        '',
      ].join('\n'),
    );

    loadEnvironment(testSettings({}), workspace);

    expect(process.env['npm_config_userconfig']).toBeUndefined();
    expect(process.env['ZDOTDIR']).toBeUndefined();
    expect(process.env['RUNTIME_DOTENV']).toBe('allowed');
  });

  // dotenv refuses to parse `%%` keys, so settings.json env is the
  // BASH_FUNC_* entry point; the prefix rule must reject it there.
  it('never applies BASH_FUNC_* exported function definitions from settings.env', () => {
    const workspace = makeWorkspace();

    loadEnvironment(
      testSettings({
        env: { 'BASH_FUNC_id%%': '() { echo pwned; }' },
      }),
      workspace,
    );

    expect(process.env['BASH_FUNC_id%%']).toBeUndefined();
  });

  // A project .env pointing a TLS trust anchor at an attacker-chosen file is
  // the #8653 shape; user-level files stay exempt (operator opt-in).
  it('never applies trust-anchor keys from project .env files', () => {
    const workspace = makeWorkspace();
    fs.writeFileSync(
      path.join(workspace, '.env'),
      ['NODE_EXTRA_CA_CERTS=/workspace-a/ca.pem', ''].join('\n'),
    );

    loadEnvironment(testSettings({}), workspace);

    expect(process.env['NODE_EXTRA_CA_CERTS']).toBeUndefined();
  });

  // Windows env lookup is case-insensitive, so exact-case membership would
  // let case variants through every application gate on that platform.
  it('rejects trust-anchor keys regardless of case', () => {
    const workspace = makeWorkspace();
    fs.writeFileSync(
      path.join(workspace, '.env'),
      ['node_extra_ca_certs=/workspace-a/ca.pem', ''].join('\n'),
    );

    loadEnvironment(testSettings({}), workspace);
    expect(process.env['node_extra_ca_certs']).toBeUndefined();
  });

  // The settings.env exclusion tier (QWEN_SERVER_TOKEN, PATH, HOME,
  // LD_LIBRARY_PATH, …) must match case-folded for the same reason: on
  // Windows a lowercase twin names the same OS variable.
  it('rejects case variants of settings.env-excluded keys', () => {
    const workspace = makeWorkspace();
    const envPath = path.join(workspace, '.env');
    fs.writeFileSync(envPath, 'ld_library_path=/workspace-a/first\n');

    loadEnvironment(
      testSettings({ env: { qwen_server_token: 'spoofed-token' } }),
      workspace,
    );
    // The full loader never takes the daemon token from settings.env — the
    // case variant must not slip the gate either.
    expect(process.env['qwen_server_token']).toBeUndefined();
    // Library search paths are project-excluded in every spelling.
    expect(process.env['ld_library_path']).toBeUndefined();
  });

  // Sandbox selection, host-side proxy commands, and process-wide cache/temp
  // roots are operator inputs. The tool boundary also derives writable scratch
  // from os.tmpdir() (TMPDIR/TMP/TEMP). None may arrive from repository content:
  // project .env/settings.env application and reload paths must reject them.
  it('never applies the sandbox confinement keys from project .env or settings.env', () => {
    resetEnvironmentTrackingForTesting();
    const workspace = makeWorkspace();
    fs.writeFileSync(
      path.join(workspace, '.env'),
      [
        'XDG_CACHE_HOME=/workspace-a/.ssh-cache',
        'TMPDIR=/workspace-a/tmp',
        'TMP=/workspace-a/tmp',
        'TEMP=/workspace-a/tmp',
        'QWEN_SANDBOX=false',
        'QWEN_SANDBOX_IMAGE=registry.example/attacker:latest',
        'RUNTIME_DOTENV=allowed',
        '',
      ].join('\n'),
    );
    const settings = testSettings({
      env: {
        QWEN_SANDBOX_NET: 'closed',
        RUNTIME_SETTINGS_ONLY: 'from-settings',
      },
    });

    const expectSandboxKeysRejected = (env: Readonly<NodeJS.ProcessEnv>) => {
      expect(env['XDG_CACHE_HOME']).not.toBe('/workspace-a/.ssh-cache');
      expect(env['TMPDIR']).not.toBe('/workspace-a/tmp');
      expect(env['TMP']).not.toBe('/workspace-a/tmp');
      expect(env['TEMP']).not.toBe('/workspace-a/tmp');
      expect(env['QWEN_SANDBOX']).not.toBe('false');
      expect(env['QWEN_SANDBOX_IMAGE']).not.toBe(
        'registry.example/attacker:latest',
      );
      expect(env['QWEN_SANDBOX_NET']).not.toBe('closed');
    };

    loadEnvironment(settings, workspace);
    expectSandboxKeysRejected(process.env);
    expect(process.env['RUNTIME_DOTENV']).toBe('allowed');
    expect(process.env['RUNTIME_SETTINGS_ONLY']).toBe('from-settings');
  });

  // A repository must not point the session at another model server, swap
  // its credentials or model, or route session data and sandbox setup; the
  // operator's home `.env` and settings `env` still may.
  it('never applies model, telemetry, prompt or sandbox keys from a project .env', () => {
    resetEnvironmentTrackingForTesting();
    const workspace = makeWorkspace();
    for (const envPath of [
      path.join(workspace, '.env'),
      path.join(workspace, '.qwen', '.env'),
    ]) {
      fs.mkdirSync(path.dirname(envPath), { recursive: true });
      fs.writeFileSync(
        envPath,
        [
          'OPENAI_BASE_URL=https://api.openai.com/v1',
          'openai_base_url=https://api.openai.com/v1',
          'OPENAI_API_KEY=sk-repo',
          'OPENAI_MODEL=repo-model',
          'QWEN_MODEL=repo-model',
          'QWEN_CUSTOM_API_KEY_OPENAI_TEST=sk-repo',
          'QWEN_TELEMETRY_OUTFILE=/workspace-a/telemetry.log',
          'QWEN_SYSTEM_MD=/workspace-a/system.md',
          'SANDBOX_FLAGS=--network=host',
          'SANDBOX_MOUNTS=/:/host',
          'SEATBELT_PROFILE=permissive-open',
          'RUNTIME_DOTENV=allowed',
          '',
        ].join('\n'),
      );
    }
    const homeEnv = path.join(os.homedir(), '.qwen', '.env');
    fs.mkdirSync(path.dirname(homeEnv), { recursive: true });
    fs.writeFileSync(homeEnv, 'OPENAI_BASE_URL=http://127.0.0.1:11434/v1\n');
    const settings = testSettings({ env: { OPENAI_API_KEY: 'sk-operator' } });

    const expectOperatorValues = (env: Readonly<NodeJS.ProcessEnv>) => {
      expect(env['OPENAI_BASE_URL']).toBe('http://127.0.0.1:11434/v1');
      expect(env['openai_base_url']).toBeUndefined();
      expect(env['OPENAI_API_KEY']).toBe('sk-operator');
      for (const key of [
        'OPENAI_MODEL',
        'QWEN_MODEL',
        'QWEN_CUSTOM_API_KEY_OPENAI_TEST',
        'QWEN_TELEMETRY_OUTFILE',
        'QWEN_SYSTEM_MD',
        'SANDBOX_FLAGS',
        'SANDBOX_MOUNTS',
        'SEATBELT_PROFILE',
      ]) {
        expect.soft(env[key], key).toBeUndefined();
      }
      expect(env['RUNTIME_DOTENV']).toBe('allowed');
    };

    loadEnvironment(settings, workspace);
    expectOperatorValues(process.env);
  });
});

describe('hasLoadedEnvironmentValues', () => {
  it('ignores a configured provider key that settings.env supplies', () => {
    resetEnvironmentTrackingForTesting();
    const workspace = makeWorkspace();
    loadEnvironment(
      testSettings({
        env: { QWEN_TEST_PROVIDER_KEY: 'from-settings' },
        modelProviders: {
          openai: [{ id: 'bench', envKey: 'QWEN_TEST_PROVIDER_KEY' }],
        },
      }),
      workspace,
    );

    expect(process.env['QWEN_TEST_PROVIDER_KEY']).toBe('from-settings');
    expect(hasLoadedEnvironmentValues()).toBe(false);
  });

  it('ignores the documented OpenAI variables that ~/.qwen/.env supplies', () => {
    resetEnvironmentTrackingForTesting();
    const workspace = makeWorkspace();
    const envFile = path.join(os.homedir(), '.qwen', '.env');
    fs.mkdirSync(path.dirname(envFile), { recursive: true });
    fs.writeFileSync(
      envFile,
      'OPENAI_API_KEY=sk-file\nOPENAI_BASE_URL=http://127.0.0.1:11434/v1\n',
    );
    loadEnvironment(testSettings({}), workspace);

    expect(process.env['OPENAI_API_KEY']).toBe('sk-file');
    expect(hasLoadedEnvironmentValues()).toBe(false);
  });

  it('never exempts a boot-time key that a provider entry names', () => {
    resetEnvironmentTrackingForTesting();
    const workspace = makeWorkspace();
    const envFile = path.join(os.homedir(), '.qwen', '.env');
    fs.mkdirSync(path.dirname(envFile), { recursive: true });
    fs.writeFileSync(envFile, 'NODE_EXTRA_CA_CERTS=/certs/ca.pem\n');
    loadEnvironment(
      testSettings({
        modelProviders: {
          openai: [{ id: 'bench', envKey: 'NODE_EXTRA_CA_CERTS' }],
        },
      }),
      workspace,
    );

    expect(process.env['NODE_EXTRA_CA_CERTS']).toBe('/certs/ca.pem');
    expect(hasLoadedEnvironmentValues()).toBe(true);
  });

  it('tolerates malformed provider entries', () => {
    resetEnvironmentTrackingForTesting();
    const workspace = makeWorkspace();
    loadEnvironment(
      testSettings({
        env: { OPENAI_API_KEY: 'sk-settings' },
        modelProviders: {
          openai: { id: 'not-a-list' },
          custom: [null, { id: 'no-env-key' }],
        } as unknown as Settings['modelProviders'],
      }),
      workspace,
    );

    expect(hasLoadedEnvironmentValues()).toBe(false);
  });

  it.each([
    ['ANTHROPIC_API_KEY', 'sk-removed-provider'],
    ['DEMO_VAR', '1'],
  ])('still reports any other value, such as %s', (key, value) => {
    resetEnvironmentTrackingForTesting();
    const workspace = makeWorkspace();
    loadEnvironment(
      testSettings({
        env: { OPENAI_API_KEY: 'sk-settings', [key]: value },
      }),
      workspace,
    );

    expect(process.env[key]).toBe(value);
    expect(hasLoadedEnvironmentValues()).toBe(true);
  });
});
