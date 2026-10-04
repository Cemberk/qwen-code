/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Skill Hooks Registration
 *
 * Registers hooks from a skill's frontmatter as session-scoped hooks.
 * When a skill is invoked, its hooks are registered for the duration
 * of the session.
 */

import { createDebugLogger } from '../utils/debugLogger.js';
import type { SessionHooksManager } from './sessionHooksManager.js';
import type { SkillHooksSettings, SkillConfig } from '../skills/types.js';
import {
  HookType,
  type HookEventName,
  type HookConfig,
  type CommandHookConfig,
} from './types.js';

const debugLogger = createDebugLogger('SKILL_HOOKS');

/**
 * Registers hooks from a skill's configuration as session hooks.
 *
 * Hooks are registered as session-scoped hooks that persist for the duration
 * of the session. If a hook has `once: true` in its configuration, it will be
 * automatically removed after its first successful execution.
 *
 * @param sessionHooksManager - The session hooks manager instance
 * @param sessionId - The current session ID
 * @param skill - The skill configuration containing hooks
 * @returns Number of hooks registered
 */
export function registerSkillHooks(
  sessionHooksManager: SessionHooksManager,
  sessionId: string,
  skill: SkillConfig,
): number {
  if (!skill.hooks) {
    debugLogger.debug(`Skill '${skill.name}' has no hooks to register`);
    return 0;
  }

  const hooksSettings: SkillHooksSettings = skill.hooks;
  let registeredCount = 0;

  for (const eventName of Object.keys(hooksSettings) as HookEventName[]) {
    const matchers = hooksSettings[eventName];
    if (!matchers) continue;

    for (const matcher of matchers) {
      const matcherPattern = matcher.matcher || '';

      for (const hook of matcher.hooks) {
        // Only register command hooks (skip function hooks)
        if (hook.type === HookType.Function) {
          debugLogger.debug(
            'Skipping function hook from skill (not supported in frontmatter)',
          );
          continue;
        }

        // Register the hook with skillRoot for environment variable
        const hookConfig = prepareHookConfig(
          hook as CommandHookConfig,
          skill.skillRoot,
        );

        // Skip hooks this skill already registered earlier in the session.
        // Unloading a skill body (/unskill, eviction sync) never unregisters
        // its session hooks, so without this dedup every unload/reload cycle
        // would push a duplicate entry and the hook would fire once per cycle.
        const alreadyRegistered = sessionHooksManager
          .getHooksForEvent(sessionId, eventName)
          .some(
            (entry) =>
              entry.matcher === matcherPattern &&
              entry.skillRoot === skill.skillRoot &&
              hookConfigKey(entry.config) === hookConfigKey(hookConfig),
          );
        if (alreadyRegistered) {
          debugLogger.debug(
            `Hook for ${eventName} with matcher '${matcherPattern}' from skill '${skill.name}' already registered; skipping duplicate`,
          );
          continue;
        }

        // A project skill's hooks are repo-supplied: they register only
        // while the folder is trusted (the caller's gate) and fire only
        // while it still is (the event handler re-checks at fire time).
        sessionHooksManager.addSessionHook(
          sessionId,
          eventName,
          matcherPattern,
          hookConfig,
          { skillRoot: skill.skillRoot, trustGated: skill.level === 'project' },
        );

        registeredCount++;
        debugLogger.debug(
          `Registered hook for ${eventName} with matcher '${matcherPattern}' from skill '${skill.name}'`,
        );
      }
    }
  }

  if (registeredCount > 0) {
    debugLogger.info(
      `Registered ${registeredCount} hooks from skill '${skill.name}'`,
    );
  }

  return registeredCount;
}

/**
 * Identity key for dedup: the whole prepared config. Keying on only
 * type + command silently drops distinct hooks the frontmatter
 * admits per matcher (same command with different timeout/shell) — the
 * second of the pair is skipped even
 * on first registration. Prepared configs from frontmatter carry no
 * functions, so a structural key is stable across reload cycles.
 */
function hookConfigKey(hook: HookConfig): string {
  return `${hook.type}:${JSON.stringify(hook)}`;
}

/**
 * Prepares hook config with skillRoot environment variable.
 *
 * @param hook - The hook configuration
 * @param skillRoot - The skill root directory
 * @returns Prepared hook configuration
 */
function prepareHookConfig(
  hook: CommandHookConfig,
  skillRoot?: string,
): CommandHookConfig {
  if (hook.type === 'command' && skillRoot) {
    // Add QWEN_SKILL_ROOT to environment variables
    return {
      ...hook,
      env: {
        ...hook.env,
        QWEN_SKILL_ROOT: skillRoot,
      },
    };
  }

  return hook;
}
