/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Startup-time worktree setup for the `--worktree` CLI flag (Phase D-1).
 *
 * Runs after argv parsing and before `loadCliConfig()` / `Config` construction
 * so the resulting `process.cwd()` change feeds directly into the Config's
 * `targetDir`. Two entry forms are supported (see {@link setupStartupWorktree}):
 *
 * - Empty string (bare `--worktree`) → auto-generated `{adj}-{noun}-{6hex}` slug
 * - Plain slug (`--worktree my-feature`) → that exact slug
 *
 * Sidecar writing and `--resume` override accounting are NOT handled here —
 * those need a constructed `Config` and live in {@link persistStartupWorktreeSidecar}.
 */

import * as path from 'node:path';
import {
  createWorktreeSessionMarker,
  ensureWorktreeSessionMarkerExcluded,
  GitWorktreeService,
  readWorktreeSessionMarker,
  replaceWorktreeSessionMarker,
  worktreeBranchForSlug,
  WorktreeMarkerCommittedError,
  WorktreeSessionMarkerOwnerChangedError,
} from '@qwen-code/qwen-code-core/services/gitWorktreeService.js';
import {
  clearWorktreeSessionDurable,
  getSessionRuntimeLiveness,
  readWorktreeSession,
  writeWorktreeSession,
} from '@qwen-code/qwen-code-core/services/worktreeSessionService.js';
import { createDebugLogger } from '@qwen-code/qwen-code-core/utils/debugLogger.js';
import { stripAnsiAndControl } from '@qwen-code/qwen-code-core/utils/textUtils.js';
import type { Config } from '@qwen-code/qwen-code-core/config/config.js';
import type { WorktreeSession } from '@qwen-code/qwen-code-core/services/worktreeSessionService.js';

const debugLogger = createDebugLogger('WORKTREE_STARTUP');

export class WorktreeOwnershipConflictError extends Error {
  constructor(
    readonly ownerSessionId: string,
    reason: 'active' | 'unverifiable' = 'active',
  ) {
    // ownerSessionId is raw `.qwen-session` marker content — the lenient
    // reader only trims — so it can carry terminal escapes/control chars
    // into a message that reaches stderr via handleCriticalError. Sanitize
    // the interpolation only; the field keeps the raw value for the
    // ownership comparisons and marker compare-and-swap.
    const safeOwner = stripAnsiAndControl(
      ownerSessionId.replace(/[\p{Cf}\s]+/gu, ' '),
    );
    super(
      reason === 'active'
        ? `Worktree is owned by active session ${safeOwner}`
        : `Worktree ownership cannot be verified for session ${safeOwner}`,
    );
    this.name = 'WorktreeOwnershipConflictError';
  }
}

/**
 * `git rev-parse --abbrev-ref HEAD` returns this literal when the
 * launch cwd has a detached HEAD checked out. Two related uses:
 *
 * 1. As an INPUT filter when normalizing `getCurrentBranch` output:
 *    we treat `'HEAD'` as "no real branch" and collapse to `undefined`
 *    so detached-state propagates uniformly through the slug/baseRef
 *    pipeline.
 * 2. As the FALLBACK metadata string written to the sidecar's
 *    `originalBranch` field when the launch state was detached
 *    (no branch name to record).
 */
const DETACHED_HEAD = 'HEAD';

/**
 * Resolved metadata for a startup worktree. Returned to the caller so the
 * sidecar write (which needs `Config`) can happen after `loadCliConfig`.
 */
export interface StartupWorktreeContext {
  /** Resolved absolute worktree path (where `process.cwd()` now points). */
  worktreePath: string;
  /** Slug, e.g. `my-feature` or `pr-123`. */
  slug: string;
  /** Branch name, e.g. `worktree-my-feature` or `worktree-pr-123`. */
  branch: string;
  /** Repo top level captured before chdir. */
  repoRoot: string;
  /** Branch that was checked out at worktree-creation time. */
  originalBranch: string;
  /** HEAD SHA captured at worktree-creation time (for WorktreeExitDialog). */
  originalHeadCommit: string;
  /**
   * True when the worktree directory already existed at startup and we
   * re-attached to it. Commit-count semantics in `WorktreeExitDialog` will track only this
   * session's new commits.
   */
  wasReattached: boolean;
}

