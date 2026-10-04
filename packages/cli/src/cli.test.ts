/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { Argv } from 'yargs';
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { FatalError } from '@qwen-code/qwen-code-core';
import { AlreadyReportedError } from './utils/errors.js';
import { TOP_LEVEL_HELP_OPTIONS } from './config/top-level-options.js';
import {
  MCP_COMMANDS,
  TOP_LEVEL_COMMANDS,
  handleCriticalError,
  isExpectedPtyRaceError,
  resolveBootstrapRoute,
  runCliEntry,
  runCliEntryPoint,
  stampCliEntryEnv,
} from './cli.js';

const mocks = vi.hoisted(() => ({
  main: vi.fn(),
  initStartupProfiler: vi.fn(),
  initCpuProfiler: vi.fn(),
  mcpHandler: vi.fn(),
  mcpBuilder: vi.fn(),
  mcpListHandler: vi.fn(),
  mcpAddHandler: vi.fn(),
  mcpRemoveHandler: vi.fn(),
  getCliVersion: vi.fn(),
}));

vi.mock('./llm.js', () => ({
  main: mocks.main,
}));

vi.mock('./utils/startupProfiler.js', () => ({
  initStartupProfiler: mocks.initStartupProfiler,
}));

vi.mock('./utils/cpuProfiler.js', () => ({
  initCpuProfiler: mocks.initCpuProfiler,
}));

vi.mock('./utils/version.js', () => ({
  getCliVersion: mocks.getCliVersion,
}));

vi.mock('./commands/mcp.js', () => ({
  mcpCommand: {
    command: 'mcp',
    describe: 'Manage MCP servers',
    builder: (yargs: Argv) => {
      mocks.mcpBuilder();
      return yargs
        .command({
          command: 'list',
          describe: 'List all configured MCP servers',
          handler: mocks.mcpListHandler,
        })
        .command({
          // Mirror the real add command's variadic tail and
          // `unknown-options-as-args` so version-looking server args are
          // captured into `args` exactly like production.
          command: 'add <name> <commandOrUrl> [args...]',
          describe: 'Add a server',
          builder: (subYargs: Argv) =>
            subYargs.parserConfiguration({
              'unknown-options-as-args': true,
              'populate--': true,
            }),
          handler: mocks.mcpAddHandler,
        })
        .command({
          command: 'remove <name>',
          describe: 'Remove a server',
          handler: mocks.mcpRemoveHandler,
        })
        .demandCommand(1, 'You need at least one command before continuing.');
    },
    handler: mocks.mcpHandler,
  },
}));

