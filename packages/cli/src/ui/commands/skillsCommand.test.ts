/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { vi, describe, it, expect } from 'vitest';
import { skillsCommand } from './skillsCommand.js';
import type { CommandContext } from './types.js';
import { createMockCommandContext } from '../../test-utils/mockCommandContext.js';

interface FakeSkill {
  name: string;
  description?: string;
  priority?: number;
  userInvocable?: boolean;
  level?: string;
  extensionName?: string;
  extensionDisplayName?: string;
}

function makeContext(opts: {
  skills?: FakeSkill[];
  workspaceDisabled?: string[];
  mergedDisabled?: string[];
  isTrusted?: boolean;
  executionMode?: 'interactive' | 'non_interactive';
}): CommandContext {
  const {
    skills = [],
    workspaceDisabled = [],
    mergedDisabled = workspaceDisabled,
    isTrusted = true,
    executionMode = 'interactive',
  } = opts;

  const skillManager = {
    listSkills: vi.fn().mockResolvedValue(skills),
  };

  // Mirror the normalization that buildDisabledSkillNamesProvider applies
  // (trim + lowercase + filter non-strings) so this fake matches the real
  // Config.getDisabledSkillNames() contract — skillsCommand calls into it
  // directly now instead of doing its own string munging.
  const disabledSet = new Set(
    mergedDisabled
      .filter((n): n is string => typeof n === 'string')
      .map((n) => n.trim().toLowerCase())
      .filter(Boolean),
  );

  return createMockCommandContext({
    executionMode,
    services: {
      config: {
        getSkillManager: () => skillManager,
        getDisabledSkillNames: () => disabledSet,
        isSkillEnabled: (skill: { name: string }) =>
          !disabledSet.has(skill.name.toLowerCase()),
      } as never,
      settings: {
        isTrusted,
        merged: { skills: { disabled: mergedDisabled } },
        forScope: vi.fn().mockReturnValue({
          settings: { skills: { disabled: workspaceDisabled } },
        }),
        setValue: vi.fn(),
      } as never,
    },
    ui: {
      addItem: vi.fn(),
    } as never,
  });
}

describe('skillsCommand bare entry', () => {
  it('opens the manage dialog directly in interactive mode', async () => {
    if (!skillsCommand.action) {
      throw new Error('skillsCommand must have an action.');
    }
    const context = makeContext({
      skills: [{ name: 'alpha' }, { name: 'beta' }],
      executionMode: 'interactive',
    });

    const result = await skillsCommand.action(context, '');

    // Single-entry UX: bare `/skills` (no args) goes straight to the
    // dialog. No SKILLS_LIST emitted in interactive mode.
    expect(result).toEqual({ type: 'dialog', dialog: 'skills_manage' });
    expect(context.ui.addItem).not.toHaveBeenCalled();
  });

  it('opens the dialog even when args are passed in interactive mode', async () => {
    // `/skills` is dialog-only — any trailing args are ignored. The legacy
    // `/skills <name>` invocation path was removed; users invoke skills
    // via `/<skill-name>` directly (loaded by SkillCommandLoader) or by
    // picking inside the dialog.
    if (!skillsCommand.action) throw new Error('action missing');
    const context = makeContext({
      skills: [{ name: 'beta' }],
      executionMode: 'interactive',
    });

    const result = await skillsCommand.action(context, 'beta');

    expect(result).toEqual({ type: 'dialog', dialog: 'skills_manage' });
    expect(context.ui.addItem).not.toHaveBeenCalled();
  });
});

describe('skillsCommand surface', () => {
  it('exposes no subCommands and no completion (single-entry, no args)', () => {
    expect(skillsCommand.subCommands ?? []).toEqual([]);
    expect(skillsCommand.completion).toBeUndefined();
  });

  it('opts into submit-on-accept so /skil<Enter> opens the dialog in one keystroke', () => {
    // Without this flag, accepting the `skills` suggestion from the
    // auto-completion popup would only fill the buffer with `/skills `
    // and force a second Enter to submit. See `Suggestion.submitOnAccept`
    // and the InputPrompt accept-suggestion branch.
    expect(skillsCommand.submitOnAccept).toBe(true);
  });
});
