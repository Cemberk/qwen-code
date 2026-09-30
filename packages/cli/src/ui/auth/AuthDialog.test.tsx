/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { setTimeout as settleInput } from 'node:timers/promises';
import { AuthDialog } from './AuthDialog.js';
import { LoadedSettings } from '../../config/settings.js';
import type { Settings } from '../../config/settingsSchema.js';
import type { Config } from '@qwen-code/qwen-code-core';
import { AuthType } from '@qwen-code/qwen-code-core';
import { renderWithProviders } from '../../test-utils/render.js';
import { UIStateContext } from '../contexts/UIStateContext.js';
import { UIActionsContext } from '../contexts/UIActionsContext.js';
import type { UIState } from '../contexts/UIStateContext.js';
import type { UIActions } from '../contexts/UIActionsContext.js';

const discoverProviderModelsMock = vi.hoisted(() =>
  vi.fn().mockResolvedValue(null),
);

vi.mock('@qwen-code/qwen-code-core', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@qwen-code/qwen-code-core')>()),
  discoverProviderModels: discoverProviderModelsMock,
}));

const TITLE = 'Local OpenAI-compatible server';
const LOCAL_BASE_URL = 'http://127.0.0.1:11434/v1';

const createMockUIState = (authError: string | null = null): UIState =>
  ({
    auth: {
      authError,
      isAuthDialogOpen: true,
      isAuthenticating: false,
    },
  }) as UIState;

const createMockUIActions = (
  overrides: Partial<UIActions['auth']> = {},
): UIActions =>
  ({
    auth: {
      closeAuthDialog: vi.fn(),
      handleProviderSubmit: vi.fn().mockResolvedValue(undefined),
      onAuthError: vi.fn(),
      openAuthDialog: vi.fn(),
      ...overrides,
    },
    handleRetryLastPrompt: vi.fn(),
  }) as unknown as UIActions;

const createSettings = (userSettings: Settings = {}): LoadedSettings => {
  const empty = { ui: { customThemes: {} }, mcpServers: {} } as Settings;
  const user = { ...empty, ...userSettings };
  return new LoadedSettings(
    { settings: empty, originalSettings: empty, path: '' },
    { settings: {}, originalSettings: {}, path: '' },
    { settings: user, originalSettings: user, path: '' },
    { settings: empty, originalSettings: empty, path: '' },
    true,
    new Set(),
  );
};

const renderAuthDialog = ({
  settings = createSettings(),
  authError = null,
  actions = {},
  configAuthType,
}: {
  settings?: LoadedSettings;
  authError?: string | null;
  actions?: Partial<UIActions['auth']>;
  configAuthType?: AuthType;
} = {}) => {
  const uiActions = createMockUIActions(actions);
  const mockConfig = {
    getAuthType: vi.fn(() => configAuthType),
    getContentGeneratorConfig: vi.fn(() => ({})),
  } as unknown as Config;

  const view = renderWithProviders(
    <UIStateContext.Provider value={createMockUIState(authError)}>
      <UIActionsContext.Provider value={uiActions}>
        <AuthDialog />
      </UIActionsContext.Provider>
    </UIStateContext.Provider>,
    { settings, config: mockConfig },
  );
  return { ...view, uiActions };
};

const WAIT_FOR_TIMEOUT = 5000;

/**
 * Type text into the terminal one character at a time.
 * Works around a Node 24.x + ink compatibility issue on Windows
 * where bulk stdin.write() may not propagate to TextInput correctly.
 */
const typeText = async (
  stdin: { write: (s: string) => void },
  text: string,
) => {
  const delay = (ms = 5) => new Promise((resolve) => setTimeout(resolve, ms));
  await settleInput(150);
  for (const char of text) {
    stdin.write(char);
    await delay(5);
  }
  await delay(30);
};

const waitForText = async (
  lastFrame: () => string | undefined,
  expectedText: string,
) => {
  await vi.waitFor(
    () => {
      expect(lastFrame()).toContain(expectedText);
    },
    { timeout: WAIT_FOR_TIMEOUT },
  );
};

const pressEnterAndWaitFor = async (
  stdin: { write: (s: string) => void },
  lastFrame: () => string | undefined,
  expectedText: string,
) => {
  await settleInput(150);
  stdin.write('\r');
  await waitForText(lastFrame, expectedText);
  await settleInput(150);
};

const stepTitle = (step: number, label: string) =>
  `${TITLE} · Step ${step}/5 · ${label}`;

