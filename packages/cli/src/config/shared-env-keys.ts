/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */
import { writeStderrLineSafe } from '../utils/stdioHelpers.js';
import { PRIVATE_RELAUNCH_ENV_PROVENANCE } from '../utils/env-provenance.js';
export { PRIVATE_RELAUNCH_ENV_PROVENANCE };

export const DEFAULT_EXCLUDED_ENV_VARS = ['DEBUG', 'DEBUG_MODE'];

export const ENV_CORRUPTED_PATH = 'QWEN_CODE_SETTINGS_CORRUPTED_PATH';
export const ENV_WAS_RECOVERED = 'QWEN_CODE_SETTINGS_WAS_RECOVERED';

// QWEN_HOME and QWEN_RUNTIME_DIR control where global state (settings, OAuth
// credentials, installation IDs, etc.) is written. A project `.env` must never
// redirect these — that would split global state between the real home and a
// project-controlled directory. Always excluded from project .env files,
// regardless of user-configurable `advanced.excludedEnvVars`.
export const PROJECT_ENV_HARDCODED_EXCLUSIONS = [
  'QWEN_HOME',
  'QWEN_RUNTIME_DIR',
  // Project reloads must not replace or relabel an operator container requirement.
  'QWEN_AGENT_EXECUTION_BACKEND',
  'QWEN_CODE_MCP_APPROVALS_PATH',
  'QWEN_CODE_TRUSTED_FOLDERS_PATH',
  // These two select which file becomes the System / SystemDefaults settings
  // layer. A project `.env` must never redirect them: the System layer
  // outranks the operator's own User settings, so a repository could promote
  // its own file into the highest-precedence layer — renaming the product in
  // every connected browser via `ui.brand`, among other operator-only
  // settings that read only the operator scopes.
  'QWEN_CODE_SYSTEM_SETTINGS_PATH',
  'QWEN_CODE_SYSTEM_DEFAULTS_PATH',
  // This points to a host temp file that carries build warnings. A project
  // `.env` must not redirect it to an arbitrary file to read or delete.
  'QWEN_CODE_WARNINGS_FILE',
  ENV_CORRUPTED_PATH,
  ENV_WAS_RECOVERED,
  // Project memory routing is frozen process-wide before workspace env files
  // load, so only the operator's launch environment or CLI flag may set it.
  'QWEN_CODE_MEMORY_PROJECT_SCOPE',
  // Workflow execution is an explicit user opt-in. A project must not enable
  // it or override a user opt-in through settings.env or a project .env.
  'QWEN_CODE_ENABLE_WORKFLOWS',
  'QWEN_CODE_DISABLE_WORKFLOWS',
  // The name-only lock is a deployment policy. A project that wants it sets
  // tools.workflowNameOnly, which a workspace may only turn on; a project
  // .env must not be able to unset the operator's exported value.
  'QWEN_CODE_WORKFLOW_NAME_ONLY',
  // QWEN_TLS_INSECURE (and NODE_TLS_REJECT_UNAUTHORIZED, which it mirrors)
  // disable TLS certificate verification for all outbound API connections. A
  // project `.env` must never enable either — that would let an untrusted repo
  // silently turn off MITM protection. Opt-in stays with the user via the
  // `--insecure` flag, the shell environment, or a home `.env`. The initial
  // `.env` load only consults this list, so both keys must be here (not just
  // RELOAD_EXCLUDED_KEYS, which only applies on reload).
  'QWEN_TLS_INSECURE',
  'NODE_TLS_REJECT_UNAUTHORIZED',
  // NODE_EXTRA_CA_CERTS reaches the same outcome by adding a TLS trust
  // anchor instead of disabling verification.
  'NODE_EXTRA_CA_CERTS',
  // The non-Node TLS trust-anchor vars reach the SAME MITM outcome for the
  // curl/git/openssl/python tools a session subprocess routinely shells out
  // to: they are honored unconditionally as a CA bundle/dir, and npm/pip
  // honor their own equivalents (npm_config_cafile / npm_config_ca / PIP_CERT
  // as attacker CAs, npm_config_strict_ssl=false disables verification with
  // no CA at all; GIT_SSL_CAPATH is git's directory-form twin of
  // GIT_SSL_CAINFO). A project `.env` pointing any of them at an attacker CA
  // lets an untrusted repo silently intercept token-bearing traffic
  // (git/npm/pip fetches) for every workspace's sessions — the exact outcome
  // NODE_EXTRA_CA_CERTS is blocked for. Like NODE_EXTRA_CA_CERTS these stay
  // reject-from-project-`.env` only: a value the operator set in their own
  // login shell or home `.env` is their trusted choice and is preserved.
  'SSL_CERT_FILE',
  'SSL_CERT_DIR',
  'CURL_CA_BUNDLE',
  'REQUESTS_CA_BUNDLE',
  'GIT_SSL_CAINFO',
  'GIT_SSL_CAPATH',
  'npm_config_cafile',
  'npm_config_ca',
  // npm treats underscore/hyphen spellings of a config key as the same key
  // (see canonicalLoaderKey below), so both forms of strict-ssl are listed.
  'npm_config_strict_ssl',
  'npm_config_strict-ssl',
  'PIP_CERT',
  // CURL_HOME / WGETRC redirect curl/wget at attacker rc files
  // (`$CURL_HOME/.curlrc`, the file WGETRC names) whose `proxy`, `cacert`, or
  // `insecure` directives intercept or downgrade the same token-bearing
  // traffic — the config-file-redirect class this list already blocks for npm
  // (`npm_config_userconfig`), git (`GIT_CONFIG_GLOBAL`), and OpenSSL
  // (`OPENSSL_CONF`).
  'CURL_HOME',
  'WGETRC',
  // PIP_CONFIG_FILE redirects all of pip's configuration at the file it
  // names — index-url, trusted-host, proxy, cert, or client-cert in an
  // attacker file sends session pip traffic or credentials to attacker
  // infrastructure — the same config-file-redirect class as
  // npm_config_userconfig and GIT_CONFIG_GLOBAL.
  'PIP_CONFIG_FILE',
  // The git command-execution env family: git runs these on any invocation in
  // a session subprocess. GIT_SSH_COMMAND / GIT_SSH (its documented legacy
  // counterpart, still exec'd by git for SSH transports) / GIT_EXTERNAL_DIFF
  // execute a command directly; GIT_ASKPASS / GIT_PROXY_COMMAND / GIT_EDITOR
  // / GIT_SEQUENCE_EDITOR are exec'd conditionally (credential prompt, proxy
  // transport, editor, `git rebase -i` todo-list edit);
  // GIT_EXEC_PATH redirects git's own remote-helper/subcommand lookup at an
  // attacker directory and GIT_TEMPLATE_DIR plants hooks that run after the
  // next clone/init; GIT_CONFIG_* injects arbitrary config (`core.hooksPath`,
  // `core.fsmonitor`, …) that turns a routine `git commit` into
  // attacker-code execution as the CLI user — GIT_CONFIG_PARAMETERS
  // carries the same injection as one quoted string, so it is blocked with
  // GIT_CONFIG_COUNT and the numbered pairs. core/utils/git-branches.ts
  // scrubs the config-injection subset from the repo's own git invocations,
  // so a project `.env` setting this family contradicts that model. Numbered
  // GIT_CONFIG_KEY_<n>/GIT_CONFIG_VALUE_<n> pairs are matched by numeric
  // suffix below.
  'GIT_SSH_COMMAND',
  'GIT_SSH',
  'GIT_EXEC_PATH',
  'GIT_TEMPLATE_DIR',
  'GIT_ASKPASS',
  'GIT_PROXY_COMMAND',
  'GIT_EDITOR',
  'GIT_SEQUENCE_EDITOR',
  'GIT_EXTERNAL_DIFF',
  'GIT_CONFIG_GLOBAL',
  'GIT_CONFIG_SYSTEM',
  // git merges `$XDG_CONFIG_HOME/git/config` with `~/.gitconfig`, so a
  // project `.env` redirecting XDG_CONFIG_HOME plants the same config
  // injection (`core.hooksPath`, …) the GIT_CONFIG_* keys block — without
  // naming a git config file at all.
  'XDG_CONFIG_HOME',
  'GIT_CONFIG_COUNT',
  'GIT_CONFIG_PARAMETERS',
  // Whole-CLI sandbox selection and network controls remain operator inputs.
  // QWEN_SANDBOX decides whether a legacy container/Seatbelt boundary runs and
  // QWEN_SANDBOX_IMAGE selects its image. The tool execution sandbox rejects these
  // legacy controls when its policy is active. A project `.env` or settings.env
  // must not select either boundary or create a mixed-boundary startup failure.
  // The operator's launch environment or a home `.env` remains trusted.
  'QWEN_SANDBOX',
  'QWEN_SANDBOX_IMAGE',
  'QWEN_SANDBOX_NET',
  // The container/Seatbelt launcher reads these to add docker flags, host
  // mounts, published ports, container env, the Seatbelt profile, and to build
  // an image from source — the same operator-only boundary as QWEN_SANDBOX.
  'SANDBOX_FLAGS',
  'SANDBOX_MOUNTS',
  'SANDBOX_PORTS',
  'SANDBOX_ENV',
  'SANDBOX_SET_UID_GID',
  'SEATBELT_PROFILE',
  'BUILD_SANDBOX',
  // Runtime markers come from the launcher, never from configuration files.
  // They also belong to the all-scope provenance gate below.
  'SANDBOX',
  'SANDBOX_ENFORCEMENT',
  // Tool-confined execution creates and binds writable scratch beneath
  // os.tmpdir(), whose POSIX fallback order reads TMPDIR/TMP/TEMP. Cache and
  // temporary roots are process-wide host locations, so repository content
  // cannot redirect them before the runtime constructs its boundary. Values
  // from the launch environment or a home `.env` remain operator-controlled.
  'XDG_CACHE_HOME',
  'TMPDIR',
  'TMP',
  'TEMP',
  // git falls back to executing $SSH_ASKPASS for passphrase prompts (its
  // askpass order is GIT_ASKPASS > core.askPass > SSH_ASKPASS, and ssh runs
  // it whenever SSH_ASKPASS_REQUIRE=force or no terminal is available), so a
  // project `.env` pointing it at an attacker script is code execution on
  // any git/ssh auth challenge. SSH_ASKPASS_REQUIRE stays settable: it only
  // selects *when* the askpass program runs, and with SSH_ASKPASS
  // project-blocked it has no program to execute.
  'SSH_ASKPASS',
  // less executes $LESSOPEN as an input preprocessor on every file a session
  // views (and $LESSCLOSE on exit whenever the preprocessor ran), so a
  // project `.env` setting either is attacker command execution the first
  // time a session runs `less`.
  'LESSOPEN',
  'LESSCLOSE',
  // node-gyp interpreter selection: node-gyp's find-python.js executes
  // NODE_GYP_FORCE_PYTHON / npm_config_python / PYTHON as the build Python,
  // so a project `.env` pointing them at an attacker script is code execution
  // during any native-addon `npm install` in another workspace's session.
  // Unlike the pure-injection loader keys these have a legitimate
  // operator-shell use (selecting a real interpreter), so they are
  // reject-from-project-`.env` only, not scrubbed from the launch env.
  'NODE_GYP_FORCE_PYTHON',
  'npm_config_python',
  'PYTHON',
  // CPython executes $PYTHONSTARTUP at interactive startup — the Python
  // analogue of NODE_REPL_EXTERNAL_MODULE. It stays reject-only (like
  // PYTHON) because operators legitimately set it in their own shells.
  'PYTHONSTARTUP',
  // git's documented editor fallback chain (GIT_EDITOR → core.editor →
  // $VISUAL → $EDITOR) executes these exactly like the blocked GIT_EDITOR,
  // and the CLI's own useLaunchEditor spawns them from ordinary interactive
  // flows.
  'VISUAL',
  'EDITOR',
  // npm runs `$npm_config_git` as the git binary for install-from-git and
  // similar flows, so a project `.env` pointing it at an attacker script is
  // the same exec redirect as the interpreter keys above.
  'npm_config_git',
  // The CLI itself execs $BROWSER via openBrowserSecurely (core/utils/
  // secure-browser-launcher.ts) before any CI/DISPLAY gate, so a project
  // `.env` pointing it at an attacker script runs on any browser-launch
  // flow.
  'BROWSER',
  // DEV selects dev-harness behavior; only the dev harness (scripts/dev.js)
  // stamps it into the launch env, so a project file must not set it.
  'DEV',
  PRIVATE_RELAUNCH_ENV_PROVENANCE,
];

