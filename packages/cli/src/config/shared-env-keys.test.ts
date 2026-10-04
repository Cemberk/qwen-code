/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, vi } from 'vitest';
import {
  INHERITED_LOADER_ENV_KEYS,
  isHardcodedProjectEnvExclusion,
  isLoaderEnvKey,
  PROJECT_ENV_HARDCODED_EXCLUSIONS,
  reportRejectedLoaderKeys,
  resetLoaderKeyRejectionReportingForTesting,
} from './shared-env-keys.js';

describe('PROJECT_ENV_HARDCODED_EXCLUSIONS', () => {
  // Security guard: a project `.env` must never be able to disable TLS
  // certificate verification. Removing this key would let an untrusted repo
  // silently turn off MITM protection for all API connections.
  it('excludes QWEN_TLS_INSECURE so a project .env cannot disable TLS', () => {
    expect(PROJECT_ENV_HARDCODED_EXCLUSIONS).toContain('QWEN_TLS_INSECURE');
  });

  // isTlsVerificationDisabled() also honors NODE_TLS_REJECT_UNAUTHORIZED=0, and
  // the initial .env load only consults this list, so it must be blocked here
  // too — otherwise a project .env could bypass TLS via the Node-native var.
  it('excludes NODE_TLS_REJECT_UNAUTHORIZED so a project .env cannot disable TLS', () => {
    expect(PROJECT_ENV_HARDCODED_EXCLUSIONS).toContain(
      'NODE_TLS_REJECT_UNAUTHORIZED',
    );
  });

  it('excludes QWEN_CODE_WARNINGS_FILE so a project .env cannot redirect temp warnings', () => {
    expect(PROJECT_ENV_HARDCODED_EXCLUSIONS).toContain(
      'QWEN_CODE_WARNINGS_FILE',
    );
  });

  // These select which file becomes the System / SystemDefaults layer. A
  // project .env pointing them at a repo-shipped file would promote
  // repository content into the highest-precedence settings layer — above
  // the operator's own User settings (e.g. rebranding the Web Shell).
  it('keeps the System settings layer selection operator-owned', () => {
    expect(PROJECT_ENV_HARDCODED_EXCLUSIONS).toContain(
      'QWEN_CODE_SYSTEM_SETTINGS_PATH',
    );
    expect(PROJECT_ENV_HARDCODED_EXCLUSIONS).toContain(
      'QWEN_CODE_SYSTEM_DEFAULTS_PATH',
    );
  });
  // The name-only lock is a deployment policy: a repo-shipped .env, or a
  // mid-session edit of one, must not overwrite the operator's exported =1
  // and silently let the model run workflow scripts again.
  it('keeps the named-workflows-only lock operator-owned', () => {
    expect(PROJECT_ENV_HARDCODED_EXCLUSIONS).toContain(
      'QWEN_CODE_WORKFLOW_NAME_ONLY',
    );
  });

  it('keeps daemon memory scope operator-owned', () => {
    expect(PROJECT_ENV_HARDCODED_EXCLUSIONS).toContain(
      'QWEN_CODE_MEMORY_PROJECT_SCOPE',
    );
  });

  // NODE_EXTRA_CA_CERTS adds a TLS trust anchor — the
  // NODE_TLS_REJECT_UNAUTHORIZED outcome by addition instead of disable.
  it('excludes trust-anchor keys', () => {
    expect(PROJECT_ENV_HARDCODED_EXCLUSIONS).toContain('NODE_EXTRA_CA_CERTS');
  });

  // The compile-cache keys stay settable from project files: a
  // project-configured V8 cache dir is a pinned feature (#7594, tests in
  // both loaders), and Node validates cache entries against the source, so
  // a poisoned/shared dir degrades to cache misses.
  it('keeps compile-cache keys out of the hardcoded exclusions', () => {
    expect(PROJECT_ENV_HARDCODED_EXCLUSIONS).not.toContain(
      'NODE_COMPILE_CACHE',
    );
    expect(PROJECT_ENV_HARDCODED_EXCLUSIONS).not.toContain(
      'QWEN_CODE_PENDING_COMPILE_CACHE',
    );
  });

  // DEV selects dev-harness behavior; only the dev harness stamps it into
  // the launch env, so a project file must not set it.
  it('excludes DEV so a project .env cannot spoof the dev harness', () => {
    expect(PROJECT_ENV_HARDCODED_EXCLUSIONS).toContain('DEV');
  });

  // The non-Node TLS trust-anchor vars reach the same MITM outcome as
  // NODE_EXTRA_CA_CERTS for the curl/git/openssl/python tools a session
  // shells out to; a project .env must not inject an attacker CA.
  it('excludes the non-Node TLS trust-anchor vars', () => {
    for (const key of [
      'SSL_CERT_FILE',
      'SSL_CERT_DIR',
      'CURL_CA_BUNDLE',
      'REQUESTS_CA_BUNDLE',
      'GIT_SSL_CAINFO',
      'GIT_SSL_CAPATH',
      'npm_config_cafile',
      'npm_config_ca',
      'npm_config_strict_ssl',
      'PIP_CERT',
    ]) {
      expect(PROJECT_ENV_HARDCODED_EXCLUSIONS).toContain(key);
    }
  });

  // npm treats underscore/hyphen spellings of a config key as the same key,
  // so the hyphen twin of npm_config_strict_ssl must be excluded too.
  it('excludes both spellings of the npm strict-ssl knob', () => {
    expect(isHardcodedProjectEnvExclusion('npm_config_strict_ssl')).toBe(true);
    expect(isHardcodedProjectEnvExclusion('npm_config_strict-ssl')).toBe(true);
  });

  // CURL_HOME/WGETRC redirect curl/wget at attacker rc files whose proxy/
  // cacert/insecure directives reach the same MITM outcome the TLS-anchor
  // tier blocks — the config-file-redirect class, not a search path.
  it('excludes the curl/wget rc-file redirect vars', () => {
    for (const key of ['CURL_HOME', 'WGETRC']) {
      expect(PROJECT_ENV_HARDCODED_EXCLUSIONS).toContain(key);
    }
  });

  // git executes these on any session git invocation (SSH command, external
  // diff, config-injected core.hooksPath); a project .env setting them is
  // code execution as the daemon user.
  it('excludes the git command-execution env family', () => {
    for (const key of [
      'GIT_SSH_COMMAND',
      'GIT_SSH',
      'GIT_EXEC_PATH',
      'GIT_TEMPLATE_DIR',
      'GIT_ASKPASS',
      'GIT_PROXY_COMMAND',
      'GIT_EDITOR',
      'GIT_EXTERNAL_DIFF',
      'GIT_CONFIG_GLOBAL',
      'GIT_CONFIG_SYSTEM',
      'GIT_CONFIG_COUNT',
      'GIT_CONFIG_PARAMETERS',
    ]) {
      expect(PROJECT_ENV_HARDCODED_EXCLUSIONS).toContain(key);
    }
  });

  // node-gyp interpreter selection runs the pointed-at file as the build
  // Python; a project .env must not redirect it.
  it('excludes the node-gyp interpreter-selection and git-binary vars', () => {
    for (const key of [
      'NODE_GYP_FORCE_PYTHON',
      'npm_config_python',
      'PYTHON',
      'npm_config_git',
    ]) {
      expect(PROJECT_ENV_HARDCODED_EXCLUSIONS).toContain(key);
    }
  });

  // PIP_CONFIG_FILE redirects all of pip's configuration (index-url /
  // trusted-host / proxy / cert) at an attacker file; SSH_ASKPASS is the
  // askpass fallback git/ssh execute on an auth challenge; less executes
  // LESSOPEN (and LESSCLOSE when the preprocessor ran) as an input
  // preprocessor. Each is code execution or credential diversion from a
  // project .env.
  it('excludes pip config, ssh askpass, and less preprocessor redirects', () => {
    for (const key of [
      'PIP_CONFIG_FILE',
      'SSH_ASKPASS',
      'LESSOPEN',
      'LESSCLOSE',
    ]) {
      expect(PROJECT_ENV_HARDCODED_EXCLUSIONS).toContain(key);
    }
  });

  // SSH_ASKPASS_REQUIRE only selects *when* the askpass program runs; with
  // SSH_ASKPASS project-blocked it has nothing to execute, so it stays
  // settable from project files.
  it('keeps SSH_ASKPASS_REQUIRE out of the hardcoded exclusions', () => {
    expect(PROJECT_ENV_HARDCODED_EXCLUSIONS).not.toContain(
      'SSH_ASKPASS_REQUIRE',
    );
    expect(isHardcodedProjectEnvExclusion('SSH_ASKPASS_REQUIRE')).toBe(false);
  });

  // git executes GIT_SEQUENCE_EDITOR for the `git rebase -i` todo list like
  // GIT_EDITOR, and merges `$XDG_CONFIG_HOME/git/config` with `~/.gitconfig`
  // — a config-discovery redirect that bypasses the GIT_CONFIG_* blocks.
  it('excludes the git sequence editor and XDG config redirect', () => {
    for (const key of ['GIT_SEQUENCE_EDITOR', 'XDG_CONFIG_HOME']) {
      expect(PROJECT_ENV_HARDCODED_EXCLUSIONS).toContain(key);
    }
  });

  // git's editor fallback chain ($VISUAL/$EDITOR) and the CLI's own
  // useLaunchEditor spawn these like the blocked GIT_EDITOR; CPython executes
  // PYTHONSTARTUP at interactive startup; the CLI execs $BROWSER via
  // openBrowserSecurely. Each is an exec redirect from a project .env.
  it('excludes the editor, startup, and browser exec-redirect keys', () => {
    for (const key of ['VISUAL', 'EDITOR', 'PYTHONSTARTUP', 'BROWSER']) {
      expect(PROJECT_ENV_HARDCODED_EXCLUSIONS).toContain(key);
    }
  });
});