export type SetupStartupWorktreeResult =
  | { ok: true; context: StartupWorktreeContext }
  | { ok: false; error: string };

/**
 * Resolves slug, creates the worktree, switches `process.cwd()`, and returns
 * the metadata needed for the post-`loadCliConfig` sidecar write.
 *
 * Returns `null` when `rawInput === undefined` (no `--worktree` flag passed
 * at all). Returns `{ ok: false, error }` for validation / git failures so
 * the caller can print to stderr and exit with a controlled non-zero status.
 *
 * The caller is responsible for chdir-ing back if a later step fails — this
 * helper does not roll back the worktree directory on a downstream error,
 * matching `EnterWorktreeTool`'s "the worktree is yours now" semantics.
 */
export interface SetupStartupWorktreeOptions {
  /**
   * Mirrors `worktree.symlinkDirectories` (Phase D-2). Forwarded to
   * `createUserWorktree` so the new worktree gets the same opt-in
   * symlinks as `enter_worktree` and agent isolation worktrees do.
   */
  symlinkDirectories?: readonly string[];
}

export async function setupStartupWorktree(
  rawInput: string | undefined,
  options?: SetupStartupWorktreeOptions,
): Promise<SetupStartupWorktreeResult | null> {
  if (rawInput === undefined) return null;

  // yargs delivers bare `--worktree` as an empty string (mirrors --resume).
  // We accept it and fall through to auto-slug below.
  const trimmed = rawInput.trim();

  // Probe service rooted at the launch cwd so we can locate the repo top
  // level before the chdir; the chdir target lives under that top level.
  const launchCwd = process.cwd();
  const probe = new GitWorktreeService(launchCwd);

  const gitCheck = await probe.checkGitAvailable();
  if (!gitCheck.available) {
    return {
      ok: false,
      error: `--worktree: ${gitCheck.error ?? 'git is not available on PATH.'}`,
    };
  }

  // Refuse nested creation: launching with --worktree from inside an existing
  // worktree creates `<otherRepo>/.qwen/worktrees/<slug>/`, which is rarely
  // what the user wants and corrupts ownership tracking.
  if (/[\\/]\.qwen[\\/]worktrees[\\/]/.test(launchCwd)) {
    return {
      ok: false,
      error: `--worktree: cannot start a new worktree from inside another worktree (cwd: ${launchCwd}). Run from the main checkout.`,
    };
  }

  // `getRepoTopLevel()` returns null when cwd is not inside a git repo,
  // so a single subprocess covers both the is-a-repo gate and the
  // top-level resolution we need for the worktree path.
  const rawRepoRoot = await probe.getRepoTopLevel();
  if (rawRepoRoot === null) {
    return {
      ok: false,
      error: `--worktree: ${launchCwd} is not a git repository. Run \`git init\` first or relaunch from inside one.`,
    };
  }
  // git always emits POSIX-style paths (forward slashes) via
  // `--show-toplevel`. Normalize to the platform-native separator
  // before storing or comparing so the sidecar's `originalCwd` and
  // downstream `startsWith` checks don't mix `/` and `\` on Windows.
  const repoRoot = path.resolve(rawRepoRoot);
  const service =
    repoRoot === launchCwd ? probe : new GitWorktreeService(repoRoot);

  let slug: string;
  if (trimmed.length === 0) {
    slug = GitWorktreeService.generateAutoSlug();
  } else {
    // The reserved `pr-<N>` shape is tolerated HERE so an existing
    // PR-backed worktree can be re-attached by its literal slug; the
    // re-attach probe below re-applies the reservation when no such
    // worktree exists, so a literal `pr-<N>` never creates one.
    const validation = GitWorktreeService.validateUserWorktreeSlug(trimmed, {
      allowPrBackedShape: true,
    });
    if (validation) {
      return { ok: false, error: `--worktree: ${validation}` };
    }
    slug = trimmed;
  }

  // Capture the launch-time branch and HEAD. These feed the WorktreeSession
  // sidecar's `originalBranch` / `originalHeadCommit` fields when we go
  // through the CREATE path; on re-attach the HEAD baseline is re-captured
  // from inside the worktree itself (see the re-attach branch below) so
  // `WorktreeExitDialog`'s `rev-list <originalHeadCommit>..HEAD` counts
  // only this session's new commits — not every commit the kept worktree
  // accumulated across prior sessions.
  //
  // The two probes are independent — run in parallel to shave one
  // subprocess off the critical path. Each is individually try-wrapped
  // so a failure in one (unborn HEAD, partial init) doesn't poison
  // the other. Detached-HEAD normalization via DETACHED_HEAD const.
  const [originalBranchRaw, originalHeadCommit] = await Promise.all([
    service.getCurrentBranch().catch(() => undefined),
    service.getCurrentCommitHash().catch(() => ''),
  ]);
  const originalBranch =
    originalBranchRaw && originalBranchRaw !== DETACHED_HEAD
      ? originalBranchRaw
      : undefined;

  // Re-attach to an existing worktree instead of erroring out. Common
  // case: user did `qwen --worktree foo` previously, exited with Keep,
  // and now runs `qwen --resume <sid> --worktree foo` to continue. The
  // directory + branch are already on disk; we just chdir into them.
  //
  // `getRegisteredWorktreeBranch` returns the worktree's HEAD commit
  // alongside the branch (single rev-parse). Using THAT as
  // `originalHeadCommit` instead of the launch-cwd capture is critical:
  // `WorktreeExitDialog` later runs `rev-list <head>..HEAD` inside the
  // worktree, so the launch-cwd HEAD would make it count every commit
  // accumulated in the worktree across all prior sessions as "new work
  // this session".
  const expectedWorktreePath = service.getUserWorktreePath(slug);
  const expectedBranch = worktreeBranchForSlug(slug);
  let registered: { branch: string; headCommit: string } | null = null;
  try {
    registered =
      await service.getRegisteredWorktreeBranch(expectedWorktreePath);
  } catch {
    registered = null;
  }
  if (registered === null) {
    // Nothing to re-attach: a user-typed `pr-<N>` would CREATE a worktree
    // in the reserved shape (binding the session to PR N it never touched)
    // — the exact case the reservation exists for.
    const reserved = GitWorktreeService.validateUserWorktreeSlug(slug);
    if (reserved) {
      return { ok: false, error: `--worktree: ${reserved}` };
    }
  }
  if (registered !== null) {
    if (registered.branch !== expectedBranch) {
      // SOMETHING ELSE is occupying the path on a different branch —
      // refuse to clobber it.
      return {
        ok: false,
        error:
          `--worktree: ${expectedWorktreePath} is already a git worktree, but its branch ` +
          `is ${registered.branch} (expected ${expectedBranch}). Refusing to re-attach. ` +
          `Resolve the conflict manually (e.g. \`git worktree remove ${expectedWorktreePath}\`).`,
      };
    }
    const worktreePath = path.resolve(expectedWorktreePath);
    try {
      process.chdir(worktreePath);
    } catch (error) {
      return {
        ok: false,
        error: `--worktree: failed to chdir into ${worktreePath} (${error instanceof Error ? error.message : String(error)}).`,
      };
    }
    debugLogger.debug(
      `setupStartupWorktree: re-attached to existing worktree at ${worktreePath} (branch=${registered.branch})`,
    );
    return {
      ok: true,
      context: {
        worktreePath,
        slug,
        branch: registered.branch,
        repoRoot,
        originalBranch: originalBranch ?? DETACHED_HEAD,
        originalHeadCommit: registered.headCommit,
        wasReattached: true,
      },
    };
  }

  const result = await service.createUserWorktree(slug, originalBranch, {
    symlinkDirectories: options?.symlinkDirectories,
  });
  if (!result.success || !result.worktree) {
    return {
      ok: false,
      error: `--worktree: ${result.error ?? 'failed to create worktree.'}`,
    };
  }

  // Switch the process working directory so loadCliConfig() picks up the
  // worktree as targetDir, and subsequent shell / file operations land
  // inside it. Mirror the convention used elsewhere in the codebase by
  // working with the resolved absolute path.
  const worktreePath = path.resolve(result.worktree.path);
  try {
    process.chdir(worktreePath);
  } catch (error) {
    return {
      ok: false,
      error: `--worktree: created worktree at ${worktreePath} but failed to chdir into it (${error instanceof Error ? error.message : String(error)}). Run \`cd ${worktreePath}\` manually.`,
    };
  }

  return {
    ok: true,
    context: {
      worktreePath,
      slug,
      branch: result.worktree.branch,
      repoRoot,
      originalBranch: originalBranch ?? DETACHED_HEAD,
      originalHeadCommit,
      wasReattached: false,
    },
  };
}

