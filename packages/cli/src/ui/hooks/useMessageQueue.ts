/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { randomUUID } from 'node:crypto';
import { useCallback, useRef, useState } from 'react';
import type {
  GoalContinuationTurn,
  GoalTurnHost,
  GoalTurnPermit,
} from '@qwen-code/qwen-code-core';
import { isSlashCommand } from '../utils/commandUtils.js';

export interface QueuedGoalTurn extends GoalContinuationTurn {
  kind: 'goal';
  permit: GoalTurnPermit;
  turnKey: string;
}

export interface QueuedUserSubmission {
  kind: 'user';
  modelText: string;
  submittedPrompt?: string;
  turnKey: string;
  /**
   * Shell intent recorded when the message was submitted. The drain routes
   * on this record instead of the live shell-mode flag, which may have
   * flipped while the entry waited in the queue (#11626). Undefined means
   * the producer recorded no intent; the drain falls back to the live flag.
   */
  shellMode?: boolean;
}

export interface DirectUserAdmission {
  turnKey: string;
  goal?: QueuedGoalTurn;
}

export type QueuedSubmission = QueuedUserSubmission | QueuedGoalTurn;
export type GoalQueueControlMode = 'normal' | 'priority' | 'only';

export interface UseMessageQueueReturn {
  messageQueue: string[];
  pendingSubmissionCount: number;
  addMessage: (
    message: string,
    deferUntilIdle?: boolean,
    submittedPrompt?: string,
    shellMode?: boolean,
  ) => void;
  enqueueGoalTurn: (
    input: Parameters<GoalTurnHost['startGoalTurn']>[0],
  ) => void;
  peekNextUserBatchKey: (goalTurnActive?: boolean) => string | undefined;
  hasQueuedUserMessages: () => boolean;
  getPendingSubmissionCount: () => number;
  claimGoalTurn: () => QueuedGoalTurn | undefined;
  claimDirectUserAdmission: () => DirectUserAdmission;
  removeGoalTurns: () => string[];
  popNextSubmission: (
    goalControlMode?: GoalQueueControlMode,
  ) => QueuedSubmission | null;
  clearQueue: () => void;
  getQueuedMessagesText: () => string;
  popAllMessages: (
    onRemoved?: (turnKeys: string[]) => void,
  ) => QueuedUserSubmission | null;
  restoreMessages: (
    messages: string[],
    submittedPrompt?: string,
    deferUntilIdle?: boolean,
    shellMode?: boolean,
  ) => void;
  drainQueue: (includeDeferred?: boolean, goalTurnActive?: boolean) => string[];
}

interface QueuedMessage {
  key: string;
  text: string;
  submittedPrompt?: string;
  deferUntilIdle: boolean;
  /**
   * Shell intent recorded at submit time (see QueuedUserSubmission).
   * Batches are kept intent-homogeneous so one routing decision never
   * misroutes another entry's command or prompt.
   */
  shellMode?: boolean;
}

export const GOAL_COMMAND_RE = /^\/goal(?:\s|$)/;

function aggregateUserMessages(
  messages: readonly QueuedMessage[],
): QueuedUserSubmission {
  const text = messages.map((message) => message.text).join('\n\n');
  // Every member contributes a projection — its own when it has one, its
  // model text otherwise.
  const submittedPrompt = messages
    .map((message) => message.submittedPrompt ?? message.text)
    .join('\n\n');
  return {
    kind: 'user',
    modelText: text,
    turnKey: messages[0].key,
    submittedPrompt,
    // Callers keep batches intent-homogeneous, so every member carries the
    // same value; the first represents the batch.
    ...(messages[0].shellMode === undefined
      ? {}
      : { shellMode: messages[0].shellMode }),
  };
}