describe('isHardcodedProjectEnvExclusion', () => {
  // Windows env lookup is case-insensitive; exact-case membership would let
  // `node_extra_ca_certs` slip past every application gate.
  it('matches the hardcoded exclusions case-insensitively', () => {
    expect(isHardcodedProjectEnvExclusion('QWEN_HOME')).toBe(true);
    expect(isHardcodedProjectEnvExclusion('qwen_home')).toBe(true);
    expect(isHardcodedProjectEnvExclusion('node_extra_ca_certs')).toBe(true);
    expect(isHardcodedProjectEnvExclusion('Node_Extra_Ca_Certs')).toBe(true);
    expect(isHardcodedProjectEnvExclusion('DEV')).toBe(true);
    expect(isHardcodedProjectEnvExclusion('dev')).toBe(true);
    expect(isHardcodedProjectEnvExclusion('QWEN_SERVER_TOKEN')).toBe(false);
    expect(isHardcodedProjectEnvExclusion('NODE_OPTIONS')).toBe(false);
  });

  it('matches the newly added hardcoded exclusions case-insensitively', () => {
    expect(isHardcodedProjectEnvExclusion('SSL_CERT_FILE')).toBe(true);
    expect(isHardcodedProjectEnvExclusion('ssl_cert_file')).toBe(true);
    expect(isHardcodedProjectEnvExclusion('GIT_SSH_COMMAND')).toBe(true);
    expect(isHardcodedProjectEnvExclusion('git_ssh_command')).toBe(true);
    expect(isHardcodedProjectEnvExclusion('GIT_SSH')).toBe(true);
    expect(isHardcodedProjectEnvExclusion('git_ssh')).toBe(true);
    expect(isHardcodedProjectEnvExclusion('GIT_CONFIG_PARAMETERS')).toBe(true);
    expect(isHardcodedProjectEnvExclusion('git_config_parameters')).toBe(true);
    expect(isHardcodedProjectEnvExclusion('PYTHON')).toBe(true);
    expect(isHardcodedProjectEnvExclusion('python')).toBe(true);
    expect(isHardcodedProjectEnvExclusion('npm_config_python')).toBe(true);
    expect(isHardcodedProjectEnvExclusion('GIT_EXEC_PATH')).toBe(true);
    expect(isHardcodedProjectEnvExclusion('git_template_dir')).toBe(true);
    expect(isHardcodedProjectEnvExclusion('git_askpass')).toBe(true);
    expect(isHardcodedProjectEnvExclusion('GIT_PROXY_COMMAND')).toBe(true);
    expect(isHardcodedProjectEnvExclusion('git_editor')).toBe(true);
    expect(isHardcodedProjectEnvExclusion('GIT_SSL_CAPATH')).toBe(true);
    expect(isHardcodedProjectEnvExclusion('pip_cert')).toBe(true);
    expect(isHardcodedProjectEnvExclusion('CURL_HOME')).toBe(true);
    expect(isHardcodedProjectEnvExclusion('wgetrc')).toBe(true);
    expect(isHardcodedProjectEnvExclusion('pip_config_file')).toBe(true);
    expect(isHardcodedProjectEnvExclusion('SSH_ASKPASS')).toBe(true);
    expect(isHardcodedProjectEnvExclusion('ssh_askpass')).toBe(true);
    expect(isHardcodedProjectEnvExclusion('LESSOPEN')).toBe(true);
    expect(isHardcodedProjectEnvExclusion('lessclose')).toBe(true);
    expect(isHardcodedProjectEnvExclusion('GIT_SEQUENCE_EDITOR')).toBe(true);
    expect(isHardcodedProjectEnvExclusion('git_sequence_editor')).toBe(true);
    expect(isHardcodedProjectEnvExclusion('XDG_CONFIG_HOME')).toBe(true);
    expect(isHardcodedProjectEnvExclusion('xdg_config_home')).toBe(true);
    expect(isHardcodedProjectEnvExclusion('VISUAL')).toBe(true);
    expect(isHardcodedProjectEnvExclusion('visual')).toBe(true);
    expect(isHardcodedProjectEnvExclusion('EDITOR')).toBe(true);
    expect(isHardcodedProjectEnvExclusion('editor')).toBe(true);
    expect(isHardcodedProjectEnvExclusion('PYTHONSTARTUP')).toBe(true);
    expect(isHardcodedProjectEnvExclusion('pythonstartup')).toBe(true);
    expect(isHardcodedProjectEnvExclusion('BROWSER')).toBe(true);
    expect(isHardcodedProjectEnvExclusion('browser')).toBe(true);
    expect(isHardcodedProjectEnvExclusion('QWEN_SANDBOX_NET')).toBe(true);
    expect(isHardcodedProjectEnvExclusion('qwen_sandbox_net')).toBe(true);
    expect(isHardcodedProjectEnvExclusion('QWEN_SANDBOX')).toBe(true);
    expect(isHardcodedProjectEnvExclusion('qwen_sandbox')).toBe(true);
    expect(isHardcodedProjectEnvExclusion('QWEN_SANDBOX_IMAGE')).toBe(true);
    expect(isHardcodedProjectEnvExclusion('qwen_sandbox_image')).toBe(true);
    expect(isHardcodedProjectEnvExclusion('XDG_CACHE_HOME')).toBe(true);
    expect(isHardcodedProjectEnvExclusion('xdg_cache_home')).toBe(true);
    expect(isHardcodedProjectEnvExclusion('TMPDIR')).toBe(true);
    expect(isHardcodedProjectEnvExclusion('tmpdir')).toBe(true);
    expect(isHardcodedProjectEnvExclusion('TMP')).toBe(true);
    expect(isHardcodedProjectEnvExclusion('TEMP')).toBe(true);
  });

  // Numbered GIT_CONFIG_KEY_<n>/GIT_CONFIG_VALUE_<n> pairs are an unbounded
  // index, matched by numeric suffix rather than literal membership.
  it('matches numbered GIT_CONFIG_KEY_/VALUE_ pairs by numeric suffix', () => {
    expect(isHardcodedProjectEnvExclusion('GIT_CONFIG_KEY_0')).toBe(true);
    expect(isHardcodedProjectEnvExclusion('GIT_CONFIG_VALUE_0')).toBe(true);
    expect(isHardcodedProjectEnvExclusion('git_config_key_12')).toBe(true);
    expect(isHardcodedProjectEnvExclusion('GIT_CONFIG_VALUE_7')).toBe(true);
    // Git only reads decimal-numbered pairs (GIT_CONFIG_KEY_%d), so keys
    // with empty, nonnumeric, or trailing-garbage suffixes are
    // project-defined variables Git never consumes and must stay settable.
    expect(isHardcodedProjectEnvExclusion('GIT_CONFIG_KEY_')).toBe(false);
    expect(isHardcodedProjectEnvExclusion('GIT_CONFIG_KEY_CACHE')).toBe(false);
    expect(isHardcodedProjectEnvExclusion('git_config_value_cache')).toBe(
      false,
    );
    expect(isHardcodedProjectEnvExclusion('GIT_CONFIG_KEY_0X')).toBe(false);
    // A key that merely starts with GIT_CONFIG but is not a KEY_/VALUE_ pair
    // (and not a listed literal) is not excluded: GIT_CONFIG_NOSYSTEM only
    // skips the system gitconfig read and injects nothing.
    expect(isHardcodedProjectEnvExclusion('GIT_CONFIG_NOSYSTEM')).toBe(false);
  });
});

