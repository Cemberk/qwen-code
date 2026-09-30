/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type React from 'react';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Box, Text } from 'ink';
import { TextInput } from '../components/shared/TextInput.js';
import { theme } from '../semantic-colors.js';
import { ICON } from '../constants.js';
import { useKeypress } from '../hooks/useKeypress.js';
import { t } from '../../i18n/index.js';
import { discoverProviderModels } from '@qwen-code/qwen-code-core';
import type { ProviderConfig, ModelSpec } from '@qwen-code/qwen-code-core';
import type { ProviderSetupFlow } from './useProviderSetupFlow.js';
import { normalizeModelIds } from './useAuth.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const NAV_HINT_INPUT = () => (
  <Box marginTop={1}>
    <Text color={theme.text.secondary}>
      {t('Enter to submit, Esc to go back')}
    </Text>
  </Box>
);

// ---------------------------------------------------------------------------
// Step: BaseURL input
// ---------------------------------------------------------------------------

function BaseUrlInputStep({
  flow,
}: {
  flow: ProviderSetupFlow;
}): React.JSX.Element {
  return (
    <Box marginTop={1} flexDirection="column">
      <Box marginTop={1}>
        <Text color={theme.text.primary}>
          {t('Enter the base URL of the local OpenAI-compatible server.')}
        </Text>
      </Box>
      <Box>
        <Text color={theme.text.secondary}>
          {t('The host must be 127.0.0.1, ::1 or localhost.')}
        </Text>
      </Box>
      <Box marginTop={1}>
        <TextInput
          key="base-url-input"
          value={flow.state.baseUrl}
          onChange={flow.changeBaseUrl}
          onSubmit={flow.submitBaseUrl}
        />
      </Box>
      {flow.state.baseUrlError && (
        <Box marginTop={1}>
          <Text color={theme.status.error}>{flow.state.baseUrlError}</Text>
        </Box>
      )}
      <NAV_HINT_INPUT />
    </Box>
  );
}

// ---------------------------------------------------------------------------
// Step: API Key input
// ---------------------------------------------------------------------------

function ApiKeyStep({
  config,
  flow,
}: {
  config: ProviderConfig;
  flow: ProviderSetupFlow;
}): React.JSX.Element {
  return (
    <Box marginTop={1} flexDirection="column">
      <Box marginTop={1}>
        <TextInput
          key="api-key-input"
          value={flow.state.apiKey}
          onChange={flow.changeApiKey}
          onSubmit={() => flow.submitApiKey(flow.state.apiKey)}
          placeholder={config.apiKeyPlaceholder ?? 'sk-...'}
        />
      </Box>
      {flow.state.apiKeyError && (
        <Box marginTop={1}>
          <Text color={theme.status.error}>{flow.state.apiKeyError}</Text>
        </Box>
      )}
      <NAV_HINT_INPUT />
    </Box>
  );
}

// ---------------------------------------------------------------------------
// Step: Model IDs input
// ---------------------------------------------------------------------------

const MODEL_DESCRIPTION_COLUMN = 28;
const MODALITY_DISPLAY_ORDER = ['image', 'video', 'audio', 'pdf'] as const;
export const MODEL_CUSTOM_INPUT_FOCUS_INDEX = -2;
export const MODEL_SEARCH_INPUT_FOCUS_INDEX = -1;
export const MAX_MODELS_TO_SHOW = 8;

export interface ModelOption {
  key: string;
  value: string;
  label: string;
}

export function formatModelOptionLabel(model: ModelSpec): string {
  const details: string[] = [];
  if (model.contextWindowSize) {
    details.push(`${model.contextWindowSize.toLocaleString('en-US')} tokens`);
  }
  const modalities = MODALITY_DISPLAY_ORDER.filter(
    (name) => model.modalities?.[name],
  );
  details.push(['text', ...modalities].join('/'));
  return `${model.id.padEnd(MODEL_DESCRIPTION_COLUMN)} ${details.join(', ')}`;
}

export function modelOptionSearchText(item: ModelOption): string {
  return `${item.key} ${item.label} ${item.value}`.toLowerCase();
}

