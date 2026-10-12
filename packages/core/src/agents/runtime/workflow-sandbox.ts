/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Strip a leading `export const meta = { ... }` declaration from a workflow
 * script. Required because the script body runs as a function body, where
 * ES module syntax does not parse.
 *
 * P1 does not use meta semantically; it is removed so that Claude-Code-trained
 * models whose first line is `export const meta = {...}` do not produce a
 * SyntaxError at sandbox parse time.
 *
 * Recognises `//` / `/* *\/` comments and regex literals in addition to
 * string literals (single, double, template). Throws on unbalanced braces
 * instead of returning a truncated string — silently deleting the script
 * body produced the worst-case failure mode (workflow runs, returns
 * undefined, no diagnostic).
 *
 * Template-literal `${...}` substitutions that contain `{` or `}` are not
 * supported — model-authored `meta` should avoid them.
 */
export function stripExportMeta(source: string): string {
  const bounds = findMetaBlockBounds(source);
  if (!bounds) return source;
  return source.slice(0, bounds.exportIdx) + source.slice(bounds.afterMeta);
}

/**
 * Locate the `export const meta = {...}` declaration's bounds in the source.
 *
 * Shared by stripExportMeta (P1) and extractAndStripMeta (P4). Anchors at file
 * start (no `/m` flag — see T33 comment below); walks the brace block while
 * skipping over comment / regex / string contexts; throws on unbalanced
 * braces rather than returning a truncated string (T9/T17 — silently
 * deleting the script body is the worst-case failure mode).
 *
 * Returns null when no meta declaration is present at the file start —
 * callers treat this as "no meta", not an error.
 */
