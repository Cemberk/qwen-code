/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import * as childProcess from 'node:child_process';
import { ApprovalMode, type Config } from '../config/config.js';
import { executeRuntimeShell } from '../sandbox/runtime-shell.js';
import { ToolNames, ToolDisplayNames } from './tool-names.js';
import { ToolErrorType } from './tool-error.js';
import type {
  FileDiff,
  ToolInvocation,
  ToolResult,
  ToolResultDisplay,
  ToolCallConfirmationDetails,
  ToolEditConfirmationDetails,
  ToolExecuteConfirmationDetails,
  ToolConfirmationPayload,
} from './tools.js';
import type { PermissionDecision } from '../permissions/types.js';
import {
  getSessionCommitGeneration,
  registerSessionCommit,
} from '../permissions/destructive-commands.js';
import {
  BaseDeclarativeTool,
  BaseToolInvocation,
  Kind,
  ToolConfirmationOutcome,
} from './tools.js';
import { getErrorMessage, isNodeError } from '../utils/errors.js';
import { truncateToolOutput } from './truncation.js';
import { getCurrentToolCallSource } from '../code-mode/tool-call-runtime.js';
import type {
  ShellExecutionConfig,
  ShellExecutionResult,
  ShellOutputEvent,
  ShellPostPromoteHandlers,
  ShellPostPromoteSettleInfo,
  ShellRawCaptureSink,
} from '../services/shellExecutionService.js';
import {
  getShellAbortReasonKind,
  isSignalTermination,
} from '../services/shellExecutionService.js';
import {
  statusFilePathFor,
  type ShellTaskRegistration,
} from '../services/backgroundShellRegistry.js';
import stripAnsi from 'strip-ansi';
import { formatMemoryUsage } from '../utils/formatters.js';
import type { AnsiOutput } from '../utils/terminalSerializer.js';
import { isSubpaths, makeRelative, shortenPath } from '../utils/paths.js';
import {
  buildShellExecWarnings,
  detectSelfKillCommand,
  getCommandRoot,
  getCommandRoots,
  getShellConfiguration,
  hasShellSubstitution,
  SHELL_SELF_KILL_REJECTION,
  type ShellConfiguration,
  type ShellType,
  splitCommands,
  stripShellWrapper,
} from '../utils/shell-utils.js';
import { parse, type ControlOperator } from 'shell-quote';
import { createDebugLogger } from '../utils/debugLogger.js';
import { checkPriorRead, StructuredToolError } from './priorReadEnforcement.js';
import {
  isShellCommandReadOnlyASTInDirectory,
  extractCommandRules,
} from '../utils/shellAstParser.js';
import {
  applySedSubstitution,
  parseSedEditCommand,
  type SedEditInfo,
} from '../utils/sedEditParser.js';
import {
  detectLineEnding,
  type ReadTextFileResponse,
} from '../services/fileSystemService.js';
import { createPatchSmart, getDiffStat } from './diffOptions.js';

const debugLogger = createDebugLogger('SHELL');
const DEFAULT_SHELL_OUTPUT_THRESHOLD = 30_000;
// Separator between the formatted body and each appended metadata string
// (long-run advisory). The reservation math and the append loop share it so
// the two cannot drift.
const APPENDED_METADATA_SEPARATOR = '\n\n';

function getShellOutputThreshold(config: Config): number {
  return config.isTruncateToolOutputThresholdExplicit()
    ? config.getTruncateToolOutputThreshold()
    : DEFAULT_SHELL_OUTPUT_THRESHOLD;
}

/**
 * Model-facing liveness guidance shared verbatim by both background
 * launch paths (`executeBackground` and the foreground→background
 * promote), so the two copies cannot drift (#7626).
 */
function statusFileGuidance(outputPath: string): string {
  return (
    `status file: ${statusFilePathFor(outputPath)}\n` +
    `To check whether this process is still running, Read the status file (status: running|completed|failed|cancelled). ` +
    `Do NOT infer liveness from the output file: programs often block-buffer stdout when not attached to a TTY, so an empty output file is normal while the process is alive (for live output, re-run with e.g. \`python -u\` or \`stdbuf -oL\`).`
  );
}

/**
 * Strip a single bare trailing `&` (bash background operator) from a
 * command string. Returns the input unchanged if the trailing form is
 * `&&` (logical AND), `\&` (escaped literal `&`), or there is no `&`
 * at the end at all. Linear time, no regex backtracking risk.
 */
function stripTrailingBackgroundAmp(command: string): string {
  const trimmed = command.trimEnd();
  if (!trimmed.endsWith('&')) return command;
  if (trimmed.endsWith('&&')) return command;
  if (trimmed.endsWith('\\&')) return command;
  return trimmed.slice(0, -1).trimEnd();
}

/**
 * Tokenise a single shell-command segment via `shell-quote`. Returns
 * the parsed string tokens with leading env-var assignments and a
 * small allowlist of safe wrappers (`sudo`, `command`, with their
 * flag block consumed) stripped. Returns `null` if the segment
 * doesn't parse — the caller should then skip the segment.
 *
 * Using `shell-quote.parse` (rather than a regex scan) is what makes
 * quoted env values (`FOO="a b" cmd`) tokenise correctly and avoids
 * the polynomial regex behaviour CodeQL flagged on the previous
 * `\S*\s+`-based slicing loop.
 */
function tokeniseSegment(segment: string): string[] | null {
  let tokens: string[];
  try {
    // Pass an env getter that preserves `$NAME` references in tokens
    // rather than collapsing them to `''` (shell-quote's default).
    // Without this, `cd $HOME` parses as `['cd', '']` and the downstream
    // `target.includes('$')` repo-shift detection silently fails: an
    // env-var that points to another repo would get treated as a
    // same-repo no-op and a commit in whatever repo `$HOME`/`$REPO_ROOT`
    // resolves to at runtime would be treated as landing in our cwd.
    // Same problem in `parseGitInvocation` for `git -C $HOME`.
    // Single-quoted forms (`cd '$HOME'`) end up looking like a variable
    // reference too, but in practice nobody creates a directory named
    // literally `$HOME`, so over-flagging is the conservative-correct
    // choice.
    tokens = parse(segment, (key) => '$' + key).filter(
      (t): t is string => typeof t === 'string',
    );
  } catch (e) {
    debugLogger.warn(
      `tokeniseSegment: parse failed for "${segment.slice(0, 80)}": ${
        e instanceof Error ? e.message : String(e)
      }`,
    );
    return null;
  }
  let i = 0;
  // Skip env-var assignments (KEY=value). If the key is one of the
  // git-repo-redirecting variables, refuse to tokenise the segment at
  // all: `GIT_DIR=elsewhere/.git git commit ...` runs against another
  // repository, so treating it as an in-cwd commit would be wrong.
  while (i < tokens.length) {
    const key = leadingEnvAssignmentKey(tokens[i]!);
    if (key === null) break;
    if (GIT_ENV_SHIFTS_REPO.has(key)) return null;
    i++;
  }
  // Strip a single safe wrapper, then any leading flag tokens it
  // took. Sudo's value-taking flags (`-u user`, `-g group`,
  // `-h host`, `-D path`, `-r role`, `-t type`) consume the next
  // argv slot, so without explicitly knowing which take values we'd
  // leave e.g. `user` standing in for the program in
  // `sudo -u user git commit ...`. `command` doesn't take any flag
  // values. `env` accepts both flags (`-i`, `-S`, `-u name`) AND
  // `KEY=VALUE` argv entries before the program — both need
  // skipping so `env GIT_COMMITTER_DATE=now git commit ...` resolves
  // to `git`.
  if (tokens[i] === 'sudo' || tokens[i] === 'command' || tokens[i] === 'env') {
    const wrapper = tokens[i];
    i++;
    while (i < tokens.length && tokens[i]!.startsWith('-')) {
      const flag = tokens[i]!;
      i++;
      // `env -C DIR` / `env --chdir DIR` (GNU coreutils 8.30+) and
      // `sudo -D DIR` / `sudo --chdir DIR` (Linux sudo with --chdir)
      // both relocate the working directory before exec. Treat the
      // segment as repo-shifting (same contract as a leading
      // `GIT_DIR=...` assignment) so a commit that landed in a
      // different repository is not treated as an in-cwd commit.
      //
      // Also catch the attached-value forms `--chdir=DIR` and the
      // short-form `-CDIR` / `-DDIR` that shell-quote tokenises as a
      // single argv entry. Without this, `sudo --chdir=/tmp git
      // commit` and `env -C/tmp git commit` would both pass through
      // the bare-flag check (which is set-membership, not prefix-
      // match) and be treated as in-cwd commits.
      const shiftSet =
        wrapper === 'env'
          ? ENV_FLAGS_SHIFT_CWD
          : wrapper === 'sudo'
            ? SUDO_FLAGS_SHIFT_CWD
            : null;
      if (shiftSet && isShiftCwdFlag(flag, shiftSet)) {
        return null;
      }
      // Value-taking flag tables, per wrapper: `sudo -u user`,
      // `env -u NAME` (unset), `env -S string` (split-string args).
      // `command` has no value-taking options in this allowlist.
      // Without skipping the value, `env -u FOO git commit ...`
      // would leave `FOO` as `tokens[0]` and the parser would treat
      // it as the program — masking the real `git commit`.
      const takesValue =
        (wrapper === 'sudo' && SUDO_FLAGS_WITH_VALUE.has(flag)) ||
        (wrapper === 'env' && ENV_FLAGS_WITH_VALUE.has(flag));
      if (takesValue && i < tokens.length) {
        i++;
      }
    }
    // `env` puts KEY=VALUE pairs between its flags and the real
    // program, so skip those too. Same git-repo-redirect bail as
    // above applies — a `env GIT_DIR=elsewhere git commit` segment
    // does not land in our cwd.
    if (wrapper === 'env') {
      while (i < tokens.length) {
        const key = leadingEnvAssignmentKey(tokens[i]!);
        if (key === null) break;
        if (GIT_ENV_SHIFTS_REPO.has(key)) return null;
        i++;
      }
    }
  }
  return tokens.slice(i);
}

const EXIT_ONE_IS_NOT_ERROR_COMMANDS = new Set([
  'grep',
  'rg',
  'diff',
  'test',
  '[',
  '[[',
]);

const PIPELINE_ALLOWED_OPERATORS = new Set<ControlOperator['op']>([
  '|',
  '|&',
  '<<<',
  '>>',
  '>&',
  '<&',
  '<',
  '>',
]);

function getExitStatusSegment(command: string): string | null {
  const segments = splitCommands(command);
  if (segments.length === 1) return segments[0]!;

  try {
    const operators = parse(command, (key) => '$' + key).filter(
      (token): token is ControlOperator =>
        typeof token === 'object' && token !== null && 'op' in token,
    );
    if (
      !operators.some(({ op }) => op === '|' || op === '|&') ||
      operators.some(({ op }) => !PIPELINE_ALLOWED_OPERATORS.has(op))
    ) {
      return null;
    }
  } catch {
    return null;
  }

  return segments.at(-1) ?? null;
}

function isShellExitError(command: string, exitCode: number | null) {
  if (exitCode === null || exitCode === 0) return false;
  if (exitCode >= 2) return true;

  const exitStatusSegment = getExitStatusSegment(command);
  if (!exitStatusSegment) return true;

  const tokens = tokeniseSegment(exitStatusSegment);
  const executable = tokens?.[0];
  if (!executable) return true;

  const commandName = path
    .basename(path.win32.basename(executable))
    .replace(/\.(?:exe|cmd|bat)$/i, '');
  return !EXIT_ONE_IS_NOT_ERROR_COMMANDS.has(commandName);
}

const SUDO_FLAGS_WITH_VALUE = new Set([
  '-u',
  '-g',
  '-h',
  '-D',
  '-r',
  '-t',
  '-C',
  '--user',
  '--group',
  '--host',
  '--chdir',
  '--role',
  '--type',
]);

// `env`'s value-taking flags. `-u NAME` unsets a variable;
// `-S "string"` splits a single string into args. Without skipping
// the value, `env -u FOO git commit ...` would leave `FOO` as the
// next token and the parser would treat it as the program.
const ENV_FLAGS_WITH_VALUE = new Set(['-u', '--unset', '-S', '--split-string']);

// `env`'s flags that relocate the working directory (and therefore
// the implicit repository) before exec — GNU coreutils 8.30+'s
// `-C DIR` / `--chdir DIR`. A `git commit` inside such an env wrapper
// runs against whatever repo lives at DIR, NOT our cwd, so we must
// refuse the segment outright the same way `cd /elsewhere && git
// commit` is refused. Returning null from tokeniseSegment keeps the
// segment's commit from being treated as landing in our cwd.
const ENV_FLAGS_SHIFT_CWD = new Set(['-C', '--chdir']);

// `sudo`'s flags that relocate the working directory before exec.
// Linux sudo's `-D DIR` / `--chdir DIR` (1.9.2+) makes the inner
// command run in DIR, which means a `git commit` underneath it
// targets DIR's repo, not ours. Refuse the segment.
const SUDO_FLAGS_SHIFT_CWD = new Set(['-D', '--chdir']);

/**
 * Match a flag token against a SHIFT_CWD set, including attached-value
 * forms. Bare `--chdir`/`-D`/`-C` are caught by direct set membership;
 * the long attached form `--name=value` matches when `--name` is in the
 * set, and the short attached form `-Xvalue` matches when `-X` is in
 * the set AND the token is longer than the flag (so `-D` alone doesn't
 * spuriously match `-D` against itself twice).
 */
function isShiftCwdFlag(flag: string, set: ReadonlySet<string>): boolean {
  if (set.has(flag)) return true;
  for (const f of set) {
    if (f.startsWith('--') && flag.startsWith(f + '=')) return true;
    if (
      f.length === 2 &&
      f.startsWith('-') &&
      flag.startsWith(f) &&
      flag.length > 2
    ) {
      return true;
    }
  }
  return false;
}

/**
 * Environment variables that redirect git's repository selection. A
 * leading `GIT_DIR=...`, `GIT_WORK_TREE=...`, etc. on a command makes
 * the inner `git commit` operate on a different repo than our cwd
 * suggests, so it must not be treated as an in-cwd commit.
 * tokeniseSegment refuses to parse such segments so the caller skips
 * them.
 *
 * Identity / date variables (`GIT_AUTHOR_*`, `GIT_COMMITTER_*`) are
 * deliberately NOT in this set — they tweak the commit's metadata
 * but don't move it to another repo.
 */
// `GIT_NAMESPACE` is intentionally NOT here: it prefixes ref names
// within the same repository, but the working tree and object store
// are unchanged, so a `git commit` under it still lands in our cwd's
// repo. The set covers ONLY variables that change which on-disk
// repository git acts on.
const GIT_ENV_SHIFTS_REPO = new Set([
  'GIT_DIR',
  'GIT_WORK_TREE',
  'GIT_COMMON_DIR',
  'GIT_INDEX_FILE',
]);

/**
 * Match the `KEY=` prefix of a `KEY=value` token and return KEY,
 * or null if the token isn't a leading env-var assignment. Centralised
 * so the leading-env-strip and the env-wrapper KEY=VALUE strip share
 * the same parsing.
 */
function leadingEnvAssignmentKey(token: string): string | null {
  const m = /^([A-Za-z_][A-Za-z0-9_]*)=/.exec(token);
  return m ? m[1]! : null;
}

/**
 * Walk a `git ...` token sequence past git's global flags
 * (`-c key=val`, `-C path`, `--no-pager`, `--git-dir`, `--work-tree`,
 * `--namespace`, etc.) to find the actual subcommand. Without this,
 * `git -c k=v commit -m x` and `git --no-pager commit -m x` would
 * silently slip past a fixed-position check at index 1.
 *
 * `changesCwd` is true when any of the consumed flags would relocate
 * the working directory (`-C`, `--git-dir`, `--work-tree`).
 */
// Two-token global flags whose second token is consumed as a value.
const GIT_GLOBAL_FLAGS_TAKES_VALUE = new Set([
  '-c',
  '-C',
  '--git-dir',
  '--work-tree',
  '--namespace',
  '--exec-path',
  '--config-env',
  '--super-prefix',
  '--list-cmds',
]);
// Flags whose presence shifts cwd interpretation.
const GIT_GLOBAL_FLAGS_SHIFTS_CWD = new Set(['-C', '--git-dir', '--work-tree']);

// `-C .` (and `./`, attached `-C.`) are no-op cwd shifts; treating
// them as cwd-changing would miss `git -C . commit` (a common alias for
// "explicit current dir").
//
// Empty string is intentionally NOT treated as no-op even though
// `-C "" commit` is technically a no-op — `shell-quote` returns ''
// for any env-var or command-substitution that it cannot resolve at
// parse time (e.g. `-C $HOME`, `-C $REPO_ROOT`, `-C $UNSET`), so
// the literal-empty and the unknown-env-var cases are
// indistinguishable from our static view. Treating them as no-op
// would treat a commit that lands in whatever repo
// `$HOME`/`$REPO_ROOT` resolves to at runtime as an in-cwd commit.
// Conservative skip is the safer call; the only misses are
// `-C $PWD commit` (rare) and literal `-C "" commit` (malformed and
// won't actually commit).
//
// Same conservatism applies to literal absolute paths that happen
// to resolve to cwd at runtime — we only have the argv at parse
// time, so the cheap textual comparison is what we can reasonably
// check here.
function isNoopCwdTarget(target: string): boolean {
  const t = target.trim();
  return t === '.' || t === './';
}

function parseGitInvocation(tokens: string[]): {
  subcommand: string | undefined;
  changesCwd: boolean;
} {
  let i = 1; // skip 'git'
  let changesCwd = false;
  while (i < tokens.length) {
    const t = tokens[i]!;
    if (GIT_GLOBAL_FLAGS_TAKES_VALUE.has(t)) {
      const value = tokens[i + 1] ?? '';
      // For `-C` specifically, the value is the new cwd. `-C .` is
      // a no-op so don't flip changesCwd. (`--git-dir`/`--work-tree`
      // path arguments aren't cwd in the same sense — leave those
      // unconditional.)
      if (t === '-C') {
        if (!isNoopCwdTarget(value)) changesCwd = true;
      } else if (GIT_GLOBAL_FLAGS_SHIFTS_CWD.has(t)) {
        changesCwd = true;
      }
      i += 2;
      continue;
    }
    // Attached-value form: `--git-dir=path`, `--work-tree=path`, etc.
    if (t.startsWith('--git-dir=') || t.startsWith('--work-tree=')) {
      changesCwd = true;
      i++;
      continue;
    }
    // Attached-value form for `-C`: `git -C/path commit ...` and
    // `git -C. commit ...`. Git accepts both `-C path` (handled
    // above by TAKES_VALUE) and the concatenated form. shell-quote
    // tokenises the latter as a single `-Cpath` token.
    if (t.length > 2 && t.startsWith('-C')) {
      const value = t.slice(2);
      if (!isNoopCwdTarget(value)) changesCwd = true;
      i++;
      continue;
    }
    // Other long/short flag (no separate arg, e.g. --no-pager,
    // --version, --bare, -p).
    if (t.startsWith('-')) {
      i++;
      continue;
    }
    // First non-flag is the subcommand.
    return { subcommand: t, changesCwd };
  }
  return { subcommand: undefined, changesCwd };
}

