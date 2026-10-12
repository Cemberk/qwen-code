/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

export enum ApprovalMode {
  PLAN = 'plan',
  DEFAULT = 'default',
  AUTO_EDIT = 'auto-edit',
  AUTO = 'auto',
  YOLO = 'yolo',
}

export type ApprovalModeValue = `${ApprovalMode}`;

export const APPROVAL_MODES = Object.values(ApprovalMode);

const APPROVAL_MODE_RANK: Record<ApprovalMode, number> = {
  [ApprovalMode.PLAN]: 0,
  [ApprovalMode.DEFAULT]: 1,
  [ApprovalMode.AUTO_EDIT]: 2,
  [ApprovalMode.AUTO]: 2,
  [ApprovalMode.YOLO]: 3,
};

/**
 * The approval mode an agent runs in: the less permissive of the mode it
 * declares and its parent's, so an agent never gets more autonomy than the
 * session that spawned it. With no declared mode it runs in the parent's.
 * Declared values that are not session modes (the subagent-only `bubble`)
 * run as DEFAULT. AUTO_EDIT and AUTO each auto-approve calls the other would
 * ask about, so neither bounds the other and together they resolve to DEFAULT.
 */
export function resolveAgentApprovalMode(
  parentMode: ApprovalMode,
  declaredMode?: string,
): ApprovalMode {
  if (!declaredMode) return parentMode;
  const declared = (APPROVAL_MODES as string[]).includes(declaredMode)
    ? (declaredMode as ApprovalMode)
    : ApprovalMode.DEFAULT;
  const order = APPROVAL_MODE_RANK[declared] - APPROVAL_MODE_RANK[parentMode];
  if (order === 0 && declared !== parentMode) return ApprovalMode.DEFAULT;
  return order < 0 ? declared : parentMode;
}
