/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { useState, useCallback } from 'react';
import {
  buildInstallPlan,
  getLocalBaseUrlError,
  getProviderModels,
  preserveModelProviderPlaceholders,
} from '@qwen-code/qwen-code-core';
import type {
  AuthType,
  InputModalities,
  ModelProvidersConfig,
  ProviderModelConfig,
  ProviderConfig,
  ProviderSetupInputs,
} from '@qwen-code/qwen-code-core';
import { t } from '../../i18n/index.js';
import { normalizeModelIds, maskApiKey } from './useAuth.js';

// ---------------------------------------------------------------------------
// Setup step names
// ---------------------------------------------------------------------------

export type SetupStep =
  | 'baseUrl'
  | 'apiKey'
  | 'models'
  | 'advancedConfig'
  | 'review';

const STEP_ORDER: SetupStep[] = [
  'baseUrl',
  'apiKey',
  'models',
  'advancedConfig',
  'review',
];

function getVisibleSteps(config: ProviderConfig): SetupStep[] {
  if (config.showAdvancedConfig === true) return STEP_ORDER;
  return STEP_ORDER.filter(
    (step) => step !== 'advancedConfig' && step !== 'review',
  );
}

// ---------------------------------------------------------------------------
// State type
// ---------------------------------------------------------------------------

export interface ProviderSetupState {
  provider: ProviderConfig | null;
  step: SetupStep | null;
  stepIndex: number;
  totalSteps: number;

  // BaseUrl
  baseUrl: string;
  baseUrlError: string | null;

  // API Key
  apiKey: string;
  apiKeyError: string | null;

  // Model IDs
  modelIds: string;
  modelIdsError: string | null;

  // Advanced config
  thinkingEnabled: boolean;
  modalityEnabled: boolean;
  modalityImage: boolean;
  modalityVideo: boolean;
  modalityAudio: boolean;
  modalityPdf: boolean;
  contextWindowSize: string;
  focusedConfigIndex: number;

  // Preview
  previewJson: string;
  // The planner's refusal, shown in place of the JSON. Always set by the
  // hook; optional so hand-built state fixtures keep compiling.
  previewError?: string;
}

// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------