// Windows env lookup is case-insensitive, so exact-case membership would let
// case variants (e.g. `node_extra_ca_certs`) slip past every application
// gate. All gates go through this predicate instead of Array.includes on the
// list above, mirroring the loader-key predicate.
const HARDCODED_PROJECT_ENV_EXCLUSIONS: ReadonlySet<string> = new Set(
  PROJECT_ENV_HARDCODED_EXCLUSIONS.map((key) => key.toLowerCase()),
);

// Command-scope git config injection uses numbered GIT_CONFIG_KEY_<n> /
// GIT_CONFIG_VALUE_<n> pairs read up to GIT_CONFIG_COUNT — an unbounded index,
// so match them by numeric suffix rather than listing literals. Git only
// reads decimal-numbered pairs (GIT_CONFIG_KEY_%d up to the count), so a key
// with an empty or nonnumeric suffix (e.g. GIT_CONFIG_KEY_CACHE) is a
// project-defined variable Git never consumes and it must stay settable.
// (core/utils/git-branches.ts scrubs the same family by bare prefix; that
// over-scrub is harmless, but a denylist rejection freezes the key, so this
// gate matches precisely.) GIT_CONFIG_COUNT alone already neutralizes the
// pairs, but rejecting the pairs too matches the repo's existing git scrub.
const HARDCODED_PROJECT_ENV_EXCLUSION_PATTERNS = [
  /^git_config_key_\d+$/u,
  /^git_config_value_\d+$/u,
] as const;