function mergeModelIds(
  customModelIdsText: string,
  selectedModelKeys: string[],
): string[] {
  // Checked served models lead: models[0] becomes the active model on
  // first-time setup.
  return normalizeModelIds(
    [...selectedModelKeys, customModelIdsText].join(', '),
  );
}

/** Pick from the models the server reported, or type ids directly. */
function ServedModelIdsStep({
  flow,
  models,
}: {
  flow: ProviderSetupFlow;
  models: ModelSpec[];
}): React.JSX.Element {
  const modelOptions = useMemo<ModelOption[]>(
    () =>
      models.map((model) => ({
        key: model.id,
        value: model.id,
        label: formatModelOptionLabel(model),
      })),
    [models],
  );
  const [focusedModelIndex, setFocusedModelIndex] = useState(
    MODEL_CUSTOM_INPUT_FOCUS_INDEX,
  );
  const [selectedModelKeys, setSelectedModelKeys] = useState<string[]>([]);
  // Saved ids from a previous setup start in the free-form input.
  const [customModelIdsText, setCustomModelIdsText] = useState(
    () => flow.state.modelIds,
  );
  const [modelSearchQuery, setModelSearchQuery] = useState('');
  const filteredModelOptions = useMemo(() => {
    const normalizedQuery = modelSearchQuery.trim().toLowerCase();
    if (!normalizedQuery) {
      return modelOptions;
    }
    return modelOptions.filter((item) =>
      modelOptionSearchText(item).includes(normalizedQuery),
    );
  }, [modelOptions, modelSearchQuery]);
  const scrollOffset =
    focusedModelIndex < 0
      ? 0
      : Math.max(
          0,
          Math.min(
            focusedModelIndex - MAX_MODELS_TO_SHOW + 1,
            filteredModelOptions.length - MAX_MODELS_TO_SHOW,
          ),
        );
  const visibleModelOptions = filteredModelOptions.slice(
    scrollOffset,
    scrollOffset + MAX_MODELS_TO_SHOW,
  );

  const handleSubmitModelIds = useCallback(() => {
    flow.submitModelIds({
      modelIds: mergeModelIds(customModelIdsText, selectedModelKeys),
    });
  }, [customModelIdsText, flow, selectedModelKeys]);

  const handleCustomModelIdsChange = useCallback(
    (value: string) => {
      setCustomModelIdsText(value);
      // Edits commit only on Enter, but a stale submit error must still clear.
      flow.clearModelIdsError();
    },
    [flow],
  );

  const toggleModelAtIndex = useCallback(
    (index: number) => {
      const item = filteredModelOptions[index];
      if (!item) {
        return;
      }
      const nextSet = new Set(selectedModelKeys);
      if (nextSet.has(item.key)) {
        nextSet.delete(item.key);
      } else {
        nextSet.add(item.key);
      }
      setSelectedModelKeys(
        modelOptions.map((option) => option.key).filter((k) => nextSet.has(k)),
      );
      flow.clearModelIdsError();
    },
    [filteredModelOptions, flow, modelOptions, selectedModelKeys],
  );

  useKeypress(
    (key) => {
      if (focusedModelIndex < 0) {
        return;
      }

      if (key.name === 'tab') {
        setFocusedModelIndex(MODEL_CUSTOM_INPUT_FOCUS_INDEX);
        return;
      }

      if (key.name === 'up') {
        setFocusedModelIndex((index) =>
          index <= 0 ? MODEL_SEARCH_INPUT_FOCUS_INDEX : index - 1,
        );
        return;
      }

      if (key.name === 'down') {
        setFocusedModelIndex((index) =>
          Math.max(0, Math.min(index + 1, filteredModelOptions.length - 1)),
        );
        return;
      }

      if (key.name === 'space' || key.sequence === ' ') {
        toggleModelAtIndex(focusedModelIndex);
        return;
      }

      if (key.name === 'return') {
        handleSubmitModelIds();
        return;
      }
    },
    { isActive: focusedModelIndex >= 0 },
  );

  return (
    <Box marginTop={1} flexDirection="column">
      <Box marginTop={1}>
        <Text color={theme.text.secondary}>
          {t(
            'Enter model IDs directly. Use commas to configure multiple models.',
          )}
        </Text>
      </Box>
      <Box marginTop={1}>
        <TextInput
          key="model-ids-input"
          value={customModelIdsText}
          onChange={handleCustomModelIdsChange}
          onSubmit={handleSubmitModelIds}
          onDown={() => {
            setFocusedModelIndex(MODEL_SEARCH_INPUT_FOCUS_INDEX);
          }}
          onTab={() => {
            setFocusedModelIndex(MODEL_SEARCH_INPUT_FOCUS_INDEX);
          }}
          placeholder="model-id"
          height={3}
          isActive={focusedModelIndex === MODEL_CUSTOM_INPUT_FOCUS_INDEX}
        />
      </Box>
      <Box marginTop={0}>
        <Text color={theme.text.secondary}>
          {t(
            'Checked models are applied on submit but not copied into the input.',
          )}
        </Text>
      </Box>
      <Box marginTop={1}>
        <Text color={theme.text.secondary}>
          {t('Models · from the provider · {{count}} checked', {
            count: String(selectedModelKeys.length),
          })}
        </Text>
      </Box>
      <Box marginTop={0} flexDirection="column">
        <Text color={theme.text.secondary}>{t('Search')}</Text>
        <TextInput
          key="model-search-input"
          value={modelSearchQuery}
          onChange={setModelSearchQuery}
          onSubmit={handleSubmitModelIds}
          onUp={() => setFocusedModelIndex(MODEL_CUSTOM_INPUT_FOCUS_INDEX)}
          onDown={() => {
            if (filteredModelOptions.length > 0) {
              setFocusedModelIndex(0);
            }
          }}
          onTab={() => {
            if (filteredModelOptions.length > 0) {
              setFocusedModelIndex(0);
            }
          }}
          placeholder="search"
          isActive={focusedModelIndex === MODEL_SEARCH_INPUT_FOCUS_INDEX}
        />
      </Box>
      <Box marginTop={1} flexDirection="column">
        {visibleModelOptions.length > 0 ? (
          visibleModelOptions.map((item, visibleIndex) => {
            const modelIndex = scrollOffset + visibleIndex;
            const isFocused = focusedModelIndex === modelIndex;
            const isSelected = selectedModelKeys.includes(item.key);
            const textColor = isFocused
              ? theme.status.success
              : isSelected
                ? theme.text.accent
                : theme.text.primary;
            return (
              <Box key={item.key} alignItems="flex-start">
                <Box minWidth={4} flexShrink={0}>
                  <Text color={textColor}>
                    {isSelected ? ICON.RADIO_FILLED : ICON.CIRCLE_EMPTY}
                  </Text>
                </Box>
                <Box flexGrow={1}>
                  <Text color={textColor}>{item.label}</Text>
                </Box>
              </Box>
            );
          })
        ) : (
          <Text color={theme.text.secondary}>{t('No models match.')}</Text>
        )}
      </Box>
      {flow.state.modelIdsError && (
        <Box marginTop={1}>
          <Text color={theme.status.error}>{flow.state.modelIdsError}</Text>
        </Box>
      )}
      <Box marginTop={1}>
        <Text color={theme.text.secondary}>
          {t(
            'Enter to submit, ↑↓/Tab to switch input, search, and models, Space to toggle models, Esc to go back',
          )}
        </Text>
      </Box>
    </Box>
  );
}