/**
 * Leading tokens the loose commit recogniser skips over: shell
 * control-flow keywords and noise words that `splitCommands` leaves at
 * the front of a segment because it splits on operators only and has
 * no shell-grammar notion — `if true; then git commit` yields the
 * segment `then git commit`, `while …; do git commit; done` yields
 * `do git commit`, and `time git commit` / `! git commit` never get
 * split at all. The amend guard recognises every one of these
 * spellings, so registration must recognise them too (#12514).
 */
const COMMIT_RECOGNITION_LEADING_NOISE: ReadonlySet<string> = new Set([
  'if',
  'then',
  'else',
  'elif',
  'fi',
  'while',
  'until',
  'for',
  'do',
  'done',
  'time',
  '!',
  '{',
  '}',
]);

/**
 * The program recogniser used by `commitLandsInCwd` (#12514): skip leading
 * control-flow/noise keywords and match the program on its
 * basename (see `programBasename`), so `then git commit`,
 * `time git commit`, `! git commit` and `/usr/bin/git commit` all
 * resolve to the `git` invocation a `tokens[0] === 'git'` check
 * misses. Returns the token slice starting at the recognised program,
 * or `null` when the segment is nothing but noise. The slice keeps the
 * program token at index 0 so `parseGitInvocation` applies unchanged.
 */
function skipCommitRecognitionNoise(tokens: string[]): string[] | null {
  let i = 0;
  while (
    i < tokens.length &&
    COMMIT_RECOGNITION_LEADING_NOISE.has(tokens[i]!)
  ) {
    i++;
  }
  if (i >= tokens.length) return null;
  return tokens.slice(i);
}

/**
 * Basename a program token and drop a Windows `.exe` suffix.
 *
 * `getCommandRoot` stops at the basename and keeps the suffix (pinned
 * as `bar.exe` by `utils/shell-utils.test.ts`), so this deliberately
 * goes one step further: recognition here is purely textual —
 * `shell.ts` has no `process.platform` branch — and
 * `"C:\Program Files\Git\cmd\git.exe" commit` is the spelling a
 * Windows session really produces. Without the strip neither `git`
 * branch fires, the commit lands unregistered, and the follow-up bare
 * `git commit --amend` is hard-blocked with the false reason #12514
 * set out to remove. Same normalisation the guard side already
 * applies (`dangerousRules.stripWindowsExecutableSuffix`).
 */
function programBasename(program: string): string {
  const base = program.split(/[\\/]/).pop()!;
  return base.endsWith('.exe') ? base.slice(0, -'.exe'.length) : base;
}

/**
 * Classify whether a command chain (potentially compound) contains a
 * `git commit` invocation that lands in the tool's initial cwd — i.e.
 * whether it is safe to capture HEAD in our cwd for session-commit
 * registration (`trackSessionCommit`).
 *
 * Program recognition is loose (#12514): leading control-flow/noise
 * keywords are skipped and the program is matched on its basename (see
 * `skipCommitRecognitionNoise`), so `if …; then git commit; fi`,
 * `time git commit`, `! git commit` and `/usr/bin/git commit` all
 * resolve to the `git` invocation they execute. The amend guard
 * recognises those spellings, so every gate fed by this walk must too
 * — a commit the guard would block must be a commit that can register.
 *
 * Walks segments in order so a `cd` AFTER an in-cwd commit doesn't
 * invalidate that commit; only a `cd` (or `git -C` /
 * `--git-dir` / `--work-tree`) BEFORE the commit shifts safety. The
 * loose recognition also covers a `cd` hidden behind a noise keyword
 * (`if …; then cd /elsewhere; fi; git commit`), which a
 * `tokens[0]`-only walk would miss.
 *
 * `cwdShifted` is intentionally a one-way latch — it isn't reset on
 * a subsequent `cd .` or `cd ..`, so harmless cd cycles like
 * `cd src && cd .. && git commit -m x` will conservatively skip
 * registration. The trade-off matches the wrong-repo guard's intent
 * (better miss than register a commit from an unrelated repo).
 */
function commitLandsInCwd(command: string): boolean {
  let hasCommit = false;
  let inCwd = false;
  let cwdShifted = false;

  for (const sub of splitCommands(command)) {
    const rawTokens = tokeniseSegment(sub);
    if (!rawTokens || rawTokens.length === 0) continue;

    const tokens = skipCommitRecognitionNoise(rawTokens);
    if (!tokens) continue;
    const program = programBasename(tokens[0]!);

    if (program === 'cd' || program === 'pushd') {
      // A cd / pushd before any commit might redirect a later
      // `git commit` into a different repo. A cd AFTER the commit
      // doesn't matter for the commit we already saw.
      //
      // A heuristic relaxation: relative cd targets that don't escape
      // upward (no `..`, no absolute path, no env-var/$home expansion)
      // almost always stay within the same repo. The very common
      // `cd subdir && git commit -m "..."` flow is the motivating case
      // — same repo, same toplevel, registration is still safe. Only
      // mark as shifted when the target *could* land us in a different
      // repo. We can't be 100% certain without running `git rev-parse
      // --show-toplevel` after the cd, which would require a synchronous
      // fs/exec call that the rest of this walk avoids — the heuristic
      // covers the common case and stays conservative on the rest.
      if (!hasCommit && cdTargetMayChangeRepo(tokens)) cwdShifted = true;
      continue;
    }
    if (program === 'popd') {
      // `popd` returns to a previous directory in the bash dir-stack.
      // Without tracking the stack we can't know whether the resulting
      // cwd is the same repo or a different one — treat conservatively
      // as a shift before any commit.
      if (!hasCommit) cwdShifted = true;
      continue;
    }

    if (program === 'git') {
      const { subcommand, changesCwd } = parseGitInvocation(tokens);
      if (subcommand === 'commit') {
        hasCommit = true;
        // The commit lands in our cwd only if no preceding cd shifted
        // us and this very invocation didn't redirect via -C/--git-dir.
        if (!cwdShifted && !changesCwd) inCwd = true;
      } else if (changesCwd && !hasCommit) {
        // `git -C /path status` and friends signal cwd-elsewhere
        // intent; subsequent in-cwd commits in this chain are unusual
        // enough to be conservative about.
        cwdShifted = true;
      }
    }
  }

  return inCwd;
}

/**
 * Heuristic: does this `cd` invocation potentially redirect us into
 * a different repository? Used by `commitLandsInCwd` to decide
 * whether a subsequent `git commit` in the same chain still lands in
 * our cwd.
 *
 * Returns true (conservative — assume shift) when the target is
 * absolute, escapes upward (`..`), goes to `$HOME` / `~`, contains an
 * env-var (we can't resolve it statically), or is missing entirely
 * (`cd` alone goes to `$HOME`). Plain relative paths like `cd src`,
 * `cd ./packages/foo`, or `cd subdir/nested` are treated as in-repo.
 */
function cdTargetMayChangeRepo(tokens: string[]): boolean {
  // tokens[0] is 'cd'. The next non-flag token is the target.
  let i = 1;
  while (i < tokens.length && tokens[i]!.startsWith('-')) i++;
  const target = tokens[i];
  // `cd` with no argument goes to $HOME.
  if (target === undefined) return true;
  if (target.startsWith('/')) return true;
  if (target.startsWith('~')) return true;
  // Env-var reference (e.g. `$HOME`, `$REPO`) — can't resolve here.
  if (target.includes('$')) return true;
  // `..`, `../..`, `..\\foo` etc. could escape the repo root.
  if (target === '..') return true;
  if (target.startsWith('../') || target.startsWith('..\\')) return true;
  // Embedded parent-dir traversal can also escape: `foo/../../escape`,
  // `./..`, `nested/..`, etc. Catching `/..` and `\..` anywhere in
  // the path covers both POSIX and Windows separators without
  // false-positiving on legitimate names that happen to contain `..`
  // (which only escape when followed by a separator).
  if (target.includes('/..') || target.includes('\\..')) return true;
  // `-` is bash's "previous directory" — could be anywhere.
  if (target === '-') return true;
  return false;
}

export const OUTPUT_UPDATE_INTERVAL_MS = 1000;
export const DEFAULT_SHELL_HEARTBEAT_INTERVAL_MS = 10_000;
const DEFAULT_FOREGROUND_TIMEOUT_MS = 120000;

/**
 * Time we give SIGTERM to settle a promoted-then-cancelled child
 * before escalating to SIGKILL. Mirrors `SIGKILL_TIMEOUT_MS` inside
 * `ShellExecutionService` (which runs the same SIGTERM-then-SIGKILL
 * pattern on the non-promote cancel path) but kept as a separate
 * constant here so tuning one doesn't silently change the other.
 */
const PROMOTE_CANCEL_SIGKILL_TIMEOUT_MS = 200;

/**
 * Maximum wait for the output stream flush before transitioning the
 * registry. Shared by the promote settle path and `executeBackground`'s
 * settle path — see `endStreamThenSettle`.
 */
const OUTPUT_FLUSH_TIMEOUT_MS = 10_000;

/**
 * End `stream` and run `settle` exactly once after its queued writes
 * have been flushed to the underlying fd (`'finish'`). `stream.end()`
 * is asynchronous — pending writes can still be in the libuv queue
 * when it returns, so transitioning the registry before the flush
 * lets `/tasks` consumers (and the status sidecar) observe a terminal
 * status and read the output file BEFORE the trailing bytes are on
 * disk, producing truncated logs. `'error'` covers a late EIO /
 * ENOSPC racing `.end()` itself, an already-destroyed or
 * already-finished stream short-circuits (neither event would ever
 * fire on it), and the timer backstops a stream wedged mid-flush —
 * whichever lands first, `settle` runs exactly once.
 */
function endStreamThenSettle(
  stream: fs.WriteStream,
  origin: 'promote' | 'background',
  shellId: string,
  settle: () => void,
): void {
  let settled = false;
  let flushTimer: ReturnType<typeof setTimeout> | null = null;
  const runOnce = () => {
    if (settled) return;
    settled = true;
    if (flushTimer !== null) clearTimeout(flushTimer);
    settle();
  };
  // A destroyed or already-finished stream emits neither 'finish' nor
  // 'error' — `.end()` on it is a silent no-op (Node only delivers
  // ERR_STREAM_DESTROYED to an `end()` callback), so waiting would
  // always burn the full timeout with nothing left to flush.
  // `writableFinished`, not `writableEnded`: the latter is already
  // true mid-flush, which is exactly the window this helper waits for.
  if (stream.destroyed || stream.writableFinished) {
    runOnce();
    return;
  }
  try {
    flushTimer = setTimeout(() => {
      debugLogger.warn(
        `${origin}: output stream flush timed out for ${shellId} after ${OUTPUT_FLUSH_TIMEOUT_MS}ms — transitioning registry without flush confirmation`,
      );
      runOnce();
    }, OUTPUT_FLUSH_TIMEOUT_MS);
    flushTimer.unref();
    stream.once('finish', runOnce);
    stream.once('error', runOnce);
    stream.end();
  } catch (closeErr) {
    debugLogger.warn(
      `${origin}: closing output stream on settle threw: ${getErrorMessage(closeErr)}`,
    );
    runOnce();
  }
}

/**
 * PR-2.5 slots shared between the foreground `execute()` postPromote
 * handlers and the post-resolve `handlePromotedForeground` finalizer.
 * The handlers fire on the service side as soon as promote happens;
 * the finalizer runs after `await resultPromise` returns. They race —
 * the buffer + settle-queue absorb the race so neither chunks nor the
 * eventual exit info are lost. See `executeForeground` for the wiring
 * and `handlePromotedForeground` for the drain logic.
 */
interface PromoteArtifacts {
  /**
   * Chunks observed by `postPromote.onData` BEFORE the stream is
   * open. Drained into the stream once `handlePromotedForeground`
   * opens it. After drain this stays empty for the rest of the run.
   */
  buffer: string[];
  /**
   * Append-mode write stream to `bg_xxx.output`. Null until
   * `handlePromotedForeground` opens it. Closed by `onSettleWired`.
   */
  stream: fs.WriteStream | null;
  /**
   * Latched true when the output stream is no longer accepting writes.
   * Two paths set it:
   *
   * 1. Stream open failed (`fs.createWriteStream` threw OR fired an
   *    async `'error'` event before bytes could land). The stream
   *    will never reopen; future `onData` chunks must drop.
   * 2. Settle has fired and `onSettleWired` has drained the buffer
   *    and called `stream.end()`. The stream is closing; any chunk
   *    that arrives during the `.end()` flush window (rare but
   *    possible on PTY when kernel buffers deliver late) MUST drop
   *    rather than be pushed into the buffer — at this point the
   *    buffer has no remaining drain path (the foreground finalizer
   *    has returned).
   *
   * Without this flag the buffer would grow without bound under a
   * sustained child whose output file we can't open, OR strand
   * late-arriving post-settle bytes in an undrainable buffer.
   */
  streamClosed: boolean;
  /**
   * Settle handler installed by `handlePromotedForeground` once the
   * registry entry exists. Null until then; `onSettle` calls below
   * queue into `settleQueued` if this isn't yet set.
   */
  onSettleWired: ((info: ShellPostPromoteSettleInfo) => void) | null;
  /**
   * Settle info captured by `postPromote.onSettle` before the wired
   * handler was installed. `handlePromotedForeground` checks this and
   * fires the wired handler synchronously after registering.
   */
  settleQueued: ShellPostPromoteSettleInfo | null;
}

// Long-run advisory threshold: half the EFFECTIVE foreground timeout
// (not the default), computed per-invocation by `longRunThresholdFor`.
// Couples to whichever timeout actually governs THIS command — so a
// user who sets `timeout: 600_000` (10 min) gets the advisory at 5 min,
// not at 60s. The 1/2 ratio is chosen so the hint surfaces well before
// the timeout would hard-kill, but late enough that normal foreground
// commands (under the 120s default) don't trigger it before ~60s.
//
// Floor of 1000ms guards the pathological tiny-positive-timeout edge.
// `timeout <= 0` is already rejected by `validateToolParamValues` so
// only positive values reach here, but `timeout: 1` (or any value < 2)
// would otherwise produce `Math.floor(timeout / 2) = 0` and make
// `elapsedMs >= 0` fire on every invocation showing "ran for 0s",
// surfacing the hint before the command had a chance to fail by
// timing out.
const MIN_LONG_RUN_THRESHOLD_MS = 1000;
function longRunThresholdFor(effectiveTimeoutMs: number): number {
  return Math.max(
    MIN_LONG_RUN_THRESHOLD_MS,
    Math.floor(effectiveTimeoutMs / 2),
  );
}

const FOREGROUND_TIMEOUT_WARNING_LEAD_MS = 15_000;
const FOREGROUND_TIMEOUT_WARNING =
  'Warning: this command is about to time out. In the interactive TUI, press Ctrl+B to keep it running in the background.';

function foregroundTimeoutWarningDelayFor(
  effectiveTimeoutMs: number,
  elapsedMs: number,
): number | null {
  if (effectiveTimeoutMs <= FOREGROUND_TIMEOUT_WARNING_LEAD_MS) {
    return null;
  }
  const remainingMs = effectiveTimeoutMs - elapsedMs;
  if (remainingMs <= 0) {
    return null;
  }
  return Math.max(0, remainingMs - FOREGROUND_TIMEOUT_WARNING_LEAD_MS);
}

function appendForegroundTimeoutWarning(
  output: string | AnsiOutput,
): string | AnsiOutput {
  if (typeof output === 'string') {
    return output
      ? `${output}\n\n${FOREGROUND_TIMEOUT_WARNING}`
      : FOREGROUND_TIMEOUT_WARNING;
  }

  return [
    ...output,
    [
      {
        text: FOREGROUND_TIMEOUT_WARNING,
        bold: true,
        italic: false,
        underline: false,
        dim: false,
        inverse: false,
        fg: '#ff5555',
        bg: '',
      },
    ],
  ];
}

/**
 * Format the long-run advisory appended to long foreground commands.
 * Exported so tests and any future consumer (e.g. an alternative
 * renderer) can render the same text without duplicating the threshold
 * logic.
 *
 * Wording deliberately keeps the dialog mention conditional ("when
 * running interactively") so the LLM doesn't relay misleading guidance
 * to non-TTY users (`-p` headless / SDK consumers, where no
 * dialog or footer pill exists). `/tasks` and the on-disk output file
 * work in every mode.
 */
export function buildLongRunningForegroundHint(elapsedMs: number): string {
  const seconds = Math.round(elapsedMs / 1000);
  return (
    `Note: this foreground command ran for ${seconds}s. ` +
    `Next time you run a similar long-running process (build watchers, ` +
    `dev servers, soak tests, polling loops), pass \`is_background: true\` ` +
    `so the agent isn't blocked while the command runs. ` +
    `(This is forward-looking guidance for FUTURE invocations — do NOT ` +
    `re-run the command that just completed; for stateful operations ` +
    `like deploys, migrations, or git push, that would cause double ` +
    `side effects.) The output of background runs stays inspectable ` +
    `via /tasks (text, any mode) or the on-disk output file; in ` +
    `interactive mode the Background tasks dialog also has a per-entry ` +
    `detail view + live updates.`
  );
}

type BlockedSleepPatternDetails = {
  description: string;
  isStandalone: boolean;
  intentionalSleepRejection?: string;
};

function detectBlockedSleepPatternDetails(
  command: string,
): BlockedSleepPatternDetails | null {
  // Strip trailing shell comments first; otherwise `sleep 5 # wait` would
  // present `# wait` as the suffix, which `getSleepSequentialSeparator`
  // rejects (only &&/||/;/\n are recognized), letting the foreground sleep
  // bypass the guard. Shell ignores top-level trailing comments, so for the
  // purposes of detection they are equivalent to end-of-command.
  const { command: uncommentedCommand, comment } =
    splitTrailingShellComment(command);
  const trimmed = uncommentedCommand.trim();
  if (!trimmed.startsWith('sleep')) return null;
  const afterSleep = trimmed.slice('sleep'.length);
  if (!afterSleep || !/\s/.test(afterSleep[0]!)) return null;

  let index = 0;
  while (index < afterSleep.length && /\s/.test(afterSleep[index]!)) {
    index++;
  }
  const durationStart = index;
  while (
    index < afterSleep.length &&
    !/\s/.test(afterSleep[index]!) &&
    ![';', '&', '|', '\n'].includes(afterSleep[index]!)
  ) {
    index++;
  }

  const durationToken = afterSleep.slice(durationStart, index);
  const secs = parseSleepDurationToSeconds(durationToken);
  if (secs === null || secs < 2) return null;

  const suffix = afterSleep.slice(index);
  const separator = getSleepSequentialSeparator(suffix);
  if (separator === null) return null;

  const rest = separator.rest.trim();
  const isStandalone = !rest;
  const description = rest
    ? `sleep ${durationToken} followed by: ${rest}`
    : `standalone sleep ${durationToken}`;
  const trimmedComment = comment?.trim();
  if (
    isStandalone &&
    trimmedComment?.startsWith(INTENTIONAL_SLEEP_COMMENT_PREFIX)
  ) {
    const reason = getIntentionalSleepReason(trimmedComment);
    if (reason === null) {
      return {
        description,
        isStandalone,
        intentionalSleepRejection:
          'The intentional-sleep comment was recognized, but the reason is too short; explain why the delay is needed after `intentional-sleep:`.',
      };
    }
    if (secs > MAX_INTENTIONAL_SLEEP_SECONDS) {
      return {
        description,
        isStandalone,
        intentionalSleepRejection:
          'The intentional-sleep comment was recognized, but foreground sleeps over 10 minutes are not allowed; use is_background: true or Monitor for longer waits.',
      };
    }
    debugLogger.debug('intentional sleep allowed', {
      durationSeconds: secs,
      reason,
    });
    return null;
  }
  return { description, isStandalone };
}