describe('resolveBootstrapRoute', () => {
  it('routes top-level help, version, and mcp correctly', async () => {
    expect(resolveBootstrapRoute(['--help'])).toBe('help');
    expect(resolveBootstrapRoute(['--version'])).toBe('version');
    expect(resolveBootstrapRoute(['mcp', '--version'])).toBe('version');
    expect(resolveBootstrapRoute(['mcp', '--help'])).toBe('mcp');
  });

  it('sends the removed serve and Runtime worker commands to the full parser', async () => {
    expect(resolveBootstrapRoute(['serve', '--help'])).toBe('default');
    expect(resolveBootstrapRoute(['managed-runtime-worker'])).toBe('default');
  });

  it('keeps bundled entrypoint paths out of the route detection', async () => {
    expect(resolveBootstrapRoute(['/repo/dist/cli.js', '--help'])).toBe('help');
    expect(
      resolveBootstrapRoute(['C:\\repo\\dist\\cli.js', 'mcp', '--help']),
    ).toBe('mcp');
  });

  it('falls back to the default route for normal interactive startup', async () => {
    expect(resolveBootstrapRoute([])).toBe('default');
    expect(resolveBootstrapRoute(['--model', 'gpt-4', 'Hello'])).toBe(
      'default',
    );
    expect(resolveBootstrapRoute(['--safe-mode', 'mcp', 'list'])).toBe(
      'default',
    );
  });

  it('does not treat values for global flags as positional commands or bootstrap flags', () => {
    expect(resolveBootstrapRoute(['--model', 'gpt-4', '--help'])).toBe('help');
    expect(resolveBootstrapRoute(['-p', 'hello', '--help'])).toBe('help');
    expect(resolveBootstrapRoute(['--approval-mode', 'auto', '--help'])).toBe(
      'help',
    );
    expect(resolveBootstrapRoute(['--auth-type', 'openai', '--help'])).toBe(
      'help',
    );
    expect(
      resolveBootstrapRoute(['--append-system-prompt', 'be brief', '--help']),
    ).toBe('help');
    expect(resolveBootstrapRoute(['--worktree', '--help'])).toBe('help');
    // A version token sitting in a value flag's value slot is skipped
    // (base parity) and the argv demotes to the full parser.
    expect(resolveBootstrapRoute(['--model', '-v'])).toBe('default');
  });

  it('matches yargs value scanning for sentinels and array options', () => {
    expect(resolveBootstrapRoute(['--worktree', '--', '--help'])).toBe(
      'default',
    );
    // Array options consume at most one token (matching yargs' command-
    // detection pass), so the second value reads as a positional and demotes
    // these to the slow path, which prints the same top-level options plus
    // the full parser's command/positional sections.
    expect(
      resolveBootstrapRoute(['--extensions', 'ext1', 'ext2', '--help']),
    ).toBe('default');
    expect(
      resolveBootstrapRoute(['--include-directories', 'one', 'two', '--help']),
    ).toBe('default');
  });

  it('keeps base help routing when -- sits in a base value slot', () => {
    // The pre-PR scan skipped the token after its hardcoded value flags
    // unconditionally, even the `--` sentinel, so `qwen --model -- --help`
    // printed top-level help (exit 0) instead of booting the agent with
    // the literal prompt `--help`. Derived-only flags keep the conditional
    // skip (pinned above: the --worktree sentinel shape demotes).
    expect(resolveBootstrapRoute(['--model', '--', '--help'])).toBe('help');
    expect(resolveBootstrapRoute(['--prompt', '--', '--help'])).toBe('help');
    expect(resolveBootstrapRoute(['--resume', '--', '-h'])).toBe('help');
    expect(resolveBootstrapRoute(['--output-format', '--', '-h'])).toBe('help');
    expect(resolveBootstrapRoute(['-p', '--', '-h'])).toBe('help');
    // A real positional after the sentinel still demotes on both paths.
    expect(resolveBootstrapRoute(['--model', '--', 'foo', '--help'])).toBe(
      'default',
    );
  });

  it('does not swallow command tokens after array-option values', () => {
    // yargs detects commands in an earlier pass where these options are
    // unknown and consume at most one token; the scanner must match, or a
    // command sitting after array values misfires the top-level help path.
    expect(
      resolveBootstrapRoute(['--extensions=a', 'sessions', '--help']),
    ).toBe('default');
    expect(
      resolveBootstrapRoute(['--extensions', 'a', 'sessions', '--help']),
    ).toBe('default');
    expect(resolveBootstrapRoute(['-e', 'a', 'sessions', '--help'])).toBe(
      'default',
    );
    expect(
      resolveBootstrapRoute(['--include-directories', 'x', 'mcp', '--help']),
    ).toBe('default');
    expect(
      resolveBootstrapRoute(['--fallback-model', 'm1', 'sessions', '--help']),
    ).toBe('default');
  });

  it('consumes hidden value options and =-form values before route detection', () => {
    // Hidden options registered outside TOP_LEVEL_HELP_OPTIONS still take
    // values the scanner must skip over.
    expect(
      resolveBootstrapRoute(['--sandbox-session-id', 'uuid', '--help']),
    ).toBe('help');
    // The `=` form carries its value inside the token and consumes nothing
    // further, so `b` reads as a positional and demotes to the slow path;
    // with --help present the full parser boots and prints help before the
    // leftover tokens matter.
    expect(resolveBootstrapRoute(['--extensions=a', 'b', 'c', '--help'])).toBe(
      'default',
    );
    // Non-array `--flag=value` keeps its value inside the token: the next
    // token must NOT be consumed (consuming it would misroute this to
    // top-level help instead of the slow-path `sessions --help`).
    expect(resolveBootstrapRoute(['--model=gpt-4', 'sessions', '--help'])).toBe(
      'default',
    );
  });

  it('keeps hidden boolean flags on the help fast path', () => {
    // The hidden boolean options registered inline in config.ts are part of
    // the known-safe grammar, so they must not demote a plain help argv to
    // the slow path (base served these on the fast path).
    expect(resolveBootstrapRoute(['--experimental-skills', '--help'])).toBe(
      'help',
    );
  });

  it("skips version tokens sitting in a value flag's value slot (base parity)", () => {
    // Base's hasFlag skipped the token after every value-taking flag
    // unconditionally, so a `-v`/`--version` in the value slot was never
    // counted: `qwen -p -v -h` printed top-level help (exit 0) and
    // `qwen --model -v` demoted to the full parser. An unconditional
    // version intercept flipped every VALUE_FLAGS x {-v,--version} x
    // {-h,--help} shape from help to version; the restored skip returns
    // them to parity.
    expect(resolveBootstrapRoute(['-p', '-v', '-h'])).toBe('help');
    expect(resolveBootstrapRoute(['--model', '-v', '--help'])).toBe('help');
    expect(resolveBootstrapRoute(['--resume', '-v', '--help'])).toBe('help');
    expect(resolveBootstrapRoute(['--model', '--version', '--help'])).toBe(
      'help',
    );
    expect(resolveBootstrapRoute(['-m', '--version', '-h'])).toBe('help');
    expect(resolveBootstrapRoute(['-r', '-v', '--help'])).toBe('help');
    expect(resolveBootstrapRoute(['--output-format', '-v', '--help'])).toBe(
      'help',
    );
    expect(resolveBootstrapRoute(['--model', '-v'])).toBe('default');
    // Version tokens outside any value slot still win, with or without
    // help siblings.
    expect(resolveBootstrapRoute(['-v', '--help'])).toBe('version');
    expect(resolveBootstrapRoute(['--version', '--help'])).toBe('version');
    expect(resolveBootstrapRoute(['foo', '-v', '--help'])).toBe('version');
    expect(resolveBootstrapRoute(['sessions', '-v', '--help'])).toBe('version');
    expect(resolveBootstrapRoute(['mcp', '-v', '--help'])).toBe('version');
    // Help still wins when no exact version token exists.
    expect(resolveBootstrapRoute(['--model', 'gpt-4', '--help'])).toBe('help');
    expect(resolveBootstrapRoute(['-p', 'hello', '-h'])).toBe('help');
  });

  it('intercepts version tokens in derived-only value-flag slots (base parity)', () => {
    // Base's hasFlag skipped value slots only for its hardcoded
    // 11-spelling set (BASE_VALUE_FLAGS). Flags added by the derived
    // VALUE_FLAGS (--worktree, -e, --auth-type, --session-id,
    // --exclude-tools, --append-system-prompt, the hidden
    // --sandbox-session-id) did not consume their value slot in the base
    // scan, so a `-v`/`--version` sitting there WAS counted and base
    // printed the version. Skipping those slots here would drop the
    // intercept and corrupt real runs: `mcp add srv cmd --exclude-tools
    // -v` persisted excludeTools:["-v"], `mcp add srv cmd -e -v`
    // swallowed the `-v` env value, `--worktree -v mcp remove victim`
    // became an exit-1 Unknown argument instead of an exit-0 version
    // print, and `--worktree -v --help` printed help instead of the
    // version.
    expect(
      resolveBootstrapRoute(['--worktree', '-v', 'mcp', 'remove', 'victim']),
    ).toBe('version');
    expect(
      resolveBootstrapRoute(['mcp', 'add', 'name', 'cmd', '-e', '-v']),
    ).toBe('version');
    expect(
      resolveBootstrapRoute([
        'mcp',
        'add',
        'srv',
        'cmd',
        '--exclude-tools',
        '-v',
      ]),
    ).toBe('version');
    expect(resolveBootstrapRoute(['--worktree', '-v', '--help'])).toBe(
      'version',
    );
    expect(resolveBootstrapRoute(['--exclude-tools', '-v', '--help'])).toBe(
      'version',
    );
    expect(resolveBootstrapRoute(['--auth-type', '-v'])).toBe('version');
    expect(resolveBootstrapRoute(['--session-id', '--version'])).toBe(
      'version',
    );
    expect(
      resolveBootstrapRoute(['--append-system-prompt', '-v', '--help']),
    ).toBe('version');
    expect(resolveBootstrapRoute(['--sandbox-session-id', '-v'])).toBe(
      'version',
    );
    // Base-set control: the 11 base spellings still skip their value
    // slot, unchanged by the derived-only fix above.
    expect(resolveBootstrapRoute(['--model', '-v'])).toBe('default');
    expect(resolveBootstrapRoute(['-m', '--version', '-h'])).toBe('help');
    expect(resolveBootstrapRoute(['--resume', '-v', '--help'])).toBe('help');
  });

  it('prints the version for exact version tokens with hidden help states (base parity)', () => {
    // Base printed the version even when argv carries tokens that set the
    // help flag on the full parser — probed against the base binary:
    // `help -v`, `-v help`, `foo help -v`, `--help=true -v`, `--h -v`,
    // `-dh -v`, `-help -v`, `-sh --version`, `-h=true -v`, and
    // `--help=false -v` all printed the version. Demoting these shapes to
    // the full parser is exactly what executed subcommand handlers on
    // command-prefixed argv (`mcp remove victim -v help` deleted the
    // server), so the intercept owns every exact version token instead.
    expect(resolveBootstrapRoute(['help', '-v'])).toBe('version');
    expect(resolveBootstrapRoute(['help', '--version'])).toBe('version');
    expect(resolveBootstrapRoute(['-v', 'help'])).toBe('version');
    expect(resolveBootstrapRoute(['foo', 'help', '-v'])).toBe('version');
    expect(resolveBootstrapRoute(['sessions', 'help', '-v'])).toBe('version');
    expect(resolveBootstrapRoute(['--help=true', '-v'])).toBe('version');
    expect(resolveBootstrapRoute(['--help=true', '--version'])).toBe('version');
    expect(resolveBootstrapRoute(['--h', '-v'])).toBe('version');
    expect(resolveBootstrapRoute(['-dh', '-v'])).toBe('version');
    expect(resolveBootstrapRoute(['-help', '-v'])).toBe('version');
    expect(resolveBootstrapRoute(['-sh', '--version'])).toBe('version');
    expect(resolveBootstrapRoute(['-h=true', '-v'])).toBe('version');
    expect(resolveBootstrapRoute(['-v', '-dh'])).toBe('version');
    expect(resolveBootstrapRoute(['--help=false', '-v'])).toBe('version');
    // Without an exact version token the help-state shapes still demote to
    // the slow path, which owns the final flag state.
    expect(resolveBootstrapRoute(['--help=true'])).toBe('default');
    expect(resolveBootstrapRoute(['--h'])).toBe('default');
    expect(resolveBootstrapRoute(['-dh'])).toBe('default');
  });

  it('routes command-prefixed version argv to the version fast path', () => {
    // Command builders disable version via `.version(false)` (mcp, hooks,
    // extensions, sessions) while the root parser's
    // version alias still consumes the token — so the full parser EXECUTES
    // the subcommand instead of printing the version (`mcp remove` deletes
    // the server and its OAuth creds). Base printed the version for these
    // argv shapes, so the bootstrap intercept restores that — including the
    // mcp add variadic tail (probed: base printed the version and persisted
    // nothing).
    expect(resolveBootstrapRoute(['mcp', '--version'])).toBe('version');
    expect(resolveBootstrapRoute(['mcp', 'list', '--version'])).toBe('version');
    expect(resolveBootstrapRoute(['mcp', '-v'])).toBe('version');
    expect(
      resolveBootstrapRoute(['mcp', 'add', 'my-server', 'node', '--version']),
    ).toBe('version');
    // Bare top-level version tokens still win; a token sitting in a value
    // flag's value slot is skipped and demotes to the full parser
    // (base parity).
    expect(resolveBootstrapRoute(['-v'])).toBe('version');
    expect(resolveBootstrapRoute(['--version'])).toBe('version');
    expect(resolveBootstrapRoute(['--model', '-v'])).toBe('default');
  });

  it('prints the version instead of persisting version-bearing mcp add argv (base parity)', () => {
    // Base printed the version and persisted NOTHING for every probed
    // version-bearing `mcp add` shape — including the variadic tail
    // (`mcp add my-server node server.js -v`), greedy-array and nargs
    // value-flag shapes, a dash token between `mcp` and `add`, and leading
    // help/version tokens. The previous add-tail exception hand-modeled the
    // builder's consumption grammar fail-open and produced corrupted
    // settings writes (`includeTools:["a","-v"]`, swallowed `-v` env
    // values); the structural close is the intercept itself.
    expect(
      resolveBootstrapRoute([
        'mcp',
        'add',
        'my-server',
        'node',
        'server.js',
        '-v',
      ]),
    ).toBe('version');
    expect(
      resolveBootstrapRoute(['mcp', 'add', 'my-server', 'node', '--version']),
    ).toBe('version');
    expect(
      resolveBootstrapRoute([
        'mcp',
        'add',
        'my-server',
        'node',
        'server.js',
        '--include-tools',
        'a',
        '-v',
      ]),
    ).toBe('version');
    expect(
      resolveBootstrapRoute([
        'mcp',
        'add',
        'my-server',
        'node',
        'server.js',
        '--env',
        '-v',
      ]),
    ).toBe('version');
    expect(
      resolveBootstrapRoute([
        'mcp',
        '--debug',
        'add',
        'my-server',
        'node',
        'server.js',
        '-v',
      ]),
    ).toBe('version');
    expect(
      resolveBootstrapRoute([
        '--help',
        'mcp',
        'add',
        'my-server',
        'node',
        'server.js',
        '-v',
      ]),
    ).toBe('version');
    expect(
      resolveBootstrapRoute([
        'mcp',
        'add',
        'my-server',
        'node',
        'server.js',
        '-v',
        'help',
      ]),
    ).toBe('version');
    // Controls: only tokens AFTER `--` are positional data the mcp fast
    // path persists verbatim.
    expect(
      resolveBootstrapRoute(['mcp', 'add', 'my-server', 'node', '--', '-v']),
    ).toBe('mcp');
    expect(resolveBootstrapRoute(['mcp', '--version'])).toBe('version');
    expect(resolveBootstrapRoute(['mcp', 'list', '--version'])).toBe('version');
  });

  it('restores base parity for command-prefixed version argv', () => {
    // Base printed the version for ANY exact `-v`/`--version` token. The
    // demotion to the full parser broke that destructively: `mcp remove x
    // -v` deleted the server (root version alias consumed the token, the
    // non-strict command tree executed), and option-shifted add argv
    // persisted corrupted entries. The intercept prints the version again,
    // unconditionally — no help-state modeling, no add-tail exception.
    expect(resolveBootstrapRoute(['mcp', 'remove', 'my-server', '-v'])).toBe(
      'version',
    );
    expect(
      resolveBootstrapRoute(['mcp', 'remove', 'my-server', '--version']),
    ).toBe('version');
    expect(
      resolveBootstrapRoute(['extensions', 'uninstall', 'foo-ext', '-v']),
    ).toBe('version');
    expect(
      resolveBootstrapRoute(['--debug', 'mcp', 'remove', 'victim', '-v']),
    ).toBe('version');
    expect(
      resolveBootstrapRoute([
        '--safe-mode',
        'mcp',
        'remove',
        'victim',
        '--version',
      ]),
    ).toBe('version');
    // Option-shifted tokens before the two required add positionals are not
    // the variadic tail.
    expect(
      resolveBootstrapRoute([
        'mcp',
        'add',
        '--scope',
        'user',
        '-v',
        'name',
        'cmd',
      ]),
    ).toBe('version');
    expect(
      resolveBootstrapRoute([
        'mcp',
        'add',
        '--transport',
        'sse',
        '-v',
        'name',
        'cmd',
      ]),
    ).toBe('version');
    // Only one positional precedes the token: not the tail yet.
    expect(resolveBootstrapRoute(['mcp', 'add', 'name', '-v'])).toBe('version');
    // Two positionals precede: the variadic tail. Base STILL printed the
    // version and persisted nothing here (probed), so the intercept fires.
    expect(
      resolveBootstrapRoute([
        'mcp',
        'add',
        '--scope',
        'user',
        'my-server',
        'node',
        '-v',
      ]),
    ).toBe('version');
    expect(
      resolveBootstrapRoute([
        '--debug',
        'mcp',
        'add',
        'my-server',
        'node',
        'server.js',
        '-v',
      ]),
    ).toBe('version');
    expect(
      resolveBootstrapRoute([
        '--model',
        'gpt-4',
        'mcp',
        'add',
        'my-server',
        'node',
        '-v',
      ]),
    ).toBe('version');
    // sessions argv is command-prefixed too.
    expect(resolveBootstrapRoute(['sessions', '--version'])).toBe('version');
    // Entrance-class regressions: the old help-state guard suppressed the
    // intercept for real `--h*` options (`--host`) and for help
    // tokens after/around the version token, letting the full parser
    // EXECUTE the subcommand where base printed the version (probed:
    // `mcp remove victim -v help` ran the remove handler).
    expect(
      resolveBootstrapRoute([
        'mcp',
        'add',
        'my-server',
        'node',
        '--host',
        'ghe.example.com',
        '-v',
      ]),
    ).toBe('version');
    expect(
      resolveBootstrapRoute(['mcp', 'remove', 'victim', '-v', 'help']),
    ).toBe('version');
    expect(
      resolveBootstrapRoute([
        'mcp',
        'remove',
        'victim',
        '--model',
        'help',
        '-v',
      ]),
    ).toBe('version');
  });

  it('demotes unrecognized short-option clusters to the slow path', () => {
    // Documented limitation (see skipOptionValues): clusters are matched as
    // whole tokens, so -h/-v inside a cluster falls back to the full boot.
    // Output stays correct via the slow path.
    expect(resolveBootstrapRoute(['-vh'])).toBe('default');
  });

  it('does not treat flags after -- as bootstrap flags', () => {
    expect(resolveBootstrapRoute(['--', '--version'])).toBe('default');
    expect(resolveBootstrapRoute(['mcp', '--', '--version'])).toBe('mcp');
  });

  it('keeps out-of-grammar argv off the help fast path; exact version tokens keep base parity', () => {
    // Structural close (not per-entrance patches): yargs' flag state is
    // last-wins and order-dependent, which exact-token scanning cannot
    // model. Each shape below was witnessed misfiring a fast path at some
    // point; all of them carry tokens outside the safe grammar (`=`-forms,
    // `--no-` negations, short clusters) and must stay off the HELP fast
    // path. Without an exact version token they demote to the slow path,
    // which owns the final flag state.
    const misfires: readonly string[][] = [
      ['--help', '--no-help'],
      ['--version=0'],
      ['--version=no'],
      ['--help', '--help=false'],
      ['-h', '-h=false'],
      ['--v=false'],
      ['--h=false'],
    ];
    for (const argv of misfires) {
      const route = resolveBootstrapRoute(argv);
      expect(route, `argv=${JSON.stringify(argv)}`).not.toBe('help');
      expect(route, `argv=${JSON.stringify(argv)}`).not.toBe('version');
    }
    // Base parity: base printed the version for ANY argv carrying an exact
    // `-v`/`--version` token, regardless of out-of-grammar siblings
    // (`--no-version`, `--version=false`, `---help`); the command-prefixed
    // intercept restores that class instead of demoting it.
    expect(resolveBootstrapRoute(['-v', '--no-version'])).toBe('version');
    expect(resolveBootstrapRoute(['--version', '--no-version'])).toBe(
      'version',
    );
    expect(resolveBootstrapRoute(['-v', '--version=false'])).toBe('version');
    expect(resolveBootstrapRoute(['---help', '-v'])).toBe('version');
    expect(resolveBootstrapRoute(['-v', '---help'])).toBe('version');
    // Controls: the plain grammar stays on the fast paths.
    expect(resolveBootstrapRoute(['--help'])).toBe('help');
    expect(resolveBootstrapRoute(['-h'])).toBe('help');
    expect(resolveBootstrapRoute(['-v'])).toBe('version');
    expect(resolveBootstrapRoute(['--version'])).toBe('version');
    expect(resolveBootstrapRoute(['--model', 'x', '-v'])).toBe('version');
    expect(resolveBootstrapRoute(['mcp', '--version'])).toBe('version');
    expect(resolveBootstrapRoute([])).toBe('default');
  });

  it('demotes unregistered flags via the KNOWN_FAST_PATH_FLAGS gate', () => {
    // The membership check is the load-bearing rule of argvSafeForFastPath:
    // KNOWN_FAST_PATH_FLAGS stores only bare registered spellings, so it
    // also rejects `--no-` negations, `=`-form resets, short-option
    // clusters, and `---` tokens. Dropping the check flips
    // `--unknown-flag --help` onto the help fast path.
    expect(resolveBootstrapRoute(['--unknown-flag', '--help'])).toBe('default');
    expect(resolveBootstrapRoute(['--unknown-flag'])).toBe('default');
    expect(resolveBootstrapRoute(['--help', '--no-help'])).toBe('default');
    expect(resolveBootstrapRoute(['--version=false', '--help'])).toBe(
      'default',
    );
    expect(resolveBootstrapRoute(['-dh', '--help'])).toBe('default');
    expect(resolveBootstrapRoute(['---help'])).toBe('default');
  });
});

