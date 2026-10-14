/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it, vi } from 'vitest';
import type { Config } from '@qwen-code/qwen-code-core';
import type { LoadedSettings } from '../../config/settings.js';
import { SettingScope } from '../../config/settings.js';
import { createMockCommandContext } from '../../test-utils/mockCommandContext.js';
import { webCommand } from './web-command.js';

/** A context whose settings store `tools.webFetch` like the real ones. */
function context(initial: boolean, systemValue?: boolean) {
  let user = initial;
  let enabled = initial;
  const setValue = vi.fn((_scope: SettingScope, _key: string, value) => {
    user = value as boolean;
  });
  const settings = {
    get merged() {
      return { tools: { webFetch: systemValue ?? user } };
    },
    setValue,
  } as unknown as LoadedSettings;
  const config = {
    isWebFetchEnabled: () => enabled,
    setWebFetchEnabled: vi.fn(async (value: boolean) => {
      enabled = value;
    }),
  };
  const ctx = createMockCommandContext();
  // Attached directly: the mock context copies what it is given, but the
  // real LoadedSettings recomputes `merged` on every setValue.
  ctx.services.settings = settings;
  ctx.services.config = config as unknown as Config;
  return { ctx, setValue, config };
}

const sub = (name: string) =>
  webCommand.subCommands!.find((command) => command.name === name)!;

describe('/web', () => {
  it('reports the current mode', async () => {
    const result = await webCommand.action!(context(false).ctx, '');
    expect(result).toMatchObject({
      type: 'message',
      messageType: 'info',
      content: expect.stringContaining('Web access is off'),
    });
  });

  it('turns web access on in the user settings and the session', async () => {
    const { ctx, setValue, config } = context(false);
    const result = await sub('on').action!(ctx, '');
    expect(setValue).toHaveBeenCalledWith(
      SettingScope.User,
      'tools.webFetch',
      true,
    );
    expect(config.setWebFetchEnabled).toHaveBeenCalledWith(true);
    expect(result).toMatchObject({
      messageType: 'info',
      content: expect.stringContaining('Web access is on'),
    });
  });

  it('turns web access off', async () => {
    const { ctx, setValue, config } = context(true);
    await sub('off').action!(ctx, '');
    expect(setValue).toHaveBeenCalledWith(
      SettingScope.User,
      'tools.webFetch',
      false,
    );
    expect(config.setWebFetchEnabled).toHaveBeenCalledWith(false);
  });

  it('says when a system setting keeps web access off', async () => {
    const { ctx, config } = context(false, false);
    const result = await sub('on').action!(ctx, '');
    expect(config.setWebFetchEnabled).toHaveBeenCalledWith(false);
    expect(result).toMatchObject({
      messageType: 'error',
      content: expect.stringContaining('stays off'),
    });
  });

  it('says when safe or bare mode keeps web access off', async () => {
    const { ctx, config } = context(false);
    config.isWebFetchEnabled = () => false;
    const result = await sub('on').action!(ctx, '');
    expect(config.setWebFetchEnabled).toHaveBeenCalledWith(true);
    expect(result).toMatchObject({
      messageType: 'error',
      content: expect.stringContaining('safe or bare mode'),
    });
  });

  it('rejects other arguments', async () => {
    const result = await webCommand.action!(context(false).ctx, 'maybe');
    expect(result).toMatchObject({ messageType: 'error' });
  });
});