const INTENTIONAL_SLEEP_COMMENT_PREFIX = 'intentional-sleep:';
const MAX_INTENTIONAL_SLEEP_SECONDS = 10 * 60;
// Require a real reason, not a trivial opt-out like "wait".
const MIN_INTENTIONAL_SLEEP_REASON_LENGTH = 8;

function getIntentionalSleepReason(trimmedComment: string): string | null {
  const reason = trimmedComment
    .slice(INTENTIONAL_SLEEP_COMMENT_PREFIX.length)
    .trim();
  return reason.length >= MIN_INTENTIONAL_SLEEP_REASON_LENGTH ? reason : null;
}

function parseSleepDurationToSeconds(token: string): number | null {
  if (!token) return null;

  let index = 0;
  let seenDigit = false;
  let seenDot = false;
  while (index < token.length) {
    const char = token[index]!;
    if (char >= '0' && char <= '9') {
      seenDigit = true;
      index++;
      continue;
    }
    if (char === '.' && !seenDot) {
      seenDot = true;
      index++;
      continue;
    }
    break;
  }

  if (!seenDigit) return null;
  const value = Number.parseFloat(token.slice(0, index));
  if (!Number.isFinite(value)) return null;

  const unit = token.slice(index).toLowerCase();
  switch (unit || 's') {
    case 'ms':
      return value / 1000;
    case 's':
      return value;
    case 'm':
      return value * 60;
    case 'h':
      return value * 60 * 60;
    case 'd':
      return value * 60 * 60 * 24;
    default:
      return null;
  }
}

function getSleepSequentialSeparator(suffix: string): { rest: string } | null {
  let index = 0;
  while (
    index < suffix.length &&
    suffix[index] !== '\n' &&
    /\s/.test(suffix[index]!)
  ) {
    index++;
  }

  const restWithSeparator = suffix.slice(index);
  if (!restWithSeparator) return { rest: '' };
  if (
    restWithSeparator.startsWith('&&') ||
    restWithSeparator.startsWith('||')
  ) {
    return { rest: restWithSeparator.slice(2) };
  }
  if (restWithSeparator[0] === ';' || restWithSeparator[0] === '\n') {
    return { rest: restWithSeparator.slice(1) };
  }
  return null;
}

function splitTrailingShellComment(
  command: string,
  keepCommandsAfterCommentNewline = true,
): {
  command: string;
  comment: string | null;
} {
  let inSingleQuote = false;
  let inDoubleQuote = false;
  let inBacktick = false;
  let escapeNext = false;
  let commandSubstitutionDepth = 0;

  for (let i = 0; i < command.length; i++) {
    const ch = command[i]!;

    if (inSingleQuote) {
      if (ch === "'") inSingleQuote = false;
      continue;
    }

    if (inBacktick) {
      if (escapeNext) {
        escapeNext = false;
        continue;
      }
      if (ch === '\\') {
        escapeNext = true;
        continue;
      }
      if (ch === '`') inBacktick = false;
      continue;
    }

    if (inDoubleQuote) {
      if (escapeNext) {
        escapeNext = false;
        continue;
      }
      if (ch === '\\') {
        escapeNext = true;
        continue;
      }
      if (ch === '"') {
        inDoubleQuote = false;
        continue;
      }
      if (ch === '$' && command[i + 1] === '(') {
        commandSubstitutionDepth++;
        i++;
        continue;
      }
      if (ch === ')' && commandSubstitutionDepth > 0) {
        commandSubstitutionDepth--;
      }
      continue;
    }

    if (escapeNext) {
      escapeNext = false;
      continue;
    }
    if (ch === '\\') {
      escapeNext = true;
      continue;
    }
    if (ch === "'") {
      inSingleQuote = true;
      continue;
    }
    if (ch === '"') {
      inDoubleQuote = true;
      continue;
    }
    if (ch === '`') {
      inBacktick = true;
      continue;
    }
    if (ch === '$' && command[i + 1] === '(') {
      commandSubstitutionDepth++;
      i++;
      continue;
    }
    if (ch === ')' && commandSubstitutionDepth > 0) {
      commandSubstitutionDepth--;
      continue;
    }
    if (
      ch === '#' &&
      commandSubstitutionDepth === 0 &&
      (i === 0 || /\s/.test(command[i - 1]!))
    ) {
      const newlineIndex = command.indexOf('\n', i + 1);
      return {
        command:
          newlineIndex === -1 || !keepCommandsAfterCommentNewline
            ? command.slice(0, i)
            : command.slice(0, i) + command.slice(newlineIndex),
        comment:
          newlineIndex === -1
            ? command.slice(i + 1)
            : command.slice(i + 1, newlineIndex),
      };
    }
  }

  return { command, comment: null };
}

function trimTrailingShellComment(command: string): string {
  return splitTrailingShellComment(command, false).command;
}

function hasTopLevelTrailingBackgroundOperator(command: string): boolean {
  const commentTrimmed = trimTrailingShellComment(command);
  const trimmed = commentTrimmed.trimEnd();
  if (!trimmed.endsWith('&')) return false;

  const trailingAmpIndex = trimmed.length - 1;
  const previousNonWhitespaceIndex = (() => {
    for (let i = trailingAmpIndex - 1; i >= 0; i--) {
      if (!/\s/.test(trimmed[i]!)) return i;
    }
    return -1;
  })();

  if (previousNonWhitespaceIndex >= 0) {
    const previous = trimmed[previousNonWhitespaceIndex]!;
    if (previous === '&' || previous === '|' || previous === '\\') {
      return false;
    }
  }

  let backslashCount = 0;
  for (let i = trailingAmpIndex - 1; i >= 0 && trimmed[i] === '\\'; i--) {
    backslashCount++;
  }
  if (backslashCount % 2 === 1) return false;

  let inSingleQuote = false;
  let inDoubleQuote = false;
  let inBacktick = false;
  let escapeNext = false;
  let commandSubstitutionDepth = 0;

  for (let i = 0; i <= trailingAmpIndex; i++) {
    const ch = trimmed[i]!;

    if (inSingleQuote) {
      if (ch === "'") inSingleQuote = false;
      continue;
    }

    if (inBacktick) {
      if (escapeNext) {
        escapeNext = false;
        continue;
      }
      if (ch === '\\') {
        escapeNext = true;
        continue;
      }
      if (ch === '`') inBacktick = false;
      continue;
    }

    if (inDoubleQuote) {
      if (escapeNext) {
        escapeNext = false;
        continue;
      }
      if (ch === '\\') {
        escapeNext = true;
        continue;
      }
      if (ch === '"') {
        inDoubleQuote = false;
        continue;
      }
      if (ch === '$' && trimmed[i + 1] === '(') {
        commandSubstitutionDepth++;
        i++;
        continue;
      }
      if (ch === ')' && commandSubstitutionDepth > 0) {
        commandSubstitutionDepth--;
      }
      continue;
    }

    if (escapeNext) {
      escapeNext = false;
      continue;
    }
    if (ch === '\\') {
      escapeNext = true;
      continue;
    }
    if (ch === "'") {
      inSingleQuote = true;
      continue;
    }
    if (ch === '"') {
      inDoubleQuote = true;
      continue;
    }
    if (ch === '`') {
      inBacktick = true;
      continue;
    }
    if (ch === '$' && trimmed[i + 1] === '(') {
      commandSubstitutionDepth++;
      i++;
      continue;
    }
    if (ch === ')' && commandSubstitutionDepth > 0) {
      commandSubstitutionDepth--;
      continue;
    }
    if (i === trailingAmpIndex) {
      return commandSubstitutionDepth === 0;
    }
  }

  return false;
}

export interface ShellToolParams {
  command: string;
  is_background: boolean;
  timeout?: number;
  description?: string;
  directory?: string;
}

interface PreparedSedEdit {
  filePath: string;
  fileName: string;
  originalContent: string;
  newContent: string;
  meta: ReadTextFileResponse['_meta'];
}

class SedEditSimulationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SedEditSimulationError';
  }
}

class SedEditCancelledError extends Error {
  constructor() {
    super('Command was cancelled by user before it could complete.');
    this.name = 'SedEditCancelledError';
  }
}

function getAbortReasonName(signal: AbortSignal): string | undefined {
  const reason = signal.reason as unknown;
  if (
    typeof reason === 'object' &&
    reason !== null &&
    'name' in reason &&
    typeof reason.name === 'string'
  ) {
    return reason.name;
  }
  return undefined;
}

const LEADING_ENV_ASSIGNMENT_RE = /^\s*[A-Za-z_][A-Za-z0-9_]*=/;

export class ShellToolInvocation extends BaseToolInvocation<
  ShellToolParams,
  ToolResult