export function isHardcodedProjectEnvExclusion(key: string): boolean {
  const lowerKey = key.toLowerCase();
  return (
    HARDCODED_PROJECT_ENV_EXCLUSIONS.has(lowerKey) ||
    HARDCODED_PROJECT_ENV_EXCLUSION_PATTERNS.some((pattern) =>
      pattern.test(lowerKey),
    )
  );
}

// Variables that pick the model server, its credentials and model, or that
// route session data (telemetry, debug log, system prompt dump, memory) and
// commands (Mermaid renderer). A project `.env` and a workspace settings `env`
// block must never set them: a repository must not redirect the conversation
// or run its own renderer. Unlike the hardcoded tier above, the operator's own
// User/System settings `env` may still set them — `/auth` stores the API key
// there under a QWEN_CUSTOM_API_KEY_* name.
const PROJECT_ENV_OPERATOR_ONLY_KEYS = [
  'QWEN_MODEL',
  'QWEN_DEBUG_LOG_FILE',
  'QWEN_SYSTEM_MD',
  'QWEN_SYSTEM_IDENTITY_MD',
  'QWEN_WRITE_SYSTEM_MD',
  'QWEN_CODE_MEMORY_BASE_DIR',
  'QWEN_CODE_MEMORY_LOCAL',
  'QWEN_CODE_MEMORY_TEAM',
  'QWEN_CODE_MERMAID_MMD_CLI',
  'QWEN_CODE_MERMAID_ALLOW_LOCAL_RENDERERS',
  'QWEN_CODE_SUPPRESS_YOLO_WARNING',
] as const;

