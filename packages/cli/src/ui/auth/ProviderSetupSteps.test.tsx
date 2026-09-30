/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { renderWithProviders } from '../../test-utils/render.js';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { customProvider } from '@qwen-code/qwen-code-core';
import type { ProviderConfig } from '@qwen-code/qwen-code-core';
import type { KeypressHandler, Key } from '../contexts/KeypressContext.js';
import { useKeypress } from '../hooks/useKeypress.js';
import { ProviderSetupSteps } from './ProviderSetupSteps.js';
import {
  useProviderSetupFlow,
  type ProviderSetupFlow,
  type ProviderSetupState,
} from './useProviderSetupFlow.js';

type UseKeypressMockOptions = { isActive: boolean };

const discoverProviderModelsMock = vi.hoisted(() => vi.fn());

vi.mock('@qwen-code/qwen-code-core', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@qwen-code/qwen-code-core')>()),
  discoverProviderModels: discoverProviderModelsMock,
}));
vi.mock('../hooks/useKeypress.js');

let activeKeypressHandlers: KeypressHandler[] = [];

const LOCAL_BASE_URL = 'http://127.0.0.1:11434/v1';

describe('ProviderSetupSteps', () => {
  beforeEach(() => {
    activeKeypressHandlers = [];
    discoverProviderModelsMock.mockReset();
    vi.mocked(useKeypress).mockImplementation(
      (handler: KeypressHandler, options?: UseKeypressMockOptions) => {
        if (options?.isActive) {
          activeKeypressHandlers.push(handler);
        }
      },
    );
  });

  const keyEvent = (
    name: string,
    sequence: string,
    overrides: Partial<Key>,
  ): Key => ({
    name,
    sequence,
    ctrl: false,
    meta: false,
    shift: false,
    paste: false,
    ...overrides,
  });

  const pressKey = (
    name: string,
    sequence: string = name,
    overrides: Partial<Key> = {},
  ) => {
    if (activeKeypressHandlers.length === 0) {
      throw new Error(`No active keypress handler for ${name}`);
    }
    for (const handler of activeKeypressHandlers) {
      handler(keyEvent(name, sequence, overrides));
    }
  };

  const pressLatestKey = (
    name: string,
    sequence: string = name,
    overrides: Partial<Key> = {},
  ) => {
    const handler = activeKeypressHandlers.at(-1);
    if (!handler) {
      throw new Error(`No active keypress handler for ${name}`);
    }
    handler(keyEvent(name, sequence, overrides));
  };

  const createFlow = (
    state: Partial<ProviderSetupState>,
    actions: Partial<ProviderSetupFlow> = {},
  ): ProviderSetupFlow => {
    const noop = vi.fn();
    return {
      state: {
        provider: customProvider,
        step: 'models',
        stepIndex: 1,
        totalSteps: 5,
        baseUrl: LOCAL_BASE_URL,
        baseUrlError: null,
        apiKey: 'secret-key',
        apiKeyError: null,
        modelIds: '',
        modelIdsError: null,
        thinkingEnabled: false,
        modalityEnabled: false,
        modalityImage: true,
        modalityVideo: true,
        modalityAudio: false,
        modalityPdf: false,
        contextWindowSize: '',
        focusedConfigIndex: 0,
        previewJson: '',
        ...state,
      },
      start: noop,
      reset: noop,
      goBack: noop,
      submitBaseUrl: noop,
      changeBaseUrl: noop,
      changeApiKey: noop,
      submitApiKey: noop,
      changeModelIds: vi.fn(),
      clearModelIdsError: vi.fn(),
      submitModelIds: vi.fn(),
      moveAdvancedFocusUp: vi.fn(),
      moveAdvancedFocusDown: vi.fn(),
      toggleFocusedAdvancedOption: noop,
      changeContextWindowSize: noop,
      submitAdvancedConfig: noop,
      submit: noop,
      ...actions,
    } as unknown as ProviderSetupFlow;
  };

  const manualProvider: ProviderConfig = {
    ...customProvider,
    supportsModelDiscovery: false,
  };

  let realFlow: ProviderSetupFlow | undefined;
  const RealFlowHarness = () => {
    const flow = useProviderSetupFlow(async () => {});
    realFlow = flow;
    return <ProviderSetupSteps flow={flow} />;
  };

  describe('base URL step', () => {
    const renderBaseUrlStep = async () => {
      const view = renderWithProviders(<RealFlowHarness />);
      await act(async () => {
        realFlow?.start(customProvider);
      });
      return view;
    };

    it('asks for a loopback server without offering a default URL', async () => {
      const { lastFrame, unmount } = await renderBaseUrlStep();

      const frame = lastFrame() ?? '';
      expect(frame).toContain(
        'Enter the base URL of the local OpenAI-compatible server.',
      );
      expect(frame).toContain('The host must be 127.0.0.1, ::1 or localhost.');
      expect(frame).not.toMatch(/https?:\/\//);
      expect(frame).not.toContain('Documentation');
      expect(realFlow?.state.baseUrl).toBe('');
      unmount();
    });

    it.each([
      ['', 'No model server base URL is configured'],
      ['https://api.openai.com/v1', 'is not allowed'],
      ['http://192.168.1.5:8000/v1', 'is not allowed'],
    ])('shows an inline error for %j', async (url, message) => {
      const { lastFrame, unmount } = await renderBaseUrlStep();

      await act(async () => {
        realFlow?.submitBaseUrl(url);
      });

      expect(lastFrame()).toContain(message);
      expect(realFlow?.state.step).toBe('baseUrl');
      unmount();
    });

    it.each(['http://127.0.0.1:11434/v1', 'http://localhost:1234/v1'])(
      'moves on to the API key for %s',
      async (url) => {
        const { lastFrame, unmount } = await renderBaseUrlStep();

        await act(async () => {
          realFlow?.submitBaseUrl(url);
        });

        expect(realFlow?.state.step).toBe('apiKey');
        expect(realFlow?.state.baseUrl).toBe(url);
        expect(lastFrame()).not.toContain('is not allowed');
        unmount();
      },
    );
  });

  it('maps Ctrl+P/N to advanced-config focus navigation', () => {
    const flow = createFlow({ step: 'advancedConfig' });

    const { unmount } = renderWithProviders(<ProviderSetupSteps flow={flow} />);

    pressKey('p', '\u0010', { ctrl: true });
    pressKey('n', '\u000E', { ctrl: true });

    expect(flow.moveAdvancedFocusUp).toHaveBeenCalledTimes(1);
    expect(flow.moveAdvancedFocusDown).toHaveBeenCalledTimes(1);
    unmount();
  });

  it('uses manual model entry when the provider has no discovery', () => {
    const submitModelIds = vi.fn();
    const flow = createFlow(
      { provider: manualProvider, modelIds: 'model-a, model-b' },
      { submitModelIds },
    );

    const { lastFrame, unmount } = renderWithProviders(
      <ProviderSetupSteps flow={flow} />,
    );

    const frame = lastFrame() ?? '';
    expect(frame).toContain('Enter model IDs separated by commas');
    expect(frame).toContain('model-a, model-b');
    expect(discoverProviderModelsMock).not.toHaveBeenCalled();

    pressLatestKey('return', '\r');

    expect(submitModelIds).toHaveBeenCalledTimes(1);
    unmount();
  });

  it('does not mount the model editor before discovery settles', () => {
    discoverProviderModelsMock.mockReturnValue(new Promise(() => {}));
    const flow = createFlow({});

    const { lastFrame, unmount } = renderWithProviders(
      <ProviderSetupSteps flow={flow} />,
    );

    const frame = lastFrame() ?? '';
    expect(frame).toContain('Loading models from provider…');
    expect(frame).toContain('Esc to go back');
    expect(frame).not.toContain('Enter model IDs directly');
    expect(discoverProviderModelsMock).toHaveBeenCalledWith({
      baseUrl: LOCAL_BASE_URL,
      apiKey: 'secret-key',
      staticModels: [],
      signal: expect.any(AbortSignal),
    });
    unmount();
  });

  it('lists the served models with saved ids kept in the free-form input', async () => {
    discoverProviderModelsMock.mockResolvedValue([
      {
        id: 'served-a',
        contextWindowSize: 1000000,
        modalities: { image: true, video: true },
      },
      { id: 'served-b', contextWindowSize: 204800 },
    ]);
    const flow = createFlow({ modelIds: 'saved-model' });

    const { lastFrame, unmount } = renderWithProviders(
      <ProviderSetupSteps flow={flow} />,
    );
    await act(async () => {});

    const frame = lastFrame() ?? '';
    expect(frame).toContain('Enter model IDs directly');
    expect(frame).toContain('Models · from the provider · 0 checked');
    expect(frame).toContain(
      'Checked models are applied on submit but not copied into the input.',
    );
    expect(frame).toContain('1,000,000 tokens, text/image/video');
    expect(frame).toContain('204,800 tokens, text');
    expect(frame).toMatch(/○︎\s+served-a/);
    expect(frame).toMatch(/○︎\s+served-b/);
    const inputLine = frame
      .split('\n')
      .find((line) => line.includes('saved-model'));
    expect(inputLine).toBeDefined();
    expect(frame).toContain(
      '↑↓/Tab to switch input, search, and models, Space to toggle models',
    );
    unmount();
  });

  it('filters served models by the search query', async () => {
    discoverProviderModelsMock.mockResolvedValue([
      { id: 'qwen3-coder' },
      { id: 'llama3' },
    ]);
    const flow = createFlow({});

    const { lastFrame, unmount } = renderWithProviders(
      <ProviderSetupSteps flow={flow} />,
    );
    await act(async () => {});

    await act(async () => {
      pressLatestKey('down');
    });
    await act(async () => {
      pressLatestKey('q', 'q');
    });

    const frame = lastFrame() ?? '';
    expect(frame).toContain('qwen3-coder');
    expect(frame).not.toContain('llama3');

    await act(async () => {
      pressLatestKey('z', 'z');
    });
    expect(lastFrame()).toContain('No models match.');
    unmount();
  });

  it('submits checked served models ahead of typed ids', async () => {
    discoverProviderModelsMock.mockResolvedValue([
      { id: 'served-a' },
      { id: 'served-b' },
    ]);
    const submitModelIds = vi.fn();
    const flow = createFlow(
      { modelIds: 'typed-model, served-b' },
      { submitModelIds },
    );

    const { lastFrame, unmount } = renderWithProviders(
      <ProviderSetupSteps flow={flow} />,
    );
    await act(async () => {});

    // Input → search → first model → second model, then toggle it.
    await act(async () => {
      pressLatestKey('down');
    });
    await act(async () => {
      pressLatestKey('down');
    });
    await act(async () => {
      pressLatestKey('down');
    });
    await act(async () => {
      pressLatestKey('space', ' ');
    });

    expect(lastFrame()).toMatch(/◉︎\s+served-b/);
    expect(lastFrame()).toContain('Models · from the provider · 1 checked');
    expect(flow.changeModelIds).not.toHaveBeenCalled();

    pressKey('return', '\r');
    expect(submitModelIds).toHaveBeenCalledWith({
      modelIds: ['served-b', 'typed-model'],
    });
    unmount();
  });

  it('falls back to manual entry when the model list is unavailable', async () => {
    discoverProviderModelsMock.mockResolvedValue(null);
    const flow = createFlow({ modelIds: 'saved-model' });

    const { lastFrame, unmount } = renderWithProviders(
      <ProviderSetupSteps flow={flow} />,
    );
    await act(async () => {});

    const frame = lastFrame() ?? '';
    expect(frame).toContain('Enter model IDs separated by commas');
    expect(frame).toContain('saved-model');
    expect(frame).not.toContain('Models · from the provider');
    unmount();
  });

  it('cancels a pending discovery when the step unmounts', () => {
    discoverProviderModelsMock.mockReturnValue(new Promise(() => {}));
    const flow = createFlow({});
    const { unmount } = renderWithProviders(<ProviderSetupSteps flow={flow} />);
    const signal = discoverProviderModelsMock.mock.calls[0]?.[0]
      .signal as AbortSignal;

    unmount();

    expect(signal.aborted).toBe(true);
  });

  it('clears the model-ids error on edit after an empty discovery submit', async () => {
    discoverProviderModelsMock.mockResolvedValue([{ id: 'served-model' }]);

    const { lastFrame, unmount } = renderWithProviders(<RealFlowHarness />);

    await act(async () => {
      realFlow?.start(customProvider);
    });
    await act(async () => {
      realFlow?.submitBaseUrl(LOCAL_BASE_URL);
    });
    await act(async () => {
      realFlow?.submitApiKey('sk-discovery');
    });
    await act(async () => {});

    expect(lastFrame()).toContain('Enter model IDs directly');

    await act(async () => {
      pressLatestKey('return', '\r');
    });
    expect(lastFrame()).toContain('Model IDs cannot be empty.');

    await act(async () => {
      pressLatestKey('x', 'x');
    });
    expect(lastFrame()).not.toContain('Model IDs cannot be empty.');

    unmount();
  });
});