/** Manual entry, used when the server's model list is unavailable. */
function ManualModelIdsStep({
  flow,
}: {
  flow: ProviderSetupFlow;
}): React.JSX.Element {
  return (
    <Box marginTop={1} flexDirection="column">
      <Box marginTop={1}>
        <Text color={theme.text.secondary}>
          {t('Enter model IDs separated by commas.')}
        </Text>
      </Box>
      <Box marginTop={1}>
        <TextInput
          key="model-ids-input"
          value={flow.state.modelIds}
          onChange={flow.changeModelIds}
          onSubmit={() => flow.submitModelIds()}
          placeholder="model-id-1, model-id-2"
        />
      </Box>
      {flow.state.modelIdsError && (
        <Box marginTop={1}>
          <Text color={theme.status.error}>{flow.state.modelIdsError}</Text>
        </Box>
      )}
      <NAV_HINT_INPUT />
    </Box>
  );
}

/** Lists the served models from `{baseUrl}/models`, then lets the user pick. */
function DiscoveringModelIdsStep({
  flow,
}: {
  flow: ProviderSetupFlow;
}): React.JSX.Element {
  const [discovered, setDiscovered] = useState<ModelSpec[] | null | undefined>(
    undefined,
  );
  const baseUrl = flow.state.baseUrl;
  const apiKey = flow.state.apiKey;

  useEffect(() => {
    const controller = new AbortController();
    let active = true;

    void discoverProviderModels({
      baseUrl,
      apiKey,
      staticModels: [],
      signal: controller.signal,
    }).then((models) => {
      if (active) {
        setDiscovered(models);
      }
    });

    return () => {
      active = false;
      controller.abort();
    };
  }, [apiKey, baseUrl]);

  if (discovered === undefined) {
    return (
      <Box marginTop={1} flexDirection="column">
        <Text color={theme.text.secondary}>
          {t('Loading models from provider…')}
        </Text>
        <Box marginTop={1}>
          <Text color={theme.text.secondary}>{t('Esc to go back')}</Text>
        </Box>
      </Box>
    );
  }

  if (!discovered || discovered.length === 0) {
    return <ManualModelIdsStep flow={flow} />;
  }

  return <ServedModelIdsStep flow={flow} models={discovered} />;
}