const PROJECT_ENV_OPERATOR_ONLY_PREFIXES = [
  'openai_',
  'qwen_custom_api_key_',
  'qwen_telemetry_',
] as const;

const PROJECT_ENV_OPERATOR_ONLY: ReadonlySet<string> = new Set(
  PROJECT_ENV_OPERATOR_ONLY_KEYS.map((key) => key.toLowerCase()),
);

export function isOperatorOnlyEnvKey(key: string): boolean {
  const lowerKey = key.toLowerCase();
  return (
    PROJECT_ENV_OPERATOR_ONLY.has(lowerKey) ||
    PROJECT_ENV_OPERATOR_ONLY_PREFIXES.some((prefix) =>
      lowerKey.startsWith(prefix),
    )
  );
}

// Launcher→child provenance markers. These are fixed constants, so a
// home-scoped `.env` could forge one — and home-scoped files are deliberately
// exempt from the hardcoded project exclusions above. No env file at any
// scope may set them: the legitimate carrier is the spawner's child env.
// Sandbox markers stay inherited.
const PRIVATE_PROVENANCE_ENV_KEYS: ReadonlySet<string> = new Set([
  PRIVATE_RELAUNCH_ENV_PROVENANCE.toLowerCase(),
  'sandbox',
  'sandbox_enforcement',
]);