> {
  private preparedSedEdit: PreparedSedEdit | undefined;
  private confirmedSedNewContent: string | undefined;
  private sedEditPreviewFailed = false;

  constructor(
    private readonly config: Config,
    params: ShellToolParams,
  ) {
    super(params);
  }

  private getSedEditInfo(): SedEditInfo | null {
    if (
      this.config.getShellExecutionSandbox?.() ||
      this.params.is_background ||
      LEADING_ENV_ASSIGNMENT_RE.test(this.params.command)
    ) {
      return null;
    }
    const strippedCommand = stripShellWrapper(this.params.command);
    if (LEADING_ENV_ASSIGNMENT_RE.test(strippedCommand)) {
      return null;
    }
    return parseSedEditCommand(strippedCommand);
  }

  private resolveSedFilePath(filePath: string): string {
    if (path.isAbsolute(filePath)) {
      return filePath;
    }
    const cwd = this.params.directory || this.config.getTargetDir();
    return path.resolve(cwd, filePath);
  }

  private async checkSedPriorRead(filePath: string): Promise<void> {
    if (this.config.getFileReadCacheDisabled()) {
      return;
    }
    const priorReadResult = await checkPriorRead(
      this.config.getFileReadCache(),
      filePath,
      'editing',
    );
    if (!priorReadResult.ok) {
      throw new StructuredToolError(
        priorReadResult.rawMessage,
        priorReadResult.type,
      );
    }
  }

  private async prepareSedEdit(sedInfo: SedEditInfo): Promise<PreparedSedEdit> {
    const filePath = this.resolveSedFilePath(sedInfo.filePath);
    if (fs.lstatSync(filePath).isSymbolicLink()) {
      throw new Error(
        `sed edit target '${filePath}' is a symlink; falling back to shell execution`,
      );
    }
    await this.checkSedPriorRead(filePath);
    const { content, _meta } = await this.config
      .getFileSystemService()
      .readTextFile({ path: filePath });
    let newContent: string;
    try {
      newContent = applySedSubstitution(content, sedInfo);
    } catch (err) {
      throw new SedEditSimulationError(getErrorMessage(err));
    }

    return {
      filePath,
      fileName: path.basename(filePath),
      originalContent: content,
      newContent,
      meta: {
        ..._meta,
        lineEnding: _meta?.lineEnding ?? detectLineEnding(content),
      },
    };
  }

  private makeSedEditDisplay(edit: PreparedSedEdit): FileDiff {
    const diffStat = getDiffStat(
      edit.fileName,
      edit.originalContent,
      edit.newContent,
      edit.newContent,
    );
    return {
      fileDiff: createPatchSmart(
        edit.fileName,
        edit.originalContent,
        edit.newContent,
        'Current',
        'Proposed',
      ),
      fileName: edit.fileName,
      filePath: edit.filePath,
      originalContent: edit.originalContent,
      newContent: edit.newContent,
      diffStat,
    };
  }

  private sedEditError(
    message: string,
    type = ToolErrorType.FILE_WRITE_FAILURE,
  ): ToolResult {
    return {
      llmContent: message,
      returnDisplay: message,
      error: {
        message,
        type,
      },
    };
  }

  private sedEditCancelledResult(
    signal: AbortSignal,
    effectiveTimeout: number,
  ): ToolResult {
    if (getAbortReasonName(signal) === 'TimeoutError') {
      const message = `Command timed out after ${effectiveTimeout}ms before it could complete.`;
      const detail = `${message} There was no output before it timed out.`;
      return {
        llmContent: detail,
        returnDisplay: detail,
        error: {
          message,
          type: ToolErrorType.EXECUTION_TIMEOUT,
        },
      };
    }
    return {
      llmContent: 'Command was cancelled by user before it could complete.',
      returnDisplay: 'Command cancelled by user.',
    };
  }

  private waitForSedOperation<T>(
    operation: () => Promise<T>,
    signal: AbortSignal,
  ): Promise<T> {
    if (signal.aborted) {
      return Promise.reject(new SedEditCancelledError());
    }

    return new Promise<T>((resolve, reject) => {
      const onAbort = () => {
        reject(new SedEditCancelledError());
      };
      const removeAbortListener = () => {
        signal.removeEventListener('abort', onAbort);
      };
      signal.addEventListener('abort', onAbort, { once: true });
      let operationPromise: Promise<T>;
      try {
        operationPromise = operation();
      } catch (err) {
        removeAbortListener();
        reject(err);
        return;
      }
      operationPromise.then(
        (value) => {
          removeAbortListener();
          resolve(value);
        },
        (err: unknown) => {
          removeAbortListener();
          reject(err);
        },
      );
    });
  }

  private async executeSedEdit(
    sedInfo: SedEditInfo,
    signal: AbortSignal,
    effectiveTimeout: number,
  ): Promise<ToolResult> {
    let edit: PreparedSedEdit;
    try {
      edit = await this.waitForSedOperation(
        () => this.prepareSedEdit(sedInfo),
        signal,
      );
    } catch (err) {
      const filePath = this.resolveSedFilePath(sedInfo.filePath);
      if (err instanceof SedEditCancelledError) {
        return this.sedEditCancelledResult(signal, effectiveTimeout);
      }
      if (err instanceof SedEditSimulationError) {
        const message = `Error simulating sed edit for file '${filePath}': ${err.message}`;
        return this.sedEditError(
          message,
          ToolErrorType.EDIT_PREPARATION_FAILURE,
        );
      }
      if (err instanceof StructuredToolError) {
        return this.sedEditError(err.message, err.errorType);
      }
      const message = `Error reading file for sed edit '${filePath}': ${getErrorMessage(err)}`;
      return this.sedEditError(
        message,
        isNodeError(err) && err.code === 'ENOENT'
          ? ToolErrorType.FILE_NOT_FOUND
          : ToolErrorType.READ_CONTENT_FAILURE,
      );
    }

    if (
      this.preparedSedEdit?.filePath === edit.filePath &&
      this.preparedSedEdit.originalContent !== edit.originalContent
    ) {
      return this.sedEditError(
        `File changed since sed edit confirmation: ${edit.filePath}. Please re-read the file and retry.`,
        ToolErrorType.FILE_CHANGED_SINCE_READ,
      );
    }

    if (
      this.preparedSedEdit?.filePath === edit.filePath &&
      this.confirmedSedNewContent !== undefined
    ) {
      edit = {
        ...edit,
        newContent: this.confirmedSedNewContent,
      };
    }

    if (edit.originalContent === edit.newContent) {
      const message = `sed edit made no changes to ${edit.filePath}.`;
      return {
        llmContent: message,
        returnDisplay: message,
      };
    }

    const display = this.makeSedEditDisplay(edit);
    let fileHistoryBackupRecorded = false;

    try {
      if (signal.aborted) {
        return this.sedEditCancelledResult(signal, effectiveTimeout);
      }
      try {
        await this.waitForSedOperation(
          () => this.config.getFileHistoryService().trackEdit(edit.filePath),
          signal,
        );
        fileHistoryBackupRecorded = true;
      } catch (err) {
        if (err instanceof SedEditCancelledError) {
          return this.sedEditCancelledResult(signal, effectiveTimeout);
        }
        debugLogger.warn(
          `file history trackEdit failed for sed edit ${edit.filePath}: ${getErrorMessage(err)}`,
        );
        // File history is best-effort; never block shell-compatible edits.
      }

      if (signal.aborted) {
        return this.sedEditCancelledResult(signal, effectiveTimeout);
      }
      // writeTextFile is not cancellation-aware; once the write starts, await
      // it so the result reflects the on-disk state instead of a stale cancel.
      await this.config.getFileSystemService().writeTextFile({
        path: edit.filePath,
        content: edit.newContent,
        _meta: edit.meta,
      });

      try {
        const postWriteStats = fs.statSync(edit.filePath);
        this.config
          .getFileReadCache()
          .recordWrite(edit.filePath, postWriteStats);
      } catch (err) {
        debugLogger.warn(
          `file read cache recordWrite failed for sed edit ${edit.filePath}: ${getErrorMessage(err)}`,
        );
        // Non-fatal: a future read can refresh the cache from disk.
      }

      return {
        llmContent: `sed edit applied to ${edit.filePath}.`,
        returnDisplay: display,
      };
    } catch (err) {
      if (err instanceof SedEditCancelledError) {
        return this.sedEditCancelledResult(signal, effectiveTimeout);
      }
      if (fileHistoryBackupRecorded) {
        debugLogger.warn(
          `sed edit write failed after file history backup was recorded for ${edit.filePath}: ${getErrorMessage(err)}`,
        );
      }
      let type = ToolErrorType.FILE_WRITE_FAILURE;
      let message = `Error writing sed edit to file '${edit.filePath}': ${getErrorMessage(err)}`;
      if (isNodeError(err)) {
        if (err.code === 'EACCES') {
          type = ToolErrorType.PERMISSION_DENIED;
          message = `Permission denied writing sed edit to file: ${edit.filePath} (${err.code})`;
        } else if (err.code === 'ENOSPC') {
          type = ToolErrorType.NO_SPACE_LEFT;
          message = `No space left on device while writing sed edit to file: ${edit.filePath} (${err.code})`;
        } else if (err.code === 'EISDIR') {
          type = ToolErrorType.TARGET_IS_DIRECTORY;
          message = `Sed edit target is a directory, not a file: ${edit.filePath} (${err.code})`;
        }
      }
      return this.sedEditError(message, type);
    }
  }

  getDescription(): string {
    let description = `${this.params.command}`;
    // append optional [in directory]
    // note description is needed even if validation fails due to absolute path
    if (this.params.directory) {
      description += ` [in ${this.params.directory}]`;
    }
    // append background indicator
    if (this.params.is_background) {
      description += ` [background]`;
    } else if (this.params.timeout) {
      // append timeout for foreground commands
      description += ` [timeout: ${this.params.timeout}ms]`;
    }
    // append optional (description), replacing any line breaks with spaces
    if (this.params.description) {
      description += ` (${this.params.description.replace(/\n/g, ' ')})`;
    }
    return description;
  }

  /**
   * AST-based permission check for the shell command.
   * - Substitution-bearing commands (any form, including inside an
   *   env-prefix wrapper that `stripShellWrapper` would discard) → 'ask'
   * - Read-only commands (via AST analysis) → 'allow'
   * - All other commands → 'ask'
   */
  override async getDefaultPermission(): Promise<PermissionDecision> {
    if (this.config.getShellExecutionSandbox?.()) return 'ask';
    // Gate on the RAW command before `stripShellWrapper` runs.
    // `stripShellWrapper` drops leading env-assignment tokens AND
    // unwraps `bash -c '...'` to its inner script — so for
    // `FOO=$(curl evil) bash -c 'echo ok'` the stripped form is just
    // `echo ok`, which the AST classifies as read-only. Without this
    // gate the command auto-executes silently with no confirmation
    // dialog and no warning. See PR #4386 R6 (cid 3298521039).
    if (hasShellSubstitution(this.params.command)) {
      return 'ask';
    }

    const command = stripShellWrapper(this.params.command);

    // AST-based read-only detection
    try {
      const isReadOnly = await isShellCommandReadOnlyASTInDirectory(
        command,
        this.params.directory || this.config.getTargetDir(),
      );
      if (isReadOnly) {
        return 'allow';
      }
    } catch (e) {
      debugLogger.warn('AST read-only check failed, falling back to ask:', e);
    }

    return 'ask';
  }

  /**
   * Constructs confirmation dialog details for a shell command that needs
   * user approval.  For compound commands (e.g. `cd foo && npm run build`),
   * sub-commands that are already allowed (read-only) are excluded from both
   * the displayed root-command list and the suggested permission rules.
   */
  override async getConfirmationDetails(
    _abortSignal: AbortSignal,
  ): Promise<ToolCallConfirmationDetails> {
    const command = stripShellWrapper(this.params.command);
    const pm = this.config.getPermissionManager?.();
    const cwd = this.params.directory || this.config.getTargetDir();
    const sedInfo = this.getSedEditInfo();
    let sedEditPreviewWarning: string | undefined;

    if (sedInfo) {
      try {
        const edit = await this.prepareSedEdit(sedInfo);
        this.preparedSedEdit = edit;
        this.confirmedSedNewContent = undefined;
        this.sedEditPreviewFailed = false;
        const display = this.makeSedEditDisplay(edit);
        const confirmationDetails: ToolEditConfirmationDetails = {
          type: 'edit',
          title: `Confirm Sed Edit: ${shortenPath(makeRelative(edit.filePath, this.config.getTargetDir()))}`,
          fileName: edit.fileName,
          filePath: edit.filePath,
          fileDiff: display.fileDiff,
          originalContent: edit.originalContent,
          newContent: edit.newContent,
          hideModify: true,
          onConfirm: async (
            outcome: ToolConfirmationOutcome,
            payload?: ToolConfirmationPayload,
          ) => {
            if (payload?.newContent !== undefined) {
              this.confirmedSedNewContent = payload.newContent;
            }
            if (outcome === ToolConfirmationOutcome.ProceedAlways) {
              this.config.setApprovalMode(ApprovalMode.AUTO_EDIT);
            }
          },
        };
        return confirmationDetails;
      } catch (err) {
        if (err instanceof StructuredToolError) {
          throw err;
        }
        this.sedEditPreviewFailed = true;
        sedEditPreviewWarning =
          'Sed edit preview unavailable; showing raw shell command confirmation.';
        debugLogger.warn(
          `sed edit preview failed, falling back to exec confirmation: ${getErrorMessage(err)}`,
        );
      }
    }

    // Split compound command and filter out already-allowed (read-only) sub-commands
    const subCommands = splitCommands(command);
    const confirmableSubCommands: string[] = [];
    for (const sub of subCommands) {
      if (this.config.getShellExecutionSandbox?.()) {
        confirmableSubCommands.push(sub);
        continue;
      }
      let isReadOnly = false;
      try {
        isReadOnly = await isShellCommandReadOnlyASTInDirectory(sub, cwd);
      } catch {
        // conservative: treat unknown commands as requiring confirmation
      }

      if (isReadOnly) {
        continue;
      }

      if (pm) {
        try {
          if ((await pm.isCommandAllowed(sub, cwd)) === 'allow') {
            continue;
          }
        } catch (e) {
          debugLogger.warn('PermissionManager command check failed:', e);
        }
      }

      confirmableSubCommands.push(sub);
    }

    // Fallback to all sub-commands if everything was filtered out (shouldn't
    // normally happen since getDefaultPermission already returned 'ask').
    const effectiveSubCommands =
      confirmableSubCommands.length > 0 ? confirmableSubCommands : subCommands;

    const rootCommands = [
      ...new Set(
        effectiveSubCommands
          .map((c) => getCommandRoot(c))
          .filter((c): c is string => !!c),
      ),
    ];

    // Extract minimum-scope permission rules only for sub-commands that
    // actually need confirmation.
    let permissionRules: string[] = [];
    try {
      const allRules: string[] = [];
      for (const sub of effectiveSubCommands) {
        const rules = await extractCommandRules(sub);
        allRules.push(...rules);
      }
      permissionRules = [...new Set(allRules)].map((rule) => `Bash(${rule})`);
    } catch (e) {
      debugLogger.warn('Failed to extract command rules:', e);
    }

    // Flag command substitution ($(), backticks, <(), >()) so the user
    // sees a visible warning in the confirmation dialog. We surface this
    // as an informational warning rather than denying outright; the deny
    // path was inconsistent and could not be overridden by YOLO mode
    // (see issue #4093). Substitution is detected on both the stripped
    // and original command so wrappers like `bash -c "..."` are checked
    // along with their inner contents.
    const warnings = [
      ...(buildShellExecWarnings(command, this.params.command) ?? []),
      ...(sedEditPreviewWarning ? [sedEditPreviewWarning] : []),
    ];

    const confirmationDetails: ToolExecuteConfirmationDetails = {
      type: 'exec',
      title: 'Confirm Shell Command',
      command: this.params.command,
      rootCommand: rootCommands.join(', '),
      permissionRules,
      onConfirm: async (
        _outcome: ToolConfirmationOutcome,
        _payload?: ToolConfirmationPayload,
      ) => {
        // No-op: persistence is handled by coreToolScheduler via PM rules
      },
    };
    if (warnings.length > 0) {
      confirmationDetails.warnings = warnings;
    }
    return confirmationDetails;
  }

  async execute(
    signal: AbortSignal,
    updateOutput?: (output: ToolResultDisplay) => void,
    shellExecutionConfig?: ShellExecutionConfig,
    setPidCallback?: (pid: number) => void,
    setPromoteAbortControllerCallback?: (ac: AbortController) => void,
    canPromoteForegroundShell?: () => boolean,
    rawCapture?: ShellRawCaptureSink,
  ): Promise<ToolResult> {
    const strippedCommand = stripShellWrapper(this.params.command);

    if (signal.aborted) {
      return {
        llmContent: 'Command was cancelled by user before it could start.',
        returnDisplay: 'Command cancelled by user.',
      };
    }

    if (this.params.is_background) {
      return this.executeBackground(signal, shellExecutionConfig);
    }

    // Precedence: an explicit per-call `timeout` wins; otherwise fall back
    // to the configured `tools.shell.defaultTimeoutMs` setting; otherwise
    // the built-in default. A value of 0 disables the timeout, but only at
    // the settings/default level — the per-call `timeout` param is validated
    // to be > 0 by `validateToolParamValues`, so 0 never arrives that way.
    const effectiveTimeout =
      this.params.timeout ??
      this.config.getShellDefaultTimeoutMs() ??
      DEFAULT_FOREGROUND_TIMEOUT_MS;
    debugLogger.debug('resolved foreground shell timeout', {
      perCallTimeout: this.params.timeout ?? null,
      configuredDefault: this.config.getShellDefaultTimeoutMs() ?? null,
      effectiveTimeout,
    });

    // Create combined signal with timeout AND promote-trigger for
    // foreground execution. The promoteAbortController is exposed to
    // the caller (the future Ctrl+B keybind handler in PR-3) via
    // `setPromoteAbortControllerCallback`. When the keybind fires
    // `promoteAbortController.abort({ kind: 'background', shellId })`,
    // ShellExecutionService detects the discriminated reason and
    // returns `result.promoted: true` instead of killing the child —
    // see #3842 / #3886 for the foundation.
    const promoteAbortController = new AbortController();
    let combinedSignal = AbortSignal.any([
      signal,
      promoteAbortController.signal,
    ]);
    let timeoutSignalStartedAt: number | null = null;
    if (effectiveTimeout) {
      timeoutSignalStartedAt = Date.now();
      const timeoutSignal = AbortSignal.timeout(effectiveTimeout);
      combinedSignal = AbortSignal.any([
        signal,
        timeoutSignal,
        promoteAbortController.signal,
      ]);
    }

    const sedInfo = this.getSedEditInfo();
    if (sedInfo && !this.sedEditPreviewFailed) {
      if (this.preparedSedEdit) {
        debugLogger.debug('executing simulated sed edit', {
          command: this.params.command,
        });
        return this.executeSedEdit(sedInfo, combinedSignal, effectiveTimeout);
      }
      try {
        await this.checkSedPriorRead(this.resolveSedFilePath(sedInfo.filePath));
      } catch (err) {
        if (err instanceof StructuredToolError) {
          return this.sedEditError(err.message, err.errorType);
        }
        throw err;
      }
      debugLogger.debug(
        'falling back to shell execution for sed edit without prepared preview',
        { command: this.params.command },
      );
    }

    // Run the *trimmed original* (not strippedCommand) so leading env
    // assignments and shell wrappers (`FOO=bar bash -c '...'`) are preserved
    // through to execution.
    const commandToExecute = this.params.command.trim();
    const cwd = this.params.directory || this.config.getTargetDir();

    // Snapshot HEAD before running so trackSessionCommit can detect
    // commit creation by HEAD movement instead of trusting the shell
    // exit code (which is unreliable for compound commands).
    //
    // Synchronous capture via `execFileSync`: a fire-and-forget async
    // rev-parse can resolve AFTER a fast-cached `git commit` moves
    // HEAD (real race seen on slow filesystems / heavy contention),
    // leaving preHead === postHead and silently skipping the
    // registration. ~10–50ms event-loop block per commit-shaped
    // command.
    //
    // We act on `commitLandsInCwd` rather than a raw regex so quoted
    // text like `echo "git commit"` doesn't trigger the snapshot, and
    // so registration still runs after a `git commit && cd ..` chain
    // (which would have failed an "any cd anywhere" gate).
    const commitInCwd = commitLandsInCwd(strippedCommand);
    // Capture preHead only when the commit lands in our cwd: that's the
    // only consumer (`trackSessionCommit`). For other commit shapes
    // (`cd /elsewhere && git commit`, `git -C /other commit`), no
    // consumer reads preHead and the ~10–50 ms execFileSync is dead work
    // that just blocks the event loop before the user's real command
    // spawns. Registration must never run against a null preHead —
    // `head.sha !== preHead` would be trivially true and exempt
    // whatever HEAD happens to be there (the fail-open #12463's
    // regression row ② pins).
    const preHead: string | null =
      !this.config.getShellExecutionSandbox?.() && commitInCwd
        ? this.getGitHeadSync(cwd)
        : null;

    let cumulativeOutput: string | AnsiOutput = '';
    let lastUpdateTime = Number.NEGATIVE_INFINITY;
    let isBinaryStream = false;
    let totalLines = 0;
    let totalBytes = 0;
    let trailingFlushTimer: ReturnType<typeof setTimeout> | null = null;
    let timeoutWarningTimer: ReturnType<typeof setTimeout> | null = null;
    let showTimeoutWarning = false;
    let heartbeatTimer: ReturnType<typeof setInterval> | null = null;
    let lastOutputPerfTime: number | null = null;

    const cancelTrailingFlush = () => {
      if (trailingFlushTimer !== null) {
        clearTimeout(trailingFlushTimer);
        trailingFlushTimer = null;
      }
    };

    const cancelTimeoutWarning = () => {
      if (timeoutWarningTimer !== null) {
        clearTimeout(timeoutWarningTimer);
        timeoutWarningTimer = null;
      }
    };

    const cancelHeartbeat = () => {
      if (heartbeatTimer !== null) {
        clearInterval(heartbeatTimer);
        heartbeatTimer = null;
      }
    };

    const doUpdate = () => {
      // Any path that emits an update supersedes a pending trailing flush —
      // cancel centrally so leading-edge text, ANSI, binary_detected, and
      // binary_progress branches all stay consistent without each having to
      // remember to clear the timer themselves.
      cancelTrailingFlush();
      lastUpdateTime = Date.now();
      if (!updateOutput) return;
      const displayOutput = showTimeoutWarning
        ? appendForegroundTimeoutWarning(cumulativeOutput)
        : cumulativeOutput;
      if (typeof displayOutput === 'string') {
        updateOutput(displayOutput);
      } else {
        updateOutput({
          ansiOutput: displayOutput,
          totalLines,
          totalBytes,
          ...(this.params.timeout != null && {
            timeoutMs: this.params.timeout,
          }),
        });
      }
    };

    // If the command is aborted (user cancel or timeout) while a trailing
    // flush is pending, cancel the timer so we don't emit a stale frame
    // between the abort signal firing and the result promise settling.
    // The heartbeat stops here too: after abort, a "still running" signal
    // during the kill-to-settle window would be a lie.
    const onAbort = () => {
      cancelTrailingFlush();
      cancelTimeoutWarning();
      cancelHeartbeat();
    };
    combinedSignal.addEventListener('abort', onAbort, { once: true });

    const armTimeoutWarning = () => {
      if (
        !updateOutput ||
        combinedSignal.aborted ||
        !this.config.isInteractive() ||
        setPromoteAbortControllerCallback === undefined ||
        canPromoteForegroundShell?.() !== true ||
        timeoutSignalStartedAt === null
      ) {
        return;
      }
      const warningDelay = foregroundTimeoutWarningDelayFor(
        effectiveTimeout,
        Date.now() - timeoutSignalStartedAt,
      );
      if (warningDelay === null) {
        return;
      }
      timeoutWarningTimer = setTimeout(() => {
        timeoutWarningTimer = null;
        if (combinedSignal.aborted || canPromoteForegroundShell?.() !== true) {
          return;
        }
        showTimeoutWarning = true;
        doUpdate();
      }, warningDelay);
    };

    const onShellOutputEvent = (event: ShellOutputEvent) => {
      let shouldUpdate = false;

      switch (event.type) {
        case 'data':
          lastOutputPerfTime = performance.now();
          if (isBinaryStream) break;
          cumulativeOutput = event.chunk;
          // Stats are only consumed by the ANSI-output branch below,
          // so skip the per-chunk accounting for plain string chunks.
          if (Array.isArray(event.chunk)) {
            totalLines = event.chunk.length;
            totalBytes = event.chunk.reduce(
              (sum, line) =>
                sum +
                line.reduce(
                  (ls, token) => ls + Buffer.byteLength(token.text, 'utf-8'),
                  0,
                ),
              0,
            );
          }
          // ANSI output is already throttled and semantically deduped by
          // ShellExecutionService, so preserve its live responsiveness.
          // Plain text data can arrive in bursts and does not need every
          // chunk to force a React render; the final ToolResult still
          // carries the complete output after command completion.
          if (Array.isArray(event.chunk)) {
            shouldUpdate = true;
          } else if (Date.now() - lastUpdateTime > OUTPUT_UPDATE_INTERVAL_MS) {
            shouldUpdate = true;
          } else if (trailingFlushTimer === null) {
            // Throttled: schedule a trailing flush so the last suppressed
            // chunk is still shown if the command goes quiet within the
            // window. The timer's callback reads `cumulativeOutput` by
            // closure, so subsequent suppressed chunks within the same
            // window don't need to reschedule — the latest value will be
            // emitted when the timer fires.
            const remaining =
              OUTPUT_UPDATE_INTERVAL_MS - (Date.now() - lastUpdateTime);
            trailingFlushTimer = setTimeout(() => {
              trailingFlushTimer = null;
              doUpdate();
            }, remaining);
          }
          break;
        case 'binary_detected':
          isBinaryStream = true;
          cumulativeOutput = '[Binary output detected. Halting stream...]';
          shouldUpdate = true;
          break;
        case 'binary_progress':
          lastOutputPerfTime = performance.now();
          isBinaryStream = true;
          cumulativeOutput = `[Receiving binary output... ${formatMemoryUsage(
            event.bytesReceived,
          )} received]`;
          if (Date.now() - lastUpdateTime > OUTPUT_UPDATE_INTERVAL_MS) {
            shouldUpdate = true;
          }
          break;
        default: {
          throw new Error('An unhandled ShellOutputEvent was found.');
        }
      }

      if (shouldUpdate) {
        doUpdate();
      }
    };

    // Pre-allocate the promote artifacts (PR-2.5). Lazily created — no
    // disk I/O unless the user actually fires Ctrl+B / promote signal.
    // The handlers below close over these slots; once promote happens,
    // `handlePromotedForeground` populates them (opens the stream, sets
    // the shellId / onSettle wiring), and any onData chunks that the
    // service forwarded BEFORE handlePromotedForeground caught up land
    // in `postPromoteBuffer` and drain to the stream once it opens.
    const promoteArtifacts: PromoteArtifacts = {
      buffer: [],
      stream: null,
      streamClosed: false,
      onSettleWired: null,
      settleQueued: null,
    };
    const postPromote: ShellPostPromoteHandlers = {
      onData: (event) => {
        if (event.type !== 'data') return;
        // ANSI structured chunks have no append semantics — coerce to
        // string. The output file is plain text; live ANSI updates are
        // owned by the foreground stream, which by promote-time has
        // already terminated.
        //
        // PR-2.5 wave-4: strip ANSI before writing so
        // the post-promote tail of `bg_xxx.output` matches the format
        // of the snapshot above (which is rendered terminal text, not
        // raw escape sequences) AND matches the regular
        // `executeBackground` path's `outputStream.write(stripAnsi(chunk))`
        // contract. Without this, an agent reading the file after a
        // promote would see plain text up to the promote moment, then
        // raw `\x1b[...m` color codes / cursor moves / clear-screen
        // sequences for any post-promote output — which is unreadable
        // and inconsistent.
        const rawChunk =
          typeof event.chunk === 'string'
            ? event.chunk
            : event.chunk
                .map((line) => line.map((tok) => tok.text).join(''))
                .join('\n');
        const chunk = stripAnsi(rawChunk);
        if (promoteArtifacts.stream) {
          try {
            promoteArtifacts.stream.write(chunk);
          } catch (err) {
            debugLogger.warn(
              `promote: postPromote stream.write failed: ${getErrorMessage(err)}`,
            );
          }
        } else if (promoteArtifacts.streamClosed) {
          // Stream-open already failed permanently — drop chunks
          // rather than buffer them. Without this guard the buffer
          // would grow without bound under a sustained child whose
          // output file we couldn't open.
          debugLogger.debug(
            'promote: dropping post-promote chunk because output stream open failed',
          );
        } else {
          promoteArtifacts.buffer.push(chunk);
        }
      },
      onSettle: (info) => {
        if (promoteArtifacts.onSettleWired) {
          promoteArtifacts.onSettleWired(info);
        } else {
          // Service observed the child exit before handlePromotedForeground
          // finished registering. Queue the settle info — handlePromotedForeground
          // applies it as soon as the registry entry exists.
          promoteArtifacts.settleQueued = info;
        }
      },
    };

    let executionHandle;
    try {
      executionHandle = await executeRuntimeShell(
        this.config,
        commandToExecute,
        cwd,
        onShellOutputEvent,
        combinedSignal,
        rawCapture ? false : this.config.getShouldUseNodePtyShell(),
        {
          ...shellExecutionConfig,
          ...(rawCapture ? { maxBufferedOutputBytes: 64 * 1024 } : {}),
        },
        { postPromote, ...(rawCapture ? { rawCapture } : {}) },
      );
    } catch (err) {
      // ShellExecutionService.execute() can throw before resolving (e.g.
      // PTY dynamic import failure). Tear down the abort listener and any
      // (theoretically) scheduled trailing flush so nothing fires after we
      // re-throw to the caller.
      cancelTrailingFlush();
      cancelTimeoutWarning();
      cancelHeartbeat();
      combinedSignal.removeEventListener('abort', onAbort);
      throw err;
    }
    const { result: resultPromise, pid } = executionHandle;

    if (pid) rawCapture?.setStarted(pid);

    if (pid && setPidCallback) {
      setPidCallback(pid);
    }
    // Hand the promote controller up to the scheduler so a future UI
    // surface (PR-3 Ctrl+B keybind) can find it and trigger promote.
    // Done unconditionally — the caller can ignore it if they don't
    // implement promote yet, but exposing it now means PR-3 doesn't
    // need to revisit shell.ts.
    setPromoteAbortControllerCallback?.(promoteAbortController);
    armTimeoutWarning();

    // Bracket the execution-handle → settle wall-clock so the result builder below
    // can decide whether to append the long-run advisory. Captured AFTER
    // `await ShellExecutionService.execute(...)` returns its handle so
    // pre-spawn setup (PTY dynamic import via `getPty()`, ~50–200ms on
    // first call) is excluded — the elapsed should reflect the
    // command's actual runtime, not the tool call's total wall time. A
    // startup-stage abort can now return a handle with no process, in which
    // case this measures only the immediate aborted-result handoff.
    //
    // `performance.now()` (monotonic high-res, ms-precision) instead of
    // `Date.now()` so NTP corrections / VM clock drift between capture
    // and read can't make `elapsedMs` go negative (which would silently
    // skip the hint with no observable failure). Returned origin is
    // arbitrary but consistent across the two reads — only the
    // difference matters here.
    const executionStartTime = performance.now();

    // Liveness heartbeat for silent commands: while no output has arrived
    // for a full interval, emit a small structured ShellProgressData through
    // the same updateOutput channel so headless consumers (stream-json)
    // can distinguish "still running" from a dead execution chain. Display
    // consumers ignore it. Both the idle gate and the reported durations use
    // the monotonic `performance.now()` clock (via `lastOutputPerfTime`,
    // falling back to spawn time before any output), so an NTP step can
    // neither skew the payload nor misfire the heartbeat. Started only
    // post-spawn so PTY init can't produce a heartbeat for a process that
    // doesn't exist yet.
    const heartbeatIntervalMs =
      this.config.getShellHeartbeatIntervalMs() ??
      DEFAULT_SHELL_HEARTBEAT_INTERVAL_MS;
    if (updateOutput && heartbeatIntervalMs > 0 && !combinedSignal.aborted) {
      heartbeatTimer = setInterval(() => {
        const now = performance.now();
        const idleSince = lastOutputPerfTime ?? executionStartTime;
        if (now - idleSince < heartbeatIntervalMs) return;
        updateOutput({
          type: 'shell_progress',
          elapsedMs: Math.round(now - executionStartTime),
          ...(lastOutputPerfTime !== null && {
            lastOutputAgeMs: Math.round(now - lastOutputPerfTime),
          }),
          // Stats are only maintained on the PTY/AnsiOutput path; omit
          // rather than report a misleading 0 on the plain-string path.
          ...(totalLines > 0 && { totalLines }),
          ...(totalBytes > 0 && { totalBytes }),
          ...(effectiveTimeout > 0 && { timeoutMs: effectiveTimeout }),
        });
      }, heartbeatIntervalMs);
    }

    let result;
    try {
      result = await resultPromise;
      rawCapture?.setProcessResult(result);
    } finally {
      // Cancel any pending trailing flush — the command has settled (or
      // threw) and either the final ToolResult carries the complete output
      // or the caller will surface an error. Either way the timer must not
      // fire a stale frame after we've returned. `finally` covers both the
      // happy path and the (theoretical) reject path so no timer leaks.
      cancelTrailingFlush();
      cancelTimeoutWarning();
      cancelHeartbeat();
      combinedSignal.removeEventListener('abort', onAbort);
    }

    // Background-promote path: the user pressed Ctrl+B (PR-3 wires the
    // keybind to `promoteAbortController.abort({ kind: 'background' })`),
    // ShellExecutionService skipped the kill, snapshotted the output up
    // to that moment, and resolved with `promoted: true`. Per #3831
    // design question 7, `result.aborted` is `false` for promoted
    // results, so this branch is checked BEFORE the `if (result.aborted)`
    // arm and falls through naturally to the success-shape arm if
    // promote didn't fire.
    //
    // What we do here:
    //   1. Generate a `bg_xxx` shell id + on-disk output path under the
    //      same project temp dir `executeBackground` uses.
    //   2. Write `result.output` (the snapshot ShellExecutionService
    //      built right before promote) to the file as the initial
    //      content. The agent / `/tasks` / dialog can `Read` this file.
    //   3. Register a `BackgroundShellEntry` with the existing pid +
    //      a FRESH `AbortController` whose abort listener kills the
    //      still-running child (mirroring `ShellExecutionService`'s
    //      SIGTERM → 200ms → SIGKILL cascade) and sync-marks the
    //      entry `cancelled`. `task_stop bg_xxx` and the dialog's
    //      `x` key route through `entry.abortController.abort()` →
    //      kill listener → child gets SIGTERM/SIGKILL. Reusing the
    //      already-aborted `promoteAbortController` would have made
    //      `task_stop` a no-op (Web `AbortController.abort()` is
    //      idempotent on already-aborted controllers per spec) — see
    //      `handlePromotedForeground` for the full rationale.
    //   4. Return a model-facing `ToolResult` with promote-flavored copy
    //      pointing the agent at `/tasks` / the Background tasks dialog
    //      / `task_stop` for follow-up.
    //
    // KNOWN LIMITATION (deferred to PR-2.5): post-promote, the
    // ShellExecutionService no longer streams output to the file (PR-1
    // detached its data listener as part of the ownership-transfer
    // contract), and there's no path for the registry entry to settle
    // when the underlying child exits naturally. The entry stays
    // `'running'` until `task_stop bg_xxx` or session shutdown
    // (`abortAll`) clears it. PR-2.5 will add post-promote stream
    // redirect (so /tasks shows live output) and a settle hook (so
    // natural exit transitions the entry to `completed`/`failed`).
    if (result.promoted) {
      // `handlePromotedForeground` takes over the still-running child
      // and this method returns before the registration block below —
      // hand the pre-spawn preHead over so a commit landed by the
      // promoted command can still register when the child settles
      // (#12514).
      const promotedToolResult = await this.handlePromotedForeground(
        result,
        cwd,
        commandToExecute,
        promoteAbortController,
        promoteArtifacts,
        preHead,
      );
      return promotedToolResult;
    }

    // A promote refused because the command already settled still carries
    // its full output and exit code — it is reported like an uninterrupted
    // foreground run.
    const wasPromoteRefused =
      result.aborted &&
      getShellAbortReasonKind(combinedSignal.reason) === 'background';

    const abortReasonName = getAbortReasonName(combinedSignal);
    const wasTimeout =
      result.aborted &&
      effectiveTimeout > 0 &&
      abortReasonName === 'TimeoutError';
    const timeoutSummary = wasTimeout
      ? `Command timed out after ${effectiveTimeout}ms before it could complete.`
      : undefined;

    let llmContent = '';
    if (result.aborted) {
      if (wasTimeout) {
        llmContent = timeoutSummary!;
        if (result.output.trim()) {
          llmContent += ` Below is the output before it timed out:\n${result.output}`;
        } else {
          llmContent += ' There was no output before it timed out.';
        }
      } else if (wasPromoteRefused) {
        // The user pressed Ctrl+B (promote) but the service refused —
        // typically the child had already terminated by the time the
        // signal was checked. Treat as a benign race: report what
        // actually happened (the run completed, just without the
        // promote handoff) rather than as a cancellation or timeout.
        llmContent =
          'Command finished before the background-promote request could be honoured (the child had already exited).';
        if (result.output.trim()) {
          llmContent += ` Output:\n${result.output}`;
        }
      } else {
        llmContent = 'Command was cancelled by user before it could complete.';
        if (result.output.trim()) {
          llmContent += ` Below is the output before it was cancelled:\n${result.output}`;
        } else {
          llmContent += ' There was no output before it was cancelled.';
        }
      }
    } else {
      // Create a formatted error string for display, replacing the wrapper command
      // with the user-facing command.
      const finalError = result.error
        ? result.error.message.replace(commandToExecute, this.params.command)
        : '(none)';

      llmContent = [
        ...(getCurrentToolCallSource()?.kind === 'code_mode'
          ? []
          : [`Command: ${this.params.command}`]),
        `Directory: ${this.params.directory || '(root)'}`,
        `Output: ${result.output || '(empty)'}`,
        `Error: ${finalError}`, // Use the cleaned error string.
        `Exit Code: ${result.exitCode ?? '(none)'}`,
        `Signal: ${result.signal ?? '(none)'}`,
        `Process Group PGID: ${result.pid ?? '(none)'}`,
      ].join('\n');

      // (Long-run advisory append happens AFTER `truncateToolOutput`
      // below — see the explanation there for why post-truncation.)
    }

    // Register outside the aborted/non-aborted branch: a
    // `git commit -m "x" && sleep 999` chain can move HEAD and then time
    // out. Registration stays fail-closed: it requires a `commit:` reflog
    // verb plus HEAD movement against the captured preHead.
    if (!this.config.getShellExecutionSandbox?.() && commitInCwd) {
      await this.trackSessionCommit(cwd, preHead);
    }

    // Decide whether to emit the long-run advisory. Conditions:
    //   - Process completed under its own steam (no AbortSignal
    //     trigger, no external signal). Specifically:
    //       * Suppressed on aborted (`result.aborted: true`) — covers
    //         the `if (result.aborted)` arm above (timeout / user-
    //         cancel). Their own messaging is enough; a "should have
    //         been background" reminder when the agent already knows
    //         the command didn't complete is noise.
    //       * Suppressed on external signal kills
    //         (`isSignalTermination(result.signal)` with `aborted: false`,
    //         e.g. SIGTERM from container shutdown, k8s eviction, OOM
    //         killer, or sibling reaping the process group). node-pty's
    //         clean-exit signal 0 is normalized to null and does not
    //         suppress this hint. The service only sets
    //         `aborted` when the AbortSignal we passed was triggered,
    //         so external signals fall through to the non-aborted
    //         branch — same rationale as timeout.
    //   - Wall-clock duration ≥ threshold. Measured spawn → resultPromise
    //     settle, intentionally BEFORE the post-processing block below
    //     (truncation I/O, output-file write). The hint reports how long
    //     the COMMAND blocked the agent, not how long the tool call
    //     spent including post-processing — that's the number the agent
    //     should be reasoning about when deciding whether to background
    //     next time. Truncation time is bounded by the temp-dir backend
    //     and isn't representative of the command's actual wait.
    // Fires on both successful and naturally-failed completions since
    // the advice ("next time, background it") is the same in both.
    const elapsedMs = performance.now() - executionStartTime;
    // When the timeout is disabled (effectiveTimeout === 0) there is no
    // meaningful "half the timeout" threshold: `longRunThresholdFor(0)` would
    // return its 1000ms floor and fire the hint on every foreground command
    // over ~1s. Suppress the long-run hint entirely in that case.
    const longRunThreshold =
      effectiveTimeout === 0 ? null : longRunThresholdFor(effectiveTimeout);
    const shouldAppendLongRunHint =
      longRunThreshold !== null &&
      !result.aborted &&
      !isSignalTermination(result.signal) &&
      elapsedMs >= longRunThreshold;
    // Observability: the hint decision is otherwise invisible. If a
    // user reports "my 65s command didn't get the hint" or "5s command
    // got the hint", the debug log shows which suppression branch fired
    // (aborted / signal / under-threshold) plus the actual elapsed and
    // computed threshold. No PII — just timing + result flags.
    debugLogger.debug(
      `long-run hint: elapsed=${Math.round(elapsedMs)}ms threshold=${longRunThreshold === null ? 'disabled' : `${longRunThreshold}ms`} ` +
        `aborted=${result.aborted} signal=${result.signal} → ${shouldAppendLongRunHint ? 'fire' : 'suppress'}`,
    );

    // returnDisplayMessage build order — chronologically:
    //   1. Initial value: in debug mode, snapshot of pre-truncation
    //      `llmContent`; in non-debug mode, terse output-or-status.
    //   2. Truncation block (below) appends `Output too long and was
    //      saved to: <path>` if truncation fired (BOTH modes).
    //   3. Long-run hint append (further below) appends the hint
    //      itself with append-style re-sync (BOTH modes), so the user
    //      sees the same advisory the agent does — otherwise the
    //      agent would suddenly suggest `is_background: true` with no
    //      visible trigger in the TUI.
    // The pre-existing debug snapshot is captured here (pre-truncation,
    // pre-hint); both subsequent steps APPEND to it rather than
    // replacing, so all information accumulates rather than being lost
    // when later steps fire.
    let returnDisplayMessage = '';
    if (this.config.getDebugMode()) {
      returnDisplayMessage = llmContent;
    } else {
      if (result.output.trim()) {
        returnDisplayMessage = wasTimeout
          ? `${timeoutSummary}\n${result.output}`
          : result.output;
      } else {
        if (result.aborted) {
          returnDisplayMessage = wasTimeout
            ? `${timeoutSummary} There was no output before it timed out.`
            : wasPromoteRefused
              ? 'Command finished before background-promote could be honoured.'
              : 'Command cancelled by user.';
        } else if (isSignalTermination(result.signal)) {
          returnDisplayMessage = `Command terminated by signal: ${result.signal}`;
        } else if (result.error) {
          returnDisplayMessage = `Command failed: ${getErrorMessage(
            result.error,
          )}`;
        } else if (result.exitCode !== null && result.exitCode !== 0) {
          returnDisplayMessage = `Command exited with code: ${result.exitCode}`;
        }
        // If output is empty and command succeeded (code 0, no error/signal/abort),
        // returnDisplayMessage will remain empty, which is fine.
      }
    }

    let persistedOutputFiles: string[] | undefined;
    let outputBudgetApplied = false;

    // The advisory is appended after the truncation below (deliberately
    // outside the truncation envelope — see the append loop), so its size
    // comes out of the body budget here: the marker asserts the ASSEMBLED
    // string fits the declared budget, and a body that fits whole must still
    // fit once it lands. The reservation and the append loop both iterate
    // this one list, so the two cannot disagree.
    const longRunHint = shouldAppendLongRunHint
      ? buildLongRunningForegroundHint(elapsedMs)
      : null;
    const appendedMetadata = longRunHint === null ? [] : [longRunHint];
    const appendedMetadataChars = appendedMetadata.reduce(
      (total, s) => total + APPENDED_METADATA_SEPARATOR.length + s.length,
      0,
    );

    // Raw capture owns full output; result.output is only a bounded preview.
    // Otherwise truncate large output and save full content to a temp file.
    if (!rawCapture && typeof llmContent === 'string') {
      const originalLlmContent = llmContent;
      const outputThreshold = getShellOutputThreshold(this.config);
      // Clamp at 1: truncateToolOutput returns the body untouched on
      // threshold <= 0, so an explicit threshold smaller than the reserved
      // metadata (the setting has no schema minimum) would stand the pass
      // down while outputBudgetApplied below still vouches for the body —
      // leaving the failure path, whose only bound is that marker, unbounded.
      // Cap the reservation at half the threshold: a sub-advisory explicit
      // threshold would otherwise spend the whole budget on the reservation
      // and leave a 1-char preview, dropping the trailing exit-code line
      // the head-and-tail preview exists to keep. The assembled string can
      // exceed the declared budget in that corner — a ~510-char truncation
      // header already does on its own — but it stays bounded.
      const bodyBudgetChars = Math.max(
        1,
        outputThreshold -
          Math.min(appendedMetadataChars, Math.floor(outputThreshold / 2)),
      );
      const truncatedResult = await truncateToolOutput(
        this.config,
        ShellTool.Name,
        llmContent,
        // Per-tool char budget: ShellTool.maxOutputChars minus the metadata
        // reserved above. keep='both' preserves the command's start AND its
        // trailing exit/error summary
        // (where shell failures report). Kept in-tool (not deferred to the
        // scheduler) so the long-run hint below is appended OUTSIDE the
        // truncation envelope; the scheduler's sentinel makes its later pass a
        // no-op here. lines: Infinity keeps this char-only so the global line
        // cap can't undercut the effective Shell char budget — many short lines
        // (e.g. `find /`, `ls -R`) would otherwise truncate while chars remain.
        {
          threshold: bodyBudgetChars,
          previewChars: Math.min(4000, bodyBudgetChars),
          keep: 'both',
          lines: Number.POSITIVE_INFINITY,
        },
      );

      if (truncatedResult.outputFile) {
        persistedOutputFiles = [truncatedResult.outputFile];
        llmContent = truncatedResult.content;
        returnDisplayMessage +=
          (returnDisplayMessage ? '\n' : '') +
          `Output too long and was saved to: ${truncatedResult.outputFile}`;
      } else if (truncatedResult.content !== originalLlmContent) {
        persistedOutputFiles = [];
        llmContent = truncatedResult.content;
      }

      // Set even when nothing was cut: the scheduler's generic gate sits BELOW
      // this budget by default, so an unmarked body inside it gets re-bounded
      // there under a stricter head-only policy.
      outputBudgetApplied = true;
    }

    // Append the metadata AFTER truncation so it isn't wrapped in
    // `truncateToolOutput`'s "Truncated part of the output" header (which the
    // LLM might misread as part of the command's own output). These are
    // process metadata about the command — how long it blocked the agent —
    // not command output, so they belong outside the truncation envelope. Both
    // llmContent (so the agent can react) and returnDisplayMessage (so the
    // human waiting in the TUI sees the same cue) get them, append-style,
    // preserving any pre-existing display content (debug snapshot, truncation
    // marker line, status line).
    //
    // Today shell.ts only emits string llmContent; the type union also allows
    // structured `Part[]` content, in which case the metadata silently
    // disappears here. Encoding it as a Part would require deciding on a
    // rendering convention, and structured llmContent isn't on the roadmap.
    // Revisit if someone adds a non-string return path.
    for (const metadata of appendedMetadata) {
      if (typeof llmContent === 'string') {
        llmContent += `${APPENDED_METADATA_SEPARATOR}${metadata}`;
        returnDisplayMessage +=
          (returnDisplayMessage ? APPENDED_METADATA_SEPARATOR : '') + metadata;
      }
    }

    // When `result.error` is set, `coreToolScheduler` builds the
    // model-facing functionResponse from `error.message`, NOT from
    // `llmContent` (see `convertToFunctionResponse` and the error
    // branch in scheduler's success/error split). So if a long
    // command hits this path the hint we appended to llmContent above
    // would be silently dropped before reaching the agent. Append the
    // hint to error.message too so the advisory survives whichever
    // branch the scheduler takes.
    //
    // Note on reach: `ShellExecutionResult.error` is reserved for
    // SPAWN / setup failures (per the field's doc comment in
    // shellExecutionService.ts); non-zero exits leave it null. Real
    // spawn failures (ENOENT, permission denied) typically resolve in
    // <1s, so the elapsed >= threshold + spawn-error combination is
    // rare. The preservation is here for the slow-spawn edge cases
    // (PTY init dragging, remote-fs exec syscalls, security scanners
    // interposing) where the rare path could still trigger and the
    // hint would otherwise vanish.
    //
    // Use a `---` divider line so downstream consumers of
    // `error.message` (firePostToolUseFailureHook, telemetry grouping,
    // SIEM alerting, hook-side error parsers) have an unambiguous
    // boundary they can split on rather than getting ~400 chars of
    // advisory text mixed inline with the original error body.
    const executionError = timeoutSummary
      ? {
          error: {
            message: timeoutSummary,
            type: ToolErrorType.EXECUTION_TIMEOUT,
          },
        }
      : result.error
        ? {
            error: {
              message:
                result.error.message +
                (longRunHint ? `\n\n---\n${longRunHint}` : ''),
              type: ToolErrorType.SHELL_EXECUTE_ERROR,
            },
          }
        : (!result.aborted && isSignalTermination(result.signal)) ||
            isShellExitError(this.params.command, result.exitCode)
          ? {
              error: {
                // Schedulers use error.message as the model-facing response.
                message:
                  typeof llmContent === 'string'
                    ? llmContent
                    : returnDisplayMessage,
                type: ToolErrorType.SHELL_EXECUTE_ERROR,
              },
            }
          : {};

    return {
      llmContent,
      returnDisplay: {
        type: 'shell_result',
        version: 1,
        text: returnDisplayMessage,
        output: result.output,
        directory: cwd,
        exitCode: result.exitCode,
        signal: result.signal,
        pid: result.pid ?? null,
        error:
          timeoutSummary ??
          (result.error
            ? result.error.message.replace(
                commandToExecute,
                this.params.command,
              )
            : null),
        outcome: wasTimeout
          ? 'timed_out'
          : result.aborted && !wasPromoteRefused
            ? 'cancelled'
            : result.error ||
                isSignalTermination(result.signal) ||
                isShellExitError(this.params.command, result.exitCode)
              ? 'failed'
              : 'completed',
        notices: appendedMetadata,
        truncated: false,
        outputFiles: persistedOutputFiles ?? [],
      },
      ...(persistedOutputFiles !== undefined ? { persistedOutputFiles } : {}),
      ...(outputBudgetApplied ? { outputBudgetApplied } : {}),
      ...executionError,
    };
  }

  /**
   * Foreground → background promote handler. Called when the foreground
   * execute path observes `result.promoted: true` (the user pressed
   * Ctrl+B mid-flight). Writes the initial snapshot + open the
   * post-promote append stream so subsequent child bytes land in
   * `bg_xxx.output`, registers a `BackgroundShellEntry` in the same
   * registry the `is_background: true` path uses, wires settle so
   * natural child exit transitions the entry to `'completed'` /
   * `'failed'`, and returns a model-facing `ToolResult` pointing at
   * `/tasks` / the dialog / `task_stop` for follow-up.
   *
   * PR-2.5: post-promote stream redirect + natural-exit registry
   * settle are now live via the `postPromote` callbacks wired in
   * `executeForeground`. The `promoteArtifacts` parameter carries the
   * pre-allocated buffer/stream slots that absorb the race between
   * service-side promote-time data flush and this finalizer running.
   *
   * `preHead` is the HEAD captured synchronously before spawn (null
   * unless the command carried a commit recognisable as landing in our
   * cwd, unsandboxed). A promoted command settles after `execute()`
   * has returned, so the foreground registration block never runs for
   * it — registration happens here, at settle (#12514).
   */
  private async handlePromotedForeground(
    result: ShellExecutionResult,
    cwd: string,
    commandToExecute: string,
    abortController: AbortController,
    promoteArtifacts: PromoteArtifacts,
    preHead: string | null,
  ): Promise<ToolResult> {
    // Mirror executeBackground's outputPath layout so /tasks-on-disk and
    // ReadFileTool's auto-allow rules treat foreground-promoted shells
    // and originally-background shells identically.
    const outputDir = path.join(
      this.config.storage.getProjectTempDir(),
      'background-shells',
      this.config.getSessionId(),
    );
    // The service has already detached its kill path by the time we
    // get here (PR-1's ownership-transfer contract), so any throw
    // before we wire up the registry's kill listener leaves the still-
    // running child as an orphan zombie that nothing can stop until
    // the OS reaps it on session end. Wrap the mkdir + write best-
    // effort: if either fails, log + reap the child immediately and
    // report the failure to the caller (mirrors the safety pattern
    // around `registry.register` further down).
    let mkdirError: Error | undefined;
    try {
      fs.mkdirSync(outputDir, { recursive: true });
    } catch (err) {
      mkdirError = err instanceof Error ? err : new Error(String(err));
    }
    if (mkdirError) {
      debugLogger.warn(
        `promote: mkdirSync(${outputDir}) failed before registry register — killing orphan child: ${mkdirError.message}`,
      );
      const pid = result.pid;
      if (pid !== undefined) {
        if (os.platform() === 'win32') {
          try {
            const taskkillChild = childProcess.spawn(
              'taskkill',
              ['/pid', String(pid), '/f', '/t'],
              // Without this flag each console-app child allocates a visible
              // window when the CLI has no console of its own.
              { windowsHide: true },
            );
            taskkillChild.on('error', () => {
              /* swallow — already in error path */
            });
          } catch {
            /* swallow */
          }
        } else {
          try {
            process.kill(-pid, 'SIGTERM');
          } catch {
            /* swallow — pid gone or perms */
          }
        }
      }
      throw mkdirError;
    }

    const shellId = `bg_${crypto.randomBytes(4).toString('hex')}`;
    const outputPath = path.join(outputDir, `shell-${shellId}.output`);
    // PR-2.5: open an append-mode write stream so the initial snapshot
    // AND post-promote bytes from the still-running child both land in
    // the same file. Synchronous open via `createWriteStream` with
    // `flags: 'w'` (overwrite) — if a stale file is somehow there from
    // a prior session with the same shellId (vanishingly unlikely
    // given the randomBytes), start fresh. Stream errors (ENOSPC mid-
    // stream, permission flip) are logged via 'error' listener; we
    // never let them crash the process.
    let outputStream: fs.WriteStream | null = null;
    try {
      outputStream = fs.createWriteStream(outputPath, { flags: 'w' });
      // PR-2.5 wave-2: `createWriteStream` reports common
      // failures (ENOENT / EACCES / ENOSPC during the async libuv
      // `open`) via an `'error'` event AFTER this synchronous call
      // returns — they do NOT throw. Without latching the failure
      // here, `promoteArtifacts.stream` would still point at an
      // already-broken stream, `postPromote.onData` would `write` into
      // it (catching the throw via its own try/catch but never
      // releasing the buffer), and `onSettleWired` would attach a
      // `'finish'` listener that never fires → registry stuck on
      // `running` forever. Latch the failure: null the stream,
      // mark `streamClosed` so `onData` drops chunks, and let
      // `onSettleWired` transition the registry immediately (its
      // existing `if (!stream)` branch handles that case).
      outputStream.on('error', (err) => {
        debugLogger.warn(
          `promote: output write stream error for ${outputPath}: ${getErrorMessage(err)}`,
        );
        const droppedChunks = promoteArtifacts.buffer.length;
        promoteArtifacts.stream = null;
        promoteArtifacts.streamClosed = true;
        try {
          fs.appendFileSync(
            outputPath,
            `\n[WARNING: post-promote output lost — stream error (${getErrorMessage(err)}). ${droppedChunks} buffered chunks dropped.]\n`,
          );
        } catch {
          // Best-effort diagnostic — if the append itself fails
          // (e.g. disk full), the debugLogger.warn above is the
          // only trace left.
        }
      });
      // Initial snapshot first, so it always precedes post-promote
      // bytes in the file (write ordering is FIFO on a single stream).
      outputStream.write(result.output);
      // PR-2.5 wave-4: assign the stream BEFORE draining
      // the buffer, not after. The drain + assign block is synchronous
      // today (single-tick JS, so a service-side `onData` callback
      // cannot fire between drain-end and assign), but the assign-
      // after-drain order leaves a hazard for any future refactor
      // that introduces an `await` inside the drain — a chunk arriving
      // in that window would be pushed into `promoteArtifacts.buffer`
      // (because `stream` is still null), then later chunks would write
      // directly to the stream after assign, producing out-of-order
      // bytes in `bg_xxx.output` until the settle drain caught the
      // straggler. Assign-first eliminates the hazard entirely:
      // concurrent `onData` writes go straight through after the
      // queued snapshot + the queued drained chunks, in the correct
      // FIFO order on the stream.
      promoteArtifacts.stream = outputStream;
      while (promoteArtifacts.buffer.length > 0) {
        const chunk = promoteArtifacts.buffer.shift()!;
        outputStream.write(chunk);
      }
    } catch (err) {
      debugLogger.warn(
        `promote: failed to open output stream for ${outputPath}: ${getErrorMessage(err)}`,
      );
      // Stream failure is recoverable — the registry entry is still
      // valuable on its own; the file is the inspection surface only.
      // Continue without a stream; future onData chunks are dropped
      // (their warns will accumulate in the log, which is enough
      // observability for a rare disk failure case).
      promoteArtifacts.stream = null;
      // Latch streamClosed so the foreground postPromote.onData
      // handler stops buffering chunks that would never be drained
      // (the drain path only runs when `stream` becomes non-null,
      // which never happens after this branch).
      promoteArtifacts.streamClosed = true;
      // PR-2.5 wave-3: record how many pre-
      // finalizer post-promote chunks are being dropped. Without
      // this an oncall engineer reading a truncated `bg_xxx.output`
      // has no signal that the truncation is due to stream-open
      // failure rather than the child not producing more output.
      // The chunks themselves are gone (no salvage path exists once
      // the stream open has failed and the buffer drain depends on
      // a non-null stream slot).
      if (promoteArtifacts.buffer.length > 0) {
        debugLogger.warn(
          `promote: dropping ${promoteArtifacts.buffer.length} buffered post-promote chunks for ${outputPath} (stream open failed before drain)`,
        );
        promoteArtifacts.buffer.length = 0;
      }
      // Last-ditch: try a sync snapshot write so /tasks still has
      // SOMETHING readable; the buffer chunks are lost in this branch.
      try {
        fs.writeFileSync(outputPath, result.output);
      } catch (err2) {
        debugLogger.warn(
          `promote: snapshot fallback writeFileSync also failed for ${outputPath}: ${getErrorMessage(err2)}`,
        );
      }
    }

    const startTime = Date.now();
    const registry = this.config.getBackgroundShellRegistry();
    // Create a FRESH AbortController for the registry entry. Using the
    // promote AbortController directly (which is already in the
    // `aborted` state — that's what triggered the promote) would be
    // a real bug: `task_stop bg_xxx` calls `entry.abortController.abort()`
    // which is a no-op on an already-aborted controller, AND
    // `ShellExecutionService` has detached its abort listener as part
    // of the promote handoff (PR-1's ownership-transfer contract), so
    // there's nobody left to translate the abort into an actual signal
    // to the still-running child. Instead, the entry gets a new
    // controller, and we wire the abort listener directly to send
    // SIGTERM → SIGKILL ourselves (mirroring the kill semantics
    // `ShellExecutionService.execute()`'s abort handler uses for the
    // non-promote path) and to mark the registry entry `cancelled`.
    const entryAc = new AbortController();
    const cancelChild = async () => {
      const pid = result.pid;
      if (pid !== undefined) {
        if (os.platform() === 'win32') {
          try {
            const taskkillChild = childProcess.spawn(
              'taskkill',
              ['/pid', String(pid), '/f', '/t'],
              // Without this flag each console-app child allocates a visible
              // window when the CLI has no console of its own.
              { windowsHide: true },
            );
            // Without an 'error' listener on the spawned ChildProcess,
            // a taskkill spawn failure (binary missing, permission
            // denied, etc.) would emit 'error' with no listener — which
            // crashes Node by default. Log + drop is the sane recovery:
            // the registry entry still transitions via `registry.cancel`
            // below; the still-running child is at worst an orphan,
            // which Windows reaps when the CLI session ends.
            taskkillChild.on('error', (err) => {
              debugLogger.warn(
                `promote: taskkill spawn failed for pid=${pid}: ${err.message}`,
              );
            });
          } catch (e) {
            // childProcess.spawn itself throwing (sync) is rare but possible
            // (e.g. EMFILE — too many open files) — same recovery.
            debugLogger.warn(
              `promote: childProcess.spawn('taskkill') threw for pid=${pid}: ${getErrorMessage(e)}`,
            );
          }
        } else {
          try {
            // Negative pid → kill the whole process group; matches the
            // `detached: !isWindows` spawn the foreground path uses.
            process.kill(-pid, 'SIGTERM');
            await new Promise((res) =>
              setTimeout(res, PROMOTE_CANCEL_SIGKILL_TIMEOUT_MS),
            );
            try {
              process.kill(-pid, 'SIGKILL');
            } catch {
              // Already dead before SIGKILL — happy path.
            }
          } catch (e) {
            debugLogger.warn(
              `promote: process.kill on -${pid} threw: ${getErrorMessage(e)}`,
            );
          }
        }
      }
      // Sync-mark the registry entry `cancelled` so /tasks reflects the
      // user intent immediately. (Recursive note: `registry.cancel`
      // calls `entry.abortController.abort()` internally, but our
      // entryAc is already aborted by the time we got here, so that
      // call is a no-op + our listener was `{ once: true }` and has
      // already detached.)
      registry.cancel(shellId, Date.now());
    };
    entryAc.signal.addEventListener('abort', () => void cancelChild(), {
      once: true,
    });
    const entry: ShellTaskRegistration = {
      shellId,
      command: commandToExecute,
      cwd,
      pid: result.pid,
      status: 'running',
      startTime,
      outputPath,
      abortController: entryAc,
    };
    // Reference `abortController` so it's not unused — the parameter
    // is kept on the signature so a future PR-2.5 that needs to
    // double-link the original promote signal can read it without
    // re-plumbing.
    void abortController;

    // `registry.register` is internally safe today (Map.set + emit),
    // but if a future implementation throws, the promoted child is
    // already detached from the service and would become an orphan
    // zombie with no kill path. Wrap defensively: best-effort kill the
    // child and re-throw so the scheduler surfaces the failure instead
    // of pretending promote succeeded.
    try {
      registry.register(entry);
    } catch (e) {
      debugLogger.warn(
        `promote: registry.register threw for ${shellId} (pid=${result.pid}) — killing orphan child: ${
          e instanceof Error ? e.message : String(e)
        }`,
      );
      try {
        entryAc.abort();
      } catch {
        /* swallow — we're already in an error path */
      }
      // PR-2.5: close the output stream so the FD doesn't leak past
      // the throw. Best-effort — if .end() itself throws we're
      // already in an error path with the orphan-child kill already
      // in flight.
      try {
        promoteArtifacts.stream?.end();
      } catch {
        /* swallow */
      }
      promoteArtifacts.stream = null;
      throw e;
    }

    // PR-2.5: wire the post-promote settle so a natural child exit
    // (or spawn-side error) transitions the registry entry from
    // `'running'` to `'completed'` / `'failed'`. Without this the
    // entry stays `'running'` until `task_stop` / session-end. The
    // service's `postPromote.onSettle` fires AT MOST ONCE per
    // promote, and `registry.complete` / `registry.fail` are
    // idempotent (no-op when status !== 'running'), so a race with
    // `entryAc.abort() → registry.cancel` (task_stop fired during the
    // exit window) is safe: whichever lands first wins, the other
    // becomes a no-op.
    // Status flags consumed by the model-facing copy below.
    //
    // - `postPromoteSettleObserved`: SET SYNCHRONOUSLY inside
    //   `onSettleWired` the moment we know the child has exited (the
    //   service has called us with settle info). Independent of
    //   whether the registry transition has actually completed yet,
    //   because the transition may be deferred awaiting the output
    //   stream's `'finish'` event (libuv flush). This is the flag
    //   the model-facing copy branches on: once we know the child has
    //   exited, saying "Status: running" + suggesting `task_stop`
    //   would mislead the agent.
    // - `postPromoteFinalStatus`: classified from the settle info at
    //   the same synchronous moment, so the status line can report
    //   the right terminal status even if the registry transition is
    //   still in flight.
    //
    // PR-2.5 wave-2: originally the model-facing copy
    // checked a `postPromoteAlreadySettled` flag that was only flipped
    // AFTER the registry transition fired (post-flush). A fast-exited
    // promoted command could therefore land "Status: running" +
    // `task_stop` instructions in the model copy even when settle was
    // already queued, because the queued-settle drain returned before
    // the stream's 'finish' event fired. The two flags decouple
    // "child has exited" (what the agent cares about) from "registry
    // transition has run" (which can lag behind libuv flush).
    let postPromoteSettleObserved = false;
    let postPromoteFinalStatus: 'completed' | 'failed' | null = null;
    const classifySettle = (
      info: ShellPostPromoteSettleInfo,
    ): { status: 'completed' | 'failed'; failMsg: string | null } => {
      // Decision table: `error` → fail (spawn-side failure); a non-zero
      // signal means the process was killed (including node-pty's
      // `exitCode: 0, signal: N` shape), then `exitCode === 0` → complete;
      // non-zero exitCode → fail; everything-null → fail with a generic
      // message.
      if (info.error) return { status: 'failed', failMsg: info.error.message };
      if (isSignalTermination(info.signal)) {
        return {
          status: 'failed',
          failMsg: `Terminated by signal ${info.signal}`,
        };
      }
      if (info.exitCode === 0) return { status: 'completed', failMsg: null };
      if (info.exitCode !== null)
        return {
          status: 'failed',
          failMsg: `Exited with code ${info.exitCode}`,
        };
      // PR-2.5 wave-3: this branch is meant to
      // be unreachable — the service always populates one of
      // `error` / `exitCode` / `signal`. Hitting it means the
      // service emitted a defective settle info object, which is a
      // logic bug. Capture the actual field values in the failure
      // message AND warn-log so the oncall engineer reading
      // `/tasks` or the debug log can tell THIS path apart from the
      // other "failed" branches. (`info.error` has been narrowed to
      // `never` by the preceding `if (info.error) return`, so we
      // can't read `.message` here — by construction it would be
      // `undefined` at runtime anyway.)
      debugLogger.warn(
        `promote: classifySettle all-null fallback hit for ${shellId} — ` +
          `exitCode=${info.exitCode}, signal=${info.signal}, error=undefined`,
      );
      return {
        status: 'failed',
        failMsg: `Exited with unknown status (exitCode=${info.exitCode}, signal=${info.signal}, error=undefined)`,
      };
    };
    const transitionRegistry = (info: ShellPostPromoteSettleInfo) => {
      // `task_stop` aborts the entry before the child necessarily reports
      // its signal. Preserve the user-intended `cancelled` state instead of
      // allowing the later signal settle to overwrite it as `failed`.
      if (entryAc.signal.aborted) {
        registry.cancel(shellId, info.endTime);
        return;
      }
      const cls = classifySettle(info);
      if (cls.status === 'completed') {
        registry.complete(shellId, info.exitCode as number, info.endTime);
      } else {
        registry.fail(shellId, cls.failMsg as string, info.endTime);
      }
    };
    // Session-commit registration for the promoted path (#12514 A.3).
    // `execute()` returns the promote ToolResult without reaching the
    // foreground registration block, so a commit landed by a promoted
    // command would never earn the amend exemption. `preHead` arrives
    // from the caller's pre-spawn capture, gated there on
    // `commitLandsInCwd` (and non-sandboxed), so a
    // null here means the command carried no commit recognisable as
    // landing in our cwd — `cd /elsewhere && git commit` stays
    // unregistered exactly as the foreground path leaves it, and
    // `head.sha !== preHead` can never be trivially true.
    //
    // Registration is settle-only by design: the commit can land at any
    // point in the backgrounded child's life, and the only moment this
    // path can observe "the child is done" is its settle. So for a child
    // that is still running the exemption arrives later than the
    // ToolResult that precedes it (pinned by the deferred-settle row in
    // `shell.session-commit-tracking.test.ts`), and for a child that
    // never settles (`npm run dev`, `tail -f`) it never arrives. Closing
    // that needs a probe independent of the settle, which is a different
    // mechanism than this PR's; the promote handoff probe alone would
    // still miss a commit that lands after the user pressed Ctrl+B.
    let promotedCommitRegistration: Promise<void> | null = null;
    // Snapshot the registry generation at promote time. `Config.
    // setApprovalMode` clears the session-commit registry on every real
    // transition because exemptions must not carry across that boundary
    // — but this registration fires when the child exits, arbitrarily
    // later, so without the check a settle landing after such a
    // transition writes the exemption straight back into the cleared
    // registry.
    const registrationGeneration = getSessionCommitGeneration();
    const registerPromotedCommit = (): void => {
      if (preHead === null || promotedCommitRegistration !== null) return;
      if (getSessionCommitGeneration() !== registrationGeneration) {
        // Fail-closed: the registry this decision was made against no
        // longer exists, so the exemption it would grant is stale. The
        // agent's own commit stays amend-blocked until it commits again
        // inside the current registry generation.
        debugLogger.warn(
          `promote: skipping session-commit registration in ${cwd}: the ` +
            `session-commit registry was cleared (approval-mode transition or ` +
            `session end) after this command was promoted, so the exemption ` +
            `must not carry across that boundary.`,
        );
        return;
      }
      promotedCommitRegistration = this.trackSessionCommit(
        cwd,
        preHead,
        // Lineage, not mere difference. This runs when the backgrounded
        // child exits — arbitrarily later than the caller's pre-spawn
        // capture — so a commit anybody else lands in this repository
        // while the child runs is the newest `commit:` entry by then,
        // and `head.sha !== preHead` alone would adopt it: the foreign
        // commit would earn the amend exemption and the promoted one
        // would lose its own. Requiring that entry to have moved HEAD
        // *from* `preHead` keeps the registered SHA one this command
        // created (see `trackSessionCommit`'s `requirePredecessor`).
        preHead,
      ).catch((err: unknown) => {
        // Registration must never break the settle path — a failure
        // here costs the exemption (fail-closed), nothing more.
        debugLogger.warn(
          `promote: session-commit registration failed: ${getErrorMessage(err)}`,
        );
      });
    };
    promoteArtifacts.onSettleWired = (info) => {
      // The child has exited — if the promoted command landed a commit
      // in our cwd, this is the moment to register it (the foreground
      // path's equivalent runs after the foreground result resolves).
      registerPromotedCommit();
      // Synchronous observation — the child has exited; classify now
      // so the model-facing copy can branch correctly even when the
      // registry transition is deferred behind the stream's flush.
      const cls = classifySettle(info);
      postPromoteFinalStatus = cls.status;
      postPromoteSettleObserved = true;
      // Wait for the output stream to fully FLUSH before transitioning
      // the registry. `stream.end()` is asynchronous — pending writes
      // can still be in the libuv queue when it returns. Without the
      // 'finish' wait, `/tasks` consumers can observe the entry as
      // `completed`/`failed` and read the output file BEFORE the
      // trailing bytes are on disk, producing truncated logs.
      const stream = promoteArtifacts.stream;
      // PR-2.5 wave-3: drain the pre-settle
      // buffer to the stream BEFORE nulling the shared slot. Service-
      // side `onData` callbacks that race the foreground finalizer
      // can land chunks in the buffer between when the wire fires
      // and when the buffer drain (during stream-open) sees them.
      // Without this drain those chunks are stranded. AND latch
      // `streamClosed` together with the null so that any
      // chunk arriving AFTER `.end()` (during the flush window —
      // unlikely once the service has emitted settle, but kernel
      // buffers can deliver late on PTY) is DROPPED via the
      // `else if (promoteArtifacts.streamClosed)` arm in `onData`
      // instead of being pushed into the now-undrainable buffer.
      if (stream) {
        while (promoteArtifacts.buffer.length > 0) {
          try {
            stream.write(promoteArtifacts.buffer.shift()!);
          } catch (writeErr) {
            // Stream write failure during pre-end drain — log + drop,
            // same recovery posture as the foreground `onData` write
            // path. The error event will fire async if the stream is
            // dead, latching `streamClosed` via the 'error' handler.
            debugLogger.warn(
              `promote: pre-end buffer drain write failed: ${getErrorMessage(writeErr)}`,
            );
          }
        }
      }
      promoteArtifacts.stream = null;
      promoteArtifacts.streamClosed = true;
      if (!stream) {
        // No stream (open failed or already ended) — transition right
        // away, no flush to wait on.
        transitionRegistry(info);
        return;
      }
      endStreamThenSettle(stream, 'promote', shellId, () =>
        transitionRegistry(info),
      );
    };
    // Drain a settle that landed BEFORE the wire installed (fast
    // commands can exit between `result.promoted` and this line).
    // After this call returns, `postPromoteSettleObserved` is true
    // if a settle was queued — that's the case the model-facing copy
    // below branches on so the message doesn't say "Status: running"
    // for a process that already finished during the registration
    // window.
    if (promoteArtifacts.settleQueued) {
      const queued = promoteArtifacts.settleQueued;
      promoteArtifacts.settleQueued = null;
      promoteArtifacts.onSettleWired(queued);
    }
    // When the settle was already queued (a fast-settling promoted
    // command), the registration probe kicked off above is in flight —
    // await it so the exemption is in place by the time the ToolResult
    // is returned. For a still-running child this is null and costs
    // nothing; the registration then completes via `onSettleWired`
    // whenever the child exits.
    await promotedCommitRegistration;

    // Build the model-facing status line based on whether the settle
    // was observed synchronously (i.e. the child has exited). Branch
    // on `postPromoteSettleObserved` rather than the post-flush latch
    // — see the flag block above for the rationale.
    const statusLine = postPromoteSettleObserved
      ? `Status: ${postPromoteFinalStatus ?? 'settled'}. PID: ${result.pid ?? '(unknown)'}.`
      : `Status: running. PID: ${result.pid ?? '(unknown)'}.`;
    const statusFileLine = statusFileGuidance(outputPath);
    const inspectLine = `To inspect: \`/tasks\` (text), the Background tasks dialog (↓ + Enter on the footer pill), or \`Read\` the output file directly.`;
    const stopLine = postPromoteSettleObserved
      ? `Process has already exited; no \`task_stop\` needed (the entry is observable in \`/tasks\` for inspection).`
      : `To stop the now-background process: \`task_stop({ task_id: '${shellId}' })\`.`;
    const llmContent = [
      `Foreground command "${commandToExecute}" promoted to background as ${shellId}.`,
      statusLine,
      `Output snapshot at promote time saved to: ${outputPath}`,
      statusFileLine,
      inspectLine,
      stopLine,
    ].join('\n');

    debugLogger.debug(
      `promote: registered ${shellId} (pid=${result.pid}) — outputPath=${outputPath}`,
    );

    return {
      llmContent,
      returnDisplay: `Promoted to background: ${shellId}`,
    };
  }

  /**
   * Background-execution path: spawn the command into a managed registry
   * entry instead of detaching with `&`. Output streams to a per-shell file
   * the agent can `Read`; cancellation flows through the entry's
   * AbortController; the registry's terminal status is set when the process
   * exits. Returns immediately so the agent's turn isn't blocked.
   */
  private async executeBackground(
    signal: AbortSignal,
    shellExecutionConfig?: ShellExecutionConfig,
  ): Promise<ToolResult> {
    // Strip a single bare trailing `&` (the bash background operator) before
    // spawn: bash treats it as background-detach, exits the wrapper
    // immediately, and the real child outlives the wrapper — the registry
    // would settle as `completed` while the shell is still running, and
    // chunked output would land on a closed stream. The managed path is
    // itself the backgrounding mechanism, so the trailing `&` is redundant.
    //
    // Deliberately precise: do not touch `&&` (logical AND), `\&` (escaped
    // literal `&`), or commands without a trailing `&`. Earlier `\s*&+\s*$`
    // was both too greedy (it ate `&&` and `\&`) and a ReDoS hazard on
    // long all-`&` inputs. Plain string checks here are linear and clearer
    // than a lookbehind regex.
    //
    // Operate on the trimmed *original* command so leading env assignments
    // / shell wrappers survive through to execution; ShellExecutionService
    // re-runs the user-approved invocation verbatim.
    const trimmedOriginal = this.params.command.trim();
    const processedCommand = stripTrailingBackgroundAmp(trimmedOriginal);
    if (processedCommand !== trimmedOriginal) {
      debugLogger.warn(
        'Stripped trailing & from background shell command — managed path handles backgrounding',
      );
    }
    const cwd = this.params.directory || this.config.getTargetDir();

    // Output goes under the project temp dir (which `ReadFileTool`
    // auto-allows by default), so the LLM can `Read` the captured output
    // without bouncing off a permission prompt — important because
    // background-agent contexts can't surface interactive prompts.
    const outputDir = path.join(
      this.config.storage.getProjectTempDir(),
      'background-shells',
      this.config.getSessionId(),
    );
    fs.mkdirSync(outputDir, { recursive: true });

    const shellId = `bg_${crypto.randomBytes(4).toString('hex')}`;
    const outputPath = path.join(outputDir, `shell-${shellId}.output`);

    // Background shells are explicitly independent of the current turn:
    // the user pressing Ctrl+C on a turn (which aborts `signal`) should
    // NOT kill a long-running dev server / watcher they intentionally
    // backgrounded. Cancellation flows only through the entry's own
    // AbortController, driven by future `task_stop` integration (#3471).
    // The `signal` parameter is still honored for the synchronous early
    // return below (don't even spawn if the agent already aborted), but
    // we deliberately do not forward it.
    const entryAc = new AbortController();

    const outputStream = fs.createWriteStream(outputPath, { flags: 'w' });
    // Without an 'error' listener, a write failure (disk full, permission
    // change, fs going away) would surface as an uncaught exception and
    // kill the entire CLI session. Log + drop is the sane default — the
    // process keeps running, the registry still settles via resultPromise.
    outputStream.on('error', (err) => {
      debugLogger.warn(
        `background shell ${shellId} output write error: ${err.message}`,
      );
    });

    const startTime = Date.now();
    const registration: ShellTaskRegistration = {
      shellId,
      command: processedCommand,
      cwd,
      status: 'running',
      startTime,
      outputPath,
      abortController: entryAc,
    };

    let executionHandle;
    try {
      executionHandle = await executeRuntimeShell(
        this.config,
        processedCommand,
        cwd,
        (event: ShellOutputEvent) => {
          if (event.type === 'data' && typeof event.chunk === 'string') {
            // Strip ANSI escape codes (color, cursor-move, clear-screen) before
            // writing — agents read the file as plain text, and dev servers /
            // build tools spam plenty of escape sequences that would render as
            // garbage. Costs ~one regex per chunk; cheap relative to disk I/O.
            outputStream.write(stripAnsi(event.chunk));
          }
          // ANSI array chunks and binary streams are not written to the output
          // file: agents read the file as plain text and binary spam would be
          // unhelpful.
        },
        entryAc.signal,
        // Background shells are non-interactive by design — no terminal to
        // attach a PTY to, no human to type at it. Force the child_process
        // path so we don't pull in node-pty for fire-and-forget commands.
        false,
        shellExecutionConfig ?? {},
        // Stream stdout/stderr through to the output file as chunks arrive.
        // Default child_process mode buffers until exit, which would leave
        // dev-server / watcher output files empty until the process dies.
        { streamStdout: true },
      );
    } catch (error) {
      outputStream.destroy();
      try {
        fs.rmSync(outputPath, { force: true });
      } catch (cleanupError) {
        debugLogger.warn(
          `background shell ${shellId} output cleanup failed: ${getErrorMessage(cleanupError)}`,
        );
      }
      throw error;
    }
    const { result: resultPromise, pid } = executionHandle;

    if (pid !== undefined) registration.pid = pid;
    const registry = this.config.getBackgroundShellRegistry();
    // Symmetric with the promote path above: `register` is internally
    // safe today (Map.set + emit), but a throwing subscriber would
    // propagate here and leave the already-spawned child + open output
    // stream unreachable by `/tasks` / `task_stop`. Best-effort abort
    // the child, tear down the stream, and re-throw so the launch fails
    // visibly instead of leaking.
    try {
      registry.register(registration);
    } catch (e) {
      debugLogger.warn(
        `background shell ${shellId} register threw (pid=${pid}) — aborting orphan child: ${
          e instanceof Error ? e.message : String(e)
        }`,
      );
      try {
        entryAc.abort();
      } catch {
        /* swallow — we're already in an error path */
      }
      try {
        outputStream.destroy();
      } catch {
        /* swallow — we're already in an error path */
      }
      throw e;
    }

    // Settle in the background — do NOT await here, the agent should be
    // unblocked immediately.
    //
    // Same flush-ordering hazard as the promote settle path: transition
    // the registry only after the output stream has flushed, so the
    // status sidecar can't report a terminal state while the trailing
    // output bytes are still in the libuv queue. The exit timestamp is
    // captured BEFORE the flush wait — endTime records when the child
    // exited, not when its bytes reached disk.
    void resultPromise.then(
      (result) => {
        const endTime = Date.now();
        endStreamThenSettle(outputStream, 'background', shellId, () => {
          if (entryAc.signal.aborted) {
            if (registry.get(shellId)?.status === 'running') {
              registry.cancel(shellId, endTime);
            }
          } else if (
            result.error ||
            (result.exitCode !== null && result.exitCode !== 0) ||
            isSignalTermination(result.signal)
          ) {
            // Non-zero exit / killed by signal / spawn error all count as failed.
            // Treating them as `completed` would let `/tasks` (and any future
            // model-facing notification) misreport a failed `npm test` or
            // `false` command as a success.
            const reason = result.error
              ? result.error.message
              : isSignalTermination(result.signal)
                ? `terminated by signal ${result.signal}`
                : `exited with code ${result.exitCode}`;
            registry.fail(shellId, reason, endTime);
          } else {
            registry.complete(shellId, result.exitCode ?? 0, endTime);
          }
        });
      },
      (err) => {
        const endTime = Date.now();
        endStreamThenSettle(outputStream, 'background', shellId, () =>
          registry.fail(shellId, getErrorMessage(err), endTime),
        );
      },
    );

    const pidLine = pid !== undefined ? `pid: ${pid}\n` : '';
    return {
      llmContent:
        `Background shell started.\n` +
        `id: ${shellId}\n` +
        pidLine +
        `output file: ${outputPath}\n` +
        `${statusFileGuidance(outputPath)}\n` +
        `To inspect: /tasks (text) or the interactive Background tasks dialog (focus the footer Background tasks pill, then Enter — detail view + live updates). Read the output file directly to view the captured output.`,
      returnDisplay: `Background shell ${shellId} started${pid !== undefined ? ` (pid ${pid})` : ''}.`,
    };
  }

  /**
   * Read the current HEAD SHA, or null if unavailable (no commits yet,
   * not a git repo, or git failed). Captured synchronously BEFORE the
   * user's shell command spawns so a fast `git commit` (hot-cached, no
   * hooks) cannot move HEAD before the read — a real race seen on slow
   * filesystems / heavy contention where preHead would otherwise resolve
   * to the new SHA and the commit would go unregistered.
   *
   * Worst case is ~10–50 ms of event-loop block per commit-shaped shell
   * command; acceptable trade for correctness of the post-command HEAD
   * comparison.
   */
  private getGitHeadSync(cwd: string): string | null {
    try {
      const stdout = childProcess.execFileSync('git', ['rev-parse', 'HEAD'], {
        cwd,
        timeout: 2000,
        windowsHide: true,
        // Discard stderr noise (e.g. "fatal: not a git repository") —
        // the catch-or-empty-output path already covers failure.
        stdio: ['ignore', 'pipe', 'ignore'],
      });
      const sha = String(stdout).trim();
      return sha.length > 0 ? sha : null;
    } catch {
      return null;
    }
  }

  /**
   * Record HEAD in the session registry (`permissions/destructive-commands.ts`)
   * when a `git commit` put it there, so a later `git commit --amend` of it is
   * exempt from the Auto-mode destructive-command block.
   *
   * The criterion is "the newest HEAD reflog entry is a `commit` verb, and
   * HEAD moved". Exit code is too strict (`git commit -m x && npm test` can
   * land the commit and then fail). HEAD movement alone is too loose, and
   * fail-open: in `git pull && git commit -m x` with nothing staged, the pull
   * fast-forwards onto somebody else's commit and the commit then exits
   * non-zero — and because `commitLandsInCwd` does not treat
   * `pull`/`checkout`/`merge` as cwd-shifting and the call site has no
   * exit-code gate, that chain really does reach here. A movement-only test
   * would register a human's SHA, trading the deterministic Layer-0 block for
   * the classifier.
   *
   * Where the reflog cannot answer at all (`core.logAllRefUpdates` off, reflog
   * expired, git missing) nothing registers and the amend stays blocked, so
   * that branch costs a blocked amend and never a lifted one.
   *
   * The reflog read does *not* establish that this command's own `git commit`
   * created HEAD, and no local read can: `preHead` is taken before the spawn
   * and the reflog after the whole command, so a commit another process lands
   * in the same repository inside that window is the newest `commit:` entry
   * and registers instead — degrading the next amend's deterministic Layer-0
   * block to the L5.3 classifier, and costing the agent its own exemption,
   * since the foreign entry is the newest one. Binding an entry to this child
   * needs a signal not derivable from reflog shape, and the cheap candidate is
   * unsound: a chain-level `GIT_REFLOG_ACTION` stamp rewrites the action of
   * every reflog-writing git call in the single `/bin/bash -c` child, so a
   * trailing `checkout` would write a `commit:` verb too. Per-invocation
   * stamping means changing how the executor spawns. Tracked in #12523.
   *
   * No multi-commit guard: in `commit a && commit b` HEAD is `b`, created
   * by this command, so registering it is sound and `a` stays blocked.
   *
   * `requirePredecessor` is the promoted path's lineage guard and is
   * deliberately not applied to the foreground one. There, the window
   * between the pre-spawn capture and this reflog read is the command's
   * own duration — the trade-off #12523 tracks and this docblock
   * discloses. On a Ctrl+B promote the same window is the backgrounded
   * child's whole (deliberately long) lifetime, so a commit anybody else
   * lands in this repository meanwhile is not a narrow race but the
   * expected shape, and difference-from-`preHead` alone would adopt it.
   * Passing the captured `preHead` here requires the entry that created
   * HEAD to have moved it *from* that SHA, which only this command's own
   * commit does. Fail-closed both ways: a foreign commit never earns an
   * exemption, and a multi-commit promoted chain (`commit a && commit b`,
   * whose newest entry descends from `a`) loses one it had earned rather
   * than guessing. The foreground call site passes nothing and keeps the
   * disclosed window unchanged.
   */
  private async trackSessionCommit(
    cwd: string,
    preHead: string | null,
    requirePredecessor?: string,
  ): Promise<void> {
    const head = await this.getGitHeadOrigin(cwd);
    if (
      head !== null &&
      requirePredecessor !== undefined &&
      head.predecessor !== requirePredecessor
    ) {
      // Same visibility contract as the `head === null` branch below: the
      // only other output of this path is a block reason asserting the
      // commit was not the agent's, so say which side of the lineage
      // check failed.
      debugLogger.warn(
        `Session commit not registered in ${cwd}: the newest HEAD reflog entry descends from ` +
          `${head.predecessor ?? '(no predecessor)'}, not from the pre-spawn HEAD ` +
          `${requirePredecessor.slice(0, 12)}, so it was not created by this command.`,
      );
      return;
    }
    // Neither condition subsumes the other: `createdByCommit` rejects a HEAD
    // something else relocated, and the `preHead` comparison rejects a commit
    // that never moved HEAD (nothing staged), which would otherwise
    // re-register the pre-existing HEAD.
    if (head !== null && head.createdByCommit && head.sha !== preHead) {
      registerSessionCommit(head.sha);
    } else if (head === null) {
      // Failing closed is the intent; failing closed *invisibly* is not. The
      // only other output of this path is a block reason asserting the
      // commit was not the agent's, and nothing else separates "the reflog
      // could not answer" (reflogs off, expired, probe timed out) from a
      // commit that is genuinely not the agent's.
      debugLogger.warn(
        `Session commit not registered in ${cwd}: the HEAD reflog could not answer, so a later amend stays blocked.`,
      );
    }
  }

  /**
   * Read HEAD, the reflog action that last moved it, and the SHA that
   * entry moved it *from*, in one subprocess.
   *
   * `--no-show-signature` is required, not cosmetic: with
   * `log.showSignature=true` git prints the signature verdict ahead of the
   * formatted output, shifting both fields and making an agent's own signed
   * commit look uncommitted. Inert when nothing is signed.
   *
   * `-2` rather than `-1` so the second entry's SHA is available as the
   * newest entry's predecessor — the lineage input
   * {@link trackSessionCommit} requires on the promoted path. It costs one
   * extra reflog record inside the same 2 s budget.
   *
   * Returns `null` when git cannot answer (not a repo, no HEAD, reflog off or
   * expired, git missing) so every caller fails closed. `predecessor` is
   * `null` when the reflog holds a single entry (an initial commit, or one
   * expired down to a single record).
   */
  private async getGitHeadOrigin(cwd: string): Promise<{
    sha: string;
    createdByCommit: boolean;
    predecessor: string | null;
  } | null> {
    return new Promise((resolve) => {
      const child = childProcess.execFile(
        'git',
        ['log', '-g', '-2', '--no-show-signature', '--format=%H%n%gs', 'HEAD'],
        { cwd, timeout: 2000, windowsHide: true },
        (error, stdout) => {
          if (error) {
            resolve(null);
            return;
          }
          // One line per field, newest entry first: its SHA, its reflog
          // subject, then the previous entry's SHA (whose subject is not
          // read).
          const [sha, subject, predecessor] = String(stdout).split('\n');
          if (!sha || !subject) {
            resolve(null);
            return;
          }
          // Reflog verbs are not localised by git. `\b` admits `commit:`,
          // `commit (initial|amend|merge):` and excludes every other verb.
          resolve({
            sha: sha.trim(),
            createdByCommit: /^commit\b/.test(subject),
            predecessor: predecessor?.trim() || null,
          });
        },
      );
      // Suppress unhandled-error events from the child stream (e.g. ENOENT
      // when git is missing); the callback still receives the error.
      child.on('error', () => {});
    });
  }
}