// ---------------------------------------------------------------------------
// Step: Advanced config
// ---------------------------------------------------------------------------

function AdvancedConfigStep({
  flow,
}: {
  flow: ProviderSetupFlow;
}): React.JSX.Element {
  const {
    focusedConfigIndex,
    thinkingEnabled,
    modalityEnabled,
    modalityImage,
    modalityVideo,
    modalityAudio,
    modalityPdf,
    contextWindowSize,
  } = flow.state;
  const checkmark = (v: boolean) => (v ? ICON.RADIO_FILLED : ICON.CIRCLE_EMPTY);
  const cursor = (index: number) => (focusedConfigIndex === index ? '›' : ' ');

  const ctxIdx = modalityEnabled ? 6 : 2;

  return (
    <Box marginTop={1} flexDirection="column">
      <Box marginTop={1}>
        <Text color={theme.text.primary}>
          {t('Optional: configure advanced generation settings.')}
        </Text>
      </Box>
      <Box marginTop={1} marginLeft={2}>
        <Text
          color={focusedConfigIndex === 0 ? theme.status.success : undefined}
        >
          {cursor(0)} {checkmark(thinkingEnabled)} {t('Enable thinking')}
        </Text>
      </Box>
      <Box marginTop={0} marginLeft={4}>
        <Text color={theme.text.secondary}>
          {t(
            'Allows the model to perform extended reasoning before responding.',
          )}
        </Text>
      </Box>
      <Box marginTop={1} marginLeft={2}>
        <Text
          color={focusedConfigIndex === 1 ? theme.status.success : undefined}
        >
          {cursor(1)} {checkmark(modalityEnabled)} {t('Enable modality')}
        </Text>
      </Box>
      <Box marginTop={0} marginLeft={4}>
        <Text color={theme.text.secondary}>
          {t('Enables multimodal input capabilities (image, video, etc.).')}
        </Text>
      </Box>
      {modalityEnabled && (
        <Box marginTop={0} marginLeft={6}>
          <Text
            color={focusedConfigIndex === 2 ? theme.status.success : undefined}
          >
            {cursor(2)} {checkmark(modalityImage)} {'Image  '}
          </Text>
          <Text
            color={focusedConfigIndex === 3 ? theme.status.success : undefined}
          >
            {cursor(3)} {checkmark(modalityVideo)} {'Video  '}
          </Text>
          <Text
            color={focusedConfigIndex === 4 ? theme.status.success : undefined}
          >
            {cursor(4)} {checkmark(modalityAudio)} {'Audio  '}
          </Text>
          <Text
            color={focusedConfigIndex === 5 ? theme.status.success : undefined}
          >
            {cursor(5)} {checkmark(modalityPdf)} {'PDF'}
          </Text>
        </Box>
      )}
      <Box marginTop={1} marginLeft={2}>
        <Text
          color={
            focusedConfigIndex === ctxIdx ? theme.status.success : undefined
          }
        >
          {cursor(ctxIdx)} {t('Context window')}:{' '}
        </Text>
        <TextInput
          value={contextWindowSize}
          onChange={flow.changeContextWindowSize}
          placeholder="auto"
          isActive={focusedConfigIndex === ctxIdx}
        />
      </Box>
      <Box marginTop={0} marginLeft={4}>
        <Text color={theme.text.secondary}>
          {t('Max input tokens (leave empty to auto-detect from model name).')}
        </Text>
      </Box>
      <Box marginTop={1}>
        <Text color={theme.text.secondary}>
          {t(
            '↑↓ to navigate, Space to toggle, Enter to continue, Esc to go back',
          )}
        </Text>
      </Box>
    </Box>
  );
}