export function isPrivateProvenanceEnvKey(key: string): boolean {
  return PRIVATE_PROVENANCE_ENV_KEYS.has(key.toLowerCase());
}

export const HOME_ENV_BOOTSTRAP_KEYS = [
  'QWEN_HOME',
  'QWEN_RUNTIME_DIR',
  'QWEN_CODE_MCP_APPROVALS_PATH',
  'QWEN_CODE_TRUSTED_FOLDERS_PATH',
] as const;

// Loader-affecting variables (code-injection vectors for spawned
// interpreters). This is the loader subset of RELOAD_EXCLUDED_KEYS
// (environment.ts), which guards .env/settings.env application.
//
// Scope is deliberate: code-injection vectors only — variables that make a
// spawned interpreter or OS loader execute an attacker-chosen file.
// LD_LIBRARY_PATH/DYLD_LIBRARY_PATH (library *search* paths) and ENV
// (sourced only by interactive sh, while the shell tool spawns
// non-interactive `bash -c`) are not here: scrubbing them breaks mainstream
// toolchains (conda/CUDA library dirs, `ENV=production` app conventions)
// for every session subprocess, and their hijack residue is the same class
// as the PATH-prefix follow-up tracked out of #8653. They stay reload-only
// in RELOAD_EXCLUDED_KEYS. Runtime-specific search paths for other
// interpreters (PYTHONPATH, JAVA_TOOL_OPTIONS, …) are the same tradeoff and
// are deferred with it.
//
// This denylist intentionally does NOT move into core `sanitizeChildEnv`:
// per-server `mcpServers[].env` and per-hook `hooks[].env` are explicit,
// trust-gated overrides that must keep working, and a blanket child-env
// strip would silently null them everywhere. The choke point that needs the
// denylist is config-driven: .env/settings.env loading (environment.ts).
//
// Known adjacent surface: LSP `.lsp.json` env overrides carry their own
// narrower denylist (`SECURITY_SENSITIVE_ENV_KEYS` in
// core/lsp/LspServerManager.ts — missing BASH_ENV/ENV/npm_config_node_options).
// Unifying the two lists is deferred: the LSP surface is experimental
// (behind --experimental-lsp) and its keys were chosen independently.
export const INHERITED_LOADER_ENV_KEYS = [
  'NODE_OPTIONS',
  // npm maps its `node-options` config onto npm_config_node_options in the
  // environment, and `npm run` lifecycle scripts apply it like NODE_OPTIONS —
  // the same hijack through an adjacent key. The config-file keys are the
  // same hijack one level up: they point npm at an attacker-chosen .npmrc
  // that can itself set node-options/script-shell/ignore-scripts, and `npm
  // run` itself exports them into the script environment.
  'npm_config_node_options',
  'npm_config_userconfig',
  'npm_config_globalconfig',
  'npm_config_script_shell',
  'npm_config_prefix',
  'NODE_PATH',
  // OPENSSL_CONF points Node's startup crypto init at an attacker `.cnf`
  // whose `nodejs_conf` section can dlopen an arbitrary engine/provider `.so`
  // before any user code runs — a pure code-injection vector with no benign
  // cross-workspace inheritance, so it is scrubbed like NODE_OPTIONS.
  'OPENSSL_CONF',
  // NODE_REPL_EXTERNAL_MODULE makes a spawned `node` REPL require() an
  // attacker file at startup. npm_config_node_gyp overrides the node-gyp
  // *script* npm's shim runs verbatim (`"$npm_config_node_gyp" "$@"`), and
  // npm_config_init_module is require()d by `npm init` (even `-y`). All three
  // are executable/module redirects with no legitimate login-shell use, so
  // they join the scrubbed loader set rather than the reject-only tier.
  'NODE_REPL_EXTERNAL_MODULE',
  'npm_config_node_gyp',
  'npm_config_init_module',
  'LD_PRELOAD',
  'LD_AUDIT',
  'DYLD_INSERT_LIBRARIES',
  'BASH_ENV',
  // zsh sources $ZDOTDIR/.zshenv on every invocation, including
  // non-interactive `zsh -c` — the zsh analogue of BASH_ENV.
  'ZDOTDIR',
  // BASH_FUNC_* exported-function definitions are bash's other env-driven
  // code-import channel (non-interactive `bash -c` still imports them);
  // matched by prefix in isLoaderEnvKey, not listed here.
] as const;