function getExecutableBasename(executable: string): string {
  return path.basename(path.win32.basename(executable));
}

function getShellDisplayName({
  executable,
  shell,
}: ShellConfiguration): string {
  switch (shell) {
    case 'cmd':
      return 'cmd.exe';
    case 'powershell': {
      const basename = getExecutableBasename(executable).toLowerCase();
      return basename === 'pwsh.exe' ? 'pwsh.exe' : 'powershell.exe';
    }
    case 'bash':
      return 'bash';
    default: {
      const _exhaustive: never = shell;
      return _exhaustive;
    }
  }
}

function getShellExecutionWrapper(
  shellConfiguration = getShellConfiguration(),
): string {
  const executable = getShellDisplayName(shellConfiguration);
  return `${executable} ${shellConfiguration.argsPrefix.join(' ')} <command>`;
}

function getShellQuotingGuidance(shell: ShellType): string {
  switch (shell) {
    case 'bash':
      return `- **Shell argument quoting and special characters**: The active shell is Bash. When passing arguments that contain special characters (parentheses \`()\`, backticks \`\`\`\`, dollar signs \`$\`, backslashes \`\\\`, semicolons \`;\`, pipes \`|\`, angle brackets \`<>\`, ampersands \`&\`, exclamation marks \`!\`, etc.), you MUST ensure they are properly quoted to prevent Bash from misinterpreting them as shell syntax:
  - **Single quotes** \`'...'\` pass everything literally, but cannot contain a literal single quote.
  - **ANSI-C quoting** \`$'...'\` supports escape sequences (e.g. \`\\n\` for newline, \`\\'\` for single quote) and is the safest approach for multi-line strings or strings with single quotes.
  - **Heredoc** is the most robust approach for large, multi-line text with mixed quotes:
    \`\`\`bash
    gh pr create --title "My Title" --body "$(cat <<'HEREDOC'
    Multi-line body with (parentheses), \`backticks\`, and 'single-quotes'.
    HEREDOC
    )"
    \`\`\`
  - NEVER use unescaped single quotes inside single-quoted strings (e.g. \`'it\\'s'\` is wrong; use \`$'it\\'s'\` or \`"it's"\` instead).
  - If unsure, prefer double-quoting arguments and escape inner double-quotes as \`\\"\`.`;
    case 'powershell':
      return `- **Shell argument quoting and special characters**: The active shell is PowerShell. When passing arguments that contain special characters (parentheses \`()\`, backticks \`\`\`\`, dollar signs \`$\`, backslashes \`\\\`, semicolons \`;\`, pipes \`|\`, angle brackets \`<>\`, ampersands \`&\`, exclamation marks \`!\`, etc.), you MUST ensure they are properly quoted to prevent PowerShell from misinterpreting them as shell syntax:
  - **Single quotes** \`'...'\` pass everything literally. To include a literal single quote, double it (e.g. \`'it''s'\`).
  - **Double quotes** \`"..."\` expand variables and subexpressions; use them only when that expansion is intended.
  - Escape PowerShell metacharacters with the backtick escape character when they must be literal.
  - For large, multi-line text, prefer a single-quoted here-string (\`@' ... '@\`) so content is not interpolated.
  - Do NOT use Bash-only forms such as ANSI-C quoting (\`$'...'\`) or Bash heredocs.`;
    case 'cmd':
      return `- **Shell argument quoting and special characters**: The active shell is cmd.exe. When passing arguments that contain special characters (parentheses \`()\`, backticks \`\`\`\`, dollar signs \`$\`, backslashes \`\\\`, semicolons \`;\`, pipes \`|\`, angle brackets \`<>\`, ampersands \`&\`, exclamation marks \`!\`, etc.), you MUST ensure they are properly quoted to prevent cmd.exe from misinterpreting them as shell syntax:
  - Use double quotes around arguments that contain spaces or metacharacters.
  - Escape literal cmd.exe metacharacters such as \`&\`, \`|\`, \`<\`, \`>\`, and \`^\` with caret (\`^\`).
  - Single quotes do not quote arguments in cmd.exe.
  - Be careful with \`%VAR%\` environment-variable expansion; avoid literal \`%...%\` unless expansion is intended.
  - Do NOT use Bash-only forms such as ANSI-C quoting (\`$'...'\`) or Bash heredocs.`;
    default: {
      const _exhaustive: never = shell;
      return _exhaustive;
    }
  }
}