describe('runCliEntry', () => {
  const savedEnv = {
    CLI_VERSION: process.env['CLI_VERSION'],
    LC_ALL: process.env['LC_ALL'],
  };

  let stdout: string[];
  let stderr: string[];
  let savedExitCode: string | number | null | undefined;

  beforeEach(() => {
    stdout = [];
    stderr = [];
    savedExitCode = process.exitCode;
    process.exitCode = undefined;
    vi.clearAllMocks();
    mocks.getCliVersion.mockResolvedValue('fallback-version');
    process.env['CLI_VERSION'] = '9.9.9';
    vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
      stdout.push(String(chunk));
      return true;
    });
    vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => {
      stderr.push(String(chunk));
      return true;
    });
  });

  afterEach(() => {
    process.exitCode = savedExitCode;
    if (savedEnv.CLI_VERSION === undefined) {
      delete process.env['CLI_VERSION'];
    } else {
      process.env['CLI_VERSION'] = savedEnv.CLI_VERSION;
    }
    if (savedEnv.LC_ALL === undefined) {
      delete process.env['LC_ALL'];
    } else {
      process.env['LC_ALL'] = savedEnv.LC_ALL;
    }
    vi.restoreAllMocks();
  });

  it('prints the version without loading the full CLI graph', async () => {
    await runCliEntry(['--version']);

    expect(stdout.join('')).toContain('9.9.9');
    expect(mocks.main).not.toHaveBeenCalled();
    expect(mocks.initStartupProfiler).not.toHaveBeenCalled();
    expect(mocks.initCpuProfiler).not.toHaveBeenCalled();
  });

  it('hands the removed Runtime worker argv to the full CLI', async () => {
    await runCliEntry(['managed-runtime-worker']);

    expect(stderr.join('')).not.toContain('Managed Runtime worker');
    expect(mocks.main).toHaveBeenCalledTimes(1);
  });

  it('falls back to getCliVersion when CLI_VERSION is unset', async () => {
    delete process.env['CLI_VERSION'];

    await runCliEntry(['--version']);

    expect(stdout.join('')).toContain('fallback-version');
    expect(mocks.getCliVersion).toHaveBeenCalledTimes(1);
    expect(mocks.main).not.toHaveBeenCalled();
  });

  it('prints top-level help without loading the full CLI graph', async () => {
    await runCliEntry(['--help']);

    const helpText = stdout.join('');
    expect(helpText).toContain('Usage: qwen [options] [command]');
    expect(helpText).toContain('\nCommands:');
    expect(helpText).toContain('\nOptions:');
    // The default command and its positional are part of the contract this
    // help output is supposed to state: `--prompt`'s own deprecation notice
    // points users at the positional prompt form, so it has to be listed.
    expect(helpText).toContain('\nPositionals:');
    expect(helpText).toContain('qwen [query..]');
    expect(helpText).toContain('Launch Qwen Code CLI');
    expect(helpText).toContain('[default]');
    expect(helpText).toContain('Positional prompt.');
    expect(helpText).toContain('Manage Qwen Code hooks');
    expect(helpText).toContain('Manage MCP servers');
    for (const removed of [
      'Run Qwen Code as a local HTTP daemon',
      'Manage messaging channels',
      'DashScope Batch API',
      'Run a review non-interactively',
      'Check for Qwen Code updates',
    ]) {
      expect(helpText).not.toContain(removed);
    }
    expect(helpText).toContain('--model');
    expect(helpText).toContain('-p, --prompt');
    expect(helpText).toContain('--safe-mode');
    expect(helpText).toContain('-s, --sandbox');
    expect(helpText).toContain('-o, --output-format');
    expect(helpText).toContain('-r, --resume');
    for (const [name] of TOP_LEVEL_HELP_OPTIONS) {
      expect(helpText).toContain(`--${name}`);
    }
    expect(helpText).toContain('[string] [choices: "openai"]');
    expect(helpText).not.toContain('--proxy');
    // The fast path mirrors config.ts and wraps help at the terminal width;
    // in a non-TTY (columns unset) that disables wrapping, so a description
    // longer than yargs' 80-column fallback renders on one unbroken line.
    expect(helpText).toContain(
      'Maximum cumulative tool calls executed during the run (success or ' +
        'failure; `structured_output` under --json-schema is exempt).',
    );
    expect(helpText).toContain('deprecated');
    expect(mocks.main).not.toHaveBeenCalled();
    expect(mocks.initStartupProfiler).not.toHaveBeenCalled();
    expect(mocks.initCpuProfiler).not.toHaveBeenCalled();
  });

  it('prints fast-path help in English under a German locale', async () => {
    // Without the `.locale('en')` pin yargs detects LC_ALL and renders its
    // bundled German boilerplate, reopening the fast/slow output divergence.
    process.env['LC_ALL'] = 'de_DE.UTF-8';

    await runCliEntry(['--help']);

    const helpText = stdout.join('');
    expect(helpText).toContain('\nCommands:');
    expect(helpText).not.toContain('Kommandos:');
  });

  it('routes the MCP help path without booting gemini', async () => {
    await runCliEntry(['mcp', '--help']);

    expect(stdout.join('')).toContain('Manage MCP servers');
    expect(mocks.main).not.toHaveBeenCalled();
    expect(mocks.initStartupProfiler).not.toHaveBeenCalled();
    expect(mocks.initCpuProfiler).not.toHaveBeenCalled();
    expect(mocks.mcpBuilder).not.toHaveBeenCalled();
  });

  it('does not execute MCP subcommands when showing subcommand help', async () => {
    await runCliEntry(['mcp', 'list', '--help']);

    const helpText = stdout.join('');
    expect(helpText).toContain('List all configured MCP servers');
    expect(mocks.mcpListHandler).not.toHaveBeenCalled();
    expect(mocks.main).not.toHaveBeenCalled();
    expect(mocks.initStartupProfiler).not.toHaveBeenCalled();
    expect(mocks.initCpuProfiler).not.toHaveBeenCalled();
  });

  it('executes MCP subcommands through the fast path', async () => {
    await runCliEntry(['mcp', 'list']);

    expect(mocks.mcpListHandler).toHaveBeenCalledTimes(1);
    expect(mocks.main).not.toHaveBeenCalled();
    expect(mocks.initStartupProfiler).not.toHaveBeenCalled();
    expect(mocks.initCpuProfiler).not.toHaveBeenCalled();
  });

  it('executes MCP subcommands after -- through the fast path', async () => {
    await runCliEntry(['mcp', '--', 'list']);

    expect(mocks.mcpListHandler).toHaveBeenCalledTimes(1);
    expect(mocks.main).not.toHaveBeenCalled();
    expect(mocks.initStartupProfiler).not.toHaveBeenCalled();
    expect(mocks.initCpuProfiler).not.toHaveBeenCalled();
  });

  it('uses the full CLI when global flags precede MCP commands', async () => {
    await runCliEntry(['--safe-mode', 'mcp', 'list']);

    expect(mocks.main).toHaveBeenCalledTimes(1);
    expect(mocks.mcpListHandler).not.toHaveBeenCalled();
  });

  it('fails MCP fast-path validation without loading the full CLI', async () => {
    await runCliEntry(['mcp', 'doesnotexist']);

    expect(process.exitCode).toBe(1);
    expect(stderr.join('')).toContain('Unknown command: doesnotexist');
    expect(mocks.mcpListHandler).not.toHaveBeenCalled();
    expect(mocks.main).not.toHaveBeenCalled();
    expect(mocks.initStartupProfiler).not.toHaveBeenCalled();
    expect(mocks.initCpuProfiler).not.toHaveBeenCalled();
  });

  it('does not run MCP subcommands with unknown options', async () => {
    await runCliEntry(['mcp', 'list', '--unknown']);

    expect(process.exitCode).toBe(1);
    expect(stderr.join('')).toContain('Unknown argument: unknown');
    expect(mocks.mcpListHandler).not.toHaveBeenCalled();
    expect(mocks.main).not.toHaveBeenCalled();
  });

  it('reports routine MCP argument errors without loading the full CLI', async () => {
    await runCliEntry(['mcp', 'add']);

    expect(process.exitCode).toBe(1);
    expect(stderr.join('')).toContain('Not enough non-option arguments');
    expect(mocks.mcpAddHandler).not.toHaveBeenCalled();
    expect(mocks.main).not.toHaveBeenCalled();
  });

  it('prints the version instead of executing mcp remove on version argv', async () => {
    await runCliEntry(['mcp', 'remove', 'victim', '-v']);

    expect(stdout.join('')).toContain('9.9.9');
    expect(mocks.mcpRemoveHandler).not.toHaveBeenCalled();
    expect(mocks.mcpAddHandler).not.toHaveBeenCalled();
    expect(mocks.main).not.toHaveBeenCalled();
  });

  it('prints the version for flag-prefixed mcp remove version argv', async () => {
    await runCliEntry(['--debug', 'mcp', 'remove', 'victim', '-v']);

    expect(stdout.join('')).toContain('9.9.9');
    expect(mocks.mcpRemoveHandler).not.toHaveBeenCalled();
    expect(mocks.mcpAddHandler).not.toHaveBeenCalled();
    expect(mocks.main).not.toHaveBeenCalled();
  });

  it('prints the version instead of persisting an option-shifted mcp add', async () => {
    await runCliEntry(['mcp', 'add', '--scope', 'user', '-v', 'name', 'cmd']);

    expect(stdout.join('')).toContain('9.9.9');
    expect(mocks.mcpAddHandler).not.toHaveBeenCalled();
    expect(mocks.main).not.toHaveBeenCalled();
  });

  it('prints the version instead of persisting flag-prefixed mcp add version argv', async () => {
    // Base printed the version and persisted nothing for this shape
    // (probed against the base binary with a sandboxed settings file).
    await runCliEntry([
      '--debug',
      'mcp',
      'add',
      'my-server',
      'node',
      'server.js',
      '-v',
    ]);

    expect(stdout.join('')).toContain('9.9.9');
    expect(mocks.mcpAddHandler).not.toHaveBeenCalled();
    expect(mocks.main).not.toHaveBeenCalled();
  });

  it('loads gemini on the default path', async () => {
    await runCliEntry([]);

    expect(mocks.main).toHaveBeenCalledTimes(1);
  });
});