export function useMessageQueue(): UseMessageQueueReturn {
  const [queuedMessages, setQueuedMessages] = useState<QueuedMessage[]>([]);
  const [queuedGoalTurns, setQueuedGoalTurns] = useState<QueuedGoalTurn[]>([]);
  const queueRef = useRef<QueuedMessage[]>([]);
  const goalQueueRef = useRef<QueuedGoalTurn[]>([]);
  const nextMessageKey = useCallback(() => `message-queue:${randomUUID()}`, []);

  const addMessage = useCallback(
    (
      message: string,
      deferUntilIdle = false,
      submittedPrompt?: string,
      shellMode?: boolean,
    ) => {
      const text = message.trim();
      if (!text) return;
      queueRef.current = [
        ...queueRef.current,
        {
          key: nextMessageKey(),
          text,
          deferUntilIdle,
          submittedPrompt,
          ...(shellMode === undefined ? {} : { shellMode }),
        },
      ];
      setQueuedMessages(queueRef.current);
    },
    [nextMessageKey],
  );

  const enqueueGoalTurn = useCallback(
    (input: Parameters<GoalTurnHost['startGoalTurn']>[0]) => {
      if (
        goalQueueRef.current.some(
          ({ permit }) => permit.turnId === input.permit.turnId,
        )
      ) {
        return;
      }
      const { permit, ...continuation } = input;
      const entry: QueuedGoalTurn = {
        kind: 'goal',
        permit: { ...permit },
        turnKey: `goal-runtime:${permit.turnId}`,
        ...continuation,
      };
      goalQueueRef.current = [...goalQueueRef.current, entry];
      setQueuedGoalTurns(goalQueueRef.current);
    },
    [],
  );

  const peekNextUserBatchKey = useCallback(
    (goalTurnActive = false) =>
      goalTurnActive
        ? undefined
        : queueRef.current.find(({ text }) => !isSlashCommand(text))?.key,
    [],
  );
  const hasQueuedUserMessages = useCallback(
    () => queueRef.current.length > 0,
    [],
  );
  const getPendingSubmissionCount = useCallback(
    () => queueRef.current.length + goalQueueRef.current.length,
    [],
  );

  const claimGoalTurn = useCallback((): QueuedGoalTurn | undefined => {
    const [goal, ...remainingGoals] = goalQueueRef.current;
    if (goal) {
      goalQueueRef.current = remainingGoals;
      setQueuedGoalTurns(remainingGoals);
    }
    return goal;
  }, []);

  const claimDirectUserAdmission = useCallback((): DirectUserAdmission => {
    const goal = claimGoalTurn();
    return {
      turnKey: nextMessageKey(),
      ...(goal ? { goal } : {}),
    };
  }, [claimGoalTurn, nextMessageKey]);

  const removeGoalTurns = useCallback((): string[] => {
    const keys = goalQueueRef.current.map(({ turnKey }) => turnKey);
    if (keys.length === 0) return [];
    goalQueueRef.current = [];
    setQueuedGoalTurns([]);
    return keys;
  }, []);

  const popNextSubmission = useCallback(
    (
      goalControlMode: GoalQueueControlMode = 'normal',
    ): QueuedSubmission | null => {
      // Goal controls bypass ordinary input so queued text cannot prevent
      // clearing or replacing the Goal that is holding that input.
      if (goalControlMode !== 'normal') {
        const goalCommandIndex = queueRef.current.findIndex(({ text }) =>
          GOAL_COMMAND_RE.test(text),
        );
        if (goalCommandIndex >= 0) {
          const goalCommand = queueRef.current[goalCommandIndex];
          queueRef.current = [
            ...queueRef.current.slice(0, goalCommandIndex),
            ...queueRef.current.slice(goalCommandIndex + 1),
          ];
          setQueuedMessages(queueRef.current);
          return aggregateUserMessages([goalCommand]);
        }
        if (goalControlMode === 'priority') {
          return claimGoalTurn() ?? null;
        }
        if (goalControlMode === 'only') return null;
      }

      const plainMessages = queueRef.current.filter(
        ({ text }) => !isSlashCommand(text),
      );
      if (plainMessages.length > 0) {
        // One routing decision per batch: the batch is the contiguous run of
        // entries from the head that share the first plain entry's recorded
        // shell intent, so a shell command and a model prompt never merge
        // into a blob the drain can only route one way (#11626). Stopping at
        // the first difference keeps submission order too — a later entry
        // with the head's intent never overtakes an earlier entry queued
        // with a different one.
        const headIntent = plainMessages[0].shellMode;
        const batch: QueuedMessage[] = [];
        for (const message of plainMessages) {
          if (message.shellMode !== headIntent) break;
          batch.push(message);
        }
        const batchKeys = new Set(batch.map(({ key }) => key));
        queueRef.current = queueRef.current.filter(
          ({ key }) => !batchKeys.has(key),
        );
        setQueuedMessages(queueRef.current);
        return aggregateUserMessages(batch);
      }

      const [userHead, ...userRest] = queueRef.current;
      if (userHead) {
        queueRef.current = userRest;
        setQueuedMessages(userRest);
        return aggregateUserMessages([userHead]);
      }

      return claimGoalTurn() ?? null;
    },
    [claimGoalTurn],
  );

  const clearQueue = useCallback(() => {
    queueRef.current = [];
    setQueuedMessages([]);
  }, []);

  const getQueuedMessagesText = useCallback(() => {
    if (queuedMessages.length === 0) return '';
    return queuedMessages.map(({ text }) => text).join('\n\n');
  }, [queuedMessages]);

  const popAllMessages = useCallback(
    (onRemoved?: (turnKeys: string[]) => void): QueuedUserSubmission | null => {
      const popped = queueRef.current;
      if (popped.length === 0) return null;
      queueRef.current = [];
      setQueuedMessages([]);
      onRemoved?.(popped.map(({ key }) => key));
      return aggregateUserMessages(popped);
    },
    [],
  );

  const restoreMessages = useCallback(
    (
      messages: string[],
      submittedPrompt?: string,
      deferUntilIdle = false,
      shellMode?: boolean,
    ) => {
      const restored = messages
        .map((text) => text.trim())
        .filter(Boolean)
        .map((text) => ({
          key: nextMessageKey(),
          text,
          ...(messages.length === 1 && submittedPrompt !== undefined
            ? { submittedPrompt }
            : {}),
          deferUntilIdle,
          ...(shellMode === undefined ? {} : { shellMode }),
        }));
      if (restored.length === 0) return;
      queueRef.current = [...restored, ...queueRef.current];
      setQueuedMessages(queueRef.current);
    },
    [nextMessageKey],
  );

  const drainQueue = useCallback(
    (includeDeferred = false, goalTurnActive = false): string[] => {
      const current = queueRef.current;
      if (current.length === 0) return [];
      const shouldDrain = (message: QueuedMessage) =>
        (goalTurnActive
          ? GOAL_COMMAND_RE.test(message.text)
          : !isSlashCommand(message.text)) &&
        (includeDeferred || !message.deferUntilIdle);
      const drained = current.filter(shouldDrain);
      if (drained.length === 0) return [];
      const rest = current.filter((message) => !shouldDrain(message));
      queueRef.current = rest;
      setQueuedMessages(rest);
      return drained.map(({ text }) => text);
    },
    [],
  );

  return {
    messageQueue: queuedMessages.map(({ text }) => text),
    pendingSubmissionCount: queuedMessages.length + queuedGoalTurns.length,
    addMessage,
    enqueueGoalTurn,
    peekNextUserBatchKey,
    hasQueuedUserMessages,
    getPendingSubmissionCount,
    claimGoalTurn,
    claimDirectUserAdmission,
    removeGoalTurns,
    popNextSubmission,
    clearQueue,
    getQueuedMessagesText,
    popAllMessages,
    restoreMessages,
    drainQueue,
  };
}