const navigateToModelIds = async (
  stdin: { write: (s: string) => void },
  lastFrame: () => string | undefined,
  apiKey = 'sk-test',
) => {
  await waitForText(lastFrame, stepTitle(1, 'Base URL'));
  await typeText(stdin, LOCAL_BASE_URL);
  await pressEnterAndWaitFor(stdin, lastFrame, stepTitle(2, 'API Key'));
  await typeText(stdin, apiKey);
  await pressEnterAndWaitFor(stdin, lastFrame, stepTitle(3, 'Model IDs'));
};

const navigateToAdvancedConfig = async (
  stdin: { write: (s: string) => void },
  lastFrame: () => string | undefined,
  modelIds = 'model-1,model-2',
) => {
  await navigateToModelIds(stdin, lastFrame);
  await waitForText(lastFrame, 'Enter model IDs separated by commas');
  await typeText(stdin, modelIds);
  await pressEnterAndWaitFor(stdin, lastFrame, stepTitle(4, 'Advanced Config'));
};

// TUI input simulation tests use stdin.write() to drive multi-step flows. On
// slower CI runners the timing between simulated key presses and React
// re-renders is unreliable, so they are skipped there.
const isUnreliableTuiInputEnvironment =
  process.platform === 'win32' || process.env['CI'] === 'true';
const itWhenTuiInputReliable = isUnreliableTuiInputEnvironment ? it.skip : it;