describe('stampCliEntryEnv', () => {
  // Isolated because the CLI exports QWEN_CODE_CLI to every shell it spawns —
  // a test run started from inside a qwen session inherits it.
  let originalCli: string | undefined;
  let tempDir: string;

  beforeEach(() => {
    originalCli = process.env['QWEN_CODE_CLI'];
    delete process.env['QWEN_CODE_CLI'];
    tempDir = mkdtempSync(path.join(tmpdir(), 'qwen-entry-stamp-'));
  });

  afterEach(() => {
    if (originalCli !== undefined) {
      process.env['QWEN_CODE_CLI'] = originalCli;
    } else {
      delete process.env['QWEN_CODE_CLI'];
    }
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('stamps the built bin entry so skill shell-outs reach THIS build', () => {
    // A direct workspace launch (`node dist/index.js`) never passes through
    // scripts/cli-entry.js, so without this stamp every
    // `"${QWEN_CODE_CLI:-qwen}"` resolved a global install off PATH.
    const entry = path.join(tempDir, 'index.js');
    writeFileSync(entry, '#!/usr/bin/env node\nconsole.log("hi");\n');

    stampCliEntryEnv(entry);

    expect(process.env['QWEN_CODE_CLI']).toBe(entry);
  });

  it("never overwrites an outer launcher's stamp", () => {
    // cli-entry.js may have selected a standalone shim, and the desktop app
    // stamps its vendored bundle — both know launch details this module
    // cannot see, and both run before runCliEntryPoint in the same process.
    const entry = path.join(tempDir, 'index.js');
    writeFileSync(entry, '#!/usr/bin/env node\n');
    process.env['QWEN_CODE_CLI'] = '/outer/launcher/qwen';

    stampCliEntryEnv(entry);

    expect(process.env['QWEN_CODE_CLI']).toBe('/outer/launcher/qwen');
  });

  it('treats an inherited empty string as unset', () => {
    // A parent session's spawn filter writes '' for an entry its shell could
    // not exec. That verdict is about the parent's entry — this build must
    // still stamp its own.
    const entry = path.join(tempDir, 'index.js');
    writeFileSync(entry, '#!/usr/bin/env node\n');
    process.env['QWEN_CODE_CLI'] = '';

    stampCliEntryEnv(entry);

    expect(process.env['QWEN_CODE_CLI']).toBe(entry);
  });

  it.skipIf(process.platform === 'win32')(
    'grants the execute bit tsc never emits, so the spawn filter passes the stamp',
    () => {
      // tsc writes dist/index.js as 0644 and only npm's bin-link chmods it; the
      // spawn-time filter in core blanks a shebang-bearing entry without X_OK,
      // which would turn this stamp into a no-op on every plain-build checkout.
      const entry = path.join(tempDir, 'index.js');
      writeFileSync(entry, '#!/usr/bin/env node\n', { mode: 0o644 });

      stampCliEntryEnv(entry);

      expect(process.env['QWEN_CODE_CLI']).toBe(entry);
      expect(statSync(entry).mode & 0o111).not.toBe(0);
    },
  );

  it('leaves the slot unset when the derived entry does not exist', () => {
    stampCliEntryEnv(path.join(tempDir, 'no', 'such', 'index.js'));

    expect(process.env['QWEN_CODE_CLI']).toBeUndefined();
  });

  it('derives the bin entry one level up from the compiled module', () => {
    // cli.ts emits to dist/src/cli.js and the shebang bin is dist/index.js —
    // one level up, not two. Two lands on the unbuilt packages/cli/index.js,
    // which fails the existence check and silently never stamps, and no other
    // test can catch that: the derivation is only reachable under a built
    // layout, where vitest never runs.
    const source = readFileSync('src/cli.ts', 'utf8');
    expect(source).toContain("new URL('../index.js', import.meta.url)");
    expect(
      new URL('../index.js', 'file:///repo/packages/cli/dist/src/cli.js')
        .pathname,
    ).toBe('/repo/packages/cli/dist/index.js');
  });

  it('default derivation never throws and never stamps outside a built layout', () => {
    // Under vitest Vite rewrites new URL(…, import.meta.url) to a non-file
    // URL, and in dev runs the derived ../index.js is the unbuilt
    // packages/cli/index.js. Both must keep the bare-`qwen` fallback — a
    // failed derivation taking the CLI down would be worse than the version
    // skew this stamp exists to fix.
    stampCliEntryEnv();

    expect(process.env['QWEN_CODE_CLI']).toBeUndefined();
  });
});

describe('bootstrap import boundaries', () => {
  it('keeps fast-path-only dependencies out of static imports', () => {
    const source = readFileSync('src/cli.ts', 'utf8');

    expect(source).not.toContain("import yargs from 'yargs'");
    expect(source).not.toContain("from '@qwen-code/qwen-code-core'");
    expect(source).not.toContain("import './llm.js'");
    expect(source).not.toContain("import { main } from './llm.js'");
  });

  it('keeps the shared option definitions free of runtime imports', () => {
    // cli.ts evaluates top-level-options.js in-process on every fast path,
    // so any runtime import it emits joins the bootstrap entry's static
    // closure. A value import from @qwen-code/qwen-code-core there was
    // measured at +10 MB and ~6x slower `qwen --help`/`qwen mcp`; only
    // erased `import type` statements are allowed in this module.
    const source = readFileSync('src/config/top-level-options.ts', 'utf8');
    for (const line of source.match(/^import .*$/gm) ?? []) {
      expect(line).toMatch(/^import type /);
    }
  });

  it('initializes profilers during bootstrap module evaluation', () => {
    const source = readFileSync('src/cli.ts', 'utf8');

    expect(source).toContain(
      "import { initStartupProfiler } from './utils/startupProfiler.js'",
    );
    expect(source).toContain(
      "import { initCpuProfiler } from './utils/cpuProfiler.js'",
    );
    expect(source.indexOf('initStartupProfiler();')).toBeLessThan(
      source.indexOf('export async function runCliEntry('),
    );
    expect(source.indexOf('initCpuProfiler();')).toBeLessThan(
      source.indexOf('export async function runCliEntry('),
    );
  });

  it('uses the bootstrap file as the production bundle entry', () => {
    const source = readFileSync('../../esbuild.config.js', 'utf8');

    expect(source).toContain("cli: 'packages/cli/src/cli.ts'");
    expect(source).toContain(
      "'execution-worker': 'packages/core/src/services/execution-worker-main.ts'",
    );
  });

  it('keeps bootstrap fast paths in-process in the npm bin wrapper', () => {
    const source = readFileSync('../../scripts/cli-entry.js', 'utf8');

    expect(source).toContain('function isInProcessFastPath()');
    expect(source).not.toContain("first === 'serve'");
    expect(source).toContain("first === 'mcp'");
    expect(source).toContain("hasFlag('--help', '-h')");
    expect(source).toContain("hasFlag('--version', '-v')");
    expect(source).not.toContain('UPDATE_COMPLETE_EXIT_CODE');
  });

  it('prints CLI_VERSION from the npm bin wrapper version shortcut', () => {
    const output = execFileSync(
      process.execPath,
      ['../../scripts/cli-entry.js', '--version'],
      {
        encoding: 'utf8',
        env: { ...process.env, CLI_VERSION: '7.7.7-test' },
      },
    );

    expect(output).toBe('7.7.7-test\n');
  });

  it('reads package.json from the npm bin wrapper version shortcut', () => {
    const expectedVersion = JSON.parse(
      readFileSync('../../package.json', 'utf8'),
    ).version;
    const env = { ...process.env };
    delete env['CLI_VERSION'];

    const output = execFileSync(
      process.execPath,
      ['../../scripts/cli-entry.js', '--version'],
      {
        encoding: 'utf8',
        env,
      },
    );

    expect(output).toBe(`${expectedVersion}\n`);
  });

  it('falls through to cli.js when wrapper package.json lookup fails', () => {
    const tempDir = mkdtempSync(path.join(tmpdir(), 'qwen-cli-entry-'));
    const entryDir = path.join(tempDir, 'bin');
    try {
      mkdirSync(entryDir);
      copyFileSync(
        '../../scripts/cli-entry.js',
        path.join(entryDir, 'cli-entry.mjs'),
      );
      writeFileSync(
        path.join(entryDir, 'cli.js'),
        "process.stdout.write('fallback-cli\\n');\n",
      );
      const env = { ...process.env };
      delete env['CLI_VERSION'];

      const output = execFileSync(
        process.execPath,
        [path.join(entryDir, 'cli-entry.mjs'), '--version'],
        {
          encoding: 'utf8',
          env,
        },
      );

      expect(output).toBe('fallback-cli\n');
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });

  it('copies the npm bin wrapper into the package instead of duplicating it', () => {
    const source = readFileSync('../../scripts/prepare-package.js', 'utf8');

    expect(source).toContain(
      "fs.copyFileSync(path.join(__dirname, 'cli-entry.js'), cliEntryPath)",
    );
    expect(source).not.toContain('const cliEntryContent = `');
  });

  it('keeps bootstrap top-level help commands aligned with config registrations', () => {
    const configSource = readFileSync('src/config/config.ts', 'utf8');
    const commandNameByIdentifier = new Map([
      ['boardCommand', 'board'],
      ['extensionsCommand', 'extensions'],
      ['hooksCommand', 'hooks'],
      ['mcpCommand', 'mcp'],
      ['sandboxCommand', 'sandbox'],
      ['sessionsCommand', 'sessions'],
    ]);
    const registeredIdentifiers = [
      ...configSource.matchAll(/\.command\((\w+Command)\)/g),
    ].map((match) => match[1]!);
    const bootstrapCommands = new Set(
      TOP_LEVEL_COMMANDS.map(([command]) => command.split(' ')[0]),
    );

    expect(registeredIdentifiers).toHaveLength(commandNameByIdentifier.size);
    for (const identifier of registeredIdentifiers) {
      const commandName = commandNameByIdentifier.get(identifier);
      expect(commandName, `missing mapping for ${identifier}`).toBeDefined();
      expect(bootstrapCommands).toContain(commandName);
    }
  });

  it('keeps bootstrap MCP help commands aligned with MCP registrations', () => {
    const mcpSource = readFileSync('src/commands/mcp.ts', 'utf8');
    const commandNameByIdentifier = new Map([
      ['addCommand', 'add'],
      ['removeCommand', 'remove'],
      ['listCommand', 'list'],
      ['reconnectCommand', 'reconnect'],
      ['approveCommand', 'approve'],
      ['rejectCommand', 'reject'],
    ]);
    const registeredIdentifiers = [
      ...mcpSource.matchAll(/\.command\((\w+Command)\)/g),
    ].map((match) => match[1]!);
    const bootstrapCommands = new Set(
      MCP_COMMANDS.map(([command]) => command.split(' ')[0]),
    );

    expect(registeredIdentifiers).toHaveLength(commandNameByIdentifier.size);
    for (const identifier of registeredIdentifiers) {
      const commandName = commandNameByIdentifier.get(identifier);
      expect(commandName, `missing mapping for ${identifier}`).toBeDefined();
      expect(bootstrapCommands).toContain(commandName);
    }
  });
});

describe('bootstrap error handling', () => {
  const savedEnv = {
    NO_COLOR: process.env['NO_COLOR'],
  };

  let stderr: string[];

  beforeEach(() => {
    stderr = [];
    vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => {
      stderr.push(String(chunk));
      return true;
    });
    vi.spyOn(process, 'exit').mockImplementation(((code) => {
      throw new Error(`process.exit:${String(code)}`);
    }) as typeof process.exit);
  });

  afterEach(() => {
    if (savedEnv.NO_COLOR === undefined) {
      delete process.env['NO_COLOR'];
    } else {
      process.env['NO_COLOR'] = savedEnv.NO_COLOR;
    }
    vi.restoreAllMocks();
  });

  it('prints FatalError messages and exits with their code', async () => {
    process.env['NO_COLOR'] = '1';

    await expect(
      handleCriticalError(new FatalError('fatal boom', 42)),
    ).rejects.toThrow('process.exit:42');

    const output = stderr.join('');
    expect(output).toContain('fatal boom');
    expect(output).not.toContain('\x1b[31m');
  });

  it('prints FatalError messages in red when color is enabled', async () => {
    delete process.env['NO_COLOR'];

    await expect(
      handleCriticalError(new FatalError('fatal color', 42)),
    ).rejects.toThrow('process.exit:42');

    expect(stderr.join('')).toContain('\x1b[31mfatal color\x1b[0m');
  });

  it('exits AlreadyReportedError without printing another error', async () => {
    await expect(
      handleCriticalError(new AlreadyReportedError('already printed', 7)),
    ).rejects.toThrow('process.exit:7');

    expect(stderr.join('')).toBe('');
  });

  it('prints unexpected errors with the generic critical header', async () => {
    await expect(
      handleCriticalError(new Error('generic boom')),
    ).rejects.toThrow('process.exit:1');

    const output = stderr.join('');
    expect(output).toContain('An unexpected critical error occurred:');
    expect(output).toContain('generic boom');
  });

  it('recognizes expected PTY race errors', () => {
    expect(
      isExpectedPtyRaceError(
        Object.assign(new Error('read EIO'), { code: 'EIO' }),
      ),
    ).toBe(true);
    expect(isExpectedPtyRaceError(new Error('read EAGAIN'))).toBe(true);
    expect(
      isExpectedPtyRaceError(
        new Error('Cannot resize a pty that has already exited'),
      ),
    ).toBe(true);
    expect(isExpectedPtyRaceError(new Error('other failure'))).toBe(false);
  });

  it('wires uncaughtException PTY race suppression without exiting', async () => {
    let uncaughtHandler: ((error: Error) => void) | undefined;
    vi.spyOn(process, 'on').mockImplementation(((
      event: string | symbol,
      listener: (...args: unknown[]) => void,
    ) => {
      if (event === 'uncaughtException') {
        uncaughtHandler = listener as (error: Error) => void;
      }
      return process;
    }) as typeof process.on);

    await runCliEntryPoint(vi.fn(async () => {}));

    expect(uncaughtHandler).toBeDefined();
    uncaughtHandler?.(Object.assign(new Error('read EIO'), { code: 'EIO' }));
    expect(process.exit).not.toHaveBeenCalled();
    expect(stderr.join('')).toBe('');
  });

  it('routes run failures through the critical error handler', async () => {
    const error = new Error('run failed');
    const run = vi.fn(async () => {
      throw error;
    });
    const handleError = vi.fn(async () => {});

    await runCliEntryPoint(run, handleError);

    expect(handleError).toHaveBeenCalledWith(error);
  });

  it('reports when the critical error handler itself fails', async () => {
    const run = vi.fn(async () => {
      throw new Error('run failed');
    });
    const handleError = vi.fn(async () => {
      throw new Error('handler failed');
    });

    await expect(runCliEntryPoint(run, handleError)).rejects.toThrow(
      'process.exit:1',
    );

    const output = stderr.join('');
    expect(output).toContain('Original error:');
    expect(output).toContain('run failed');
    expect(output).toContain('Error handler failed:');
    expect(output).toContain('handler failed');
  });

  it('wires stampCliEntryEnv into the entry point', () => {
    const source = readFileSync('src/cli.ts', 'utf8');
    const entryPoint = source.slice(
      source.indexOf('export async function runCliEntryPoint'),
    );
    expect(entryPoint).toContain('stampCliEntryEnv()');
    // "First thing in runCliEntryPoint" is the property the doc relies on: the
    // stamp must land before the CLI runs, not merely somewhere in the body —
    // a stamp moved below `await run()` would still pass a contains() check.
    expect(entryPoint.indexOf('stampCliEntryEnv()')).toBeLessThan(
      entryPoint.indexOf('await run()'),
    );
  });
});

describe('shared top-level option definitions', () => {
  it('keeps every definition typed and described so yargs renders them', () => {
    // TOP_LEVEL_HELP_OPTIONS is the union both help builders consume, so one
    // pass covers every definition in the global and default-command maps.
    for (const [name, config] of TOP_LEVEL_HELP_OPTIONS) {
      expect(config.type, `${name} is missing a type`).toBeDefined();
      expect(
        typeof config.description,
        `${name} is missing a description`,
      ).toBe('string');
    }
  });
});