// ---------------------------------------------------------------------------
// Step: Review JSON
// ---------------------------------------------------------------------------

function ReviewStep({ flow }: { flow: ProviderSetupFlow }): React.JSX.Element {
  return (
    <Box marginTop={1} flexDirection="column">
      <Box marginTop={1}>
        <Text color={theme.text.primary}>
          {t('The following JSON will be saved to settings.json:')}
        </Text>
      </Box>
      <Box marginTop={1}>
        {flow.state.previewError ? (
          <Text color={theme.status.error}>{flow.state.previewError}</Text>
        ) : (
          <Text>{flow.state.previewJson}</Text>
        )}
      </Box>
      <Box marginTop={1}>
        <Text color={theme.text.secondary}>
          {t('Enter to save, Esc to go back')}
        </Text>
      </Box>
    </Box>
  );
}

// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------

export interface ProviderSetupStepsProps {
  flow: ProviderSetupFlow;
}

export function ProviderSetupSteps({
  flow,
}: ProviderSetupStepsProps): React.JSX.Element | null {
  const { provider, step } = flow.state;

  // Keyboard handling for steps that need it (advancedConfig, review)
  useKeypress(
    (key) => {
      if (step === 'advancedConfig') {
        // The context-window row has an embedded TextInput that's conditionally
        // active. Restrict the focus-row navigation to unambiguous shortcuts —
        // arrow keys and the readline-style Ctrl+P/Ctrl+N — so typing a letter
        // into the context-window field never simultaneously moves the focus.
        const isFocusUp = key.name === 'up' || (key.ctrl && key.name === 'p');
        const isFocusDown =
          key.name === 'down' || (key.ctrl && key.name === 'n');
        if (isFocusUp) {
          flow.moveAdvancedFocusUp();
          return;
        }
        if (isFocusDown) {
          flow.moveAdvancedFocusDown();
          return;
        }
        if (key.name === 'space') {
          flow.toggleFocusedAdvancedOption();
          return;
        }
        if (key.name === 'return') {
          flow.submitAdvancedConfig();
          return;
        }
      }

      if (step === 'review' && key.name === 'return') {
        flow.submit();
      }
    },
    { isActive: step === 'advancedConfig' || step === 'review' },
  );

  if (!provider || !step) return null;

  switch (step) {
    case 'baseUrl':
      return <BaseUrlInputStep flow={flow} />;

    case 'apiKey':
      return <ApiKeyStep config={provider} flow={flow} />;

    case 'models':
      if (provider.supportsModelDiscovery) {
        return <DiscoveringModelIdsStep flow={flow} />;
      }
      return <ManualModelIdsStep flow={flow} />;

    case 'advancedConfig':
      return <AdvancedConfigStep flow={flow} />;

    case 'review':
      return <ReviewStep flow={flow} />;

    default:
      return null;
  }
}