function findMetaBlockBounds(source: string): {
  /** Start offset of the `export const meta` match. */
  exportIdx: number;
  /** Offset of the `{` opening the meta object literal. */
  startBrace: number;
  /** Offset of the matching `}` closing the literal (inclusive). */
  endBraceIncl: number;
  /** Offset past meta + any trailing whitespace + optional `;`. */
  afterMeta: number;
} | null {
  // T33 (PR #4732 R4): anchor at file start (no `/m` flag). Per the design
  // doc, `export const meta = {...}` must be the script's FIRST statement.
  // With `/m`, the regex matched every line-start occurrence — including
  // inside template literals — and the brace-walker then ripped content
  // out of the string body, silently corrupting the script.
  const re = /^\s*export\s+const\s+meta\s*=\s*\{/;
  const match = re.exec(source);
  if (!match) return null;
  const exportIdx = match.index;
  const startBrace = source.indexOf('{', exportIdx);
  let depth = 1;
  let i = startBrace + 1;
  while (i < source.length && depth > 0) {
    const ch = source[i];
    const next = source[i + 1];
    // Single-line comment: skip to newline (T16).
    if (ch === '/' && next === '/') {
      i += 2;
      while (i < source.length && source[i] !== '\n') i++;
      continue;
    }
    // Block comment: skip to closing `*/` (T16).
    if (ch === '/' && next === '*') {
      i += 2;
      while (i < source.length && !(source[i] === '*' && source[i + 1] === '/'))
        i++;
      i += 2;
      continue;
    }
    // Regex literal: skip to matching `/`. We accept the heuristic that a `/`
    // appearing as a value in `{` context is a regex literal, not division
    // — meta objects don't perform arithmetic on properties.
    if (ch === '/' && isRegexContext(source, i)) {
      i++;
      let inClass = false;
      while (
        i < source.length &&
        (inClass || source[i] !== '/') &&
        source[i] !== '\n'
      ) {
        if (source[i] === '\\') i += 2;
        else if (source[i] === '[') {
          inClass = true;
          i++;
        } else if (source[i] === ']') {
          inClass = false;
          i++;
        } else {
          i++;
        }
      }
      i++; // skip closing /
      // Skip flags
      while (i < source.length && /[gimsuy]/.test(source[i]!)) i++;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === '`') {
      const q = ch;
      i++;
      while (i < source.length && source[i] !== q) {
        if (source[i] === '\\') i++; // skip escaped char
        i++;
      }
      i++; // skip closing quote
      continue;
    }
    if (ch === '{') depth++;
    else if (ch === '}') depth--;
    i++;
  }
  // T9/T17: refuse to truncate the script when the meta block is unbalanced.
  // Returning `""` previously caused the entire workflow body to vanish
  // silently — the worst possible failure mode.
  if (depth !== 0) {
    throw new Error(
      'unbalanced braces in export const meta declaration — ' +
        'the workflow script cannot be safely stripped. Check the meta block syntax.',
    );
  }
  const endBraceIncl = i - 1;
  // Skip trailing whitespace and an optional semicolon.
  while (i < source.length && /[\s;]/.test(source[i]!)) i++;
  return { exportIdx, startBrace, endBraceIncl, afterMeta: i };
}

/**
 * The `meta` object shape — verbatim from upstream Claude Code 2.1.168.
 * `name` and `description` are mandatory; `whenToUse` and `phases` are
 * optional. Each phase carries a mandatory `title` and optional `detail`
 * / `model`. P4 surfaces this shape on `WorkflowRunOutcome.meta` so
 * `/workflows` listing and the phase-tree UI can read it directly.
 */
export interface WorkflowMeta {
  name: string;
  description: string;
  whenToUse?: string;
  phases?: Array<{ title: string; detail?: string; model?: string }>;
}

/**
 * Strip `export const meta = {...}` from the script AND extract the meta
 * object as a plain host-realm value, ready to surface on `WorkflowRunOutcome`.
 *
 * Implementation:
 *   1. `findMetaBlockBounds` (shared with `stripExportMeta`) locates the
 *      object-literal source range via the brace-walker.
 *   2. `parseWorkflowMetaLiteral` parses that range. Meta is a declaration —
 *      every contract field is a string — so it is parsed, never executed.
 *   3. `validateMeta` copies the contract fields into a fresh host object.
 *
 * Parsing rather than evaluating is what keeps this safe. The literal is
 * model-authored source, so executing it means executing whatever the model
 * wrote, and the ways that can go wrong are open-ended: a loop in a field
 * value, a getter that only spins when the value is read, a proxy trap, a
 * promise reaction that never settles, an allocation large enough to exhaust
 * memory, a dynamic `import()` whose rejection lands on a later tick and takes
 * the host process with it. Bounding each of those in turn is a moving target.
 * A parser has no execution semantics, so none of them can be expressed —
 * there is nothing to time out, sandbox, or isolate.
 *
 * Returns `{ stripped, meta: null }` when no meta declaration is present
 * (callers treat this as "no meta"). Throws when meta is present but
 * malformed: not a pure literal, missing required field, or wrong field type.
 * Error messages for the missing-required-field cases match upstream
 * 2.1.168 verbatim so script authors see one consistent error text.
 */
export function extractAndStripMeta(source: string): {
  stripped: string;
  meta: WorkflowMeta | null;
} {
  const bounds = findMetaBlockBounds(source);
  if (!bounds) return { stripped: source, meta: null };

  const metaSource = source.slice(bounds.startBrace, bounds.endBraceIncl + 1);
  const stripped =
    source.slice(0, bounds.exportIdx) + source.slice(bounds.afterMeta);

  let raw: unknown;
  try {
    raw = parseWorkflowMetaLiteral(metaSource);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    throw new Error(`invalid meta object literal: ${msg}`);
  }

  const meta = validateMeta(raw);
  return { stripped, meta };
}

/** A body that does not parse, located in the source the author wrote. */
class WorkflowSyntaxError extends SyntaxError {
  constructor(
    message: string,
    readonly source: string,
    /**
     * UTF-16 offset of the error in `source`: negative on the opening
     * wrapper, past its end on the closing one.
     */
    readonly index: number,
  ) {
    super(message);
    this.name = 'SyntaxError';
  }
}

/** Every JavaScript line terminator; QuickJS's own line count sees only LF. */
const LINE_TERMINATOR = /\r\n|[\n\r\u2028\u2029]/;

let quickJsModule: Promise<QuickJSWASMModule> | undefined;

/**
 * Parse `export const meta`, strip it, and syntax-check the remaining body.
 *
 * Exported so the pre-launch gate in `WorkflowRunner.start` and the run itself
 * check through one function rather than two lookalikes. Throws exactly what
 * either step would throw: `extractAndStripMeta`'s errors for a malformed meta
 * literal, and a `SyntaxError` for a body that does not parse. The check is
 * the parser of the engine the script runs in — QuickJS, compiled to
 * WebAssembly — in compile-only mode, so nothing in the script executes.
 *
 * Returns the body a run executes: the meta declaration masked rather than
 * deleted, and CR / CRLF folded to LF (which JavaScript does to template
 * literals anyway), so the engine's line numbers match the author's script.
 */
export async function compileWorkflowScript(scriptSource: string): Promise<{
  source: string;
  meta: WorkflowMeta | null;
}> {
  const { stripped, meta } = extractAndStripMeta(scriptSource);
  const bounds = findMetaBlockBounds(scriptSource);
  const source = (
    bounds
      ? scriptSource.slice(0, bounds.exportIdx) +
        scriptSource
          .slice(bounds.exportIdx, bounds.afterMeta)
          .replace(/[^\r\n\u2028\u2029]/g, ' ') +
        scriptSource.slice(bounds.afterMeta)
      : stripped
  ).replace(/\r\n?/g, '\n');
  // Loaded on first use: Workflows are off by default, and the engine is
  // large enough to keep out of the startup path.
  quickJsModule ??= Promise.all([
    import('@jitl/quickjs-singlefile-mjs-release-sync'),
    import('quickjs-emscripten-core'),
  ]).then(([variant, core]) =>
    core.newQuickJSWASMModuleFromVariant(variant.default),
  );
  const runtime = (await quickJsModule).newRuntime();
  runtime.setMemoryLimit(64 * 1024 * 1024);
  runtime.setMaxStackSize(256 * 1024);
  const context = runtime.newContext();
  const wrapped = wrapWorkflowBody(source);
  let compiled: ReturnType<typeof context.evalCode>;
  try {
    compiled = context.evalCode(wrapped, WORKFLOW_SCRIPT_FILENAME, {
      compileOnly: true,
    });
  } catch (error) {
    // The engine itself failed — deeply nested source can run its parser out
    // of Node's stack — and may be left inconsistent, so it is discarded and
    // the next check loads a fresh one.
    quickJsModule = undefined;
    throw error;
  }
  try {
    if (compiled.error) {
      const dumped = context.dump(compiled.error) as {
        name?: unknown;
        message?: unknown;
        stack?: unknown;
      } | null;
      compiled.error.dispose();
      const message = String(dumped?.message ?? dumped);
      if (dumped?.name !== 'SyntaxError') throw new Error(message);
      const at = /workflow\.js:(\d+):(\d+)/.exec(String(dumped.stack ?? ''));
      if (!at) throw new SyntaxError(message);
      // QuickJS reports a 1-based line (counting LF only) and a 1-based
      // column in code points; turn them into an offset in the author's body.
      const lines = wrapped.split('\n');
      const line = Number(at[1]);
      let offset = Array.from(lines[line - 1] ?? '')
        .slice(0, Number(at[2]) - 1)
        .join('').length;
      for (let i = 0; i < line - 1; i++) offset += lines[i]!.length + 1;
      throw new WorkflowSyntaxError(
        message,
        source,
        offset - (wrapped.indexOf('\n') + 1),
      );
    }
    compiled.value.dispose();
  } finally {
    context.dispose();
    runtime.dispose();
  }
  return { source, meta };
}

/**
 * The error a cancelled run settles with. Named `AbortError` so every
 * `isAbortError` check on the way up classifies it as a cancellation rather
 * than a failure.
 */
function workflowCancelledError(): Error {
  const error = new Error('Workflow run was aborted (cancelled).');
  error.name = 'AbortError';
  return error;
}

/** Longest source line rendered in a compile-failure message. */
const COMPILE_ERROR_LINE_WIDTH = 80;

/**
 * Turn a compile failure into something a script author can act on: the
 * author's line number, the offending line with a caret under the column the
 * parser stopped at, and the parser's message. Lines are counted the way the
 * author's editor does, over every line terminator, and never include the
 * IIFE wrapper.
 *
 * Falls back to the bare message when the error carries no location.
 */
export function describeWorkflowCompileError(
  error: unknown,
  authorLineCount: number,
): string {
  const err = error instanceof Error ? error : new Error(String(error));
  if (!(err instanceof WorkflowSyntaxError) || err.index < 0) {
    return err.message;
  }

  const linesBefore = err.source.slice(0, err.index).split(LINE_TERMINATOR);
  const bodyLine = linesBefore.length;
  // An error on the closing wrapper is the author's incomplete ending;
  // describe that instead of naming our token.
  if (err.index > err.source.length || bodyLine > authorLineCount) {
    return (
      'The script ends with unmatched or incomplete syntax. Check ' +
      'parentheses, brackets, braces, quotes, and template literals near the end.'
    );
  }

  const column = linesBefore[bodyLine - 1]!.length;
  const sourceLine = err.source
    .slice(err.index - column)
    .split(LINE_TERMINATOR)[0]!;
  return [
    `line ${bodyLine}`,
    clampSourceFrame(sourceLine, `${' '.repeat(column)}^`),
    `SyntaxError: ${err.message}`,
  ].join('\n');
}

/**
 * Keep a long source line readable without breaking caret alignment: slide a
 * window over the line and shift the caret by the same amount.
 */
function clampSourceFrame(sourceLine: string, caretLine: string): string {
  if (sourceLine.length <= COMPILE_ERROR_LINE_WIDTH) {
    return `${sourceLine}\n${caretLine}`;
  }
  const caret = /\^+/.exec(caretLine);
  if (!caret) return '';
  const caretCol = caret.index;
  const start = Math.max(
    0,
    Math.min(
      caretCol - Math.floor(COMPILE_ERROR_LINE_WIDTH / 2),
      sourceLine.length - COMPILE_ERROR_LINE_WIDTH,
    ),
  );
  const prefix = start > 0 ? '…' : '';
  const window = sourceLine.slice(start, start + COMPILE_ERROR_LINE_WIDTH);
  const suffix =
    start + COMPILE_ERROR_LINE_WIDTH < sourceLine.length ? '…' : '';
  const visibleCaretStart = Math.max(caretCol, start);
  const visibleCaretEnd = Math.min(
    caretCol + caret[0].length,
    start + COMPILE_ERROR_LINE_WIDTH,
  );
  const shiftedCaret =
    ' '.repeat(prefix.length + visibleCaretStart - start) +
    '^'.repeat(visibleCaretEnd - visibleCaretStart);
  return `${prefix}${window}${suffix}\n${shiftedCaret}`;
}

/**
 * Validate the parsed meta value and copy it into a fresh plain object — the
 * parser returns null-prototype objects, and this is where the contract fields
 * cross over into ordinary ones. Throws on shape violation with the
 * upstream-aligned error message text for the required-field cases.
 *
 * Field rules:
 *   - `name`           required, non-empty string
 *   - `description`    required, non-empty string
 *   - `whenToUse`      optional, string (may be empty)
 *   - `phases`         optional, Array of plain objects with:
 *                        `title`   required, non-empty string
 *                        `detail`  optional, string
 *                        `model`   optional, string
 */
function validateMeta(value: unknown): WorkflowMeta {
  if (value === null || typeof value !== 'object') {
    throw new Error('meta must be an object');
  }
  const obj = value as Record<string, unknown>;
  if (typeof obj['name'] !== 'string' || (obj['name'] as string).length === 0) {
    // Verbatim from upstream Claude Code 2.1.168.
    throw new Error('meta.name must be a non-empty string');
  }
  if (
    typeof obj['description'] !== 'string' ||
    (obj['description'] as string).length === 0
  ) {
    // Verbatim from upstream Claude Code 2.1.168.
    throw new Error('meta.description must be a non-empty string');
  }
  if (obj['whenToUse'] !== undefined && typeof obj['whenToUse'] !== 'string') {
    throw new Error('meta.whenToUse must be a string');
  }
  let phases:
    | Array<{ title: string; detail?: string; model?: string }>
    | undefined;
  if (obj['phases'] !== undefined) {
    if (!Array.isArray(obj['phases'])) {
      throw new Error('meta.phases must be an array');
    }
    phases = [];
    for (const p of obj['phases'] as unknown[]) {
      if (p === null || typeof p !== 'object') {
        throw new Error('meta.phases entries must be objects');
      }
      const ph = p as Record<string, unknown>;
      if (
        typeof ph['title'] !== 'string' ||
        (ph['title'] as string).length === 0
      ) {
        throw new Error('meta.phases[].title must be a non-empty string');
      }
      const phase: { title: string; detail?: string; model?: string } = {
        title: ph['title'] as string,
      };
      if (ph['detail'] !== undefined) {
        if (typeof ph['detail'] !== 'string') {
          throw new Error('meta.phases[].detail must be a string');
        }
        phase.detail = ph['detail'] as string;
      }
      if (ph['model'] !== undefined) {
        if (typeof ph['model'] !== 'string') {
          throw new Error('meta.phases[].model must be a string');
        }
        phase.model = ph['model'] as string;
      }
      phases.push(phase);
    }
  }

  const out: WorkflowMeta = {
    name: obj['name'] as string,
    description: obj['description'] as string,
  };
  if (obj['whenToUse'] !== undefined) {
    out.whenToUse = obj['whenToUse'] as string;
  }
  if (phases !== undefined) {
    out.phases = phases;
  }
  return out;
}

/**
 * Heuristic: a `/` at offset `i` is a regex literal (not division) if the
 * previous non-whitespace character is an operator, opening brace/bracket,
 * comma, colon, or `=` — i.e. positions where a value is expected.
 */
function isRegexContext(source: string, i: number): boolean {
  let j = i - 1;
  while (j >= 0 && /\s/.test(source[j]!)) j--;
  if (j < 0) return true;
  const prev = source[j]!;
  return /[{[(,;:=!&|?+\-*/%^~<>]/.test(prev);
}

import {
  readWorkflowStepId,
  type WorkflowCallTrace,
} from '../workflow-correlation.js';
import type { QuickJSWASMModule } from 'quickjs-emscripten-core';
import { createDebugLogger } from '../../utils/debugLogger.js';
import {
  normalizeReasoningEffort,
  REASONING_EFFORT_TIERS,
  type ReasoningEffort,
} from '../../core/reasoning-effort.js';
import {
  canonicalAgentToolName,
  describeAgentToolAllowEntryProblem,
} from './workflow-agent-tools.js';
import { stripAnsiAndControl } from '../../utils/textUtils.js';
import { parseWorkflowMetaLiteral } from './workflow-meta-literal.js';
import type { WorkflowDispatchScheduler } from './workflow-dispatch-scheduler.js';
import { isWorkflowRunLevelError } from './workflow-agent-failure.js';
import {
  startWorkflowHost,
  type WorkflowHostConnection,
} from './workflow-host-client.js';
import {
  WORKFLOW_SCRIPT_FILENAME,
  wrapWorkflowBody,
  type WorkflowBudgetSnapshot,
  type WorkflowErrorData,
} from './workflow-protocol.js';

// Shared with workflow-orchestrator (avoids a duplicate createDebugLogger
// instance with the same 'WORKFLOW' namespace). Re-exported so orchestrator
// imports the same instance — orchestrator already imports from this module,
// so this is the natural direction (the reverse would be a circular dep).
export const debugLogger = createDebugLogger('WORKFLOW');

// Cap log + phase lines to prevent unbounded memory growth from runaway
// model-authored loops.
const MAX_LOG_LINES = 10_000;
const MAX_PHASE_ENTRIES = 10_000;
// Max nesting depth for args; defends against stack-overflow on deeply
// nested model-authored input.
const ARGS_MAX_DEPTH = 64;

/**
 * WorkflowAgentOpts — structured options for the `agent()` global.
 *
 * The named fields below are explicitly recognised. P1 throws for unsupported
 * fields (`schema`, `model`, `isolation`, `agentType`) rather than silently
 * dropping them. The runtime allowlist enforced in the guest runtime
 * additionally throws on ANY field not in the known set — catching typos
 * like `scema` before they reach dispatch.
 */
export interface WorkflowAgentOpts {
  stepId?: string;
  label?: string;
  phase?: string;
  schema?: object;
  model?: string;
  isolation?: 'worktree' | 'remote';
  agentType?: string;
  /**
   * Pin this agent to an EXISTING, caller-owned git worktree of the current
   * repository — the same contract as `AgentTool`'s `working_dir`, and
   * validated by the same check. The runtime neither creates nor removes the
   * directory; it only rebinds the subagent Config's cwd surfaces, so the
   * agent's file / shell / search tools resolve inside it.
   *
   * `isolation: 'worktree'` is not a substitute and the two are mutually
   * exclusive: isolation CREATES a worktree from the current tree and refuses
   * to run when the parent tree is dirty — which is the opposite of pinning an
   * agent to a directory whose uncommitted state is the whole point (a review
   * worktree, a scratch checkout a prior step provisioned).
   *
   * It is a cwd pin, not a filesystem sandbox: an explicit absolute path can
   * still reach outside it.
   */
  workingDir?: string;
  /**
   * P-stall: per-call stall-watchdog timeout in milliseconds. The dispatch
   * is aborted + retried (up to 3 attempts) after this many ms of no
   * subagent progress (with no tool in flight). Defaults to 180_000 (env
   * override `QWEN_CODE_WORKFLOW_STALL_SECONDS`). `0` disables the watchdog
   * for this call.
   */
  stallMs?: number;
  /**
   * Reasoning effort for this one agent (`low` … `max`). The sandbox accepts
   * the aliases `/effort` accepts and hands the host the canonical tier; the
   * dispatch writes it onto the agent's own content-generator config, never
   * the session's. Part of the resume key.
   */
  effort?: ReasoningEffort;
  /**
   * Tools this agent may not call, on top of the workflow floor. It only
   * narrows: the dispatch unions it with the floor and the agentType's own
   * denies, and refuses an entry that matches no tool. The sandbox hands the
   * host a sorted, de-duplicated list with built-in display names mapped to
   * tool names (and drops an empty one), so order, duplicates and the choice
   * of name never change the resume key.
   */
  disallowedTools?: string[];
  /**
   * The only tools this agent may be declared, as exact tool names. It only
   * narrows: the dispatch bounds it by the agentType's own allowlist and then
   * removes the workflow floor and every deny, so it never brings a tool back.
   * `'*'`, other patterns, a whole MCP server and `exec` are refused, and so is
   * an entry that names no tool. The sandbox hands the host a sorted,
   * de-duplicated list with built-in display names mapped to tool names;
   * any other name is compared as written, so only those two differences leave
   * the resume key unchanged.
   */
  tools?: string[];
  // The index signature exists so TypeScript accepts forward-compat opt names
  // at compile time; the runtime allowlist still rejects unknown names.
  [key: string]: unknown;
}

/**
 * Agent dispatch return type. P1/P2 was `string` (the subagent's final text
 * verbatim). P3 widens to also allow a JSON-serializable object — the
 * validated arguments of the subagent's `structured_output` call when
 * `agent({schema})` is used. Strings remain the no-schema return shape;
 * it reaches the script as JSON data, never as an object reference.
 */
export type WorkflowAgentResult = string | object;

/**
 * P5: budget global API surface. P1 default is throwing stubs (total = null,
 * spent()/remaining() throw). P5 will inject a real tracker.
 */
export interface WorkflowBudget {
  total: number | null;
  spent(): number;
  remaining(): number;
  /**
   * Host-only, never bridged into the script: this run's own agents' output
   * tokens, and the cap that applies to this run alone. The run registry
   * mirrors these, so a run's numbers never include tokens spent outside it
   * when `spent()` measures the whole turn. A budget without them (test
   * doubles) reports `spent()` / `total` instead.
   */
  runSpent?(): number;
  runCap?(): number | null;
}

/**
 * P4b: host-side live-event channel for the orchestrator and sandbox to
 * notify external consumers (typically the `WorkflowRunRegistry`) when
 * a phase boundary or agent dispatch happens, or when the script logs
 * something. Every method is called on the host side (from the sandbox's
 * message handling and `countedDispatch`), never from script code.
 *
 * All methods are no-ops by default — implementations are free to
 * implement only the events they care about.
 *
 * Truncation: `phaseStarted` / `logAppended` are NOT called once the
 * sandbox's internal `MAX_PHASE_ENTRIES` / `MAX_LOG_LINES` cap has
 * been reached, mirroring `getPhases()` / `getLogs()` so a chatty
 * workflow does not flood the registry with thousands of events.
 */
export interface WorkflowOrchestratorEmitter {
  workflowCallUpdated?(call: WorkflowCallTrace): void;
  workflowCallsTruncated?(): void;
  /** Sandbox `phase(title)` was called. */
  phaseStarted?(title: string): void;
  /** Sandbox `log(...)` produced one line of output (or `console.log`). */
  logAppended?(line: string): void;
  /** Orchestrator's `countedDispatch` is about to invoke `dispatch(...)`. */
  agentDispatched?(label?: string): void;
  /** `dispatch(...)` settled (success or thrown). `error` set on rejection. */
  agentCompleted?(label?: string, error?: string): void;
  /** A dispatch was issued and joined to the runtime dependency graph. */
  dispatchQueued?(event: {
    stepId?: string;
    workflowCallId?: string;
    id: string;
    label?: string;
    prompt: string;
    dependsOn: string[];
    queuedAt: number;
    cached?: boolean;
  }): void;
  /** A queued dispatch acquired a scheduler slot. */
  dispatchStarted?(id: string, startedAt: number): void;
  /** A dispatch reached a terminal state. */
  dispatchSettled?(id: string, error?: string, endedAt?: number): void;
  /**
   * P5: cumulative `spent` re-snapshot after each successful agent
   * completion. `total` is `null` when no per-run cap is set
   * (`QWEN_CODE_MAX_TOKENS_PER_WORKFLOW` unset). Caller (the
   * `WorkflowTool`) mirrors this into the `WorkflowRunRegistry` so the
   * pill / dialog / detail body surface the live token usage. The
   * orchestrator only fires this when a `budget` was passed to
   * `WorkflowRunRequest.budget`.
   */
  budgetUpdated?(spent: number, total: number | null): void;
  /** A resume ran a journaled call live again; `line` is also sandbox-logged. */
  resumeRespawn?(line: string): void;
}

/**
 * A branch of the run's dependency graph: `tails` are the dispatch ids the
 * next dispatch issued in this branch depends on. The array is replaced,
 * never mutated, so fan-out branches can share their parent's snapshot.
 */
export interface WorkflowDependencyContext {
  tails: readonly string[];
}

export interface SandboxOptions {
  /** Value bound to the `args` global inside the script. */
  args: unknown;
  /**
   * Function called by the script's `agent(prompt, opts)` global. Returns the
   * agent's final text, or `null` when that agent failed on its own terms
   * (turn/time cap, model error, stall, or no structured result) —
   * the same value a fan-out slot has always carried for a missing agent.
   * `context` is the dependency-graph branch that issued the call.
   * Injected so tests can mock without spawning an LLM.
   */
  dispatch: (
    prompt: string,
    opts: WorkflowAgentOpts,
    context: WorkflowDependencyContext,
  ) => Promise<WorkflowAgentResult | null>;
  /**
   * Host-side `workflow(nameOrRef, args)` implementation. When provided, the
   * sandbox exposes the `workflow` global that resolves a saved workflow
   * (by name from `.qwen/workflows/<name>.js`, or by `{scriptPath}`) and runs
   * it as a nested orchestration sharing this run's agent-count cap and token
   * budget. When omitted the sandbox falls back to a throwing stub — this is
   * also how single-level nesting is enforced: the orchestrator injects
   * `workflow` only at the top level, so a nested workflow's sandbox has no
   * `workflow` impl and a second-level `workflow()` call throws.
   */
  workflow?: (
    nameOrRef: string | { scriptPath: string },
    args: unknown,
    stepId: string | undefined,
    context: WorkflowDependencyContext,
  ) => Promise<unknown>;
  /**
   * The dependency-graph branch the script's top level runs in; defaults to
   * a fresh root. A nested workflow is handed its caller's branch so its
   * dispatches chain from it. `parallel()` / `pipeline()` fork one branch per
   * thunk / item and merge the branches' tails back when the batch settles.
   *
   * The script runs in another process with no async-context tracking, so a
   * call is attributed to the branch whose synchronous code issued it, or —
   * after an `await` — to the branch of the `agent()` / `workflow()` result
   * whose settlement resumed it. Code resumed by anything else (`await null`,
   * a promise the script built itself) is attributed to whichever settlement
   * resumed the script, and a call from a branch whose batch has already
   * settled falls back to this root branch.
   */
  dependencies?: WorkflowDependencyContext;
  budget?: WorkflowBudget;
  /**
   * T23 (PR #4732 R2): async wall-clock cap (ms) covering the entire script
   * including awaits, from the moment its host process is ready. Each
   * synchronous stretch is separately capped at
   * `WORKFLOW_SYNC_EVALUATION_TIMEOUT_MS`; this cap catches what that cannot,
   * like `return new Promise(() => {})`.
   *
   * Defaults to 30 minutes, override via `QWEN_CODE_MAX_WORKFLOW_SECONDS`
   * env var, or pass an explicit value here (tests use small values for
   * fast verification).
   *
   * This stays a permanent defense even after P5's `budget` ships:
   * budget caps tokens, but a 0-token hang (`new Promise(() => {})`) only
   * a wall-clock can catch.
   */
  maxWallClockMs?: number;
  /**
   * T40 (PR #4732 R4): completes the R2 wall-clock defense. When the timer
   * fires, the sandbox `abort()`s this controller BEFORE rejecting. The
   * caller threads the same controller's `signal` into the dispatch
   * function (via `createProductionDispatch`) so in-flight subagents see
   * the abort and stop. Without this, the workflow user-side rejects but
   * the subagent keeps burning tokens until its own `max_time_minutes`
   * limit (10 min default).
   *
   * The caller is responsible for cleanup on natural completion (call
   * `abort()` in a `finally` block to cancel any straggler dispatch).
   */
  abortOnTimeout?: AbortController;
  /**
   * P4b: optional host-side event channel. When provided, the sandbox's
   * `safePhase` / `safeLog` closures fire `phaseStarted` / `logAppended`
   * on every accepted entry (after the per-cap truncation guard). The
   * caller (typically `WorkflowTool` via `WorkflowOrchestrator`) wires
   * these into the `WorkflowRunRegistry` so the UI surfaces (pill /
   * dialog / detail body) can re-render without polling `getPhases()`.
   */
  emitter?: WorkflowOrchestratorEmitter;
  /**
   * The run's dispatch scheduler. When provided, the async wall-clock
   * watchdog suspends only while the scheduler is `paused`: by then no
   * dispatch is in flight or being issued, so paused time must neither
   * burn wall-clock budget nor let the timer kill the run mid-pause
   * (resume would then be impossible). During `pausing` the backstop
   * stays armed because an in-flight dispatch is typically still
   * executing real work. Known limitation: an in-flight dispatch parked
   * on a tool approval waits on the user rather than executing, but
   * `pausing` time still burns wall-clock budget until the approval is
   * answered (the watchdog cannot suspend on `pausing` without losing
   * the backstop for genuinely executing dispatches, and `resume()`
   * only works from `paused`).
   *
   * The guarantee covers dispatch-gated code only: script awaits outside
   * a scheduler gate keep executing while paused and are not covered by
   * the wall-clock backstop until resume.
   */
  scheduler?: WorkflowDispatchScheduler;
}

/**
 * T23 (PR #4732 R2): default async wall-clock cap. The wall clock is a
 * 0-token-hang backstop, NOT a precise cost cap: it bounds patterns like an
 * in-script `await new Promise(() => {})` that the synchronous-evaluation
 * timeout cannot reach. For genuine cost control, use the env-overridable per-run cap
 * (`QWEN_CODE_MAX_WORKFLOW_AGENTS`) and concurrency window
 * (`QWEN_CODE_MAX_WORKFLOW_CONCURRENCY`). 30 minutes is set generously
 * enough that typical workflows never see it but a hang doesn't waste
 * operator hours; raise via `QWEN_CODE_MAX_WORKFLOW_SECONDS` for long
 * legitimate fan-outs (1000 agents × 10-min subagent cap ÷ default
 * concurrency would already exceed 30 min).
 */
const DEFAULT_MAX_WALL_CLOCK_MS = 30 * 60 * 1000;

/**
 * How long the script's synchronous code may run before its first `await`
 * returns control — and likewise each later synchronous stretch, since the
 * host interrupts any one that runs longer. Exported so the authoring
 * reference's statement of it is pinned to this value.
 */
export const WORKFLOW_SYNC_EVALUATION_TIMEOUT_MS = 30_000;

function resolveMaxWallClockMs(opts: SandboxOptions): number {
  if (typeof opts.maxWallClockMs === 'number' && opts.maxWallClockMs > 0) {
    return opts.maxWallClockMs;
  }
  const envSec = Number(process.env['QWEN_CODE_MAX_WORKFLOW_SECONDS']);
  if (Number.isFinite(envSec) && envSec > 0) return envSec * 1000;
  return DEFAULT_MAX_WALL_CLOCK_MS;
}

/**
 * Async wall-clock watchdog whose budget only accrues while armed.
 * `pause()` clears the timer and banks the unconsumed remainder;
 * `resume()` re-arms with that remainder — so pause/resume cycles
 * neither extend the total active-time budget nor lose any of it.
 */
class WallClockWatchdog {
  private timer: ReturnType<typeof setTimeout> | undefined;
  private remainingMs: number;
  private armedAt = 0;
  private paused = false;
  private stopped = false;

  constructor(
    budgetMs: number,
    private readonly onFire: () => void,
  ) {
    this.remainingMs = budgetMs;
    this.arm();
  }

  pause(): void {
    if (this.stopped || this.paused || this.timer === undefined) return;
    this.paused = true;
    clearTimeout(this.timer);
    this.timer = undefined;
    // The deadline is a setTimeout (libuv's monotonic loop clock), so the
    // elapsed-armed-time deduction must measure with the monotonic clock
    // too: Date.now() diverges on system suspend and any NTP / manual
    // clock step, corrupting the banked remainder in both directions.
    this.remainingMs = Math.max(
      0,
      this.remainingMs - (performance.now() - this.armedAt),
    );
  }

  resume(): void {
    if (this.stopped || !this.paused) return;
    this.paused = false;
    this.arm();
  }

  stop(): void {
    this.stopped = true;
    if (this.timer !== undefined) clearTimeout(this.timer);
    this.timer = undefined;
  }

  private arm(): void {
    this.armedAt = performance.now();
    this.timer = setTimeout(() => {
      this.stopped = true;
      this.timer = undefined;
      this.onFire();
    }, this.remainingMs);
    // Don't keep the event loop alive on Node — if the run resolves
    // quickly, the timer will be stopped in finally; this guards against
    // edge cases where the caller drops the promise.
    this.timer.unref?.();
  }
}

export interface WorkflowSandbox {
  /**
   * Execute the user-authored script source. The script is wrapped as an async
   * IIFE so it may use top-level `await` and `return`. Returns the script's
   * top-level return value.
   *
   * `export const meta = {...}` is extracted before parsing and exposed via
   * `getMeta()` — the script body sees the meta-stripped source.
   */
  run(scriptSource: string): Promise<unknown>;
  /** Phase titles announced by the script in order. */
  getPhases(): string[];
  /** Log lines emitted by the script in order. */
  getLogs(): string[];
  /** Merge a nested workflow log into the parent buffer without re-emitting. */
  appendLog(line: string): void;
  /**
   * The script's `export const meta = {...}` declaration, validated and
   * extracted before the script body runs. `null` when the script omits
   * the declaration. Throws (during `run`) when the declaration is
   * present but malformed.
   */
  getMeta(): WorkflowMeta | null;
}

/**
 * Validate `args` without mutating it. Throws on functions, BigInts, circular
 * references, and nesting beyond `ARGS_MAX_DEPTH`. The script's `args`
 * global is parsed from the JSON text inside the guest — this validation
 * just gates what we hand to JSON stringification.
 */
function validateArgs(
  val: unknown,
  depth = 0,
  seen: WeakSet<object> = new WeakSet(),
): void {
  if (depth > ARGS_MAX_DEPTH) {
    throw new Error(
      `WorkflowSandbox: args exceeded max nesting depth of ${ARGS_MAX_DEPTH}`,
    );
  }
  if (val === null) return;
  const t = typeof val;
  if (t === 'function') {
    throw new Error(
      'WorkflowSandbox: args must be JSON-serializable (functions are not allowed).',
    );
  }
  if (t === 'bigint') {
    throw new Error(
      'WorkflowSandbox: args must be JSON-serializable (BigInt is not allowed — pass as string).',
    );
  }
  if (t !== 'object') return;
  const obj = val as object;
  if (seen.has(obj)) {
    throw new Error(
      'WorkflowSandbox: args must be JSON-serializable (circular reference detected).',
    );
  }
  seen.add(obj);
  if (Array.isArray(val)) {
    for (const item of val) validateArgs(item, depth + 1, seen);
  } else {
    for (const v of Object.values(val as Record<string, unknown>)) {
      validateArgs(v, depth + 1, seen);
    }
  }
}

/** How long the host process may take to start before the run fails. */
const WORKFLOW_HOST_STARTUP_GRACE_MS = 30_000;

/**
 * After a run settles, how long its host process may keep running to deliver
 * what is still in flight — a cancelled script's own `finally` blocks, a late
 * rejection the run log mirrors — before it is killed.
 */
const WORKFLOW_HOST_DRAIN_GRACE_MS = 10_000;

/** Deepest result nesting the host accepts back from the script. */
const MAX_RESULT_DEPTH = 1001;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function invalidHostMessage(): Error {
  return new Error('The workflow host sent an invalid message.');
}

function requireString(value: unknown): string {
  if (typeof value !== 'string') throw invalidHostMessage();
  return value;
}

function requireId(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw invalidHostMessage();
  }
  return value as number;
}

/**
 * Merge a settled fan-out's branch tails back into the branch that issued it.
 * A dispatching branch always ends on its fresh dispatch id; a branch that
 * never dispatched still carries its inherited seed. Merging that seed back
 * would re-inject ancestor ids as redundant transitive dependsOn edges —
 * unless no branch dispatched at all, where the inherited tails must pass
 * through unchanged (same contract as an empty fan-out).
 */
function mergeFanoutTails(
  currentParentTails: readonly string[],
  inheritedTails: readonly string[],
  branchTails: readonly string[],
): string[] {
  const inherited = new Set(inheritedTails);
  const newBranchTails = branchTails.filter((tail) => !inherited.has(tail));
  const merged =
    newBranchTails.length > 0
      ? [
          ...newBranchTails,
          ...currentParentTails.filter((tail) => !inherited.has(tail)),
        ]
      : currentParentTails;
  return Array.from(new Set(merged));
}

/**
 * Rebuild a script's return value from the guest's tagged encoding
 * (`encodeResult` in `workflow-guest.ts`): plain JSON for primitives, and a
 * tagged array for everything else. Every object is built here, from data.
 */
function decodeWorkflowValue(encoded: unknown): unknown {
  const seen = new Map<number, unknown>();
  const unreadable = (message: unknown) => ({
    toJSON(): never {
      throw new Error(String(message));
    },
  });
  const entriesOf = (payload: unknown): unknown[] => {
    if (!Array.isArray(payload)) throw invalidHostMessage();
    return payload;
  };
  const pairOf = (entry: unknown): [unknown, unknown] => {
    if (!Array.isArray(entry) || entry.length !== 2) throw invalidHostMessage();
    return [entry[0], entry[1]];
  };
  const decode = (node: unknown, depth: number): unknown => {
    if (node === null || typeof node !== 'object') return node;
    if (depth > MAX_RESULT_DEPTH || !Array.isArray(node)) {
      throw invalidHostMessage();
    }
    const [tag, id, payload, extra] = node as unknown[];
    switch (tag) {
      case 'u':
        return undefined;
      case 'n':
        if (id === 'NaN' || id === 'Infinity' || id === '-Infinity') {
          return Number(id);
        }
        throw invalidHostMessage();
      case 'b':
        if (typeof id === 'string' && /^-?\d+$/.test(id)) return BigInt(id);
        throw invalidHostMessage();
      case 'x':
        return unreadable(id);
      case 'r':
        if (typeof id === 'number' && seen.has(id)) return seen.get(id);
        throw invalidHostMessage();
      default:
        break;
    }
    if (typeof id !== 'number' || seen.has(id)) throw invalidHostMessage();
    switch (tag) {
      case 'e': {
        const error = new Error(typeof extra === 'string' ? extra : '');
        if (typeof payload === 'string') error.name = payload;
        seen.set(id, error);
        return error;
      }
      case 'a': {
        const items: unknown[] = [];
        seen.set(id, items);
        for (const item of entriesOf(payload)) {
          items.push(decode(item, depth + 1));
        }
        return items;
      }
      case 'm': {
        const map = new Map<unknown, unknown>();
        seen.set(id, map);
        for (const entry of entriesOf(payload)) {
          const [key, value] = pairOf(entry);
          map.set(decode(key, depth + 1), decode(value, depth + 1));
        }
        return map;
      }
      case 's': {
        const set = new Set<unknown>();
        seen.set(id, set);
        for (const item of entriesOf(payload)) set.add(decode(item, depth + 1));
        return set;
      }
      case 'o': {
        const object: Record<string, unknown> = {};
        seen.set(id, object);
        for (const entry of entriesOf(payload)) {
          const [key, value] = pairOf(entry);
          if (typeof key !== 'string') throw invalidHostMessage();
          // defineProperty, not assignment: a "__proto__" key stays data.
          if (Array.isArray(value) && value[0] === 'x') {
            const message = String(value[1]);
            Object.defineProperty(object, key, {
              enumerable: true,
              configurable: true,
              get() {
                throw new Error(message);
              },
            });
          } else {
            Object.defineProperty(object, key, {
              value: decode(value, depth + 1),
              enumerable: true,
              writable: true,
              configurable: true,
            });
          }
        }
        return object;
      }
      default:
        throw invalidHostMessage();
    }
  };
  return decode(encoded, 0);
}

interface FanOut {
  parent: WorkflowDependencyContext;
  inherited: readonly string[];
  /** Created on first use, so a branch that never dispatches costs nothing. */
  branches: Map<number, WorkflowDependencyContext>;
}

/**
 * Normalize the options of one `agent()` call: the JSON copy the script
 * produced is validated here, and effort aliases, built-in tool display
 * names, order and duplicates are folded so equivalent spellings share one
 * resume key. Throws with the message the script sees.
 */
function normalizeAgentOptions(raw: unknown): WorkflowAgentOpts {
  const agentOpts = (isRecord(raw) ? { ...raw } : {}) as WorkflowAgentOpts;
  if (agentOpts.effort !== undefined) {
    const tier =
      typeof agentOpts.effort === 'string'
        ? normalizeReasoningEffort(agentOpts.effort)
        : undefined;
    if (tier === undefined) {
      throw new Error(
        `agent({effort}): unknown effort tier ${stripAnsiAndControl(
          JSON.stringify(agentOpts.effort),
        )}. Known tiers are: ${REASONING_EFFORT_TIERS.join(', ')}.`,
      );
    }
    agentOpts.effort = tier;
  }
  const isToolNameList = (value: unknown): value is string[] =>
    Array.isArray(value) &&
    value.every(
      (name) =>
        typeof name === 'string' && name.length > 0 && name === name.trim(),
    );
  if (agentOpts.disallowedTools !== undefined) {
    if (!isToolNameList(agentOpts.disallowedTools)) {
      throw new Error(
        "agent({disallowedTools}): must be an array of non-empty tool-name strings without surrounding whitespace, e.g. ['run_shell_command', 'write_file'].",
      );
    }
    const denied = [
      ...new Set(agentOpts.disallowedTools.map(canonicalAgentToolName)),
    ].sort();
    if (denied.length === 0) delete agentOpts.disallowedTools;
    else agentOpts.disallowedTools = denied;
  }
  // An empty allowlist would leave the agent nothing to call, so unlike an
  // empty deny list it is refused rather than dropped.
  if (agentOpts.tools !== undefined) {
    if (!isToolNameList(agentOpts.tools) || agentOpts.tools.length === 0) {
      throw new Error(
        "agent({tools}): must be a non-empty array of tool-name strings without surrounding whitespace, e.g. ['run_shell_command', 'read_file']. Omit tools to keep every tool.",
      );
    }
    const allowed: string[] = [];
    for (const name of agentOpts.tools) {
      const problem = describeAgentToolAllowEntryProblem(name);
      if (problem !== null) {
        throw new Error(`agent({tools}): ${stripAnsiAndControl(problem)}`);
      }
      const canonical = canonicalAgentToolName(name);
      if (!allowed.includes(canonical)) allowed.push(canonical);
    }
    agentOpts.tools = allowed.sort();
  }
  return agentOpts;
}

export function createWorkflowSandbox(opts: SandboxOptions): WorkflowSandbox {
  const phases: string[] = [];
  const logs: string[] = [];

  const emitLog = (line: string): void => {
    try {
      opts.emitter?.logAppended?.(line);
    } catch (e) {
      debugLogger.warn('emitter.logAppended threw:', e);
    }
  };

  const safeLog = (line: string, notify = true): void => {
    if (logs.length < MAX_LOG_LINES) {
      logs.push(line);
      // P4b: emit to host-side subscriber (registry). Defensive try/catch
      // because a subscriber error must not interrupt script execution
      // — the script body has no business knowing about UI plumbing.
      if (notify) emitLog(line);
    } else if (logs.length === MAX_LOG_LINES) {
      const marker = `[workflow log truncated at ${MAX_LOG_LINES} lines]`;
      logs.push(marker);
      if (notify) emitLog(marker);
    }
  };

  const safePhase = (title: string): void => {
    if (phases.length < MAX_PHASE_ENTRIES) {
      // Normalize before collapse/push/emit so the sandbox list and the
      // registry mirror (same rule at its boundary) compare the same value:
      // titles colliding only after ANSI/control stripping or the 200-char
      // cap previously diverged the two phase surfaces of the same run.
      const t = stripAnsiAndControl(title).slice(0, 200) || 'phase';
      // R7 (wenshao): collapse consecutive identical titles so the
      // sandbox is the single source of truth for the phase list.
      // Without this, `outcome.phases` (terminal `returnDisplay` JSON)
      // carried duplicates while `entry.phases` on the registry
      // (live UI / `/workflows` detail) was deduped by the registry's
      // own `onPhaseStarted` collapse — the same run showed different
      // phase counts in the terminal output vs the live UI. The
      // `agent({phase})` path already dedups against the last entry;
      // this brings the bare `phase()` global into the same contract.
      if (phases[phases.length - 1] === t) return;
      phases.push(t);
      // P4b: emit to host-side subscriber. Same defensive try/catch as
      // safeLog — subscriber errors must not bubble into the script.
      try {
        opts.emitter?.phaseStarted?.(t);
      } catch (e) {
        debugLogger.warn('emitter.phaseStarted threw:', e);
      }
    } else if (phases.length === MAX_PHASE_ENTRIES) {
      phases.push(
        `[workflow phases truncated at ${MAX_PHASE_ENTRIES} entries]`,
      );
    }
  };

  // FIX-Round1-T6: validate args structure (functions/BigInt/circular/depth)
  // before serialising. Without this, `JSON.stringify({fn: () => {}})` silently
  // drops the function key.
  if (opts.args !== undefined) validateArgs(opts.args);
  const argsJson = opts.args === undefined ? null : JSON.stringify(opts.args);
  const maxWallClockMs = resolveMaxWallClockMs(opts);
  const signal = opts.abortOnTimeout?.signal;

  // spent()/remaining() are synchronous in the script, so the host sends a
  // fresh snapshot with every settlement; the script only ever runs right
  // after one.
  const budgetSnapshot = (): WorkflowBudgetSnapshot | undefined => {
    const budget = opts.budget;
    if (!budget) return undefined;
    try {
      const remaining = budget.remaining();
      return {
        total: budget.total,
        spent: budget.spent(),
        remaining: Number.isFinite(remaining) ? remaining : null,
      };
    } catch (e) {
      debugLogger.warn('Workflow budget snapshot failed:', e);
      return undefined;
    }
  };

  // What the script learns about a failed request: the message, and whether
  // it is teardown or a run-level failure, which decide how fan-outs and the
  // unconsumed-rejection mirror treat it. Teardown is matched on the error
  // NAME (the scheduler's AbortError), never the message text, plus any
  // rejection once the run's abort has fired: the dominant cancellation path
  // rejects with a plain Error ('did not complete (terminate mode:
  // CANCELLED).').
  const errorData = (error: unknown): WorkflowErrorData => {
    let message: string;
    let name: unknown;
    try {
      const raw = isRecord(error) ? error['message'] : undefined;
      message = raw != null ? String(raw) : String(error);
      name = isRecord(error) ? error['name'] : undefined;
    } catch {
      message = '[unserializable rejection value]';
    }
    return {
      message,
      ...(typeof name === 'string' ? { name } : {}),
      ...(isWorkflowRunLevelError(error) ? { runFailure: true } : {}),
      ...(name === 'AbortError' || signal?.aborted ? { abort: true } : {}),
    };
  };

  const execute = (source: string): Promise<unknown> =>
    new Promise<unknown>((resolve, reject) => {
      const root: WorkflowDependencyContext = opts.dependencies ?? {
        tails: [],
      };
      const fanOuts = new Map<number, FanOut>();
      const outstanding = new Set<number>();
      let ready = false;
      let settled = false;
      let outcome:
        | { ok: true; value: unknown }
        | { ok: false; error: Error }
        | undefined;
      let flushInFlight = false;
      let settlesSinceFlush = 0;
      let watchdog: WallClockWatchdog | undefined;
      let wallClockFired = false;
      let drainTimer: ReturnType<typeof setTimeout> | undefined;

      const send = (body: string | { type: 'abort' | 'flush' }): void => {
        if (!host.alive) return;
        try {
          host.send(body);
        } catch (e) {
          debugLogger.warn('Workflow host message could not be sent:', e);
        }
      };

      // Once the run has settled, keep the host only while it has requests
      // in flight; a flush acknowledged with nothing sent since means every
      // consequence of the last result has reached this side.
      const release = (): void => {
        if (!settled || !host.alive || outstanding.size > 0 || flushInFlight) {
          return;
        }
        flushInFlight = true;
        settlesSinceFlush = 0;
        send({ type: 'flush' });
      };

      // Pause-aware watchdog: suspend only while the scheduler is `paused` —
      // once truly idle, the run must neither burn budget it will need after
      // resume nor be killed mid-pause (resume would then be impossible).
      // During `pausing` the backstop stays armed: an in-flight dispatch is
      // typically still executing real work. (An abort settles the run and
      // stops the watchdog, so no transition after it matters.)
      const stopWatchingState = opts.scheduler?.onStateChange(({ state }) => {
        if (state === 'paused') watchdog?.pause();
        else watchdog?.resume();
      });

      const startupTimer = setTimeout(
        () =>
          failHost(
            new Error(
              `The workflow host did not start within ${WORKFLOW_HOST_STARTUP_GRACE_MS} ms.`,
            ),
          ),
        WORKFLOW_HOST_STARTUP_GRACE_MS,
      );
      startupTimer.unref?.();

      const finish = (error: Error | undefined, value?: unknown): void => {
        if (settled) return;
        settled = true;
        clearTimeout(startupTimer);
        watchdog?.stop();
        stopWatchingState?.();
        if (error) reject(error);
        else resolve(value);
        if (!host.alive) return;
        // A run that ends before its script started must not start it.
        if (!ready) {
          host.kill();
          return;
        }
        host.unref();
        drainTimer = setTimeout(
          () => host.kill(),
          WORKFLOW_HOST_DRAIN_GRACE_MS,
        );
        drainTimer.unref?.();
        release();
      };

      const failHost = (error: unknown): void => {
        host.kill();
        finish(error instanceof Error ? error : new Error(String(error)));
      };

      // Cancellation settles the run now, not when the wall clock runs out.
      // The host is told so the script's teardown rejections are not
      // mirrored as failures, and it keeps running briefly so the script's
      // own `finally` blocks still run as its dispatches reject.
      const onAbort = (): void => {
        send({ type: 'abort' });
        // The watchdog aborts the controller itself on the way to rejecting
        // with the timeout; that abort is not a cancellation.
        if (!wallClockFired) finish(workflowCancelledError());
      };
      signal?.addEventListener('abort', onAbort, { once: true });

      const contextFor = (
        group: unknown,
        branch: unknown,
      ): WorkflowDependencyContext => {
        const fanOut =
          typeof group === 'number' ? fanOuts.get(group) : undefined;
        if (!fanOut || typeof branch !== 'number') return root;
        let context = fanOut.branches.get(branch);
        if (!context) {
          context = { tails: fanOut.inherited };
          fanOut.branches.set(branch, context);
        }
        return context;
      };

      const settleRequest = (id: number, ok: boolean, payload: unknown) => {
        outstanding.delete(id);
        const budget = budgetSnapshot();
        let body: string;
        if (ok) {
          try {
            body = JSON.stringify({
              type: 'settle',
              id,
              ok,
              value: payload,
              budget,
            });
          } catch (e) {
            debugLogger.warn(
              `Workflow result revival failed at index 0: ${String(
                (e as Error)?.message ?? e,
              )}; slot set to null (non-JSON-serializable thunk return).`,
            );
            body = JSON.stringify({
              type: 'settle',
              id,
              ok,
              value: null,
              budget,
            });
          }
        } else {
          body = JSON.stringify({
            type: 'settle',
            id,
            ok,
            error: errorData(payload),
            budget,
          });
        }
        if (host.alive) {
          settlesSinceFlush += 1;
          try {
            host.send(body);
          } catch (e) {
            // A result past the frame limit still settles the request.
            send(
              JSON.stringify({
                type: 'settle',
                id,
                ok: false,
                error: errorData(e),
                budget,
              }),
            );
          }
        }
        release();
      };

      // Every request is answered exactly once; work() runs synchronously so
      // requests reach the dispatch layer in the order the script issued them.
      const respond = (id: number, work: () => Promise<unknown>): void => {
        outstanding.add(id);
        let result: Promise<unknown>;
        try {
          result = Promise.resolve(work());
        } catch (error) {
          result = Promise.reject(error);
        }
        void result.then(
          (value) => settleRequest(id, true, value),
          (error: unknown) => settleRequest(id, false, error),
        );
      };

      const handle = (message: Record<string, unknown>): void => {
        switch (message['type']) {
          case 'ready': {
            if (settled) return;
            ready = true;
            clearTimeout(startupTimer);
            watchdog = new WallClockWatchdog(maxWallClockMs, () => {
              // T40 (PR #4732 R4): abort the linked controller BEFORE
              // rejecting so in-flight subagents see the cancellation and
              // stop. A timeout is not a cancellation, and it has to be
              // reported as the timeout it is.
              wallClockFired = true;
              opts.abortOnTimeout?.abort();
              finish(
                new Error(
                  `Workflow execution exceeded ${maxWallClockMs} ms of active time (paused time is not counted). ` +
                    'Override via SandboxOptions.maxWallClockMs or QWEN_CODE_MAX_WORKFLOW_SECONDS env var.',
                ),
              );
            });
            // A sandbox started while the scheduler is ALREADY `paused` never
            // receives a `paused` transition, so seed the current state.
            if (opts.scheduler?.snapshot().state === 'paused') {
              watchdog.pause();
            }
            return;
          }
          case 'log':
            safeLog(requireString(message['line']));
            return;
          case 'phase':
            safePhase(requireString(message['title']));
            return;
          case 'debug':
            debugLogger.warn(
              stripAnsiAndControl(requireString(message['message'])).slice(
                0,
                2000,
              ),
            );
            return;
          case 'agent': {
            const context = contextFor(message['group'], message['branch']);
            const { prompt, phase } = message;
            const rawOpts = message['opts'];
            respond(requireId(message['id']), () => {
              const agentOpts = normalizeAgentOptions(rawOpts);
              // Recorded only once every option gate has passed, so a call
              // its options rejected leaves no phase that dispatched nothing.
              if (
                typeof phase === 'string' &&
                phase.length > 0 &&
                phases[phases.length - 1] !== phase
              ) {
                safePhase(phase);
              }
              const stepId = readWorkflowStepId(agentOpts.stepId);
              delete agentOpts.stepId;
              if (stepId !== undefined) agentOpts.stepId = stepId;
              return opts.dispatch(prompt as string, agentOpts, context);
            });
            return;
          }
          case 'workflow': {
            const context = contextFor(message['group'], message['branch']);
            const workflow = opts.workflow;
            respond(requireId(message['id']), () => {
              if (!workflow) throw new Error('workflow() is unavailable here.');
              return workflow(
                message['ref'] as string | { scriptPath: string },
                message['args'],
                readWorkflowStepId(message['stepId']),
                context,
              );
            });
            return;
          }
          case 'fork': {
            const parent = contextFor(
              message['parentGroup'],
              message['parentBranch'],
            );
            fanOuts.set(requireId(message['group']), {
              parent,
              inherited: parent.tails,
              branches: new Map(),
            });
            return;
          }
          case 'join': {
            const group = requireId(message['group']);
            const fanOut = fanOuts.get(group);
            fanOuts.delete(group);
            if (fanOut && message['merge'] === true) {
              fanOut.parent.tails = mergeFanoutTails(
                fanOut.parent.tails,
                fanOut.inherited,
                [...fanOut.branches.entries()]
                  .sort(([a], [b]) => a - b)
                  .flatMap(([, context]) => context.tails),
              );
            }
            return;
          }
          case 'done': {
            if (settled || outcome) return;
            if (message['ok'] === true) {
              outcome = {
                ok: true,
                value: decodeWorkflowValue(message['value']),
              };
            } else {
              const data = message['error'];
              if (!isRecord(data)) throw invalidHostMessage();
              const error = new Error(requireString(data['message']));
              if (typeof data['name'] === 'string') error.name = data['name'];
              if (data['runFailure'] === true) {
                Object.assign(error, { __wfRunFailure: true });
              }
              outcome = { ok: false, error };
            }
            // One macrotask lets dispatch rejections already settling on this
            // side reach the script before the unconsumed-rejection verdict.
            setImmediate(() => {
              if (settled || flushInFlight) return;
              flushInFlight = true;
              settlesSinceFlush = 0;
              send({ type: 'flush' });
            });
            return;
          }
          case 'flushed': {
            const completed = outcome;
            if (!settled && completed) {
              if (completed.ok) finish(undefined, completed.value);
              else finish(completed.error);
            }
            flushInFlight = false;
            if (settled && outstanding.size === 0 && settlesSinceFlush === 0) {
              host.kill();
            } else {
              release();
            }
            return;
          }
          case 'error':
            failHost(new Error(requireString(message['message'])));
            return;
          default:
            throw invalidHostMessage();
        }
      };

      // Declared last: every handler above runs only once the host is up.
      const host: WorkflowHostConnection = startWorkflowHost({
        onMessage: (body) => {
          try {
            const message: unknown = JSON.parse(body);
            if (!isRecord(message)) throw invalidHostMessage();
            handle(message);
          } catch (error) {
            failHost(error);
          }
        },
        onExit: (detail) => {
          clearTimeout(drainTimer);
          signal?.removeEventListener('abort', onAbort);
          finish(
            new Error(
              `The workflow host stopped before the script finished. ${detail}`,
            ),
          );
        },
      });
      try {
        host.send({
          type: 'start',
          source,
          args: argsJson,
          workflow: opts.workflow !== undefined,
          budget: budgetSnapshot() ?? null,
          maxLogLines: MAX_LOG_LINES,
          syncTimeoutMs: WORKFLOW_SYNC_EVALUATION_TIMEOUT_MS,
        });
      } catch (error) {
        failHost(error);
      }
    });

  let extractedMeta: WorkflowMeta | null = null;
  return {
    async run(scriptSource: string): Promise<unknown> {
      // P4: extract `export const meta = {...}` once before the body runs.
      // Compilation goes through the same exported helper the pre-launch
      // gate calls. Sharing the function is the whole point: a gate that
      // compiled the script even slightly differently from the run would
      // wave through something that then fails after the run is registered,
      // which is the failure the gate exists to prevent.
      const { source, meta } = await compileWorkflowScript(scriptSource);
      extractedMeta = meta;
      // A run cancelled before its script started must not start it: the
      // registry pre-registers the run and shares this controller, so a
      // user cancel can land before `run()` is entered.
      if (signal?.aborted) throw workflowCancelledError();
      return execute(source);
    },
    getPhases: () => [...phases],
    getLogs: () => [...logs],
    appendLog: (line: string) => safeLog(line, false),
    getMeta: () => extractedMeta,
  };
}
