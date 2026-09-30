/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */
// @vitest-environment jsdom

import { render, cleanup, act } from '@testing-library/react';
import process from 'node:process';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ModelDialog, encodeAuxModelSelector } from './ModelDialog.js';
import { useKeypress } from '../hooks/useKeypress.js';
import { DescriptiveRadioButtonSelect } from './shared/DescriptiveRadioButtonSelect.js';
import { ConfigContext } from '../contexts/ConfigContext.js';
import { SettingsContext } from '../contexts/SettingsContext.js';
import { UIStateContext, type UIState } from '../contexts/UIStateContext.js';
import type { Config } from '@qwen-code/qwen-code-core';
import { AuthType } from '@qwen-code/qwen-code-core';
import type { LoadedSettings } from '../../config/settings.js';
import { SettingScope } from '../../config/settings.js';

vi.mock('../hooks/useKeypress.js', () => ({
  useKeypress: vi.fn(),
}));
const mockedUseKeypress = vi.mocked(useKeypress);

vi.mock('./shared/DescriptiveRadioButtonSelect.js', () => ({
  DescriptiveRadioButtonSelect: vi.fn(() => null),
}));

const LOCAL_BASE_URL = 'http://127.0.0.1:11434/v1';
const OTHER_LOCAL_BASE_URL = 'http://localhost:1234/v1';
const DEFAULT_MODEL_ID = 'qwen3-coder';

// The single model the default mock config exposes.
const createDefaultModels = () => [
  {
    id: DEFAULT_MODEL_ID,
    label: DEFAULT_MODEL_ID,
    description: 'Local coder model',
    authType: AuthType.USE_OPENAI,
    baseUrl: LOCAL_BASE_URL,
  },
];
const DEFAULT_MODEL_KEY = `${AuthType.USE_OPENAI}::${DEFAULT_MODEL_ID}\0${LOCAL_BASE_URL}`;
const mockedSelect = vi.mocked(DescriptiveRadioButtonSelect);

const renderComponent = (
  props: Partial<React.ComponentProps<typeof ModelDialog>> = {},
  contextValue: Partial<Config> | undefined = undefined,
  settingsValue: Partial<LoadedSettings> | undefined = undefined,
) => {
  const defaultProps = {
    onClose: vi.fn(),
  };
  const combinedProps = { ...defaultProps, ...props };

  const mockSettings = {
    isTrusted: true,
    user: { settings: {} },
    workspace: { settings: {} },
    setValue: vi.fn(),
    ...(settingsValue ?? {}),
  } as unknown as LoadedSettings;

  const recordSlashCommand = vi.fn();

  const mockConfig = {
    // --- Functions used by ModelDialog ---
    getModel: vi.fn(() => DEFAULT_MODEL_ID),
    setModel: vi.fn().mockResolvedValue(undefined),
    switchModel: vi.fn().mockResolvedValue(undefined),
    getAuthType: vi.fn(() => AuthType.USE_OPENAI),
    getAllConfiguredModels: vi.fn(createDefaultModels),
    getModelsConfig: vi.fn(() => ({
      getGenerationConfig: vi.fn(() => ({ baseUrl: LOCAL_BASE_URL })),
    })),
    getActiveRuntimeModelSnapshot: vi.fn(() => undefined),
    getAdvisorModel: vi.fn(() => undefined),
    setAdvisorModel: vi.fn().mockResolvedValue(undefined),
    getChatRecordingService: vi.fn(() => ({ recordSlashCommand })),

    // --- Functions used by ClearcutLogger ---
    getUsageStatisticsEnabled: vi.fn(() => true),
    getSessionId: vi.fn(() => 'mock-session-id'),
    getDebugMode: vi.fn(() => false),
    getContentGeneratorConfig: vi.fn(() => ({
      authType: AuthType.USE_OPENAI,
      model: DEFAULT_MODEL_ID,
      baseUrl: LOCAL_BASE_URL,
    })),
    getUseModelRouter: vi.fn(() => false),

    // --- Spread test-specific overrides ---
    ...(contextValue ?? {}),
  } as unknown as Config;

  // ModelDialog only reads historyManager off the UI state; mock just that so
  // selection notices (e.g. the non-image-capable vision warning) are assertable.
  const mockHistoryManager = {
    addItem: vi.fn(),
  } as unknown as UIState['historyManager'];

  const renderResult = render(
    <SettingsContext.Provider value={mockSettings}>
      <ConfigContext.Provider value={mockConfig}>
        <UIStateContext.Provider
          value={{ historyManager: mockHistoryManager } as unknown as UIState}
        >
          <ModelDialog {...combinedProps} />
        </UIStateContext.Provider>
      </ConfigContext.Provider>
    </SettingsContext.Provider>,
  );

  return {
    ...renderResult,
    props: combinedProps,
    mockConfig,
    mockSettings,
    mockHistoryManager,
    recordSlashCommand,
  };
};