function getShellCommandSequencingGuidance({
  executable,
  shell,
}: ShellConfiguration): string {
  const independentGuidance =
    '- If the commands are independent and can run in parallel, make multiple run_shell_command tool calls in a single message.';

  switch (shell) {
    case 'bash':
      return `- When issuing multiple commands:
  ${independentGuidance}
  - If the commands depend on each other and must run sequentially, use a single run_shell_command call with '&&' to chain them together (e.g., \`git add . && git commit -m "message" && git push\`).
  - Use ';' only when you need to run commands sequentially but don't care if earlier commands fail.
  - DO NOT use newlines to separate commands (newlines are ok in quoted strings).`;
    case 'cmd':
      return `- When issuing multiple commands:
  ${independentGuidance}
  - If the commands depend on each other and must run sequentially, use a single run_shell_command call with '&&' to chain them together (e.g., \`git add . && git commit -m "message" && git push\`).
  - Use '&' only when you need to run commands sequentially but don't care if earlier commands fail.
  - DO NOT use ';' or newlines to separate commands in cmd.exe.`;
    case 'powershell': {
      const executableBasename =
        getExecutableBasename(executable).toLowerCase();
      if (executableBasename === 'pwsh.exe') {
        return `- When issuing multiple commands:
  ${independentGuidance}
  - If the commands depend on each other and must run sequentially, use a single run_shell_command call with '&&' to chain them together (e.g., \`git add . && git commit -m "message" && git push\`).
  - Use ';' only when you need to run commands sequentially but don't care if earlier commands fail.
  - DO NOT use newlines to separate commands (newlines are ok in quoted strings).`;
      }

      return `- When issuing multiple commands:
  ${independentGuidance}
  - Windows PowerShell does not support '&&'. If commands must run sequentially and stop on failure, use explicit PowerShell control flow (for example, check \`$LASTEXITCODE\` before running the next external command) or run the next command only after seeing the previous run_shell_command result.
  - Use ';' only when you need to run commands sequentially but don't care if earlier commands fail.
  - DO NOT use newlines to separate commands (newlines are ok in quoted strings).`;
    }
    default: {
      const _exhaustive: never = shell;
      return _exhaustive;
    }
  }
}