/**
 * Result of the post-`loadCliConfig` sidecar persist step. Callers use the
 * boolean fields to decide whether to surface an INFO line in TUI / a
 * `<system-reminder>` in headless / a `pendingWorktreeNotice` in ACP.
 */
export interface PersistStartupWorktreeResult {
  /** True when a pre-existing sidecar was found and overridden. */
  overrodeResumedWorktree: boolean;
  /**
   * Slug of the worktree that was overridden, when {@link overrodeResumedWorktree}
   * is true. Used in the INFO message so users can re-attach to it if they
   * launched with `--worktree` by mistake.
   */
  overriddenSlug?: string;
  /** Path to the sidecar file just written. */
  sidecarPath: string;
}

/**
 * Writes the `WorktreeSession` sidecar that Phase C's `--resume` restore
 * machinery consumes, and tags the worktree directory with the current
 * session ID so cross-session `exit_worktree action="remove"` is refused.
 *
 * Handles the `--worktree` × `--resume` precedence: when a sidecar already
 * exists (the user resumed a session that previously had a different
 * worktree), the new context wins and the previous slug is reported back
 * so callers can show an INFO line.
 */
export async function persistStartupWorktreeSidecar(
  config: Config,
  context: StartupWorktreeContext,
): Promise<PersistStartupWorktreeResult> {
  const sessionId = config.getSessionId();
  const sidecarPath = config
    .getSessionService()
    .getWorktreeSessionPath(sessionId);

  // Read whatever sidecar exists before we clobber it, so we can detect
  // and report an override. A read failure (corrupt JSON, permission)
  // collapses to "no previous worktree" — the new sidecar still wins.
  // Log the failure with the sidecar path so an operator can recover the
  // previous slug from a backup if they care; silent loss would make
  // "where did my previous worktree binding go?" undebuggable.
  let overrodeResumedWorktree = false;
  let overriddenSlug: string | undefined;
  let previous: WorktreeSession | null = null;
  try {
    previous = await readWorktreeSession(sidecarPath);
  } catch (error) {
    debugLogger.warn(
      `persistStartupWorktreeSidecar: failed to read existing sidecar at ${sidecarPath} — treating as "no previous worktree" and proceeding: ${error}`,
    );
    previous = null;
  }
  if (previous && previous.slug !== context.slug) {
    overrodeResumedWorktree = true;
    overriddenSlug = previous.slug;
  }

  let observedOwner: string | null = null;
  try {
    if (!context.wasReattached) {
      await createWorktreeSessionMarker(context.worktreePath, sessionId);
    } else {
      observedOwner = await readWorktreeSessionMarker(context.worktreePath);
      if (observedOwner === null) {
        await createWorktreeSessionMarker(context.worktreePath, sessionId);
      } else if (observedOwner === sessionId) {
        await ensureWorktreeSessionMarkerExcluded(context.worktreePath);
      } else {
        const ownerLiveness = await getSessionRuntimeLiveness(observedOwner, [
          context.repoRoot,
          context.worktreePath,
        ]).catch((error) => {
          debugLogger.warn(
            `persistStartupWorktreeSidecar: failed to check owner runtime ${observedOwner}: ${error}`,
          );
          return 'unknown' as const;
        });
        if (ownerLiveness === 'active') {
          throw new WorktreeOwnershipConflictError(observedOwner);
        }
        if (ownerLiveness === 'unknown') {
          debugLogger.warn(
            `persistStartupWorktreeSidecar: cannot verify marker owner ${observedOwner} at ` +
              `${path.join(context.worktreePath, '.qwen-session')}; preserving ownership`,
          );
          // No new binding is written on this path, so a pre-existing
          // sidecar naming a DIFFERENT worktree would survive and direct a
          // later --resume at a worktree this session is not running in.
          if (previous && previous.slug !== context.slug) {
            await clearWorktreeSessionDurable(sidecarPath).catch((error) =>
              debugLogger.warn(
                `persistStartupWorktreeSidecar: failed to clear the stale sidecar at ${sidecarPath}: ${error}`,
              ),
            );
          }
          return { overrodeResumedWorktree: false, sidecarPath };
        } else {
          await replaceWorktreeSessionMarker(
            context.worktreePath,
            observedOwner,
            sessionId,
          );
        }
      }
    }
  } catch (error) {
    if (error instanceof WorktreeOwnershipConflictError) throw error;
    if (error instanceof WorktreeSessionMarkerOwnerChangedError) {
      throw new WorktreeOwnershipConflictError(observedOwner ?? '(unknown)');
    }
    if (error instanceof WorktreeMarkerCommittedError) {
      if (
        error.committedOwner !== sessionId ||
        (await readWorktreeSessionMarker(context.worktreePath)) !== sessionId
      ) {
        throw error;
      }
    } else {
      let markerAlreadyOwned = false;
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
        const currentOwner = await readWorktreeSessionMarker(
          context.worktreePath,
        );
        if (currentOwner !== null && currentOwner !== sessionId) {
          throw new WorktreeOwnershipConflictError(currentOwner);
        }
        markerAlreadyOwned = currentOwner === sessionId;
      }
      if (context.wasReattached && !markerAlreadyOwned) throw error;
      debugLogger.warn(
        `persistStartupWorktreeSidecar: marker update failed; persisting the sidecar without changing ownership: ${error}`,
      );
    }
  }

  await writeWorktreeSession(sidecarPath, {
    slug: context.slug,
    worktreePath: context.worktreePath,
    worktreeBranch: context.branch,
    originalCwd: context.repoRoot,
    originalBranch: context.originalBranch,
    originalHeadCommit: context.originalHeadCommit,
  });

  // The previous worktree directory (if any) is intentionally left on
  // disk — the user retains the ability to re-attach by launching again
  // with `--worktree <previous-slug>`. We only swap the sidecar's slug.

  return { overrodeResumedWorktree, overriddenSlug, sidecarPath };
}

