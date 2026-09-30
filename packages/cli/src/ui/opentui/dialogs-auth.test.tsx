/** @jsxImportSource @opentui/react */
// @vitest-environment jsdom
/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Component wiring tests for the OpenTUI /auth dialog (#57). The native
 * renderer (Bun/FFI) is exercised by the separate PTY gate; here the OpenTUI
 * hooks/jsx runtime are replaced with fakes (same harness as
 * input-prompt.test.tsx) so the tests verify what the dialog guarantees:
 *
 *  - the dialog opens straight on the local-server setup (no provider list)
 *    and Esc on its first step is blocked while unauthenticated;
 *  - the base URL has no default and only loopback URLs are accepted;
 *  - the wizard walks base URL → API key → models → advanced config → review
 *    and the final Enter drives the same install-plan write path as ink's
 *    useAuth.handleProviderSubmit (buildInstallPlan → applyProviderInstall
 *    Plan → feedback + close);
 *  - a rejected install plan surfaces the error and keeps the dialog open.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { render, screen } from '@testing-library/react';
import type { Config } from '@qwen-code/qwen-code-core';
import type { LoadedSettings } from '../../config/settings.js';

const mocks = vi.hoisted(() => {
  const state = {
    inputHandlers: [] as Array<(sequence: string) => boolean>,
    keyboardHandlers: [] as Array<(key: unknown) => void>,
    pasteHandlers: [] as Array<(event: unknown) => void>,
  };
  const renderer = {
    addInputHandler(handler: (sequence: string) => boolean) {
      state.inputHandlers.push(handler);
    },
    removeInputHandler(handler: (sequence: string) => boolean) {
      const index = state.inputHandlers.indexOf(handler);
      if (index >= 0) state.inputHandlers.splice(index, 1);
    },
  };
  async function buildJsxRuntime() {
    const React = await import('react');
    const jsx = (
      type: unknown,
      props: { children?: unknown; key?: React.Key } | null,
      key?: React.Key,
    ) => {
      const config = key === undefined ? props : { ...props, key };
      const children = (config?.children ?? null) as React.ReactNode;
      if (type === 'box' || type === 'text') {
        // `bg` is the one style prop carried through: the dialog gives a
        // background colour to exactly one cell, the software cursor.
        const bg = (config as { bg?: string }).bg;
        return React.createElement(
          type === 'box' ? 'div' : 'span',
          {
            ...(key === undefined ? null : { key }),
            ...(bg === undefined ? null : { 'data-bg': bg }),
          },
          children,
        );
      }
      return React.createElement(
        type as React.ElementType,
        config as Record<string, unknown>,
        children,
      );
    };
    return { jsx, jsxs: jsx, jsxDEV: jsx, Fragment: React.Fragment };
  }
  return { state, renderer, buildJsxRuntime };
});

const core = vi.hoisted(() => ({
  applyProviderInstallPlan: vi.fn(),
  logAuth: vi.fn(),
}));

vi.mock('@opentui/react', () => ({
  useKeyboard: (handler: (key: unknown) => void) => {
    mocks.state.keyboardHandlers.push(handler);
  },
  usePaste: (handler: (event: unknown) => void) => {
    mocks.state.pasteHandlers.push(handler);
  },
  useRenderer: () => mocks.renderer,
}));

vi.mock('@opentui/react/jsx-runtime', () => mocks.buildJsxRuntime());
vi.mock('@opentui/react/jsx-dev-runtime', () => mocks.buildJsxRuntime());
vi.mock('./theme.js', () => ({
  C: new Proxy({}, { get: () => '#ffffff' }),
}));
vi.mock('../../config/loadedSettingsAdapter.js', () => ({
  createLoadedSettingsAdapter: () => ({}),
  getRawModelProviders: () => ({}),
}));
vi.mock('@qwen-code/qwen-code-core', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('@qwen-code/qwen-code-core')>();
  return {
    ...actual,
    applyProviderInstallPlan: core.applyProviderInstallPlan,
    logAuth: core.logAuth,
  };
});

import { AuthType } from '@qwen-code/qwen-code-core';
import * as coreRuntime from '@qwen-code/qwen-code-core';
import { OpenTuiAuthDialog } from './dialogs-auth.js';

function baseKeyEvent(overrides: Record<string, unknown> = {}) {
  return {
    name: 'a',
    sequence: 'a',
    ctrl: false,
    meta: false,
    shift: false,
    option: false,
    super: false,
    hyper: false,
    eventType: 'press',
    preventDefault: () => {},
    stopPropagation: () => {},
    ...overrides,
  };
}

