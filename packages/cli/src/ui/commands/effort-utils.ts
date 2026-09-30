/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import type { Config, ReasoningEffort } from '@qwen-code/qwen-code-core';
import { t } from '../../i18n/index.js';

export function formatEffortChangeMessage(
  config: Config,
  tier: ReasoningEffort,
): string {
  if (config.getReasoningEffort() !== tier) {
    return t(
      'Reasoning effort set to {{tier}}, but thinking is currently disabled — it will take effect when thinking is re-enabled.',
      { tier },
    );
  }

  return t(
    'Reasoning effort: {{tier}} (requested; the effective tier depends on the active provider/model).',
    { tier },
  );
}
