/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { BackgroundNotificationTurn } from '@qwen-code/qwen-code-core';

export function parseBackgroundNotificationTurn(
  value: unknown,
): BackgroundNotificationTurn | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    return undefined;
  const record = value as Record<string, unknown>;
  const { turnId, taskId, kind, startedAt } = record;
  if (
    typeof turnId !== 'string' ||
    !turnId ||
    turnId.length > 256 ||
    typeof taskId !== 'string' ||
    !taskId ||
    taskId.length > 256 ||
    (kind !== 'agent' &&
      kind !== 'monitor' &&
      kind !== 'shell' &&
      kind !== 'workflow') ||
    typeof startedAt !== 'number' ||
    !Number.isFinite(startedAt) ||
    startedAt < 0
  )
    return undefined;
  for (const key of ['toolUseId', 'sourceTurnId', 'label']) {
    if (
      record[key] !== undefined &&
      (typeof record[key] !== 'string' || (record[key] as string).length > 4096)
    )
      return undefined;
  }
  return {
    turnId,
    taskId,
    kind,
    startedAt,
    ...(record['toolUseId'] !== undefined
      ? { toolUseId: record['toolUseId'] as string }
      : {}),
    ...(record['sourceTurnId'] !== undefined
      ? { sourceTurnId: record['sourceTurnId'] as string }
      : {}),
    ...(record['label'] !== undefined
      ? { label: record['label'] as string }
      : {}),
  };
}