/**
 * Builds the one-shot context message that gets injected into the model on
 * the first user prompt (TUI: INFO history item + reminder prefix; headless:
 * `<system-reminder>` prefix + JSON event; ACP currently exits before
 * reaching this code path — see the `--worktree` × `--acp` mutex check
 * in `llm.tsx`).
 *
 * Mirrors `restoreWorktreeContext`'s contextMessage shape so resumed-with-
 * worktree and started-with-worktree sessions read identically to the model.
 *
 * Differentiates the verb based on whether the worktree was just created
 * or the CLI re-attached to a pre-existing one — same slug + branch but
 * meaningfully different user intent. The override addendum (when
 * `--worktree` clobbered a resumed session's prior worktree) is shown
 * regardless of created/reattached state.
 *
 * Parameter type is `Pick<StartupWorktreeContext, …>` rather than the full
 * context so test fixtures can construct minimal literals without
 * tracking every internal field. Adding fields to {@link
 * StartupWorktreeContext} should NOT force test-fixture churn here.
 */
export function buildStartupWorktreeNotice(
  context: Pick<
    StartupWorktreeContext,
    'slug' | 'worktreePath' | 'branch' | 'wasReattached'
  >,
  override?: PersistStartupWorktreeResult,
): string {
  const verb = context.wasReattached
    ? 'Re-attached to worktree'
    : 'Active worktree';
  const base =
    `[Startup] ${verb}: "${context.slug}" at ${context.worktreePath} ` +
    `(branch: ${context.branch}). Continue using this path for all file operations.`;
  if (override?.overrodeResumedWorktree && override.overriddenSlug) {
    return (
      `${base}\n` +
      `Note: --worktree overrode the resumed session's previous worktree "${override.overriddenSlug}". ` +
      `That worktree directory was left intact; re-attach with \`qwen --worktree ${override.overriddenSlug}\` if needed.`
    );
  }
  return base;
}