describe('AuthDialog', { timeout: 15000 }, () => {
  const wait = (ms = 50) => new Promise((resolve) => setTimeout(resolve, ms));

  beforeEach(() => {
    vi.clearAllMocks();
    discoverProviderModelsMock.mockResolvedValue(null);
  });

  it('shows the auth error from the UI state', () => {
    const { lastFrame } = renderAuthDialog({
      authError: 'No model server base URL is configured.',
    });

    expect(lastFrame()).toContain('No model server base URL is configured.');
  });

  it('opens directly on the local server base URL step', async () => {
    const { lastFrame, unmount } = renderAuthDialog();

    await waitForText(lastFrame, stepTitle(1, 'Base URL'));
    const frame = lastFrame() ?? '';
    expect(frame).toContain('The host must be 127.0.0.1, ::1 or localhost.');
    expect(frame).not.toContain('Alibaba');
    expect(frame).not.toContain('Third-party');
    expect(frame).not.toContain('Custom Provider');
    expect(frame).not.toContain('Terms of Services');
    expect(frame).not.toMatch(/https?:\/\//);
    unmount();
  });

  itWhenTuiInputReliable(
    'prevents exiting while no provider is connected',
    async () => {
      const closeAuthDialog = vi.fn();
      const { lastFrame, stdin, unmount } = renderAuthDialog({
        actions: { closeAuthDialog },
      });
      await waitForText(lastFrame, stepTitle(1, 'Base URL'));
      await settleInput(150);

      stdin.write('\u001b');

      await vi.waitFor(
        () => {
          const frame = lastFrame();
          expect(frame).toContain('You must connect a provider to proceed');
          expect(frame).toContain('Press Ctrl+C again to exit');
        },
        { timeout: WAIT_FOR_TIMEOUT },
      );
      expect(closeAuthDialog).not.toHaveBeenCalled();
      unmount();
    },
  );

  itWhenTuiInputReliable(
    'closes on Escape when a provider is already connected',
    async () => {
      const closeAuthDialog = vi.fn();
      const { lastFrame, stdin, unmount } = renderAuthDialog({
        actions: { closeAuthDialog },
        configAuthType: AuthType.USE_OPENAI,
      });
      await waitForText(lastFrame, stepTitle(1, 'Base URL'));
      await settleInput(150);

      stdin.write('\u001b');
      await wait();

      await vi.waitFor(() => expect(closeAuthDialog).toHaveBeenCalled(), {
        timeout: WAIT_FOR_TIMEOUT,
      });
      unmount();
    },
  );

  itWhenTuiInputReliable(
    'keeps a non-loopback base URL on the base URL step',
    async () => {
      const { lastFrame, stdin, unmount } = renderAuthDialog();
      await waitForText(lastFrame, stepTitle(1, 'Base URL'));

      await typeText(stdin, 'https://api.openai.com/v1');
      await pressEnterAndWaitFor(stdin, lastFrame, 'is not allowed');

      expect(lastFrame()).toContain(stepTitle(1, 'Base URL'));
      unmount();
    },
  );

  itWhenTuiInputReliable('shows an error for an empty base URL', async () => {
    const { lastFrame, stdin, unmount } = renderAuthDialog();
    await waitForText(lastFrame, stepTitle(1, 'Base URL'));

    await pressEnterAndWaitFor(
      stdin,
      lastFrame,
      'No model server base URL is configured',
    );

    expect(lastFrame()).toContain(stepTitle(1, 'Base URL'));
    unmount();
  });

  itWhenTuiInputReliable(
    'goes back from the API key step to the base URL step',
    async () => {
      const { lastFrame, stdin, unmount } = renderAuthDialog();
      await waitForText(lastFrame, stepTitle(1, 'Base URL'));
      await typeText(stdin, LOCAL_BASE_URL);
      await pressEnterAndWaitFor(stdin, lastFrame, stepTitle(2, 'API Key'));

      stdin.write('\u001b');

      await waitForText(lastFrame, stepTitle(1, 'Base URL'));
      unmount();
    },
  );

  itWhenTuiInputReliable(
    'pre-fills the Model IDs step with previously saved model IDs',
    async () => {
      const settings = createSettings({
        modelProviders: {
          openai: [
            {
              id: 'my-saved-model',
              baseUrl: LOCAL_BASE_URL,
              envKey: 'QWEN_CUSTOM_API_KEY_OPENAI_SAVED',
            },
          ],
        },
      } as unknown as Settings);
      const { lastFrame, stdin, unmount } = renderAuthDialog({ settings });

      await navigateToModelIds(stdin, lastFrame);
      await waitForText(lastFrame, 'Enter model IDs separated by commas');
      expect(lastFrame()).toContain('my-saved-model');
      unmount();
    },
  );

  itWhenTuiInputReliable(
    'shows review JSON and submits the local server setup',
    async () => {
      const handleProviderSubmit = vi.fn().mockResolvedValue(undefined);
      const { lastFrame, stdin, unmount } = renderAuthDialog({
        actions: { handleProviderSubmit },
      });

      await navigateToAdvancedConfig(stdin, lastFrame, 'model-1,model-2');
      expect(lastFrame()).toContain(
        'Optional: configure advanced generation settings',
      );
      await pressEnterAndWaitFor(stdin, lastFrame, stepTitle(5, 'Review'));

      const frame = lastFrame() ?? '';
      expect(frame).toContain('The following JSON will be saved');
      expect(frame).toContain('QWEN_CUSTOM_API_KEY_');
      expect(frame).toContain('model-1');
      expect(frame).toContain(LOCAL_BASE_URL);
      expect(frame).toContain('Enter to save');

      stdin.write('\r');

      await vi.waitFor(
        () => {
          expect(handleProviderSubmit).toHaveBeenCalledWith(
            expect.objectContaining({ id: 'custom-openai-compatible' }),
            {
              baseUrl: LOCAL_BASE_URL,
              apiKey: 'sk-test',
              modelIds: ['model-1', 'model-2'],
              advancedConfig: undefined,
            },
          );
        },
        { timeout: WAIT_FOR_TIMEOUT },
      );
      unmount();
    },
  );

  itWhenTuiInputReliable(
    'passes generationConfig when advanced options are toggled',
    async () => {
      const handleProviderSubmit = vi.fn().mockResolvedValue(undefined);
      const { lastFrame, stdin, unmount } = renderAuthDialog({
        actions: { handleProviderSubmit },
      });

      await navigateToAdvancedConfig(stdin, lastFrame, 'model-1');

      // Toggle thinking (initially focused), then modality.
      stdin.write(' ');
      await wait();
      stdin.write('\u001b[B');
      await wait();
      stdin.write(' ');
      await wait();

      stdin.write('\r');
      await wait();

      await vi.waitFor(
        () => {
          const frame = lastFrame();
          expect(frame).toContain('"generationConfig"');
          expect(frame).toContain('"enable_thinking"');
          expect(frame).toContain('"image": true');
          expect(frame).toContain('"video": true');
          expect(frame).not.toContain('"audio"');
        },
        { timeout: WAIT_FOR_TIMEOUT },
      );

      stdin.write('\r');
      await wait();

      await vi.waitFor(
        () => {
          expect(handleProviderSubmit).toHaveBeenCalledWith(
            expect.objectContaining({ id: 'custom-openai-compatible' }),
            expect.objectContaining({
              advancedConfig: {
                enableThinking: true,
                multimodal: { image: true, video: true },
              },
            }),
          );
        },
        { timeout: WAIT_FOR_TIMEOUT },
      );
      unmount();
    },
  );
});