function getShellToolDescription(
  shellConfiguration: ShellConfiguration,
): string {
  const executionWrapper = getShellExecutionWrapper(shellConfiguration);
  const isWindows = os.platform() === 'win32';
  const processGroupNote = isWindows
    ? ''
    : '\n  - Command is executed as a subprocess that leads its own process group. Command process group can be terminated as `kill -- -PGID` or signaled as `kill -s SIGNAL -- -PGID`.';
  const processStopNote =
    '\n  - To stop a background command started by this tool, use `task_stop` when a task id is available. Do not use broad process-name kills such as `kill $(pgrep node)`, `pkill node`, or `killall node`; use a specific PID or process group id where supported.';

  return `Executes a given shell command (as \`${executionWrapper}\`) in a subprocess with optional timeout, ensuring proper handling and security measures.

IMPORTANT: This tool is for terminal operations like git, npm, docker, etc. DO NOT use it for file operations (reading, writing, editing, searching, finding files) - use the specialized tools for this instead.

**Usage notes**:
- You can specify an optional timeout in milliseconds (up to 600000ms / 10 minutes). If not specified, commands will timeout after 120000ms (2 minutes). For longer commands, use \`is_background: true\` and observe the managed task instead of passing a larger timeout.

- Avoid using run_shell_command with the \`find\`, \`grep\`, \`cat\`, \`head\`, \`tail\`, \`sed\`, \`awk\`, or \`echo\` commands, unless explicitly instructed or when these commands are truly necessary for the task. Instead, always prefer using the dedicated tools for these commands:
  - File search: Use ${ToolNames.GLOB} (NOT find or ls)
  - Content search: Use ${ToolNames.GREP} (NOT grep or rg)
  - Read files: Use ${ToolNames.READ_FILE} (NOT cat/head/tail)
  - Edit files: Use ${ToolNames.EDIT} (NOT sed/awk)
  - Write files: Use ${ToolNames.WRITE_FILE} (NOT echo >/cat <<EOF)
  - Communication: Output text directly (NOT echo/printf)
${getShellQuotingGuidance(shellConfiguration.shell)}
${getShellCommandSequencingGuidance(shellConfiguration)}
- Try to maintain your current working directory throughout the session by using absolute paths and avoiding usage of \`cd\`. You may use \`cd\` if the User explicitly requests it.
  <good-example>
  pytest /foo/bar/tests
  </good-example>
  <bad-example>
  cd /foo/bar && pytest tests
  </bad-example>

**Background vs Foreground Execution:**
- You should decide whether commands should run in background or foreground based on their nature:
- Use background execution (is_background: true) for:
  - Long-running development servers: \`npm run start\`, \`npm run dev\`, \`yarn dev\`, \`bun run start\`
  - Build watchers: \`npm run watch\`, \`webpack --watch\`
  - Database servers: \`mongod\`, \`mysql\`, \`redis-server\`
  - Web servers: \`python -m http.server\`, \`php -S localhost:8000\`
  - Any command expected to run indefinitely until manually stopped
${processGroupNote}${processStopNote}
- Use foreground execution (the default) for commands that finish on their own, such as builds, installs, git operations, and test runs.
`;
}