describe('<ModelDialog />', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Ensure env-based fallback models don't leak into this suite from the developer environment.
    delete process.env['OPENAI_MODEL'];
  });

  afterEach(() => {
    cleanup();
  });

  it('renders the title', () => {
    const { getByText } = renderComponent();
    expect(getByText('Select Model')).toBeDefined();
  });

  it('passes all model options to DescriptiveRadioButtonSelect', () => {
    renderComponent();
    expect(mockedSelect).toHaveBeenCalledTimes(1);

    const props = mockedSelect.mock.calls[0][0];
    expect(props.items).toHaveLength(1);
    expect(props.items[0].value).toBe(DEFAULT_MODEL_KEY);
    expect(props.showNumbers).toBe(true);
  });

  it('can turn Advisor off when no models are available', async () => {
    const { mockSettings, mockConfig, props } = renderComponent(
      { isAdvisorModelMode: true },
      {
        getAuthType: () => AuthType.USE_OPENAI,
        getAdvisorModel: () => 'unavailable-advisor',
        getAllConfiguredModels: () => [],
      },
    );
    const select = mockedSelect.mock.calls[0][0];
    expect(select.items.map(({ value }) => value)).toEqual(['$advisor-off']);
    await act(async () => {
      await select.onSelect('$advisor-off');
    });
    expect(mockConfig.setAdvisorModel).toHaveBeenCalledWith(undefined);
    expect(mockSettings.setValue).toHaveBeenCalledWith(
      SettingScope.User,
      'advisorModel',
      '',
    );
    expect(mockConfig.switchModel).not.toHaveBeenCalled();
    expect(props.onClose).toHaveBeenCalled();
  });

  it('persists and highlights the selected Advisor registry endpoint', async () => {
    const endpoint = LOCAL_BASE_URL;
    const selector = `openai:advisor\0${endpoint}`;
    const { mockSettings, mockConfig } = renderComponent(
      { isAdvisorModelMode: true },
      {
        getAuthType: () => AuthType.USE_OPENAI,
        getAdvisorModel: () => selector,
        getAllConfiguredModels: () => [
          {
            id: 'advisor',
            label: 'Default endpoint',
            authType: AuthType.USE_OPENAI,
            baseUrl: endpoint,
          },
          {
            id: 'advisor',
            label: 'Explicit endpoint',
            authType: AuthType.USE_OPENAI,
            baseUrl: endpoint,
            registryBaseUrl: endpoint,
          },
        ],
      },
    );
    const select = mockedSelect.mock.calls[0][0];
    const selectedKey = `openai::advisor\0${endpoint}`;
    expect(select.items.map(({ value }) => value)).toEqual([
      '$advisor-off',
      'openai::advisor',
      selectedKey,
    ]);
    expect(select.initialIndex).toBe(2);
    await act(async () => {
      await select.onSelect(selectedKey);
    });
    expect(mockConfig.setAdvisorModel).toHaveBeenCalledWith(selector);
    expect(mockSettings.setValue).toHaveBeenCalledWith(
      SettingScope.User,
      'advisorModel',
      selector,
    );
  });

  it('lists Off and persists an Advisor model without switching the executor', async () => {
    const setAdvisorModel = vi.fn().mockResolvedValue(undefined);
    const switchModel = vi.fn();
    const { mockSettings, props } = renderComponent(
      { isAdvisorModelMode: true },
      {
        getAuthType: vi.fn(() => AuthType.USE_OPENAI),
        getModel: vi.fn(() => 'executor-model'),
        getAllConfiguredModels: vi.fn(() => [
          {
            id: 'advisor-model',
            label: 'Advisor Model',
            authType: AuthType.USE_OPENAI,
          },
          {
            id: 'vision-only',
            label: 'Vision Only',
            authType: AuthType.USE_OPENAI,
            visionOnly: true,
          },
        ]),
        setAdvisorModel,
        switchModel,
      },
      { merged: {} },
    );
    const select = mockedSelect.mock.calls[0][0];

    expect(select.items.map((item) => item.value)).toEqual([
      '$advisor-off',
      `${AuthType.USE_OPENAI}::advisor-model`,
    ]);
    await select.onSelect(`${AuthType.USE_OPENAI}::advisor-model`);

    expect(mockSettings.setValue).toHaveBeenCalledWith(
      SettingScope.User,
      'advisorModel',
      `${AuthType.USE_OPENAI}:advisor-model\0`,
    );
    expect(setAdvisorModel).toHaveBeenCalledWith(
      `${AuthType.USE_OPENAI}:advisor-model\0`,
    );
    expect(switchModel).not.toHaveBeenCalled();
    expect(props.onClose).toHaveBeenCalled();
  });

  it('does not persist an Advisor model when the tool is disabled', async () => {
    const setAdvisorModel = vi.fn().mockResolvedValue(false);
    const { mockSettings, props } = renderComponent(
      { isAdvisorModelMode: true },
      {
        getAuthType: vi.fn(() => AuthType.USE_OPENAI),
        getModel: vi.fn(() => 'executor-model'),
        getAllConfiguredModels: vi.fn(() => [
          {
            id: 'advisor-model',
            label: 'Advisor Model',
            authType: AuthType.USE_OPENAI,
          },
        ]),
        setAdvisorModel,
      },
      { merged: {} },
    );
    const select = mockedSelect.mock.calls[0][0];

    await select.onSelect(`${AuthType.USE_OPENAI}::advisor-model`);

    expect(mockSettings.setValue).not.toHaveBeenCalled();
    expect(props.onClose).not.toHaveBeenCalled();
  });

  it('does not default to Off when the configured Advisor model is unavailable', async () => {
    const setAdvisorModel = vi.fn().mockResolvedValue(undefined);
    const { mockSettings } = renderComponent(
      { isAdvisorModelMode: true },
      {
        getAuthType: vi.fn(() => AuthType.USE_OPENAI),
        getAdvisorModel: vi.fn(() => 'stale-advisor-model'),
        getAllConfiguredModels: vi.fn(() => [
          {
            id: 'available-advisor-model',
            label: 'Available Advisor Model',
            authType: AuthType.USE_OPENAI,
          },
        ]),
        setAdvisorModel,
      },
    );
    const select = mockedSelect.mock.calls[0][0];

    expect(select.initialIndex).toBe(1);
    await select.onSelect(select.items[1]!.value);

    expect(mockSettings.setValue).toHaveBeenCalledWith(
      SettingScope.User,
      'advisorModel',
      `${AuthType.USE_OPENAI}:available-advisor-model\0`,
    );
    expect(setAdvisorModel).toHaveBeenCalledWith(
      `${AuthType.USE_OPENAI}:available-advisor-model\0`,
    );
  });

  it('shows and selects the fast-only model configured as Advisor fast', () => {
    renderComponent(
      { isAdvisorModelMode: true },
      {
        getAuthType: vi.fn(() => AuthType.USE_OPENAI),
        getAdvisorModel: vi.fn(() => 'fast'),
        getFastModel: vi.fn(() => `${AuthType.USE_OPENAI}:fast-advisor-model`),
        getAllConfiguredModels: vi.fn(() => [
          {
            id: 'fast-advisor-model',
            label: 'Fast Advisor Model',
            authType: AuthType.USE_OPENAI,
            fastOnly: true,
          },
        ]),
      },
    );
    const select = mockedSelect.mock.calls[0][0];

    expect(select.items.map((item) => item.value)).toEqual([
      '$advisor-off',
      `${AuthType.USE_OPENAI}::fast-advisor-model`,
    ]);
    expect(select.initialIndex).toBe(1);
  });

  it('shows the active runtime model in Advisor mode', () => {
    renderComponent(
      { isAdvisorModelMode: true },
      {
        getAuthType: vi.fn(() => AuthType.USE_OPENAI),
        getAdvisorModel: vi.fn(() => 'runtime-advisor'),
        getModel: vi.fn(() => 'runtime-advisor'),
        getContentGeneratorConfig: vi.fn(() => ({
          authType: AuthType.USE_OPENAI,
          model: 'runtime-advisor',
        })),
        getAllConfiguredModels: vi.fn(() => [
          {
            id: 'runtime-advisor',
            label: 'Runtime Advisor',
            authType: AuthType.USE_OPENAI,
            isRuntimeModel: true,
            runtimeSnapshotId: '$runtime|openai|runtime-advisor',
          },
        ]),
      },
    );
    const select = mockedSelect.mock.calls[0][0];

    expect(select.items.map((item) => item.value)).toEqual([
      '$advisor-off',
      '$runtime|openai|runtime-advisor',
    ]);
    expect(select.initialIndex).toBe(1);
  });

  it('keeps the persisted fast-only Advisor model listed and highlighted', () => {
    renderComponent(
      { isAdvisorModelMode: true },
      {
        getAuthType: vi.fn(() => AuthType.USE_OPENAI),
        getAdvisorModel: vi.fn(
          () => `${AuthType.USE_OPENAI}:fast-advisor-model`,
        ),
        getFastModel: vi.fn(() => `${AuthType.USE_OPENAI}:fast-advisor-model`),
        getAllConfiguredModels: vi.fn(() => [
          {
            id: 'fast-advisor-model',
            label: 'Fast Advisor Model',
            authType: AuthType.USE_OPENAI,
            fastOnly: true,
          },
          {
            id: 'regular-advisor-model',
            label: 'Regular Advisor Model',
            authType: AuthType.USE_OPENAI,
          },
        ]),
      },
    );
    const select = mockedSelect.mock.calls[0][0];

    expect(select.items.map((item) => item.value)).toEqual([
      '$advisor-off',
      `${AuthType.USE_OPENAI}::fast-advisor-model`,
      `${AuthType.USE_OPENAI}::regular-advisor-model`,
    ]);
    expect(select.initialIndex).toBe(1);
  });

  it('does not list or persist other fast-only models in Advisor mode', async () => {
    const setAdvisorModel = vi.fn().mockResolvedValue(undefined);
    const { mockSettings } = renderComponent(
      { isAdvisorModelMode: true },
      {
        getAuthType: vi.fn(() => AuthType.USE_OPENAI),
        getAdvisorModel: vi.fn(() => 'fast'),
        getFastModel: vi.fn(() => `${AuthType.USE_OPENAI}:fast-flash`),
        getAllConfiguredModels: vi.fn(() => [
          {
            id: 'fast-flash',
            label: 'Fast Flash',
            authType: AuthType.USE_OPENAI,
            fastOnly: true,
          },
          {
            id: 'fast-mini',
            label: 'Fast Mini',
            authType: AuthType.USE_OPENAI,
            fastOnly: true,
          },
          {
            id: 'regular-advisor-model',
            label: 'Regular Advisor Model',
            authType: AuthType.USE_OPENAI,
          },
        ]),
        setAdvisorModel,
      },
    );
    const select = mockedSelect.mock.calls[0][0];

    expect(select.items.map((item) => item.value)).toEqual([
      '$advisor-off',
      `${AuthType.USE_OPENAI}::fast-flash`,
      `${AuthType.USE_OPENAI}::regular-advisor-model`,
    ]);

    await select.onSelect(`${AuthType.USE_OPENAI}::fast-mini`);

    expect(mockSettings.setValue).not.toHaveBeenCalled();
    expect(setAdvisorModel).not.toHaveBeenCalled();
  });

  it('caps visible model options to the available dialog height', () => {
    renderComponent(
      { availableTerminalHeight: 20 },
      {
        getModel: vi.fn(() => 'model-1'),
        getAuthType: vi.fn(() => AuthType.USE_OPENAI),
        getAllConfiguredModels: vi.fn(() =>
          Array.from({ length: 12 }, (_, i) => ({
            id: `model-${i + 1}`,
            label: `Model ${i + 1}`,
            description: '',
            authType: AuthType.USE_OPENAI,
          })),
        ),
      },
    );

    const props = mockedSelect.mock.calls[0][0];
    expect(props.items).toHaveLength(12);
    expect(props.maxItemsToShow).toBe(6);
    // The picker deliberately leaves the ▲/▼ scroll indicators off: they are
    // two always-rendered chrome rows better spent on two more entries.
    expect(props.showScrollArrows).toBeUndefined();
  });

  it('floors visible model options to 1 when the terminal is very short', () => {
    renderComponent(
      { availableTerminalHeight: 5 },
      {
        getModel: vi.fn(() => 'model-1'),
        getAuthType: vi.fn(() => AuthType.USE_OPENAI),
        getAllConfiguredModels: vi.fn(() =>
          Array.from({ length: 12 }, (_, i) => ({
            id: `model-${i + 1}`,
            label: `Model ${i + 1}`,
            description: '',
            authType: AuthType.USE_OPENAI,
          })),
        ),
      },
    );

    const props = mockedSelect.mock.calls[0][0];
    expect(props.maxItemsToShow).toBe(1);
  });

  it('accounts for the taller two-row option height when descriptions are present', () => {
    renderComponent(
      { availableTerminalHeight: 20 },
      {
        getModel: vi.fn(() => 'model-1'),
        getAuthType: vi.fn(() => AuthType.USE_OPENAI),
        getAllConfiguredModels: vi.fn(() =>
          Array.from({ length: 12 }, (_, i) => ({
            id: `model-${i + 1}`,
            label: `Model ${i + 1}`,
            description: `Description ${i + 1}`,
            authType: AuthType.USE_OPENAI,
          })),
        ),
      },
    );

    const props = mockedSelect.mock.calls[0][0];
    expect(props.maxItemsToShow).toBe(3);
  });

  it('falls back to the default max item count when no terminal height is given', () => {
    renderComponent(
      {},
      {
        getModel: vi.fn(() => 'model-1'),
        getAuthType: vi.fn(() => AuthType.USE_OPENAI),
        getAllConfiguredModels: vi.fn(() =>
          Array.from({ length: 12 }, (_, i) => ({
            id: `model-${i + 1}`,
            label: `Model ${i + 1}`,
            description: '',
            authType: AuthType.USE_OPENAI,
          })),
        ),
      },
    );

    const props = mockedSelect.mock.calls[0][0];
    expect(props.maxItemsToShow).toBe(10);
  });

  it('clamps visible model options to the default max when the terminal is tall', () => {
    renderComponent(
      { availableTerminalHeight: 100 },
      {
        getModel: vi.fn(() => 'model-1'),
        getAuthType: vi.fn(() => AuthType.USE_OPENAI),
        getAllConfiguredModels: vi.fn(() =>
          Array.from({ length: 12 }, (_, i) => ({
            id: `model-${i + 1}`,
            label: `Model ${i + 1}`,
            description: '',
            authType: AuthType.USE_OPENAI,
          })),
        ),
      },
    );

    // floor((100 - 14) / 1) = 86 rows of budget, clamped to the 10-item max.
    const props = mockedSelect.mock.calls[0][0];
    expect(props.maxItemsToShow).toBe(10);
  });

  it('shrinks visible model options to leave room for a displayed error message', async () => {
    const switchModel = vi.fn().mockRejectedValue(new Error('network down'));

    renderComponent(
      { availableTerminalHeight: 20 },
      {
        getModel: vi.fn(() => 'model-1'),
        getAuthType: vi.fn(() => AuthType.USE_OPENAI),
        switchModel,
        getAllConfiguredModels: vi.fn(() =>
          Array.from({ length: 12 }, (_, i) => ({
            id: `model-${i + 1}`,
            label: `Model ${i + 1}`,
            description: '',
            authType: AuthType.USE_OPENAI,
          })),
        ),
      },
    );

    const initialProps = mockedSelect.mock.calls[0][0];
    expect(initialProps.maxItemsToShow).toBe(6);

    await act(async () => {
      await initialProps.onSelect(initialProps.items[0].value);
    });

    const propsAfterError =
      mockedSelect.mock.calls[mockedSelect.mock.calls.length - 1][0];
    // errorMessage = "Failed to switch model to 'model-1'.\n\nnetwork down"
    // (3 lines) -> errorMessageRows = 2 + 3 = 5 ->
    // max(1, floor((20 - 14 - 5) / 1)) = 1.
    expect(propsAfterError.maxItemsToShow).toBe(1);
  });

  it('initializes with the model from ConfigContext', () => {
    const mockGetModel = vi.fn(() => 'second-model');
    renderComponent(
      {},
      {
        getModel: mockGetModel,
        getAllConfiguredModels: vi.fn(() => [
          ...createDefaultModels(),
          {
            id: 'second-model',
            label: 'second-model',
            description: '',
            authType: AuthType.USE_OPENAI,
            baseUrl: LOCAL_BASE_URL,
          },
        ]),
      },
    );

    expect(mockGetModel).toHaveBeenCalled();
    expect(mockedSelect).toHaveBeenCalledWith(
      expect.objectContaining({
        initialIndex: 1,
      }),
      undefined,
    );
  });

  it('initializes with the first model if getModel returns undefined', () => {
    const mockGetModel = vi.fn(() => undefined as unknown as string);
    renderComponent({}, { getModel: mockGetModel });

    expect(mockGetModel).toHaveBeenCalled();
    expect(mockedSelect).toHaveBeenCalledWith(
      expect.objectContaining({
        initialIndex: 0,
      }),
      undefined,
    );
    expect(mockedSelect).toHaveBeenCalledTimes(1);
  });

  it('calls config.switchModel and onClose when selecting a model', async () => {
    const switchModel = vi.fn().mockResolvedValue(undefined);
    const getAuthType = vi.fn(() => AuthType.USE_OPENAI);

    const { props, mockSettings } = renderComponent({}, {
      getModel: vi.fn(() => 'gpt-4'),
      getAuthType,
      switchModel,
      getAllConfiguredModels: vi.fn(() => [
        ...createDefaultModels(),
        {
          id: 'gpt-4',
          label: 'GPT-4',
          description: 'GPT-4 model',
          authType: AuthType.USE_OPENAI,
        },
      ]),
      getContentGeneratorConfig: vi.fn(() => ({
        authType: AuthType.USE_OPENAI,
        model: 'gpt-4',
      })),
    } as unknown as Partial<Config>);

    const childOnSelect = mockedSelect.mock.calls[0][0].onSelect;
    expect(childOnSelect).toBeDefined();

    await childOnSelect(`${AuthType.USE_OPENAI}::gpt-4`);

    expect(switchModel).toHaveBeenCalledWith(AuthType.USE_OPENAI, 'gpt-4', {
      baseUrl: undefined,
    });
    expect(mockSettings.setValue).toHaveBeenCalledWith(
      SettingScope.User,
      'model.name',
      'gpt-4',
    );
    // The selected provider has no baseUrl, so the disambiguator must be
    // cleared with an empty-string tombstone (overrides any lower-scope value).
    expect(mockSettings.setValue).toHaveBeenCalledWith(
      SettingScope.User,
      'model.baseUrl',
      '',
    );
    expect(mockSettings.setValue).toHaveBeenCalledWith(
      SettingScope.User,
      'security.auth.selectedType',
      AuthType.USE_OPENAI,
    );
    expect(props.onClose).toHaveBeenCalledTimes(1);
  });

  it('persists model.baseUrl alongside model.name when the selected provider has a baseUrl', async () => {
    const switchModel = vi.fn().mockResolvedValue(undefined);
    const { props, mockSettings } = renderComponent({}, {
      getModel: vi.fn(() => 'qwen3.7-max'),
      getAuthType: vi.fn(() => AuthType.USE_OPENAI),
      switchModel,
      getAllConfiguredModels: vi.fn(() => [
        {
          id: 'qwen3.7-max',
          label: '[Ollama] qwen3.7-max',
          description: '',
          authType: AuthType.USE_OPENAI,
          baseUrl: LOCAL_BASE_URL,
          envKey: 'OLLAMA_API_KEY',
        },
        {
          id: 'qwen3.7-max',
          label: '[LM Studio] qwen3.7-max',
          description: '',
          authType: AuthType.USE_OPENAI,
          baseUrl: OTHER_LOCAL_BASE_URL,
          envKey: 'LM_STUDIO_API_KEY',
        },
      ]),
      getContentGeneratorConfig: vi.fn(() => ({
        authType: AuthType.USE_OPENAI,
        model: 'qwen3.7-max',
        baseUrl: OTHER_LOCAL_BASE_URL,
      })),
    } as unknown as Partial<Config>);

    const childOnSelect = mockedSelect.mock.calls[0][0].onSelect;
    // Select the LM Studio entry (second server with the same id).
    await childOnSelect(
      `${AuthType.USE_OPENAI}::qwen3.7-max\0${OTHER_LOCAL_BASE_URL}`,
    );

    expect(switchModel).toHaveBeenCalledWith(
      AuthType.USE_OPENAI,
      'qwen3.7-max',
      {
        baseUrl: OTHER_LOCAL_BASE_URL,
      },
    );
    expect(mockSettings.setValue).toHaveBeenCalledWith(
      SettingScope.User,
      'model.name',
      'qwen3.7-max',
    );
    expect(mockSettings.setValue).toHaveBeenCalledWith(
      SettingScope.User,
      'model.baseUrl',
      OTHER_LOCAL_BASE_URL,
    );
    expect(props.onClose).toHaveBeenCalledTimes(1);
  });

  it('falls back to the picker entry baseUrl when switchModel does not propagate it', async () => {
    // Regression guard for the `after?.baseUrl ?? selectedEntry?.model.baseUrl`
    // fallback: if switchModel succeeds but getContentGeneratorConfig returns a
    // config WITHOUT baseUrl, the disambiguator must still be persisted from the
    // selected picker entry's baseUrl — otherwise an empty-string tombstone would
    // be written and the wrong same-id provider would resolve on next launch.
    const switchModel = vi.fn().mockResolvedValue(undefined);
    const { props, mockSettings } = renderComponent({}, {
      getModel: vi.fn(() => 'qwen3.7-max'),
      getAuthType: vi.fn(() => AuthType.USE_OPENAI),
      switchModel,
      getAllConfiguredModels: vi.fn(() => [
        {
          id: 'qwen3.7-max',
          label: '[Ollama] qwen3.7-max',
          description: '',
          authType: AuthType.USE_OPENAI,
          baseUrl: LOCAL_BASE_URL,
          envKey: 'OLLAMA_API_KEY',
        },
        {
          id: 'qwen3.7-max',
          label: '[LM Studio] qwen3.7-max',
          description: '',
          authType: AuthType.USE_OPENAI,
          baseUrl: OTHER_LOCAL_BASE_URL,
          envKey: 'LM_STUDIO_API_KEY',
        },
      ]),
      // Resolved config has NO baseUrl, so `after?.baseUrl` is undefined and the
      // `?? selectedEntry?.model.baseUrl` fallback must supply the disambiguator.
      getContentGeneratorConfig: vi.fn(() => ({
        authType: AuthType.USE_OPENAI,
        model: 'qwen3.7-max',
      })),
    } as unknown as Partial<Config>);

    const childOnSelect = mockedSelect.mock.calls[0][0].onSelect;
    // Select the LM Studio entry (second server with the same id).
    await childOnSelect(
      `${AuthType.USE_OPENAI}::qwen3.7-max\0${OTHER_LOCAL_BASE_URL}`,
    );

    expect(mockSettings.setValue).toHaveBeenCalledWith(
      SettingScope.User,
      'model.name',
      'qwen3.7-max',
    );
    // baseUrl comes from the picker entry, not the (baseUrl-less) resolved config.
    expect(mockSettings.setValue).toHaveBeenCalledWith(
      SettingScope.User,
      'model.baseUrl',
      OTHER_LOCAL_BASE_URL,
    );
    expect(props.onClose).toHaveBeenCalledTimes(1);
  });

  it('shows image + video modality and 1M context details', () => {
    const { getByText } = renderComponent({}, {
      getModel: vi.fn(() => 'qwen3-vl'),
      getAuthType: vi.fn(() => AuthType.USE_OPENAI),
      getAllConfiguredModels: vi.fn(() => [
        {
          id: 'qwen3-vl',
          label: 'qwen3-vl',
          description: '',
          authType: AuthType.USE_OPENAI,
          baseUrl: LOCAL_BASE_URL,
          envKey: 'LOCAL_SERVER_API_KEY',
          modalities: { image: true, video: true },
          contextWindowSize: 1000000,
        },
      ]),
      getModelsConfig: vi.fn(() => ({
        getGenerationConfig: vi.fn(() => ({
          baseUrl: LOCAL_BASE_URL,
        })),
      })),
    } as unknown as Partial<Config>);

    expect(getByText('Modality:')).toBeDefined();
    expect(getByText('text · image · video')).toBeDefined();
    expect(getByText('Context Window:')).toBeDefined();
    expect(getByText('1,000,000 tokens')).toBeDefined();
  });

  it('hydrates provider API key env from settings.env before switching', async () => {
    const previousApiKey = process.env['LOCAL_SERVER_API_KEY'];
    delete process.env['LOCAL_SERVER_API_KEY'];

    try {
      const switchModel = vi.fn().mockImplementation(async () => {
        expect(process.env['LOCAL_SERVER_API_KEY']).toBe(
          'sk-local-from-settings',
        );
      });

      renderComponent(
        {},
        {
          getModel: vi.fn(() => 'qwen3-coder'),
          getAuthType: vi.fn(() => AuthType.USE_OPENAI),
          switchModel,
          getAllConfiguredModels: vi.fn(() => [
            {
              id: 'qwen3-vl',
              label: 'qwen3-vl',
              description: '',
              authType: AuthType.USE_OPENAI,
              baseUrl: LOCAL_BASE_URL,
              envKey: 'LOCAL_SERVER_API_KEY',
              modalities: { image: true, video: true },
              contextWindowSize: 1000000,
            },
          ]),
          getModelsConfig: vi.fn(() => ({
            getGenerationConfig: vi.fn(() => ({
              baseUrl: LOCAL_BASE_URL,
            })),
          })),
          getContentGeneratorConfig: vi.fn(() => ({
            authType: AuthType.USE_OPENAI,
            model: 'qwen3-vl',
            apiKey: 'sk-local-from-settings',
            baseUrl: LOCAL_BASE_URL,
          })),
        } as unknown as Partial<Config>,
        {
          merged: {
            env: { LOCAL_SERVER_API_KEY: 'sk-local-from-settings' },
          },
        } as unknown as Partial<LoadedSettings>,
      );

      const selected = mockedSelect.mock.calls[0][0].items[0].value;
      await mockedSelect.mock.calls[0][0].onSelect(selected);

      expect(switchModel).toHaveBeenCalledWith(
        AuthType.USE_OPENAI,
        'qwen3-vl',
        { baseUrl: LOCAL_BASE_URL },
      );
    } finally {
      if (previousApiKey === undefined) {
        delete process.env['LOCAL_SERVER_API_KEY'];
      } else {
        process.env['LOCAL_SERVER_API_KEY'] = previousApiKey;
      }
    }
  });

  it('stores authType-qualified selectors in fast model mode', async () => {
    const setFastModel = vi.fn();
    const { props, mockSettings, recordSlashCommand } = renderComponent(
      { isFastModelMode: true },
      {
        getAuthType: vi.fn(() => AuthType.USE_OPENAI),
        getModel: vi.fn(() => 'qwen3-coder'),
        getAllConfiguredModels: vi.fn(() => [
          {
            id: 'deepseek-v4-flash',
            label: 'deepseek-v4-flash',
            authType: AuthType.USE_OPENAI,
          },
          {
            id: 'qwen3-coder',
            label: 'qwen3-coder',
            authType: AuthType.USE_OPENAI,
          },
        ]),
        getContentGeneratorConfig: vi.fn(() => ({
          authType: AuthType.USE_OPENAI,
          model: 'qwen3-coder',
        })),
        setFastModel,
      } as unknown as Partial<Config>,
    );

    const childOnSelect = mockedSelect.mock.calls[0][0].onSelect;
    await childOnSelect(`${AuthType.USE_OPENAI}::deepseek-v4-flash`);

    expect(mockSettings.setValue).toHaveBeenCalledWith(
      SettingScope.User,
      'fastModel',
      'openai:deepseek-v4-flash',
    );
    expect(setFastModel).toHaveBeenCalledWith('openai:deepseek-v4-flash');
    expect(recordSlashCommand).toHaveBeenCalledWith({
      phase: 'result',
      rawCommand: '/model',
      outputHistoryItems: [
        { type: 'success', text: 'Fast Model: openai:deepseek-v4-flash' },
      ],
    });
    expect(props.onClose).toHaveBeenCalledTimes(1);
  });

  it('stores authType-qualified selectors in vision model mode without switching models', async () => {
    const switchModel = vi.fn();
    const setVisionModel = vi.fn();
    const { props, mockSettings, recordSlashCommand } = renderComponent(
      { isVisionModelMode: true },
      {
        getAuthType: vi.fn(() => AuthType.USE_OPENAI),
        getModel: vi.fn(() => 'qwen3-coder'),
        switchModel,
        getAllConfiguredModels: vi.fn(() => [
          {
            id: 'qwen-vl-max',
            label: 'qwen-vl-max',
            authType: AuthType.USE_OPENAI,
          },
          {
            id: 'qwen3-coder',
            label: 'qwen3-coder',
            authType: AuthType.USE_OPENAI,
          },
        ]),
        getContentGeneratorConfig: vi.fn(() => ({
          authType: AuthType.USE_OPENAI,
          model: 'qwen3-coder',
        })),
        isCurrentPrimaryModel: (m: { id: string; authType?: string }) =>
          m.id === 'qwen3-coder' && m.authType === AuthType.USE_OPENAI,
        setVisionModel,
      } as unknown as Partial<Config>,
    );

    const childOnSelect = mockedSelect.mock.calls[0][0].onSelect;
    await childOnSelect(`${AuthType.USE_OPENAI}::qwen-vl-max`);

    expect(mockSettings.setValue).toHaveBeenCalledWith(
      SettingScope.User,
      'visionModel',
      'openai:qwen-vl-max',
    );
    expect(setVisionModel).toHaveBeenCalledWith('openai:qwen-vl-max');
    expect(recordSlashCommand).toHaveBeenCalledWith({
      phase: 'result',
      rawCommand: '/model',
      outputHistoryItems: [
        { type: 'success', text: 'Vision Model: openai:qwen-vl-max' },
      ],
    });
    expect(switchModel).not.toHaveBeenCalled();
    expect(mockSettings.setValue).not.toHaveBeenCalledWith(
      SettingScope.User,
      'model.name',
      expect.any(String),
    );
    expect(props.onClose).toHaveBeenCalledTimes(1);
  });

  it('stores compaction model selector without switching models', async () => {
    const switchModel = vi.fn();
    const setCompactionModel = vi.fn();
    const { props, mockSettings, recordSlashCommand } = renderComponent(
      { isCompactionModelMode: true },
      {
        getAuthType: vi.fn(() => AuthType.USE_OPENAI),
        getModel: vi.fn(() => 'gpt-4'),
        switchModel,
        getAllConfiguredModels: vi.fn(() => [
          {
            id: 'compaction-model',
            label: 'compaction-model',
            authType: AuthType.USE_OPENAI,
          },
          {
            id: 'gpt-4',
            label: 'gpt-4',
            authType: AuthType.USE_OPENAI,
          },
        ]),
        getContentGeneratorConfig: vi.fn(() => ({
          authType: AuthType.USE_OPENAI,
          model: 'gpt-4',
        })),
        isCurrentPrimaryModel: (m: { id: string; authType?: string }) =>
          m.id === 'gpt-4' && m.authType === AuthType.USE_OPENAI,
        setCompactionModel,
      } as unknown as Partial<Config>,
    );

    const childOnSelect = mockedSelect.mock.calls[0][0].onSelect;
    await childOnSelect(`${AuthType.USE_OPENAI}::compaction-model`);

    expect(mockSettings.setValue).toHaveBeenCalledWith(
      SettingScope.User,
      'compactionModel',
      'openai:compaction-model',
    );
    expect(setCompactionModel).toHaveBeenCalledWith('openai:compaction-model');
    expect(recordSlashCommand).toHaveBeenCalledWith({
      phase: 'result',
      rawCommand: '/model',
      outputHistoryItems: [
        {
          type: 'success',
          text: 'Compaction Model: openai:compaction-model',
        },
      ],
    });
    expect(switchModel).not.toHaveBeenCalled();
    expect(props.onClose).toHaveBeenCalledTimes(1);
  });

  it('keeps the selected baseUrl for duplicate vision model ids', async () => {
    const switchModel = vi.fn();
    const setVisionModel = vi.fn();
    const selectedBaseUrl = OTHER_LOCAL_BASE_URL;
    const { props, mockSettings } = renderComponent(
      { isVisionModelMode: true },
      {
        getAuthType: vi.fn(() => AuthType.USE_OPENAI),
        getModel: vi.fn(() => 'qwen3.7-max'),
        switchModel,
        getAllConfiguredModels: vi.fn(() => [
          {
            id: 'qwen3.7-plus',
            label: '[Ollama] qwen3.7-plus',
            authType: AuthType.USE_OPENAI,
            baseUrl: LOCAL_BASE_URL,
            modalities: { image: true, video: true },
          },
          {
            id: 'qwen3.7-plus',
            label: '[LM Studio] qwen3.7-plus',
            authType: AuthType.USE_OPENAI,
            baseUrl: selectedBaseUrl,
            modalities: { image: true, video: true },
          },
        ]),
        getContentGeneratorConfig: vi.fn(() => ({
          authType: AuthType.USE_OPENAI,
          model: 'qwen3.7-max',
          baseUrl: LOCAL_BASE_URL,
        })),
        isCurrentPrimaryModel: (m: { id: string }) => m.id === 'qwen3.7-max',
        setVisionModel,
      } as unknown as Partial<Config>,
    );

    const childOnSelect = mockedSelect.mock.calls[0][0].onSelect;
    await childOnSelect(
      `${AuthType.USE_OPENAI}::qwen3.7-plus\0${selectedBaseUrl}`,
    );

    expect(mockSettings.setValue).toHaveBeenCalledWith(
      SettingScope.User,
      'visionModel',
      `openai:qwen3.7-plus\0${selectedBaseUrl}`,
    );
    expect(setVisionModel).toHaveBeenCalledWith(
      `openai:qwen3.7-plus\0${selectedBaseUrl}`,
    );
    expect(switchModel).not.toHaveBeenCalled();
    expect(props.onClose).toHaveBeenCalledTimes(1);
  });

  it('warns in the history when a pinned vision model is not image-capable', async () => {
    // qwen-plus is text-only by name default, so the pin is honored but flagged.
    // The primary is a different model so the pin isn't rejected as the primary.
    const setVisionModel = vi.fn();
    const { mockHistoryManager } = renderComponent(
      { isVisionModelMode: true },
      {
        getAuthType: vi.fn(() => AuthType.USE_OPENAI),
        getModel: vi.fn(() => 'qwen3.7-max'),
        getAllConfiguredModels: vi.fn(() => [
          {
            id: 'qwen-plus',
            label: 'qwen-plus',
            authType: AuthType.USE_OPENAI,
          },
        ]),
        getContentGeneratorConfig: vi.fn(() => ({
          authType: AuthType.USE_OPENAI,
          model: 'qwen3.7-max',
        })),
        isCurrentPrimaryModel: (m: { id: string }) => m.id === 'qwen3.7-max',
        setVisionModel,
      } as unknown as Partial<Config>,
    );

    const childOnSelect = mockedSelect.mock.calls[0][0].onSelect;
    await childOnSelect(`${AuthType.USE_OPENAI}::qwen-plus`);

    expect(setVisionModel).toHaveBeenCalledWith('openai:qwen-plus');
    expect(mockHistoryManager.addItem).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'success',
        text: expect.stringContaining('not a known image-capable model'),
      }),
      expect.any(Number),
    );
  });

  it('highlights the row for a bare fast-model setting', () => {
    // `/model --fast deepseek-v4-flash` persists the bare model id. When the
    // dialog re-opens, it must locate the right row even though the setting
    // carries no authType prefix — otherwise the highlight falls back to the
    // first row and Enter would silently overwrite the setting.
    const mockSettings = {
      isTrusted: true,
      user: { settings: {} },
      workspace: { settings: {} },
      merged: { fastModel: 'deepseek-v4-flash' },
      setValue: vi.fn(),
    } as unknown as LoadedSettings;

    const allModels = [
      {
        id: 'qwen3-coder',
        label: 'qwen3-coder',
        description: '',
        authType: AuthType.USE_OPENAI,
      },
      {
        id: 'deepseek-v4-flash',
        label: 'deepseek-v4-flash',
        description: '',
        authType: AuthType.USE_OPENAI,
      },
    ];

    render(
      <SettingsContext.Provider value={mockSettings}>
        <ConfigContext.Provider
          value={
            {
              getModel: vi.fn(() => 'qwen3-coder'),
              getAuthType: vi.fn(() => AuthType.USE_OPENAI),
              getAllConfiguredModels: vi.fn(() => allModels),
              getContentGeneratorConfig: vi.fn(() => ({
                authType: AuthType.USE_OPENAI,
                model: 'qwen3-coder',
              })),
              getModelsConfig: vi.fn(() => ({
                getGenerationConfig: vi.fn(() => ({ baseUrl: undefined })),
              })),
              getActiveRuntimeModelSnapshot: vi.fn(() => undefined),
              getUsageStatisticsEnabled: vi.fn(() => false),
              getSessionId: vi.fn(() => 'session'),
              getDebugMode: vi.fn(() => false),
              getUseModelRouter: vi.fn(() => false),
            } as unknown as Config
          }
        >
          <ModelDialog onClose={vi.fn()} isFastModelMode={true} />
        </ConfigContext.Provider>
      </SettingsContext.Provider>,
    );

    const items = mockedSelect.mock.calls[0][0].items;
    const deepseekIndex = items.findIndex((item) =>
      String(item.value).includes('deepseek-v4-flash'),
    );
    expect(deepseekIndex).toBeGreaterThanOrEqual(0);
    expect(mockedSelect.mock.calls[0][0].initialIndex).toBe(deepseekIndex);
  });

  it('highlights the row for a bare vision-model setting', () => {
    // `/model --vision qwen-vl-max` persists the bare model id. When the dialog
    // re-opens in vision mode, the preferred-entry resolution must locate that
    // row even though the setting carries no authType prefix — otherwise the
    // highlight falls back to the first row and Enter would silently overwrite
    // the setting.
    const mockSettings = {
      isTrusted: true,
      user: { settings: {} },
      workspace: { settings: {} },
      merged: { visionModel: 'qwen-vl-max' },
      setValue: vi.fn(),
    } as unknown as LoadedSettings;

    const allModels = [
      {
        id: 'qwen3-coder',
        label: 'qwen3-coder',
        description: '',
        authType: AuthType.USE_OPENAI,
      },
      {
        id: 'qwen-vl-max',
        label: 'qwen-vl-max',
        description: '',
        authType: AuthType.USE_OPENAI,
      },
    ];

    render(
      <SettingsContext.Provider value={mockSettings}>
        <ConfigContext.Provider
          value={
            {
              getModel: vi.fn(() => 'qwen3-coder'),
              getAuthType: vi.fn(() => AuthType.USE_OPENAI),
              getAllConfiguredModels: vi.fn(() => allModels),
              getContentGeneratorConfig: vi.fn(() => ({
                authType: AuthType.USE_OPENAI,
                model: 'qwen3-coder',
              })),
              getModelsConfig: vi.fn(() => ({
                getGenerationConfig: vi.fn(() => ({ baseUrl: undefined })),
              })),
              getActiveRuntimeModelSnapshot: vi.fn(() => undefined),
              getUsageStatisticsEnabled: vi.fn(() => false),
              getSessionId: vi.fn(() => 'session'),
              getDebugMode: vi.fn(() => false),
              getUseModelRouter: vi.fn(() => false),
            } as unknown as Config
          }
        >
          <ModelDialog onClose={vi.fn()} isVisionModelMode={true} />
        </ConfigContext.Provider>
      </SettingsContext.Provider>,
    );

    const items = mockedSelect.mock.calls[0][0].items;
    const visionIndex = items.findIndex((item) =>
      String(item.value).includes('qwen-vl-max'),
    );
    expect(visionIndex).toBeGreaterThanOrEqual(0);
    expect(mockedSelect.mock.calls[0][0].initialIndex).toBe(visionIndex);
  });

  it('highlights the matching baseUrl for duplicate vision-model settings', () => {
    const selectedBaseUrl = OTHER_LOCAL_BASE_URL;
    const mockSettings = {
      isTrusted: true,
      user: { settings: {} },
      workspace: { settings: {} },
      merged: {
        visionModel: `openai:qwen3.7-plus\0${selectedBaseUrl}`,
      },
      setValue: vi.fn(),
    } as unknown as LoadedSettings;

    const allModels = [
      {
        id: 'qwen3.7-plus',
        label: '[Ollama] qwen3.7-plus',
        description: '',
        authType: AuthType.USE_OPENAI,
        baseUrl: LOCAL_BASE_URL,
      },
      {
        id: 'qwen3.7-plus',
        label: '[LM Studio] qwen3.7-plus',
        description: '',
        authType: AuthType.USE_OPENAI,
        baseUrl: selectedBaseUrl,
      },
    ];

    render(
      <SettingsContext.Provider value={mockSettings}>
        <ConfigContext.Provider
          value={
            {
              getModel: vi.fn(() => 'qwen3.7-max'),
              getAuthType: vi.fn(() => AuthType.USE_OPENAI),
              getAllConfiguredModels: vi.fn(() => allModels),
              getContentGeneratorConfig: vi.fn(() => ({
                authType: AuthType.USE_OPENAI,
                model: 'qwen3.7-max',
                baseUrl: LOCAL_BASE_URL,
              })),
              getModelsConfig: vi.fn(() => ({
                getGenerationConfig: vi.fn(() => ({
                  baseUrl: LOCAL_BASE_URL,
                })),
              })),
              getActiveRuntimeModelSnapshot: vi.fn(() => undefined),
              getUsageStatisticsEnabled: vi.fn(() => false),
              getSessionId: vi.fn(() => 'session'),
              getDebugMode: vi.fn(() => false),
              getUseModelRouter: vi.fn(() => false),
            } as unknown as Config
          }
        >
          <ModelDialog onClose={vi.fn()} isVisionModelMode={true} />
        </ConfigContext.Provider>
      </SettingsContext.Provider>,
    );

    const items = mockedSelect.mock.calls[0][0].items;
    const visionIndex = items.findIndex(
      (item) =>
        String(item.value).includes('qwen3.7-plus') &&
        String(item.value).includes(selectedBaseUrl),
    );
    expect(visionIndex).toBeGreaterThanOrEqual(0);
    expect(mockedSelect.mock.calls[0][0].initialIndex).toBe(visionIndex);
  });

  it('passes onHighlight to DescriptiveRadioButtonSelect', () => {
    renderComponent();

    const childOnHighlight = mockedSelect.mock.calls[0][0].onHighlight;
    expect(childOnHighlight).toBeDefined();
    expect(typeof childOnHighlight).toBe('function');
  });

  it('reports the unchanged model when "escape" closes the primary picker', () => {
    const { props, mockHistoryManager } = renderComponent();

    expect(mockedUseKeypress).toHaveBeenCalled();

    const keyPressHandler = mockedUseKeypress.mock.calls[0][0];
    const options = mockedUseKeypress.mock.calls[0][1];

    expect(options).toEqual({ isActive: true });

    keyPressHandler({
      name: 'escape',
      ctrl: false,
      meta: false,
      shift: false,
      paste: false,
      sequence: '',
    });
    expect(mockHistoryManager.addItem).toHaveBeenCalledWith(
      {
        type: 'info',
        text: `Kept model as ${DEFAULT_MODEL_ID}`,
      },
      expect.any(Number),
    );
    expect(props.onClose).toHaveBeenCalledTimes(1);

    // A second Escape byte in the same stdin chunk must not double-report.
    keyPressHandler({
      name: 'escape',
      ctrl: false,
      meta: false,
      shift: false,
      paste: false,
      sequence: '',
    });
    expect(mockHistoryManager.addItem).toHaveBeenCalledTimes(1);
    expect(props.onClose).toHaveBeenCalledTimes(1);

    keyPressHandler({
      name: 'a',
      ctrl: false,
      meta: false,
      shift: false,
      paste: false,
      sequence: '',
    });
    expect(mockHistoryManager.addItem).toHaveBeenCalledTimes(1);
    expect(props.onClose).toHaveBeenCalledTimes(1);
  });

  it('records dismissal feedback for resumed history', () => {
    const recordSlashCommand = vi.fn();
    const { mockHistoryManager } = renderComponent({}, {
      getChatRecordingService: vi.fn(() => ({ recordSlashCommand })),
    } as unknown as Partial<Config>);

    const keyPressHandler = mockedUseKeypress.mock.calls[0][0];
    keyPressHandler({
      name: 'escape',
      ctrl: false,
      meta: false,
      shift: false,
      paste: false,
      sequence: '',
    });

    expect(mockHistoryManager.addItem).toHaveBeenCalledTimes(1);
    expect(recordSlashCommand).toHaveBeenCalledWith({
      phase: 'result',
      rawCommand: '/model',
      outputHistoryItems: [
        { type: 'info', text: `Kept model as ${DEFAULT_MODEL_ID}` },
      ],
    });
  });

  it('does not close the primary picker on "left"', () => {
    const { props, mockHistoryManager } = renderComponent();

    const keyPressHandler = mockedUseKeypress.mock.calls[0][0];
    keyPressHandler({
      name: 'left',
      ctrl: false,
      meta: false,
      shift: false,
      paste: false,
      sequence: '',
    });

    expect(mockHistoryManager.addItem).not.toHaveBeenCalled();
    expect(props.onClose).not.toHaveBeenCalled();
  });

  it.each([
    [{ isFastModelMode: true }, 'escape'],
    [{ isVisionModelMode: true }, 'escape'],
    [{ isCompactionModelMode: true }, 'escape'],
    [{ isFastModelMode: true }, 'left'],
    [{ isVisionModelMode: true }, 'left'],
    [{ isCompactionModelMode: true }, 'left'],
  ])(
    'does not report the primary model when closing an auxiliary picker (%j, %s)',
    (modeProps, keyName) => {
      const { props, mockHistoryManager } = renderComponent(modeProps);

      const keyPressHandler = mockedUseKeypress.mock.calls[0][0];
      keyPressHandler({
        name: keyName,
        ctrl: false,
        meta: false,
        shift: false,
        paste: false,
        sequence: '',
      });

      expect(mockHistoryManager.addItem).not.toHaveBeenCalled();
      expect(props.onClose).toHaveBeenCalledTimes(1);
    },
  );

  it('reports the active runtime model when closing the primary picker', () => {
    const { mockHistoryManager } = renderComponent({}, {
      getModel: vi.fn(() => 'configured-model'),
      getActiveRuntimeModelSnapshot: vi.fn(() => ({
        id: '$runtime|openai|runtime-model',
        authType: AuthType.USE_OPENAI,
        modelId: 'runtime-model',
      })),
    } as unknown as Partial<Config>);

    const keyPressHandler = mockedUseKeypress.mock.calls[0][0];
    keyPressHandler({
      name: 'escape',
      ctrl: false,
      meta: false,
      shift: false,
      paste: false,
      sequence: '',
    });

    expect(mockHistoryManager.addItem).toHaveBeenCalledWith(
      { type: 'info', text: 'Kept model as runtime-model' },
      expect.any(Number),
    );
  });

  it('does not report the unchanged model when a selection is made', async () => {
    const switchModel = vi.fn().mockResolvedValue(undefined);
    const { props, mockHistoryManager } = renderComponent({}, {
      getModel: vi.fn(() => 'gpt-4'),
      getAuthType: vi.fn(() => AuthType.USE_OPENAI),
      switchModel,
      getAllConfiguredModels: vi.fn(() => [
        {
          id: 'gpt-4',
          label: 'GPT-4',
          description: 'GPT-4 model',
          authType: AuthType.USE_OPENAI,
        },
      ]),
      getContentGeneratorConfig: vi.fn(() => ({
        authType: AuthType.USE_OPENAI,
        model: 'gpt-4',
      })),
    } as unknown as Partial<Config>);

    const childOnSelect = mockedSelect.mock.calls[0][0].onSelect;
    await childOnSelect(`${AuthType.USE_OPENAI}::gpt-4`);

    expect(props.onClose).toHaveBeenCalledTimes(1);
    expect(mockHistoryManager.addItem).not.toHaveBeenCalledWith(
      expect.objectContaining({
        text: expect.stringContaining('Kept model as'),
      }),
      expect.any(Number),
    );

    const keyPressHandler = mockedUseKeypress.mock.calls[0][0];
    keyPressHandler({
      name: 'escape',
      ctrl: false,
      meta: false,
      shift: false,
      paste: false,
      sequence: '',
    });
    expect(props.onClose).toHaveBeenCalledTimes(1);
  });

  it('records successful model-switch feedback for resumed history', async () => {
    const recordSlashCommand = vi.fn();
    const { mockHistoryManager } = renderComponent({}, {
      getModel: vi.fn(() => 'gpt-4'),
      getAuthType: vi.fn(() => AuthType.USE_OPENAI),
      switchModel: vi.fn().mockResolvedValue(undefined),
      getAllConfiguredModels: vi.fn(() => [
        {
          id: 'gpt-4',
          label: 'GPT-4',
          authType: AuthType.USE_OPENAI,
        },
      ]),
      getContentGeneratorConfig: vi.fn(() => ({
        authType: AuthType.USE_OPENAI,
        model: 'gpt-4',
      })),
      getChatRecordingService: vi.fn(() => ({ recordSlashCommand })),
    } as unknown as Partial<Config>);

    await act(async () => {
      await mockedSelect.mock.calls[0][0].onSelect(
        `${AuthType.USE_OPENAI}::gpt-4`,
      );
    });

    const feedbackItem = vi.mocked(mockHistoryManager.addItem).mock.calls[0][0];
    expect(feedbackItem.text).toContain('Using model: gpt-4');
    expect(recordSlashCommand).toHaveBeenCalledWith({
      phase: 'result',
      rawCommand: '/model',
      outputHistoryItems: [feedbackItem],
    });
  });

  it('remains dismissible after a failed model switch', async () => {
    const { props, mockHistoryManager } = renderComponent({}, {
      getModel: vi.fn(() => 'gpt-4'),
      getAuthType: vi.fn(() => AuthType.USE_OPENAI),
      switchModel: vi.fn().mockRejectedValue(new Error('network down')),
      getAllConfiguredModels: vi.fn(() => [
        {
          id: 'gpt-4',
          label: 'GPT-4',
          authType: AuthType.USE_OPENAI,
        },
      ]),
    } as unknown as Partial<Config>);

    await act(async () => {
      await mockedSelect.mock.calls[0][0].onSelect(
        `${AuthType.USE_OPENAI}::gpt-4`,
      );
    });
    expect(props.onClose).not.toHaveBeenCalled();

    mockedUseKeypress.mock.calls[0][0]({
      name: 'escape',
      ctrl: false,
      meta: false,
      shift: false,
      paste: false,
      sequence: '',
    });

    expect(props.onClose).toHaveBeenCalledTimes(1);
    expect(mockHistoryManager.addItem).toHaveBeenCalledWith(
      { type: 'info', text: 'Kept model as gpt-4' },
      expect.any(Number),
    );
  });

  it('ignores escape while a model selection is in flight', async () => {
    let resolveSwitch: (() => void) | undefined;
    const switchModel = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          resolveSwitch = resolve;
        }),
    );
    const { props, mockHistoryManager } = renderComponent({}, {
      getModel: vi.fn(() => 'gpt-4'),
      getAuthType: vi.fn(() => AuthType.USE_OPENAI),
      switchModel,
      getAllConfiguredModels: vi.fn(() => [
        {
          id: 'gpt-4',
          label: 'GPT-4',
          description: 'GPT-4 model',
          authType: AuthType.USE_OPENAI,
        },
      ]),
      getContentGeneratorConfig: vi.fn(() => ({
        authType: AuthType.USE_OPENAI,
        model: 'gpt-4',
      })),
    } as unknown as Partial<Config>);

    const selection = mockedSelect.mock.calls[0][0].onSelect(
      `${AuthType.USE_OPENAI}::gpt-4`,
    );
    const keyPressHandler = mockedUseKeypress.mock.calls[0][0];
    keyPressHandler({
      name: 'escape',
      ctrl: false,
      meta: false,
      shift: false,
      paste: false,
      sequence: '',
    });

    expect(mockHistoryManager.addItem).not.toHaveBeenCalledWith(
      expect.objectContaining({
        text: expect.stringContaining('Kept model as'),
      }),
      expect.any(Number),
    );
    expect(props.onClose).not.toHaveBeenCalled();

    resolveSwitch?.();
    await selection;
    expect(props.onClose).toHaveBeenCalledTimes(1);
  });

  it('ignores a second selection while a model switch is in flight', async () => {
    let resolveSwitch: (() => void) | undefined;
    const switchModel = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          resolveSwitch = resolve;
        }),
    );
    const { props, mockHistoryManager, recordSlashCommand } = renderComponent(
      {},
      {
        getModel: vi.fn(() => 'gpt-4'),
        getAuthType: vi.fn(() => AuthType.USE_OPENAI),
        switchModel,
        getAllConfiguredModels: vi.fn(() => [
          {
            id: 'gpt-4',
            label: 'GPT-4',
            description: 'GPT-4 model',
            authType: AuthType.USE_OPENAI,
          },
        ]),
        getContentGeneratorConfig: vi.fn(() => ({
          authType: AuthType.USE_OPENAI,
          model: 'gpt-4',
        })),
      } as unknown as Partial<Config>,
    );

    const onSelect = mockedSelect.mock.calls[0][0].onSelect;
    const firstSelection = onSelect(`${AuthType.USE_OPENAI}::gpt-4`);
    await onSelect(`${AuthType.USE_OPENAI}::gpt-4`);

    expect(switchModel).toHaveBeenCalledTimes(1);

    resolveSwitch?.();
    await firstSelection;

    expect(switchModel).toHaveBeenCalledTimes(1);
    expect(props.onClose).toHaveBeenCalledTimes(1);
    expect(mockHistoryManager.addItem).toHaveBeenCalledTimes(1);
    expect(recordSlashCommand).toHaveBeenCalledTimes(1);
  });

  it('does not retry or report an unchanged model after persistence fails', async () => {
    const switchModel = vi.fn().mockResolvedValue(undefined);
    const setValue = vi.fn(() => {
      const error = new Error('settings are read-only');
      Object.assign(error, { code: 'EACCES' });
      throw error;
    });
    const { props, getByText, mockHistoryManager, recordSlashCommand } =
      renderComponent(
        {},
        {
          getModel: vi.fn(() => 'old-model'),
          getAuthType: vi.fn(() => AuthType.USE_OPENAI),
          switchModel,
          getAllConfiguredModels: vi.fn(() => [
            {
              id: 'gpt-4',
              label: 'GPT-4',
              description: 'GPT-4 model',
              authType: AuthType.USE_OPENAI,
            },
          ]),
          getContentGeneratorConfig: vi.fn(() => ({
            authType: AuthType.USE_OPENAI,
            model: 'gpt-4',
          })),
        } as unknown as Partial<Config>,
        { setValue },
      );

    const onSelect = mockedSelect.mock.calls[0][0].onSelect;
    await act(async () => {
      await onSelect(`${AuthType.USE_OPENAI}::gpt-4`);
    });

    expect(
      getByText((text) =>
        text.includes('Model switched, but the selection could not be saved.'),
      ),
    ).toBeDefined();

    await onSelect(`${AuthType.USE_OPENAI}::gpt-4`);
    mockedUseKeypress.mock.calls[0][0]({
      name: 'escape',
      ctrl: false,
      meta: false,
      shift: false,
      paste: false,
      sequence: '',
    });

    expect(switchModel).toHaveBeenCalledTimes(1);
    expect(setValue).toHaveBeenCalledTimes(1);
    expect(mockHistoryManager.addItem).not.toHaveBeenCalled();
    expect(recordSlashCommand).not.toHaveBeenCalled();
    expect(props.onClose).toHaveBeenCalledTimes(1);
  });

  it('updates initialIndex when config context changes', () => {
    const mockGetModel = vi.fn(() => DEFAULT_MODEL_ID);
    const mockGetAuthType = vi.fn(() => AuthType.USE_OPENAI);
    const mockGetModelsConfig = vi.fn(() => ({
      getGenerationConfig: vi.fn(() => ({ baseUrl: LOCAL_BASE_URL })),
    }));
    const mockGetActiveRuntimeModelSnapshot = vi.fn(() => undefined);
    const models = [
      ...createDefaultModels(),
      {
        id: 'second-model',
        label: 'second-model',
        description: '',
        authType: AuthType.USE_OPENAI,
        baseUrl: LOCAL_BASE_URL,
      },
    ];
    const mockSettings = {
      isTrusted: true,
      user: { settings: {} },
      workspace: { settings: {} },
      setValue: vi.fn(),
    } as unknown as LoadedSettings;
    const { rerender } = render(
      <SettingsContext.Provider value={mockSettings}>
        <ConfigContext.Provider
          value={
            {
              getModel: mockGetModel,
              getAuthType: mockGetAuthType,
              getAllConfiguredModels: vi.fn(() => models),
              getModelsConfig: mockGetModelsConfig,
              getActiveRuntimeModelSnapshot: mockGetActiveRuntimeModelSnapshot,
            } as unknown as Config
          }
        >
          <ModelDialog onClose={vi.fn()} />
        </ConfigContext.Provider>
      </SettingsContext.Provider>,
    );

    expect(mockedSelect.mock.calls[0][0].initialIndex).toBe(0);

    mockGetModel.mockReturnValue('second-model');
    const newMockConfig = {
      getModel: mockGetModel,
      getAuthType: mockGetAuthType,
      getAllConfiguredModels: vi.fn(() => models),
      getModelsConfig: mockGetModelsConfig,
      getActiveRuntimeModelSnapshot: mockGetActiveRuntimeModelSnapshot,
    } as unknown as Config;

    rerender(
      <SettingsContext.Provider value={mockSettings}>
        <ConfigContext.Provider value={newMockConfig}>
          <ModelDialog onClose={vi.fn()} />
        </ConfigContext.Provider>
      </SettingsContext.Provider>,
    );

    // Initial render + re-render after the context change.
    expect(mockedSelect).toHaveBeenCalledTimes(2);
    expect(mockedSelect.mock.calls[1][0].initialIndex).toBe(1);
  });
});

describe('encodeAuxModelSelector', () => {
  it('encodes the "authType::modelId" key, dropping the baseUrl', () => {
    expect(encodeAuxModelSelector(`openai::gpt-4o\0${LOCAL_BASE_URL}`)).toBe(
      'openai:gpt-4o',
    );
    expect(encodeAuxModelSelector('openai::gpt-4o')).toBe('openai:gpt-4o');
  });

  it('encodes the "$runtime|authType|modelId" key by positional split', () => {
    expect(encodeAuxModelSelector('$runtime|openai|gpt-4o')).toBe(
      'openai:gpt-4o',
    );
  });

  it('passes a bare id (and a malformed runtime key) through unchanged', () => {
    expect(encodeAuxModelSelector('gpt-4o')).toBe('gpt-4o');
    expect(encodeAuxModelSelector('$runtime|openai')).toBe('$runtime|openai');
  });
});