function lastKeyboardHandler(): (key: unknown) => void {
  const handler = mocks.state.keyboardHandlers.at(-1);
  if (!handler) throw new Error('no keyboard handler registered');
  return handler;
}

async function press(
  name: string,
  overrides: Record<string, unknown> = {},
): Promise<void> {
  const handler = lastKeyboardHandler();
  await act(async () => {
    handler(baseKeyEvent({ name, sequence: name, ...overrides }));
  });
}

/**
 * The cell the software cursor is drawn on, or null with no focused field. The
 * jsdom harness keeps the earlier renders of one row mounted beside the live one
 * (the native renderer does not), so the newest cell is the last.
 */
function cursorCell(): HTMLElement | null {
  const cells = document.querySelectorAll<HTMLElement>('[data-bg]');
  return cells[cells.length - 1] ?? null;
}

async function typeText(text: string): Promise<void> {
  // One act per character: the flow state lives in React state, so each
  // keystroke must flush a render before the next handler closure is fresh.
  for (const char of text) {
    await act(async () => {
      const handler = lastKeyboardHandler();
      handler(baseKeyEvent({ name: char, sequence: char }));
    });
  }
}

/** Every character in one act, as a burst out of a single pty read arrives. */
async function typeBatched(text: string): Promise<void> {
  const handler = lastKeyboardHandler();
  await act(async () => {
    for (const char of text) {
      handler(baseKeyEvent({ name: char, sequence: char }));
    }
  });
}

async function pressEsc(): Promise<boolean> {
  const handler = mocks.state.inputHandlers.at(-1);
  if (!handler) throw new Error('no raw input handler registered');
  let consumed = false;
  await act(async () => {
    consumed = handler('\x1b');
  });
  return consumed;
}

interface FakePasteEvent {
  type: 'paste';
  bytes: Uint8Array;
  preventDefault: ReturnType<typeof vi.fn>;
  stopPropagation: ReturnType<typeof vi.fn>;
}

function makePasteEvent(text: string): FakePasteEvent {
  return {
    type: 'paste',
    bytes: new TextEncoder().encode(text),
    preventDefault: vi.fn(),
    stopPropagation: vi.fn(),
  };
}

/** Dispatch one bracketed paste to the most recently mounted input. */
async function pasteText(text: string): Promise<FakePasteEvent> {
  const handler = mocks.state.pasteHandlers.at(-1);
  if (!handler) throw new Error('no paste handler registered');
  const event = makePasteEvent(text);
  await act(async () => {
    handler(event);
  });
  return event;
}

function createMockConfig(authType?: AuthType): Config {
  return {
    getAuthType: vi.fn(() => authType),
    getContentGeneratorConfig: vi.fn(() => ({})),
    getModelsConfig: vi.fn(() => ({
      syncAfterAuthRefresh: vi.fn(),
    })),
    reloadModelProvidersConfig: vi.fn(),
    syncModelSelection: vi.fn(),
    refreshAuth: vi.fn(),
  } as unknown as Config;
}

function createMockSettings(
  merged: Record<string, unknown> = {},
): LoadedSettings {
  return {
    merged: { env: {}, modelProviders: {}, ...merged },
    forScope: () => ({ settings: {}, path: '', originalSettings: {} }),
  } as unknown as LoadedSettings;
}

function renderDialog(overrides?: {
  authType?: AuthType;
  initialError?: string;
  merged?: Record<string, unknown>;
}) {
  const onClose = vi.fn();
  const notify = vi.fn();
  const config = createMockConfig(overrides?.authType);
  const settings = createMockSettings(overrides?.merged);
  render(
    <OpenTuiAuthDialog
      config={config}
      settings={settings}
      onClose={onClose}
      notify={notify}
      initialError={overrides?.initialError}
    />,
  );
  return { onClose, notify, config };
}

const LOCAL_URL = 'http://127.0.0.1:11434/v1';

/** Drive the dialog through the full five-step wizard to its review. */
async function runWizardToReview(): Promise<{
  onClose: ReturnType<typeof vi.fn>;
  notify: ReturnType<typeof vi.fn>;
}> {
  const { onClose, notify } = renderDialog();
  await typeText(LOCAL_URL);
  await press('return'); // baseUrl → apiKey
  await typeText('sk-test');
  await press('return'); // apiKey → models
  await typeText('model-1, model-2');
  await press('return'); // models → advancedConfig
  await press('return'); // advancedConfig: skip → review
  return { onClose, notify };
}