export function useProviderSetupFlow(
  onSubmit: (
    config: ProviderConfig,
    inputs: ProviderSetupInputs,
  ) => Promise<void>,
  modelProviders?: ModelProvidersConfig,
  rawModelProviders?: ModelProvidersConfig,
) {
  const [provider, setProvider] = useState<ProviderConfig | null>(null);
  const [visibleSteps, setVisibleSteps] = useState<SetupStep[]>([]);
  const [stepIndex, setStepIndex] = useState(0);

  const [baseUrl, setBaseUrl] = useState('');
  const [baseUrlError, setBaseUrlError] = useState<string | null>(null);
  const [apiKey, setApiKey] = useState('');
  const [apiKeyError, setApiKeyError] = useState<string | null>(null);
  const [modelIds, setModelIds] = useState('');
  const [modelIdsError, setModelIdsError] = useState<string | null>(null);
  const [thinkingEnabled, setThinkingEnabled] = useState(false);
  const [modalityEnabled, setModalityEnabled] = useState(false);
  const [modalityImage, setModalityImage] = useState(true);
  const [modalityVideo, setModalityVideo] = useState(true);
  const [modalityAudio, setModalityAudio] = useState(false);
  const [modalityPdf, setModalityPdf] = useState(false);
  const [contextWindowSize, setContextWindowSize] = useState('');
  const [focusedConfigIndex, setFocusedConfigIndex] = useState(0);

  const currentStep = visibleSteps[stepIndex] ?? null;

  // -- Lifecycle ------------------------------------------------------------

  const start = useCallback(
    (config: ProviderConfig, existingModelIds?: string[]) => {
      setProvider(config);
      setVisibleSteps(getVisibleSteps(config));
      setStepIndex(0);

      // There is no default endpoint: the user must type the local server's
      // base URL.
      setBaseUrl('');
      setBaseUrlError(null);
      setApiKey('');
      setApiKeyError(null);
      setModelIds((existingModelIds ?? []).join(', '));
      setModelIdsError(null);
      setThinkingEnabled(false);
      setModalityEnabled(false);
      setModalityImage(true);
      setModalityVideo(true);
      setModalityAudio(false);
      setModalityPdf(false);
      setContextWindowSize('');
      setFocusedConfigIndex(0);
    },
    [],
  );

  const reset = useCallback(() => {
    setProvider(null);
    setVisibleSteps([]);
    setStepIndex(0);
  }, []);

  const goBack = useCallback((): boolean => {
    if (stepIndex > 0) {
      setStepIndex((i) => i - 1);
      return true;
    }
    reset();
    return false;
  }, [stepIndex, reset]);

  const goNext = useCallback(() => {
    setStepIndex((i) => Math.min(i + 1, visibleSteps.length - 1));
  }, [visibleSteps]);

  // -- Step handlers --------------------------------------------------------

  const submitBaseUrl = useCallback(
    (valueOverride?: string): boolean => {
      // The caller's live field text, when it has one: a keystroke burst can leave
      // `baseUrl` a whole batch behind.
      const current = (valueOverride ?? baseUrl).trim();
      const error = getLocalBaseUrlError(current);
      if (error) {
        setBaseUrlError(error);
        return false;
      }
      setBaseUrl(current);
      setBaseUrlError(null);
      goNext();
      return true;
    },
    [baseUrl, goNext],
  );

  const changeBaseUrl = useCallback((value: string) => {
    setBaseUrl(value);
    setBaseUrlError(null);
  }, []);

  const changeApiKey = useCallback((value: string) => {
    setApiKey(value);
    setApiKeyError(null);
  }, []);

  // Shared by the preview and submission so the persisted model shape agrees.
  const buildCurrentInputs = useCallback(
    (overrides?: Partial<ProviderSetupInputs>): ProviderSetupInputs => {
      const multimodal: InputModalities | undefined = modalityEnabled
        ? {
            image: modalityImage || undefined,
            video: modalityVideo || undefined,
            audio: modalityAudio || undefined,
            pdf: modalityPdf || undefined,
          }
        : undefined;
      const ctxSize = parseInt(contextWindowSize, 10);
      // TODO: add maxTokens input field — type and buildInstallPlan support it but UI is deferred
      const hasAdvanced = thinkingEnabled || modalityEnabled || ctxSize > 0;
      return {
        baseUrl: baseUrl.trim(),
        apiKey: apiKey.trim(),
        modelIds: normalizeModelIds(modelIds),
        advancedConfig: hasAdvanced
          ? {
              enableThinking: thinkingEnabled || undefined,
              multimodal,
              contextWindowSize: ctxSize > 0 ? ctxSize : undefined,
            }
          : undefined,
        ...overrides,
      };
    },
    [
      baseUrl,
      apiKey,
      modelIds,
      modalityEnabled,
      modalityImage,
      modalityVideo,
      modalityAudio,
      modalityPdf,
      contextWindowSize,
      thinkingEnabled,
    ],
  );

  const submitOrNext = useCallback(
    (overrides?: Partial<ProviderSetupInputs>) => {
      if (stepIndex >= visibleSteps.length - 1) {
        if (provider) void onSubmit(provider, buildCurrentInputs(overrides));
      } else {
        goNext();
      }
    },
    [stepIndex, visibleSteps, provider, onSubmit, buildCurrentInputs, goNext],
  );

  const submitApiKey = useCallback(
    (keyOverride?: string): boolean => {
      const trimmed = (keyOverride ?? apiKey).trim();
      if (!trimmed) {
        setApiKeyError(t('API key cannot be empty.'));
        return false;
      }
      setApiKeyError(null);
      setApiKey(trimmed);
      submitOrNext({ apiKey: trimmed });
      return true;
    },
    [apiKey, submitOrNext],
  );

  const changeModelIds = useCallback((value: string) => {
    setModelIds(value);
    setModelIdsError(null);
  }, []);

  const clearModelIdsError = useCallback(() => {
    setModelIdsError(null);
  }, []);

  const submitModelIds = useCallback(
    (overrides?: Partial<ProviderSetupInputs>): boolean => {
      const normalized = overrides?.modelIds ?? normalizeModelIds(modelIds);
      if (normalized.length === 0) {
        setModelIdsError(t('Model IDs cannot be empty.'));
        return false;
      }
      setModelIds(normalized.join(', '));
      setModelIdsError(null);
      submitOrNext({ ...overrides, modelIds: normalized });
      return true;
    },
    [modelIds, submitOrNext],
  );

  const advancedOptionCount = modalityEnabled ? 7 : 3;

  const moveAdvancedFocusUp = useCallback(() => {
    setFocusedConfigIndex((v) => (v <= 0 ? advancedOptionCount - 1 : v - 1));
  }, [advancedOptionCount]);

  const moveAdvancedFocusDown = useCallback(() => {
    setFocusedConfigIndex((v) => (v >= advancedOptionCount - 1 ? 0 : v + 1));
  }, [advancedOptionCount]);

  const toggleFocusedAdvancedOption = useCallback(() => {
    switch (focusedConfigIndex) {
      case 0:
        setThinkingEnabled((v) => !v);
        break;
      case 1:
        setModalityEnabled((v) => !v);
        break;
      case 2:
        setModalityImage((v) => !v);
        break;
      case 3:
        setModalityVideo((v) => !v);
        break;
      case 4:
        setModalityAudio((v) => !v);
        break;
      case 5:
        setModalityPdf((v) => !v);
        break;
      default:
        break;
    }
  }, [focusedConfigIndex]);

  const submitAdvancedConfig = useCallback(() => {
    goNext();
  }, [goNext]);

  // -- Final submit ---------------------------------------------------------

  const changeContextWindowSize = useCallback((value: string) => {
    setContextWindowSize(value.replace(/[^0-9]/g, ''));
  }, []);

  const submit = useCallback(() => {
    if (provider) void onSubmit(provider, buildCurrentInputs());
  }, [provider, onSubmit, buildCurrentInputs]);

  // Display copy only: preserved models come from the env-resolved merged
  // settings, so a stored `${TOKEN}` reference reaches the hook as the real
  // secret — in any string field, not just `customHeaders`. Render the form
  // the writer persists (placeholders restored from the raw file), then mask
  // whatever header value is still a literal; `submit` builds its own plan
  // from the raw inputs.
  const holdsReference = (value: unknown) =>
    typeof value === 'string' && /\$\{[^}]+\}/.test(value);
  const maskCustomHeaders = (
    model: ProviderModelConfig,
  ): ProviderModelConfig => {
    const headers = model.generationConfig?.customHeaders;
    if (!headers) return model;
    return {
      ...model,
      generationConfig: {
        ...model.generationConfig,
        customHeaders: Object.fromEntries(
          Object.entries(headers).map(([name, value]) => [
            name,
            holdsReference(value) ? value : '***',
          ]),
        ),
      },
    };
  };
  const previewModels = (patch: {
    authType: AuthType;
    models: ProviderModelConfig[];
  }): ProviderModelConfig[] =>
    (rawModelProviders && modelProviders
      ? preserveModelProviderPlaceholders(
          patch.models,
          patch.authType,
          modelProviders,
          rawModelProviders,
        )
      : patch.models
    ).map(maskCustomHeaders);

  // Computed during render on the review step, so it must stay total:
  // buildInstallPlan refuses reachable inputs (e.g. two same-endpoint models
  // holding different credential references) and that refusal is surfaced
  // as `previewError` instead of escaping into React and unmounting the CLI.
  const buildPreview = (): { json: string; error: string } => {
    if (!provider) return { json: '', error: '' };
    try {
      const inputs = buildCurrentInputs();
      const plan = buildInstallPlan(
        provider,
        { ...inputs, apiKey: maskApiKey(inputs.apiKey) },
        getProviderModels(modelProviders),
      );
      return {
        json: JSON.stringify(
          {
            env: plan.env,
            modelProviders: Object.fromEntries(
              (plan.modelProviders ?? []).map((patch) => [
                patch.authType,
                previewModels(patch),
              ]),
            ),
            security: { auth: { selectedType: plan.authType } },
            model: {
              name: plan.modelSelection?.modelId,
              baseUrl: plan.modelSelection?.baseUrl ?? '',
            },
          },
          null,
          2,
        ),
        error: '',
      };
    } catch (error) {
      return {
        json: '',
        error: error instanceof Error ? error.message : String(error),
      };
    }
  };

  const preview =
    currentStep === 'review' ? buildPreview() : { json: '', error: '' };

  // -- State ----------------------------------------------------------------

  const state: ProviderSetupState = {
    provider,
    step: currentStep,
    stepIndex: stepIndex + 1, // 1-based for display
    totalSteps: visibleSteps.length,
    baseUrl,
    baseUrlError,
    apiKey,
    apiKeyError,
    modelIds,
    modelIdsError,
    thinkingEnabled,
    modalityEnabled,
    modalityImage,
    modalityVideo,
    modalityAudio,
    modalityPdf,
    contextWindowSize,
    focusedConfigIndex,
    previewJson: preview.json,
    previewError: preview.error,
  };

  return {
    state,
    start,
    reset,
    goBack,
    submitBaseUrl,
    changeBaseUrl,
    changeApiKey,
    submitApiKey,
    changeModelIds,
    clearModelIdsError,
    submitModelIds,
    moveAdvancedFocusUp,
    moveAdvancedFocusDown,
    toggleFocusedAdvancedOption,
    changeContextWindowSize,
    submitAdvancedConfig,
    submit,
  };
}

export type ProviderSetupFlow = ReturnType<typeof useProviderSetupFlow>;
