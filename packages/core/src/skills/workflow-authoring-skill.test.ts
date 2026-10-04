/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import type { Config } from '../config/config.js';
import { ToolMode } from '../tools/code-mode.js';
import { ToolNames } from '../tools/tool-names.js';
import { parseSkillContent } from './skill-load.js';
import {
  isToolHiddenBehindToolSearch,
  readWorkflowAuthoringReference,
  resolveWorkflowAuthoringSurface,
  WORKFLOW_AUTHORING_SKILL_NAME,
} from './workflow-authoring-skill.js';

const SKILL_PATH = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  'bundled',
  WORKFLOW_AUTHORING_SKILL_NAME,
  'SKILL.md',
);

interface StubOptions {
  skillManager?: boolean;
  /** `null` models a registry that cannot answer. */
  toolNames?: string[] | null;
  deferred?: string[];
  /** `settings.tools.visible`: deferred, but declared from session start. */
  visibleTools?: string[];
  /** Deferred tools already revealed through ToolSearch. */
  revealed?: string[];
  disabledNames?: string[];
  disabledLevels?: string[];
  /** `Config.getToolMode()` — defaults to direct mode. */
  toolMode?: ToolMode;
}

/**
 * A config that answers exactly the questions the route asks. `isSkillEnabled`
 * decides on the name it is handed, as the real one does, so a drift in the
 * name the production code probes turns the disabled-by-name case red.
 */
function stubConfig(options: StubOptions = {}) {
  const {
    skillManager = true,
    toolNames = [
      ToolNames.SKILL,
      ToolNames.WORKFLOW,
      ToolNames.TOOL_SEARCH,
      ToolNames.TOOL_CALL,
    ],
    deferred = [],
    visibleTools = [],
    revealed = [],
    disabledNames = [],
    disabledLevels = [],
    toolMode = ToolMode.Direct,
  } = options;
  // Models the real `Config.isSkillEnabled`: a level other than the bundled one
  // for this skill finds no owner and answers false, so a drift in the level
  // the production code passes turns every row below red.
  const isSkillEnabled = vi.fn(
    (skill: { name: string; level?: string }) =>
      skill.level === 'bundled' && !disabledNames.includes(skill.name),
  );
  const config = {
    getSkillManager: () => (skillManager ? {} : null),
    getToolRegistry: () => ({
      getAllToolNames: () => toolNames ?? undefined,
      isPermissionDeferred: (name: string) => deferred.includes(name),
      isDeferredToolRevealed: (name: string) => revealed.includes(name),
    }),
    getVisibleTools: () => new Set(visibleTools),
    getToolMode: () => toolMode,
    isSkillEnabled,
    getDisabledSkillLevels: () => new Set(disabledLevels),
  } as unknown as Config;
  return { config, isSkillEnabled };
}

describe('readWorkflowAuthoringReference', () => {
  it('reads the bundled SKILL.md the Skill tool would load', () => {
    const parsed = parseSkillContent(
      fs.readFileSync(SKILL_PATH, 'utf8'),
      SKILL_PATH,
    );

    const reference = readWorkflowAuthoringReference();

    expect(reference?.body).toBe(parsed.body);
    expect(reference?.baseDir).toBe(path.dirname(SKILL_PATH));
  });
});

describe('resolveWorkflowAuthoringSurface', () => {
  it.each([
    [{}, 'pointer'],
    [{ deferred: [ToolNames.SKILL] }, 'pointer-via-tool-search'],
    [
      {
        toolMode: ToolMode.CodeModeOnly,
        deferred: [ToolNames.SKILL],
      },
      'pointer',
    ],
    [
      {
        deferred: [ToolNames.SKILL],
        toolNames: [ToolNames.SKILL, ToolNames.WORKFLOW, ToolNames.TOOL_SEARCH],
      },
      'inline',
    ],
    [{ toolNames: [ToolNames.WORKFLOW] }, 'inline'],
    [{ disabledNames: [WORKFLOW_AUTHORING_SKILL_NAME] }, 'withheld'],
  ])('maps %o to %s', (options: StubOptions, surface) => {
    expect(resolveWorkflowAuthoringSurface(stubConfig(options).config)).toBe(
      surface,
    );
  });
});

// Asked again on every turn (the keyword reminder asks it of the Workflow tool),
// so a reveal counts here — unlike the route, which is recorded once.
describe('isToolHiddenBehindToolSearch', () => {
  it.each([
    ['deferred', { deferred: [ToolNames.WORKFLOW] }, true],
    [
      'deferred and revealed',
      { deferred: [ToolNames.WORKFLOW], revealed: [ToolNames.WORKFLOW] },
      false,
    ],
    [
      'deferred and listed in tools.visible',
      { deferred: [ToolNames.WORKFLOW], visibleTools: [ToolNames.WORKFLOW] },
      false,
    ],
    ['not deferred', {}, false],
  ])('answers for a tool that is %s', (_case, options: StubOptions, hidden) => {
    expect(
      isToolHiddenBehindToolSearch(
        stubConfig(options).config,
        ToolNames.WORKFLOW,
      ),
    ).toBe(hidden);
  });
});