function getCommandDescription(shellConfiguration: ShellConfiguration): string {
  const executionWrapper = getShellExecutionWrapper(shellConfiguration);
  switch (shellConfiguration.shell) {
    case 'cmd':
      return `Exact cmd.exe command to execute as \`${executionWrapper}\``;
    case 'powershell':
      return `Exact PowerShell command to execute as \`${executionWrapper}\``;
    case 'bash':
      return `Exact bash command to execute as \`${executionWrapper}\``;
    default: {
      const _exhaustive: never = shellConfiguration.shell;
      return _exhaustive;
    }
  }
}

export class ShellTool extends BaseDeclarativeTool<
  ShellToolParams,
  ToolResult
> {
  static Name: string = ToolNames.SHELL;

  override get maxOutputChars(): number {
    return getShellOutputThreshold(this.config);
  }

  constructor(private readonly config: Config) {
    const shellConfiguration: ShellConfiguration = getShellConfiguration();
    super(
      ShellTool.Name,
      ToolDisplayNames.SHELL,
      getShellToolDescription(shellConfiguration),
      Kind.Execute,
      {
        type: 'object',
        properties: {
          command: {
            type: 'string',
            description: getCommandDescription(shellConfiguration),
          },
          is_background: {
            type: 'boolean',
            description:
              'Optional: Whether to run the command in background. If not specified, defaults to false (foreground execution). Explicitly set to true for long-running processes like development servers, watchers, or daemons that should continue running without blocking further commands.',
          },
          timeout: {
            type: 'integer',
            minimum: 1,
            maximum: 600000,
            description: 'Optional timeout in milliseconds (max 600000)',
          },
          description: {
            type: 'string',
            description:
              'Brief description of the command for the user. Be specific and concise. Ideally a single sentence. Can be up to 3 sentences for clarity. No line breaks.',
          },
          directory: {
            type: 'string',
            description:
              '(OPTIONAL) The absolute path of the directory to run the command in. If not provided, the project root directory is used. Must be a directory within the workspace and must already exist.',
          },
        },
        required: ['command'],
      },
      false, // output is not markdown
      true, // output can be updated
    );
  }

  protected override validateToolParamValues(
    params: ShellToolParams,
  ): string | null {
    // NOTE: Permission checks (read-only detection, PM rules) are handled at
    // L3 (getDefaultPermission) and L4 (PM override) in coreToolScheduler.
    // This method handles parameter validation plus non-overridable shell
    // safety gates that must run before auto/YOLO execution.
    if (!params.command.trim()) {
      return 'Command cannot be empty.';
    }
    const strippedCommand = stripShellWrapper(params.command);
    if (detectSelfKillCommand(params.command)) {
      return SHELL_SELF_KILL_REJECTION;
    }
    if (
      params.is_background &&
      hasTopLevelTrailingBackgroundOperator(strippedCommand)
    ) {
      return 'Background shell commands must not end with a bare "&". Remove the trailing "&" and rely on is_background: true instead.';
    }
    if (getCommandRoots(params.command).length === 0) {
      return 'Could not identify command root to obtain permission from user.';
    }
    if (params.timeout !== undefined) {
      if (
        typeof params.timeout !== 'number' ||
        !Number.isInteger(params.timeout)
      ) {
        return 'Timeout must be an integer number of milliseconds.';
      }
      if (params.timeout <= 0) {
        return 'Timeout must be a positive number.';
      }
      if (params.timeout > 600000) {
        return 'Timeout cannot exceed 600000ms (10 minutes).';
      }
    }
    if (params.directory) {
      if (!path.isAbsolute(params.directory)) {
        return 'Directory must be an absolute path.';
      }

      const userSkillsDirs = this.config.storage.getUserSkillsDirs();
      const resolvedDirectoryPath = path.resolve(params.directory);
      const isWithinUserSkills = isSubpaths(
        userSkillsDirs,
        resolvedDirectoryPath,
      );
      if (isWithinUserSkills) {
        return `Explicitly running shell commands from within the user skills directory is not allowed. Please use absolute paths for command parameter instead.`;
      }

      const workspaceContext = this.config.getWorkspaceContext();
      if (!workspaceContext.isPathWithinWorkspace(params.directory)) {
        return `Directory '${params.directory}' is not within any of the registered workspace directories.`;
      }
    }
    // Sleep interception: block sleep >= 2s in foreground, suggest Monitor.
    // Strip shell wrappers first so `bash -c 'sleep 5'` / `sh -c '...'` etc.
    // cannot route around the check by hiding the foreground sleep inside a
    // `-c` script. This matches every other sensitive check in this file
    // (directory, read-only, command-root extraction, etc.).
    if (!params.is_background) {
      const sleepPattern = detectBlockedSleepPatternDetails(strippedCommand);
      if (sleepPattern !== null) {
        const intentionalSleepGuidance =
          sleepPattern.intentionalSleepRejection ??
          (sleepPattern.isStandalone
            ? 'If you genuinely need a standalone delay (rate limiting, deliberate pacing), ' +
              'add a trailing comment like `# intentional-sleep: wait for MCP rate limit reset` (up to 10 minutes).'
            : 'Split into two calls: first `sleep N # intentional-sleep: <reason>` (standalone), then the follow-up command.');
        return (
          `Blocked: ${sleepPattern.description}. ` +
          'Run blocking commands in the background with is_background: true. ' +
          'For streaming events (watching logs, polling APIs), use the Monitor tool. ' +
          intentionalSleepGuidance
        );
      }
    }
    return null;
  }

  protected createInvocation(
    params: ShellToolParams,
  ): ToolInvocation<ShellToolParams, ToolResult> {
    return new ShellToolInvocation(this.config, params);
  }

  override toAutoClassifierInput(
    params: ShellToolParams,
  ): Record<string, unknown> {
    // The full command is required for safety classification — do not redact.
    return {
      command: params.command,
      cwd: params.directory ?? this.config.getTargetDir(),
    };
  }
}