function resetHarness(): void {
  mocks.state.inputHandlers.length = 0;
  mocks.state.keyboardHandlers.length = 0;
  mocks.state.pasteHandlers.length = 0;
  core.applyProviderInstallPlan.mockReset().mockResolvedValue(undefined);
  core.logAuth.mockReset();
}

describe('OpenTuiAuthDialog (#57 onboarding flow)', () => {
  beforeEach(resetHarness);

  it('opens straight on the local-server base URL step', () => {
    renderDialog();
    expect(
      screen.getByText('Local OpenAI-compatible server · Step 1/5 · Base URL'),
    ).toBeTruthy();
    expect(
      screen.getByText(
        /Enter the base URL of the local OpenAI-compatible server/,
      ),
    ).toBeTruthy();
    expect(
      screen.getByText('The host must be 127.0.0.1, ::1 or localhost.'),
    ).toBeTruthy();
    // No provider list, and no URL offered as a default or placeholder.
    expect(screen.queryByText('Custom Provider')).toBeNull();
    expect(screen.queryByText(/Third-party/)).toBeNull();
    expect(document.body.textContent).not.toMatch(/https?:\/\//);
  });

  it('blocks Esc on the first step while unauthenticated', async () => {
    const { onClose } = renderDialog();
    const consumed = await pressEsc();
    expect(consumed).toBe(true);
    expect(onClose).not.toHaveBeenCalled();
    expect(
      screen.getByText(/You must connect a provider to proceed/),
    ).toBeTruthy();
  });

  it('closes via Esc on the first step when authenticated', async () => {
    const { onClose } = renderDialog({ authType: AuthType.USE_OPENAI });
    await pressEsc();
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('closes via Esc when the error was seeded from boot (R2-1)', async () => {
    // A startup failure seeds the message before mount; the swallow is for
    // errors the dialog arms itself, so Esc must still close.
    const { onClose } = renderDialog({
      authType: AuthType.USE_OPENAI,
      initialError: 'Failed to login',
    });
    await pressEsc();
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('closes via Esc when boot failed before any auth type existed (R2-1)', async () => {
    // With no auth type the unauthenticated arm would overwrite the boot
    // diagnostic with the must-connect message and wedge the dialog shut:
    // Esc must close instead.
    const { onClose } = renderDialog({ initialError: 'Boot failed' });
    const consumed = await pressEsc();
    expect(consumed).toBe(true);
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(screen.queryByText(/You must connect a provider/)).toBeNull();
  });

  it('steps back through the wizard with Esc before leaving it', async () => {
    const { onClose } = renderDialog({ authType: AuthType.USE_OPENAI });
    await typeText(LOCAL_URL);
    await press('return'); // baseUrl → apiKey
    expect(screen.getByText(/Step 2\/5 · API Key/)).toBeTruthy();
    await pressEsc(); // back to the base URL step
    expect(screen.getByText(/Step 1\/5 · Base URL/)).toBeTruthy();
    expect(onClose).not.toHaveBeenCalled();
  });

  it('walks the wizard and submits the install plan', async () => {
    const { onClose, notify } = await runWizardToReview();
    // review: step title reflects the last step before saving
    expect(screen.getByText(/Step 5\/5 · Review/)).toBeTruthy();
    await press('return'); // save

    await vi.waitFor(() => {
      expect(core.applyProviderInstallPlan).toHaveBeenCalledTimes(1);
    });
    expect(core.applyProviderInstallPlan).toHaveBeenCalledWith(
      expect.objectContaining({
        authType: AuthType.USE_OPENAI,
        modelSelection: { modelId: 'model-1', baseUrl: LOCAL_URL },
      }),
      expect.anything(),
    );
    expect(core.logAuth).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ status: 'success' }),
    );
    expect(notify).toHaveBeenCalledWith(
      expect.stringContaining(
        'Successfully configured Local OpenAI-compatible server',
      ),
    );
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('prefills the model IDs already saved for the local server', async () => {
    renderDialog({
      merged: {
        modelProviders: {
          openai: [
            {
              id: 'm1',
              baseUrl: LOCAL_URL,
              envKey: 'QWEN_CUSTOM_API_KEY_X',
            },
          ],
        },
      },
    });
    await typeText(LOCAL_URL);
    await press('return'); // baseUrl → apiKey
    await typeText('sk-test');
    await press('return'); // apiKey → models (prefilled with m1)
    expect(document.body.textContent).toContain('> m1');
  });

  it('surfaces the model-ids error on empty submit (ink modelIdsError parity)', async () => {
    renderDialog();
    await typeText(LOCAL_URL);
    await press('return'); // baseUrl → apiKey
    await typeText('sk-test');
    await press('return'); // apiKey → models
    // The row is composed of several spans (`> ` prefix plus the placeholder's
    // cursor cell), so match the line the step paints rather than one node.
    expect(document.body.textContent).toContain('> model-id-1, model-id-2');
    await press('return'); // empty submit → flow sets modelIdsError
    expect(screen.getByText(/Model IDs cannot be empty/)).toBeTruthy();
    // the error is non-fatal: the step stays mounted
    expect(
      screen.getByText(/Enter model IDs separated by commas/),
    ).toBeTruthy();
  });

  it('keeps the dialog open and shows the error when the plan fails', async () => {
    core.applyProviderInstallPlan.mockRejectedValueOnce(
      new Error('disk on fire'),
    );
    const { onClose, notify } = await runWizardToReview();
    await press('return'); // save → rejects

    await vi.waitFor(() => {
      expect(screen.getByText(/Failed to authenticate/)).toBeTruthy();
    });
    expect(onClose).not.toHaveBeenCalled();
    expect(notify).not.toHaveBeenCalled();
    expect(core.logAuth).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ status: 'error' }),
    );
  });

  it('retries the install from the review step after a failure', async () => {
    core.applyProviderInstallPlan.mockRejectedValueOnce(new Error('401'));
    await runWizardToReview();
    await press('return'); // save → rejects
    await vi.waitFor(() => {
      expect(screen.getByText(/Failed to authenticate/)).toBeTruthy();
    });
    await press('return');
    await vi.waitFor(() => {
      expect(core.applyProviderInstallPlan).toHaveBeenCalledTimes(2);
    });
  });
});

describe('base URL step validation', () => {
  beforeEach(resetHarness);

  it('rejects an empty base URL instead of falling back to a default', async () => {
    renderDialog();
    await press('return');
    expect(
      screen.getByText(/No model server base URL is configured/),
    ).toBeTruthy();
    expect(screen.getByText(/Step 1\/5 · Base URL/)).toBeTruthy();
  });

  it.each(['https://api.openai.com/v1', 'http://192.168.1.5:8000/v1'])(
    'rejects the non-loopback URL %s',
    async (url) => {
      renderDialog();
      await typeText(url);
      await press('return');
      expect(
        screen.getByText(
          /is not allowed: the host must be 127\.0\.0\.1, ::1 or localhost\./,
        ),
      ).toBeTruthy();
      expect(screen.getByText(/Step 1\/5 · Base URL/)).toBeTruthy();
    },
  );

  it.each([
    'http://127.0.0.1:11434/v1',
    'http://localhost:1234/v1',
    'http://[::1]:8000/v1',
  ])('accepts the loopback URL %s', async (url) => {
    renderDialog();
    await typeText(url);
    await press('return');
    expect(screen.getByText(/Step 2\/5 · API Key/)).toBeTruthy();
    expect(screen.queryByText(/is not allowed/)).toBeNull();
  });
});

describe('bracketed-paste into dialog inputs (#57)', () => {
  beforeEach(resetHarness);

  /** Walk the wizard up to the API-key step. */
  async function runToApiKeyStep(): Promise<void> {
    renderDialog();
    await typeText(LOCAL_URL);
    await press('return'); // baseUrl → apiKey
  }

  /** The step titles the wizard walks through from the API key to the review. */
  async function runToReviewStep(): Promise<void> {
    await typeText('sk-test');
    await press('return'); // apiKey → models
    await typeText('test-model');
    await press('return'); // models → advancedConfig
    await press('return'); // advancedConfig → review
  }

  /**
   * A held key repeats out of one stdin read, and so does a bracketed paste's
   * trailing Enter: every keystroke and the Enter that commits them are handled
   * against the render that registered the handler.
   */
  async function typeBatchedThenEnter(text: string): Promise<void> {
    const handler = lastKeyboardHandler();
    await act(async () => {
      for (const char of text) {
        handler(baseKeyEvent({ name: char, sequence: char }));
      }
      handler(baseKeyEvent({ name: 'return', sequence: '\r' }));
    });
  }

  it('keeps every character of a burst that shares one batch', async () => {
    await runToApiKeyStep();
    await typeBatched('sk-burst-key');
    expect(
      screen.getByText((_, element) => element?.textContent === 'sk-burst-key'),
    ).toBeTruthy();
    // the burst is what the wizard carries forward, not its last character
    await press('return'); // apiKey → models
    expect(
      screen.getByText(/Enter model IDs separated by commas/),
    ).toBeTruthy();
  });

  it('submits the burst that shares one batch with its Enter', async () => {
    await runToApiKeyStep();
    await typeBatchedThenEnter('sk-burst-key');
    // Before the fix the Enter read the flow's state, which no render had
    // refreshed yet, and the step refused the key it was showing; the submit now
    // reads the editor's live text, so the burst lands on the models step.
    expect(
      screen.getByText(/Enter model IDs separated by commas/),
    ).toBeTruthy();
  });

  it('carries the URL typed in the same batch as its Enter to the review', async () => {
    renderDialog();
    await typeBatchedThenEnter('http://127.0.0.1:8080/v1');
    // A stale empty URL would be refused, so advancing proves the Enter read
    // the burst rather than the flow's not-yet-rendered state.
    expect(screen.getByText(/Step 2\/5 · API Key/)).toBeTruthy();
    await runToReviewStep();
    expect(screen.getByText(/Step 5\/5 · Review/)).toBeTruthy();
    expect(document.body.textContent).toContain(
      '"baseUrl": "http://127.0.0.1:8080/v1"',
    );
  });

  it('ignores the keystrokes that trail the Enter of the same read', async () => {
    await runToApiKeyStep();
    const build = vi.spyOn(coreRuntime, 'buildInstallPlan');
    try {
      const handler = lastKeyboardHandler();
      await act(async () => {
        for (const char of 'sk-test') {
          handler(baseKeyEvent({ name: char, sequence: char }));
        }
        handler(baseKeyEvent({ name: 'return', sequence: '\r' }));
        // The read is not over: the Enter moved the wizard on, and this key is
        // still dispatched to the step that was on screen when it started.
        handler(baseKeyEvent({ name: 'Z', sequence: 'Z' }));
      });
      await typeText('test-model');
      await press('return'); // models → advancedConfig
      await press('return'); // advancedConfig → review
      await press('return'); // review → save
      // The review step builds the plan again for its preview, so the submit
      // count is the install call; the key it carried must be the burst alone.
      await vi.waitFor(() =>
        expect(core.applyProviderInstallPlan).toHaveBeenCalledTimes(1),
      );
      const keys = build.mock.calls.map((call) => call[1]?.apiKey);
      expect(keys).toContain('sk-test');
      expect(keys).not.toContain('sk-testZ');
    } finally {
      build.mockRestore();
    }
  });

  it('ignores the keystroke that trails the models step Enter', async () => {
    await runToApiKeyStep();
    await typeText('sk-test');
    await press('return'); // apiKey → models
    const build = vi.spyOn(coreRuntime, 'buildInstallPlan');
    try {
      const handler = lastKeyboardHandler();
      await act(async () => {
        for (const char of 'mod') {
          handler(baseKeyEvent({ name: char, sequence: char }));
        }
        handler(baseKeyEvent({ name: 'return', sequence: '\r' }));
        handler(baseKeyEvent({ name: 'Z', sequence: 'Z' }));
      });
      await press('return'); // advancedConfig → review
      await press('return'); // review → save
      await vi.waitFor(() =>
        expect(core.applyProviderInstallPlan).toHaveBeenCalledTimes(1),
      );
      const ids = build.mock.calls.map((call) =>
        JSON.stringify(call[1]?.modelIds),
      );
      expect(ids).toContain('["mod"]');
      expect(ids).not.toContain('["modZ"]');
    } finally {
      build.mockRestore();
    }
  });

  it('ignores the digit that trails the advanced-config step Enter', async () => {
    await runToApiKeyStep();
    await typeText('sk-test');
    await press('return'); // apiKey → models
    await typeText('test-model');
    await press('return'); // models → advancedConfig
    await press('down'); // thinking → modality
    await press('down'); // modality → context window
    const handler = lastKeyboardHandler();
    await act(async () => {
      for (const char of '12') {
        handler(baseKeyEvent({ name: char, sequence: char }));
      }
      handler(baseKeyEvent({ name: 'return', sequence: '\r' }));
      handler(baseKeyEvent({ name: '3', sequence: '3' }));
    });
    // The review step prints what will be saved, and the Enter that left the
    // advanced-config step carried 12. The trailing digit belongs to no step.
    expect(document.body.textContent).toContain('"contextWindowSize": 12');
    expect(document.body.textContent).not.toContain('"contextWindowSize": 123');
  });

  it('ignores the paste that trails the advanced-config step Enter', async () => {
    await runToApiKeyStep();
    await typeText('sk-test');
    await press('return'); // apiKey → models
    await typeText('test-model');
    await press('return'); // models → advancedConfig
    await press('down'); // thinking → modality
    await press('down'); // modality → context window
    const handler = lastKeyboardHandler();
    const pasteHandler = mocks.state.pasteHandlers.at(-1);
    if (!pasteHandler) throw new Error('no paste handler registered');
    await act(async () => {
      for (const char of '12') {
        handler(baseKeyEvent({ name: char, sequence: char }));
      }
      handler(baseKeyEvent({ name: 'return', sequence: '\r' }));
      // One stdin read dispatches its keys and its pastes in order to the same
      // still-registered handlers, with no commit in between, so a paste the
      // terminal buffered while the app was busy lands after the Enter.
      pasteHandler(makePasteEvent('3'));
    });
    expect(document.body.textContent).toContain('"contextWindowSize": 12');
    expect(document.body.textContent).not.toContain('"contextWindowSize": 123');
  });

  it('keeps taking the read after an Enter the step refused', async () => {
    renderDialog();
    const handler = lastKeyboardHandler();
    await act(async () => {
      for (const char of 'abc') {
        handler(baseKeyEvent({ name: char, sequence: char }));
      }
      handler(baseKeyEvent({ name: 'return', sequence: '\r' }));
      // A refused Enter keeps the step mounted, so the read is still this
      // field's: only an Enter that moved the wizard ends it.
      for (const char of 'def') {
        handler(baseKeyEvent({ name: char, sequence: char }));
      }
    });
    expect(
      screen.getByText((_, element) => element?.textContent === 'abcdef'),
    ).toBeTruthy();
    expect(
      screen.getByText(
        /Enter the base URL of the local OpenAI-compatible server/,
      ),
    ).toBeTruthy();
  });

  it('submits a paste that shares its read with the Enter', async () => {
    await runToApiKeyStep();
    await typeText('sk-test');
    await press('return'); // apiKey → models
    const pasteHandler = mocks.state.pasteHandlers.at(-1);
    if (!pasteHandler) throw new Error('no paste handler registered');
    const keyHandler = lastKeyboardHandler();
    await act(async () => {
      pasteHandler(makePasteEvent('pasted-model'));
      keyHandler(baseKeyEvent({ name: 'return', sequence: '\r' }));
    });
    await press('return'); // advancedConfig: skip → review
    expect(document.body.textContent).toContain('"id": "pasted-model"');
  });

  it('inserts a paste into the API-key input and prevents default', async () => {
    await runToApiKeyStep();
    const event = await pasteText('sk-pasted-key');
    expect(event.preventDefault).toHaveBeenCalledTimes(1);
    expect(screen.getByText('sk-pasted-key')).toBeTruthy();
    // the pasted key is what the wizard carries forward, not a lost paste
    await press('return'); // apiKey → models
    expect(
      screen.getByText(/Enter model IDs separated by commas/),
    ).toBeTruthy();
  });

  it('keeps a pasted line break out of the field row', async () => {
    await runToApiKeyStep();
    // Line-ending normalization itself is pinned in line-edit's own tests; this
    // one covers what the wizard draws: only the line the caret sits on, so the
    // other line reaches the screen when the caret crosses the break.
    await pasteText('key-1\r\nkey-2');
    expect(document.body.textContent).toContain('key-2');
    expect(document.body.textContent).not.toContain('key-1');
    await press('a', { ctrl: true, sequence: '\x01' });
    await press('left');
    expect(document.body.textContent).toContain('key-1');
    expect(document.body.textContent).not.toContain('key-2');
  });

  it('appends a paste after typed text in the model-IDs input', async () => {
    await runToApiKeyStep();
    await typeText('sk-test');
    await press('return'); // apiKey → models
    await typeText('typed-');
    const event = await pasteText('pasted-model');
    expect(event.preventDefault).toHaveBeenCalledTimes(1);
    expect(
      screen.getByText(
        (_, element) => element?.textContent === 'typed-pasted-model',
      ),
    ).toBeTruthy();
    await press('return'); // models → advancedConfig
    expect(
      screen.getByText(/Optional: configure advanced generation settings/),
    ).toBeTruthy();
  });

  it('ignores a paste while a toggle row owns the advanced-config focus', async () => {
    await runToApiKeyStep();
    await typeText('sk-test');
    await press('return'); // apiKey → models
    await pasteText('debug-model'); // fill the model-IDs input via paste
    await press('return'); // models → advancedConfig (focus on the first toggle)
    const event = await pasteText('12345');
    // guard bails before consuming: no preventDefault, ctx stays auto
    expect(event.preventDefault).not.toHaveBeenCalled();
    expect(screen.getByText('auto')).toBeTruthy();
    await press('return'); // advancedConfig: skip → review
    expect(screen.getByText(/Step 5\/5 · Review/)).toBeTruthy();
  });
});

describe('caret editing in dialog text fields (#107)', () => {
  beforeEach(resetHarness);

  /** Walk to the advanced-config step with the context-window row focused. */
  async function runToContextWindowRow(): Promise<void> {
    renderDialog();
    await typeText(LOCAL_URL);
    await press('return'); // baseUrl → apiKey
    await typeText('sk-test');
    await press('return'); // apiKey → models
    await typeText('test-model');
    await press('return'); // models → advancedConfig
    await press('down'); // thinking → modality
    await press('down'); // modality → context window (index 2 while it's closed)
  }

  /**
   * The focused field's rendered text and the cell the cursor sits on, read off
   * the cursor cell's neighbours so a row that labels its own field — the
   * context-window row — contributes only the value. Valid while the field holds
   * a value: an empty field puts the cell on its placeholder's first character,
   * which is the row's first text element.
   */
  function focusedField(): { text: string; cell: string } {
    const cell = cursorCell();
    if (!cell) throw new Error('no field renders a cursor cell');
    const at = cell.textContent ?? '';
    return {
      text:
        (cell.previousElementSibling?.textContent ?? '') +
        at +
        (cell.nextElementSibling?.textContent ?? ''),
      cell: at,
    };
  }

  it('inserts at the position the arrows left the caret', async () => {
    renderDialog();
    await typeText('abcdef');
    await press('left');
    await press('left');
    await typeText('X');
    expect(focusedField()).toEqual({ text: 'abcdXef', cell: 'e' });
  });

  it('draws the model-IDs field with its own caret', async () => {
    renderDialog();
    await typeText(LOCAL_URL);
    await press('return'); // baseUrl → apiKey
    await typeText('sk-test');
    await press('return'); // apiKey → models
    await typeText('ab');
    await press('left');
    await typeText('X');
    expect(focusedField()).toEqual({ text: 'aXb', cell: 'b' });
  });

  it('keeps the caret at either end for ctrl+A and ctrl+E', async () => {
    renderDialog();
    await typeText('ab');
    await press('a', { ctrl: true, sequence: '\x01' });
    expect(focusedField()).toEqual({ text: 'ab', cell: 'a' });
    await press('e', { ctrl: true, sequence: '\x05' });
    // past the last code point ink draws a blank cell, which the text keeps
    expect(focusedField()).toEqual({ text: 'ab ', cell: ' ' });
    await typeText('c');
    expect(focusedField()).toEqual({ text: 'abc ', cell: ' ' });
  });

  it('erases backward with backspace and forward with delete', async () => {
    renderDialog();
    await typeText('abcd');
    await press('a', { ctrl: true, sequence: '\x01' });
    await press('backspace');
    // nothing left of the caret, so the value stands
    expect(focusedField()).toEqual({ text: 'abcd', cell: 'a' });
    await press('delete');
    expect(focusedField()).toEqual({ text: 'bcd', cell: 'b' });
  });

  it('erases the word left of the caret with ctrl+W', async () => {
    renderDialog();
    await typeText('http://remote');
    await press('w', { ctrl: true, sequence: '\x17' });
    expect(focusedField()).toEqual({ text: 'http:// ', cell: ' ' });
    // the edited value, not the typed one, is what the step submits
    await typeText('localhost:1234/v1');
    await press('return');
    expect(screen.getByText(/Step 2\/5 · API Key/)).toBeTruthy();
  });

  it('sends ctrl+E to the end of a pasted value and bare End to its own line', async () => {
    renderDialog();
    await pasteText('https://one.test\nhttps://two.test');
    // The paste leaves the caret at the value's end, and ctrl+A is ink's line
    // home, so the row drawn is the second line and the caret opens it.
    await press('a', { ctrl: true, sequence: '\x01' });
    expect(focusedField()).toEqual({ text: 'https://two.test', cell: 'h' });
    // Walk back over the break: the offset just past it belongs to the first
    // line's end, so two lefts park the caret inside that line.
    await press('left');
    await press('left');
    expect(focusedField()).toEqual({ text: 'https://one.test', cell: 't' });
    await press('e', { ctrl: true, sequence: '\x05' });
    await typeText('s');
    // ink's ctrl+E binding is the end of the value, not of the caret's line, so
    // from the first line it crosses the break: the row switches and the
    // character lands on the second line rather than before the break.
    expect(focusedField()).toEqual({ text: 'https://two.tests ', cell: ' ' });
    // The bare key is ink's reducer move, which stops at the line the caret is
    // on. Park the caret inside the first line — ctrl+A after the ctrl+E jump
    // lands on the second line's start — and End takes it to that line's end,
    // so the next character lands before the break rather than at the value's.
    await press('a', { ctrl: true, sequence: '\x01' });
    await press('left');
    await press('left');
    await press('end');
    await typeText('X');
    // The row holds the caret's line and nothing else, so a caret parked on the
    // break shows a blank cell where ink's own row would.
    expect(focusedField()).toEqual({ text: 'https://one.testX ', cell: ' ' });
    // Crossing the break proves the value kept it: the row switches lines, and
    // the second line was never on screen until the caret reached it.
    await press('right');
    expect(focusedField()).toEqual({
      text: 'https://two.tests',
      cell: 'h',
    });
  });

  it('edits the context-window field in place', async () => {
    await runToContextWindowRow();
    await typeText('1234');
    await press('left');
    await press('left');
    await typeText('9');
    expect(focusedField()).toEqual({ text: '12934', cell: '3' });
    // The step's setter keeps digits only, so a letter never reaches the value —
    // and never moves the caret either, so the next digit lands where this one
    // was parked. ink stores the rejected letter in its own buffer instead,
    // which is recorded as a divergence rather than ported.
    await typeText('x');
    expect(focusedField()).toEqual({ text: '12934', cell: '3' });
    await typeText('7');
    expect(focusedField()).toEqual({ text: '129734', cell: '3' });
    await press('return');
    expect(screen.getByText(/Step 5\/5 · Review/)).toBeTruthy();
    expect(document.body.textContent).toContain('"contextWindowSize": 129734');
  });

  /** The text the row owning the context-window field renders. */
  function contextRow(): string {
    const rows = [...document.querySelectorAll('div')].filter((el) =>
      (el.textContent ?? '').includes('Context window'),
    );
    const last = rows[rows.length - 1];
    if (!last) throw new Error('no context-window row rendered');
    return last.textContent ?? '';
  }

  it('prints the whole value of a field that lost the cursor', async () => {
    await runToContextWindowRow();
    await typeText('1234');
    await press('left');
    expect(focusedField()).toEqual({ text: '1234', cell: '4' });
    // ↑ hands the cursor to the toggle row above, as ink's does, and the field
    // keeps printing every character: the highlight marks which row the caret is
    // in, it is not part of the value.
    await press('up');
    expect(contextRow()).toMatch(/Context window: 1234$/);
    await press('down');
    expect(focusedField()).toEqual({ text: '1234', cell: '4' });
  });

  it('keeps the caret a late install verdict finds parked in an earlier field', async () => {
    // The install is async, so its verdict can land after the user has Esc'd back
    // to a field that never submitted. The failure must not re-seed that field
    // and throw the parked caret away, or the next Backspace deletes a
    // character the user did not mean to.
    let rejectInstall: (error: Error) => void = () => {};
    core.applyProviderInstallPlan.mockImplementationOnce(
      () =>
        new Promise<void>((_, reject) => {
          rejectInstall = reject;
        }),
    );
    await runWizardToReview();
    await press('return'); // review: fires the install, which stays in flight
    await pressEsc(); // back to the advanced-config step
    await pressEsc(); // back to the model-IDs step
    await press('left');
    await press('left');
    expect(focusedField()).toEqual({ text: 'model-1, model-2', cell: '-' });
    await act(async () => {
      rejectInstall(new Error('401'));
    });
    await vi.waitFor(() => {
      expect(screen.getByText(/Failed to authenticate/)).toBeTruthy();
    });
    expect(focusedField()).toEqual({ text: 'model-1, model-2', cell: '-' });
    await press('backspace');
    expect(focusedField()).toEqual({ text: 'model-1, mode-2', cell: '-' });
  });

  it('draws no bidi override out of a field a paste put one in', async () => {
    // stripUnsafeCharacters keeps U+202E, so a bracketed paste can park a
    // RIGHT-TO-LEFT OVERRIDE in a field's value. The value holds every code
    // point; the cell the caret sits on must not emit one raw and rewrite the
    // direction of the row the user is reading.
    renderDialog();
    await pasteText('ab\u202ecd');
    await press('left');
    await press('left');
    await press('left');
    expect(focusedField()).toEqual({ text: 'ab cd', cell: ' ' });
    expect(document.body.textContent).not.toContain('\u202e');
  });
});