// Loader-key matching is case-insensitive and treats npm config-key
// underscore/hyphen spellings as equivalent: npm applies npm_config_* env
// vars regardless of case (it matches the prefix case-insensitively and
// lowercases the rest) and maps non-leading underscores onto hyphens, so
// npm_config_node-options injects NODE_OPTIONS into `npm run` lifecycle
// scripts exactly like npm_config_node_options. Windows env lookup is
// case-insensitive outright. Exact-case or exact-spelling gates would leave
// such variants loader-effective while slipping past the denylist and the
// scrubs. Every gate and scrub must go through this predicate instead of
// re-deriving set membership.
const canonicalLoaderKey = (key: string): string =>
  key.toLowerCase().replace(/_/gu, '-');

const LOADER_ENV_KEYS: ReadonlySet<string> = new Set(
  INHERITED_LOADER_ENV_KEYS.map(canonicalLoaderKey),
);

// Exported bash function definitions (`BASH_FUNC_<name>%%=() { ... }`) are
// imported by every bash child, non-interactive `bash -c` included — env key
// names cannot be arrayed above since the function name is embedded in the
// key. bash compares the prefix case-sensitively, but Windows env lookup
// does not, so match the canonical (case-folded) spelling.
export function isLoaderEnvKey(key: string): boolean {
  const canonical = canonicalLoaderKey(key);
  return canonical.startsWith('bash-func-') || LOADER_ENV_KEYS.has(canonical);
}

// Loader keys rejected from .env/settings.env used to apply on some
// application paths before the denylist existed; dropping them silently
// would send upgrade investigations everywhere except here. Report once per
// source+key per process, so repeated loads do not repeat the same warning.
const reportedLoaderKeyRejections = new Map<string, Set<string>>();

// candidateKeys is the raw key list of a parsed source (e.g.
// Object.keys(parsedEnv)); the intersection with the loader denylist happens
// here so every application site reports with identical matching semantics.
export function reportRejectedLoaderKeys(
  source: string,
  candidateKeys: readonly string[],
): string[] {
  const rejectedKeys = candidateKeys.filter(isLoaderEnvKey);
  const warnedKeys =
    reportedLoaderKeyRejections.get(source) ?? new Set<string>();
  const freshKeys = rejectedKeys.filter((key) => !warnedKeys.has(key));
  if (freshKeys.length === 0) return rejectedKeys;
  for (const key of freshKeys) warnedKeys.add(key);
  reportedLoaderKeyRejections.set(source, warnedKeys);
  writeStderrLineSafe(
    `qwen: ${source} cannot set loader-affecting env vars; ignored: ` +
      freshKeys.join(', '),
  );
  return rejectedKeys;
}

/** Test-only: forget already-reported loader-key rejections. */
export function resetLoaderKeyRejectionReportingForTesting(): void {
  reportedLoaderKeyRejections.clear();
}