describe('isLoaderEnvKey', () => {
  // npm's config reader matches /^npm_config_/i and then replaces
  // non-leading underscores with hyphens, so the hyphen spelling
  // npm_config_node-options maps onto the same node-options config and is
  // injected as NODE_OPTIONS into every `npm run` lifecycle script. Both
  // spellings (in every case variant) must count as the same loader key.
  it('matches npm underscore/hyphen spelling variants case-insensitively', () => {
    expect(isLoaderEnvKey('npm_config_node_options')).toBe(true);
    expect(isLoaderEnvKey('npm_config_node-options')).toBe(true);
    expect(isLoaderEnvKey('NPM_CONFIG_NODE-OPTIONS')).toBe(true);
    expect(isLoaderEnvKey('Node_Options')).toBe(true);
    expect(isLoaderEnvKey('ld_preload')).toBe(true);
    expect(isLoaderEnvKey('npm_config_registry')).toBe(false);
    expect(isLoaderEnvKey('PATH')).toBe(false);
    expect(isLoaderEnvKey('NODE_OPTIONS_EXTRA')).toBe(false);
  });

  // The npm config-file keys redirect npm to an attacker-chosen .npmrc —
  // the node-options hijack one level up. Note the underscore/hyphen
  // equivalence only covers npm's real config names: `userconfig` has no
  // hyphen, so npm_config_user-config maps to a different (harmless) key.
  it('matches the npm config-file redirect keys', () => {
    expect(isLoaderEnvKey('npm_config_userconfig')).toBe(true);
    expect(isLoaderEnvKey('npm_config_globalconfig')).toBe(true);
    expect(isLoaderEnvKey('npm_config_script_shell')).toBe(true);
    expect(isLoaderEnvKey('npm_config_prefix')).toBe(true);
    expect(isLoaderEnvKey('NPM_CONFIG_USERCONFIG')).toBe(true);
    expect(isLoaderEnvKey('npm_config_script-shell')).toBe(true);
    expect(isLoaderEnvKey('npm_config_user-config')).toBe(false);
  });

  // bash imports exported function definitions from the environment even in
  // non-interactive `bash -c`; the function name is embedded in the key, so
  // this is a prefix rule rather than a listed literal.
  it('matches BASH_FUNC_* exported function definitions by prefix', () => {
    expect(isLoaderEnvKey('BASH_FUNC_id%%')).toBe(true);
    expect(isLoaderEnvKey('BASH_FUNC_anything()')).toBe(true);
    expect(isLoaderEnvKey('bash_func_id%%')).toBe(true);
  });

  // Pure code-injection vectors with no benign cross-workspace inheritance:
  // OPENSSL_CONF (dlopen an engine at crypto init), NODE_REPL_EXTERNAL_MODULE
  // (require at REPL start), and the npm node-gyp/init script redirects.
  it('matches the pure-injection loader keys added for the #8653 follow-up', () => {
    expect(isLoaderEnvKey('OPENSSL_CONF')).toBe(true);
    expect(isLoaderEnvKey('openssl_conf')).toBe(true);
    expect(isLoaderEnvKey('NODE_REPL_EXTERNAL_MODULE')).toBe(true);
    expect(isLoaderEnvKey('npm_config_node_gyp')).toBe(true);
    expect(isLoaderEnvKey('npm_config_node-gyp')).toBe(true);
    expect(isLoaderEnvKey('npm_config_init_module')).toBe(true);
    expect(isLoaderEnvKey('npm_config_init-module')).toBe(true);
  });

  // The interpreter-selection vars stay in the reject-only hardcoded tier
  // (they have a legitimate operator-shell use), NOT the scrubbed loader set.
  it('does not scrub interpreter-selection or TLS-anchor keys', () => {
    expect(isLoaderEnvKey('PYTHON')).toBe(false);
    expect(isLoaderEnvKey('npm_config_python')).toBe(false);
    expect(isLoaderEnvKey('NODE_GYP_FORCE_PYTHON')).toBe(false);
    expect(isLoaderEnvKey('SSL_CERT_FILE')).toBe(false);
    expect(isLoaderEnvKey('GIT_SSH_COMMAND')).toBe(false);
    expect(isLoaderEnvKey('GIT_EXEC_PATH')).toBe(false);
    expect(isLoaderEnvKey('GIT_TEMPLATE_DIR')).toBe(false);
    expect(isLoaderEnvKey('npm_config_cafile')).toBe(false);
    expect(isLoaderEnvKey('PIP_CERT')).toBe(false);
    expect(isLoaderEnvKey('CURL_HOME')).toBe(false);
    expect(isLoaderEnvKey('WGETRC')).toBe(false);
    expect(isLoaderEnvKey('PIP_CONFIG_FILE')).toBe(false);
    expect(isLoaderEnvKey('SSH_ASKPASS')).toBe(false);
    expect(isLoaderEnvKey('LESSOPEN')).toBe(false);
    expect(isLoaderEnvKey('LESSCLOSE')).toBe(false);
    expect(isLoaderEnvKey('GIT_SEQUENCE_EDITOR')).toBe(false);
    expect(isLoaderEnvKey('XDG_CONFIG_HOME')).toBe(false);
    expect(isLoaderEnvKey('VISUAL')).toBe(false);
    expect(isLoaderEnvKey('EDITOR')).toBe(false);
    expect(isLoaderEnvKey('PYTHONSTARTUP')).toBe(false);
    expect(isLoaderEnvKey('BROWSER')).toBe(false);
    expect(isLoaderEnvKey('QWEN_CDP_MCP_COMMAND')).toBe(false);
    expect(isLoaderEnvKey('QWEN_SERVE_CDP_TUNNEL_OVER_WS')).toBe(false);
  });

  // Library search paths and the interactive-sh-only ENV are deliberately
  // reload-only: scrubbing them breaks mainstream toolchains.
  it('does not match search paths or the ENV convention', () => {
    expect(isLoaderEnvKey('LD_LIBRARY_PATH')).toBe(false);
    expect(isLoaderEnvKey('DYLD_LIBRARY_PATH')).toBe(false);
    expect(isLoaderEnvKey('ENV')).toBe(false);
    expect(isLoaderEnvKey('env')).toBe(false);
  });
});

