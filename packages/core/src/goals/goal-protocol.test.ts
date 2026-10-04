/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import {
  GOAL_CHECKPOINT_REQUEST_TOO_LARGE_REASON,
  GOAL_EVIDENCE_CATALOG_EXHAUSTED_REASON,
  goalLimitKindForReason,
  isGoalLimitKind,
  GOAL_PAUSE_REASON_COMMAND,
  GOAL_PAUSE_REASON_HEADLESS_RUN_ENDED,
  GOAL_PAUSE_REASON_MAX_CHARACTERS,
  GOAL_PAUSE_REASON_NO_PROGRESS,
  GOAL_PAUSE_REASON_SESSION_TOKEN_LIMIT,
  GOAL_PAUSE_REASON_STOP_HOOK_CAP,
  GOAL_PAUSE_REASON_USER_INTERRUPT,
  goalActiveTimeBudgetReason,
  goalPauseReasonForFailure,
  goalPauseReasonForHeadlessFailure,
  goalPauseReasonForRunBudget,
  goalTurnBudgetReason,
} from './goal-protocol.js';

const codePoints = (value: string) => [...value].length;

describe('goal pause reasons', () => {
  it('keeps every shared constant within the bound', () => {
    for (const reason of [
      GOAL_PAUSE_REASON_USER_INTERRUPT,
      GOAL_PAUSE_REASON_COMMAND,
      GOAL_PAUSE_REASON_HEADLESS_RUN_ENDED,
      GOAL_PAUSE_REASON_SESSION_TOKEN_LIMIT,
      GOAL_PAUSE_REASON_STOP_HOOK_CAP,
      GOAL_PAUSE_REASON_NO_PROGRESS,
    ]) {
      expect(reason.trim()).not.toBe('');
      expect(codePoints(reason)).toBeLessThanOrEqual(
        GOAL_PAUSE_REASON_MAX_CHARACTERS,
      );
    }
  });

  it('truncates built reasons to the bound in code points', () => {
    // 5000 astral code points are 10000 UTF-16 units; the bound counts code
    // points, so a UTF-16 truncation would split a surrogate pair.
    const built = goalPauseReasonForFailure('\u{1F600}'.repeat(5_000));
    expect(codePoints(built)).toBe(GOAL_PAUSE_REASON_MAX_CHARACTERS);
    expect(built.endsWith('…')).toBe(true);
  });

  it('bounds built reasons however long the detail', () => {
    for (const built of [
      goalPauseReasonForFailure('x'.repeat(5_000)),
      goalPauseReasonForHeadlessFailure('x'.repeat(5_000)),
      goalPauseReasonForRunBudget('x'.repeat(5_000)),
    ]) {
      expect(codePoints(built)).toBe(GOAL_PAUSE_REASON_MAX_CHARACTERS);
    }
  });

  it('falls back to a detail-free sentence when given none', () => {
    expect(goalPauseReasonForFailure('   ')).toBe(
      'The Goal turn could not finish. Run /goal resume to continue.',
    );
    expect(goalPauseReasonForRunBudget('   ')).toBe(
      'The headless run stopped at a budget. Resume the Goal in a later run.',
    );
    expect(goalPauseReasonForHeadlessFailure('   ')).toBe(
      'The headless run stopped before the Goal turn finished. Resume the Goal in a later run.',
    );
  });

  it('keeps the headless register free of slash commands', () => {
    // A headless process has already exited by the time a user reads these,
    // so none of them may point at a slash command.
    for (const reason of [
      GOAL_PAUSE_REASON_HEADLESS_RUN_ENDED,
      GOAL_PAUSE_REASON_NO_PROGRESS,
      goalPauseReasonForRunBudget('wall-time'),
      goalPauseReasonForHeadlessFailure('the model stream broke'),
    ]) {
      expect(reason).not.toContain('/goal resume');
      expect(reason).not.toContain('/goal ');
    }
    expect(
      goalPauseReasonForHeadlessFailure('the model stream broke'),
    ).toContain('the model stream broke');
  });

  it('names the budget that tripped', () => {
    expect(goalPauseReasonForRunBudget('wall-time')).toContain('wall-time');
    expect(goalPauseReasonForRunBudget('tool-calls')).toContain('tool-calls');
  });
});

describe('legacy evidence limit reasons', () => {
  it('recognises a record an earlier build stopped by its reason alone', () => {
    // Records written before `limitKind` existed carry only the prose, and
    // resume still has to give them a fresh evidence window.
    expect(goalLimitKindForReason(GOAL_EVIDENCE_CATALOG_EXHAUSTED_REASON)).toBe(
      'evidence_catalog',
    );
    expect(
      goalLimitKindForReason(GOAL_CHECKPOINT_REQUEST_TOO_LARGE_REASON),
    ).toBe('checkpoint_request');
    expect(goalLimitKindForReason('anything else')).toBeUndefined();
  });

  it('keeps the legacy limit kinds valid', () => {
    expect(isGoalLimitKind('evidence_catalog')).toBe(true);
    expect(isGoalLimitKind('checkpoint_request')).toBe(true);
  });
});

describe('Goal cadence budget reasons', () => {
  it('formats singular and plural turn budgets', () => {
    expect(goalTurnBudgetReason(1)).toContain('(1 turn)');
    expect(goalTurnBudgetReason(2)).toContain('(2 turns)');
  });

  it('reports sub-minute time budgets in seconds', () => {
    expect(goalActiveTimeBudgetReason(500)).toContain('(1 second)');
    expect(goalActiveTimeBudgetReason(30_000)).toContain('(30 seconds)');
    expect(goalActiveTimeBudgetReason(60_000)).toContain('(1 minute)');
    expect(goalActiveTimeBudgetReason(120_000)).toContain('(2 minutes)');
  });
});