describe('INHERITED_LOADER_ENV_KEYS', () => {
  it('pins the exact loader-key list so silent edits fail', () => {
    expect([...INHERITED_LOADER_ENV_KEYS].sort()).toEqual([
      'BASH_ENV',
      'DYLD_INSERT_LIBRARIES',
      'LD_AUDIT',
      'LD_PRELOAD',
      'NODE_OPTIONS',
      'NODE_PATH',
      'NODE_REPL_EXTERNAL_MODULE',
      'OPENSSL_CONF',
      'ZDOTDIR',
      'npm_config_globalconfig',
      'npm_config_init_module',
      'npm_config_node_gyp',
      'npm_config_node_options',
      'npm_config_prefix',
      'npm_config_script_shell',
      'npm_config_userconfig',
    ]);
  });
});

describe('reportRejectedLoaderKeys', () => {
  it('returns every rejected key while warning only once per source and key', () => {
    resetLoaderKeyRejectionReportingForTesting();
    const writes: string[] = [];
    const write = vi
      .spyOn(process.stderr, 'write')
      .mockImplementation((chunk) => {
        writes.push(String(chunk));
        return true;
      });

    try {
      expect(
        reportRejectedLoaderKeys('/workspace/.env', [
          'NODE_OPTIONS',
          'PATH',
          'LD_PRELOAD',
        ]),
      ).toEqual(['NODE_OPTIONS', 'LD_PRELOAD']);
      expect(
        reportRejectedLoaderKeys('/workspace/.env', [
          'NODE_OPTIONS',
          'DYLD_INSERT_LIBRARIES',
        ]),
      ).toEqual(['NODE_OPTIONS', 'DYLD_INSERT_LIBRARIES']);
    } finally {
      write.mockRestore();
    }

    expect(writes.join('').match(/NODE_OPTIONS/gu)).toHaveLength(1);
    expect(writes.join('')).toContain('LD_PRELOAD');
    expect(writes.join('')).toContain('DYLD_INSERT_LIBRARIES');
  });

  // Without the reset the dedup map survives across boots/reloads in one
  // process and silently swallows a repeat rejection for the same source.
  it('warns again for an already-reported source and key after the reset', () => {
    resetLoaderKeyRejectionReportingForTesting();
    const writes: string[] = [];
    const write = vi
      .spyOn(process.stderr, 'write')
      .mockImplementation((chunk) => {
        writes.push(String(chunk));
        return true;
      });

    try {
      reportRejectedLoaderKeys('/workspace/.env', ['NODE_OPTIONS']);
      reportRejectedLoaderKeys('/workspace/.env', ['NODE_OPTIONS']);
      resetLoaderKeyRejectionReportingForTesting();
      reportRejectedLoaderKeys('/workspace/.env', ['NODE_OPTIONS']);
    } finally {
      write.mockRestore();
    }

    expect(writes).toHaveLength(2);
  });
});
