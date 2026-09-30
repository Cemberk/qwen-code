/* eslint-disable react/no-unknown-property */
/** @jsxImportSource @opentui/react */
/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Full /auth onboarding flow (#57, M4 fidelity pass): a native OpenTUI port
 * of ink's AuthDialog + ProviderSetupSteps for the one supported provider, a
 * local OpenAI-compatible server. The setup-flow state (useProviderSetupFlow —
 * renderer-agnostic, reused verbatim from the ink tree) and the final submit
 * (buildInstallPlan → applyProviderInstallPlan, the same write path
 * useAuth.handleProviderSubmit drives) mirror the ink implementation; only
 * the view layer is OpenTUI.
 *
 * Steps: base URL → API key → model IDs → advanced config → review. The base
 * URL has no default and must be a loopback URL (validated by the flow).
 */

import { useCallback, useLayoutEffect, useMemo, useState } from 'react';
import { useKeyboard, usePaste, useRenderer } from '@opentui/react';
import type { PasteEvent } from '@opentui/core';
import { decodePasteBytes } from '@opentui/core';
import type {
  Config,
  ProviderConfig,
  ProviderSetupInputs,
} from '@qwen-code/qwen-code-core';
import {
  AuthEvent,
  applyProviderInstallPlan,
  buildInstallPlan,
  customProvider,
  findExistingProviderModels,
  getErrorMessage,
  getProviderModels,
  logAuth,
} from '@qwen-code/qwen-code-core';
import type { LoadedSettings } from '../../config/settings.js';
import {
  createLoadedSettingsAdapter,
  getRawModelProviders,
} from '../../config/loadedSettingsAdapter.js';
import { t } from '../../i18n/index.js';
import { ICON } from '../constants.js';
import {
  useProviderSetupFlow,
  type ProviderSetupFlow,
} from '../auth/useProviderSetupFlow.js';
import { normalizeModelIds } from '../auth/useAuth.js';
import { toOriginalKey } from './key-map.js';
import { isPrintableKeyInput } from './input-prompt-key.js';
import { normalizePastedText } from './input-prompt-model.js';
import { sanitizeTerminalText } from '../utils/textUtils.js';
import { caretSpans, useLineEdit } from './line-edit.js';
import { Shell } from './dialogs-misc.js';
import { C } from './theme.js';

// ---------------------------------------------------------------------------
// Static data
// ---------------------------------------------------------------------------

function getStepLabel(step: string | null): string {
  if (step === 'baseUrl') return t('Base URL');
  if (step === 'apiKey') return t('API Key');
  if (step === 'models') return t('Model IDs');
  if (step === 'advancedConfig') return t('Advanced Config');
  if (step === 'review') return t('Review');
  return '';
}

const NAV_HINT_INPUT = t('Enter to submit, Esc to go back');

// ---------------------------------------------------------------------------
// Shared view primitives
// ---------------------------------------------------------------------------

/**
 * A dialog field's text with ink's software cursor: the cell under the caret
 * drawn on a background, and an empty field putting that cell on its
 * placeholder's first character so it still shows where text will start.
 */
function FieldText({
  value,
  caret,
  placeholder,
  active,
}: {
  value: string;
  caret: number;
  placeholder?: string;
  active?: boolean;
}) {
  if (value.length === 0 && placeholder) {
    if (!active) return <text fg={C.dim}>{placeholder}</text>;
    return (
      <>
        <text bg={C.accent}>{placeholder.slice(0, 1)}</text>
        <text fg={C.dim}>{placeholder.slice(1)}</text>
      </>
    );
  }
  const spans = caretSpans({ text: value, cursor: caret });
  return (
    <>
      <text fg={C.text}>{sanitizeTerminalText(spans.before)}</text>
      {/* The character belongs to the value whatever owns the focus; only the
          highlight says which field the caret is in. Dropping it while inactive
          would print a value one character shorter than the one held. */}
      {active ? (
        <text bg={C.accent}>{sanitizeTerminalText(spans.at) || ' '}</text>
      ) : (
        <text fg={C.text}>{sanitizeTerminalText(spans.at)}</text>
      )}
      <text fg={C.text}>{sanitizeTerminalText(spans.after)}</text>
    </>
  );
}

function InputLine({
  value,
  caret,
  placeholder,
  active,
}: {
  value: string;
  caret: number;
  placeholder?: string;
  active?: boolean;
}) {
  return (
    <box flexDirection="row" marginTop={1}>
      <text fg={C.accent}>{'> '}</text>
      <FieldText
        value={value}
        caret={caret}
        placeholder={placeholder}
        active={active}
      />
    </box>
  );
}

/**
 * Shared single-line text-input key handling (backend ask-user parity). Returns
 * the caret offset so the row can put its cursor cell where ink's would be. The
 * submit's own verdict is what settles the field, so a step that reports nothing
 * cannot leave the latch unarmed.
 */
function useLineInputKeys(
  value: string,
  onChange: (next: string) => void,
  onSubmit: (text: string) => boolean,
): number {
  const line = useLineEdit(value, onChange);
  useKeyboard((key) => {
    if (line.settled) return;
    const o = toOriginalKey(key);
    if (o.name === 'return' || o.name === 'enter') {
      if (onSubmit(line.text)) line.settle();
      return;
    }
    if (!line.handleKey(o) && isPrintableKeyInput(key)) {
      line.insert(key.sequence);
    }
  });
  // Bracketed pastes arrive as one PasteEvent with no keypress per character
  // (ink parity: its keypress state machine broadcasts the buffered paste as a
  // single `paste` key, which TextInput's buffer inserts verbatim). The main
  // composer's editor is unfocused while a dialog owns input, so consume the
  // paste here instead of letting it drop.
  usePaste((event: PasteEvent) => {
    const text = normalizePastedText(decodePasteBytes(event.bytes));
    if (!text) return;
    event.preventDefault();
    line.insert(text);
  });
  return line.caret;
}

// ---------------------------------------------------------------------------
// Setup steps (ProviderSetupSteps parity)
// ---------------------------------------------------------------------------

function BaseUrlStep({ flow }: { flow: ProviderSetupFlow }) {
  const caret = useLineInputKeys(
    flow.state.baseUrl,
    flow.changeBaseUrl,
    (text) => flow.submitBaseUrl(text),
  );
  return (
    <box flexDirection="column" marginTop={1}>
      <text fg={C.text}>
        {t('Enter the base URL of the local OpenAI-compatible server.')}
      </text>
      <text fg={C.dim}>
        {t('The host must be 127.0.0.1, ::1 or localhost.')}
      </text>
      <InputLine value={flow.state.baseUrl} caret={caret} active />
      {flow.state.baseUrlError && (
        <box marginTop={1}>
          <text fg={C.red}>{flow.state.baseUrlError}</text>
        </box>
      )}
      <box marginTop={1}>
        <text fg={C.dim}>{NAV_HINT_INPUT}</text>
      </box>
    </box>
  );
}

function ApiKeyStep({
  provider,
  flow,
}: {
  provider: ProviderConfig;
  flow: ProviderSetupFlow;
}) {
  const caret = useLineInputKeys(flow.state.apiKey, flow.changeApiKey, (text) =>
    flow.submitApiKey(text),
  );
  return (
    <box flexDirection="column" marginTop={1}>
      <InputLine
        value={flow.state.apiKey}
        caret={caret}
        placeholder={provider.apiKeyPlaceholder ?? 'sk-...'}
        active
      />
      {flow.state.apiKeyError && (
        <box marginTop={1}>
          <text fg={C.red}>{flow.state.apiKeyError}</text>
        </box>
      )}
      <box marginTop={1}>
        <text fg={C.dim}>{NAV_HINT_INPUT}</text>
      </box>
    </box>
  );
}

/** Model IDs step: comma-separated manual entry (ink ModelIdsStep parity). */
function ModelsStep({ flow }: { flow: ProviderSetupFlow }) {
  const caret = useLineInputKeys(
    flow.state.modelIds,
    flow.changeModelIds,
    (text) => flow.submitModelIds({ modelIds: normalizeModelIds(text) }),
  );
  return (
    <box flexDirection="column" marginTop={1}>
      <box marginTop={1}>
        <text fg={C.dim}>{t('Enter model IDs separated by commas.')}</text>
      </box>
      <InputLine
        value={flow.state.modelIds}
        caret={caret}
        placeholder="model-id-1, model-id-2"
        active
      />
      {flow.state.modelIdsError && (
        <box marginTop={1}>
          <text fg={C.red}>{flow.state.modelIdsError}</text>
        </box>
      )}
      <box marginTop={1}>
        <text fg={C.dim}>{NAV_HINT_INPUT}</text>
      </box>
    </box>
  );
}

function AdvancedConfigStep({ flow }: { flow: ProviderSetupFlow }) {
  const {
    thinkingEnabled,
    modalityEnabled,
    modalityImage,
    modalityVideo,
    modalityAudio,
    modalityPdf,
    contextWindowSize,
    focusedConfigIndex,
  } = flow.state;
  const ctxIdx = modalityEnabled ? 6 : 2;
  const onCtxRow = focusedConfigIndex === ctxIdx;
  const ctxField = useLineEdit(contextWindowSize, flow.changeContextWindowSize);
  useKeyboard((key) => {
    if (ctxField.settled) return;
    const o = toOriginalKey(key);
    // Focus-row navigation restricted to unambiguous shortcuts (ink parity:
    // a letter typed into the context-window field must not move the row).
    if (o.name === 'up' || (o.ctrl && o.name === 'p')) {
      flow.moveAdvancedFocusUp();
      return;
    }
    if (o.name === 'down' || (o.ctrl && o.name === 'n')) {
      flow.moveAdvancedFocusDown();
      return;
    }
    if (o.name === 'space') {
      // On the context row Space inserts a space into the field; the flow's
      // toggleFocusedAdvancedOption has no case for ctxIdx (ink parity).
      if (onCtxRow) ctxField.insert(' ');
      else flow.toggleFocusedAdvancedOption();
      return;
    }
    if (o.name === 'return') {
      flow.submitAdvancedConfig();
      ctxField.settle();
      return;
    }
    if (onCtxRow && !ctxField.handleKey(o) && isPrintableKeyInput(key)) {
      ctxField.insert(key.sequence);
    }
  });
  // Only the context-window field accepts text; a paste while another row is
  // focused should not move any toggle.
  usePaste((event: PasteEvent) => {
    if (!onCtxRow) return;
    const text = normalizePastedText(decodePasteBytes(event.bytes));
    if (!text) return;
    event.preventDefault();
    ctxField.insert(text);
  });
  const checkmark = (v: boolean) => (v ? ICON.RADIO_FILLED : ICON.CIRCLE_EMPTY);
  const cursor = (index: number) => (focusedConfigIndex === index ? '›' : ' ');
  const rowFg = (index: number) =>
    focusedConfigIndex === index ? C.green : undefined;
  return (
    <box flexDirection="column" marginTop={1}>
      <text fg={C.text}>
        {t('Optional: configure advanced generation settings.')}
      </text>
      <box flexDirection="row" marginTop={1} paddingLeft={2}>
        <text fg={rowFg(0)}>
          {`${cursor(0)} ${checkmark(thinkingEnabled)} ${t('Enable thinking')}`}
        </text>
      </box>
      <box paddingLeft={4}>
        <text fg={C.dim}>
          {t(
            'Allows the model to perform extended reasoning before responding.',
          )}
        </text>
      </box>
      <box flexDirection="row" marginTop={1} paddingLeft={2}>
        <text fg={rowFg(1)}>
          {`${cursor(1)} ${checkmark(modalityEnabled)} ${t('Enable modality')}`}
        </text>
      </box>
      <box paddingLeft={4}>
        <text fg={C.dim}>
          {t('Enables multimodal input capabilities (image, video, etc.).')}
        </text>
      </box>
      {modalityEnabled && (
        <box flexDirection="row" paddingLeft={6}>
          <text
            fg={rowFg(2)}
          >{`${cursor(2)} ${checkmark(modalityImage)} Image  `}</text>
          <text
            fg={rowFg(3)}
          >{`${cursor(3)} ${checkmark(modalityVideo)} Video  `}</text>
          <text
            fg={rowFg(4)}
          >{`${cursor(4)} ${checkmark(modalityAudio)} Audio  `}</text>
          <text
            fg={rowFg(5)}
          >{`${cursor(5)} ${checkmark(modalityPdf)} PDF`}</text>
        </box>
      )}
      <box flexDirection="row" marginTop={1} paddingLeft={2}>
        <text
          fg={rowFg(ctxIdx)}
        >{`${cursor(ctxIdx)} ${t('Context window')}: `}</text>
        <FieldText
          value={contextWindowSize}
          caret={ctxField.caret}
          placeholder="auto"
          active={onCtxRow}
        />
      </box>
      <box paddingLeft={4}>
        <text fg={C.dim}>
          {t('Max input tokens (leave empty to auto-detect from model name).')}
        </text>
      </box>
      <box marginTop={1}>
        <text fg={C.dim}>
          {t(
            '↑↓ to navigate, Space to toggle, Enter to continue, Esc to go back',
          )}
        </text>
      </box>
    </box>
  );
}

function ReviewStep({ flow }: { flow: ProviderSetupFlow }) {
  useKeyboard((key) => {
    const o = toOriginalKey(key);
    if (o.name === 'return') flow.submit();
  });
  return (
    <box flexDirection="column" marginTop={1}>
      <text fg={C.text}>
        {t('The following JSON will be saved to settings.json:')}
      </text>
      <box marginTop={1}>
        {flow.state.previewError ? (
          <text fg={C.red}>{flow.state.previewError}</text>
        ) : (
          <text fg={C.text}>{flow.state.previewJson}</text>
        )}
      </box>
      <box marginTop={1}>
        <text fg={C.dim}>{t('Enter to save, Esc to go back')}</text>
      </box>
    </box>
  );
}

function SetupSteps({ flow }: { flow: ProviderSetupFlow }) {
  const { provider, step } = flow.state;
  if (!provider || !step) return null;
  switch (step) {
    case 'baseUrl':
      return <BaseUrlStep flow={flow} />;
    case 'apiKey':
      return <ApiKeyStep provider={provider} flow={flow} />;
    case 'models':
      return <ModelsStep flow={flow} />;
    case 'advancedConfig':
      return <AdvancedConfigStep flow={flow} />;
    case 'review':
      return <ReviewStep flow={flow} />;
    default:
      return null;
  }
}

// ---------------------------------------------------------------------------
// AuthDialog
// ---------------------------------------------------------------------------

type AuthDialogProps = {
  config?: Config;
  settings: LoadedSettings;
  onClose: () => void;
  /** Append a command-style message to the chat history (success feedback). */
  notify?: (text: string) => void;
  /** Startup auth failure surfaced by the auto-open (U-6); null when the
   * dialog opened because no auth type is configured. */
  initialError?: string;
};

export function OpenTuiAuthDialog(props: AuthDialogProps) {
  // Without a live config (settings-only mount) there is nothing to connect:
  // keep the pre-flow read-only summary instead of a broken wizard.
  if (!props.config) {
    return (
      <Shell title={t('Auth')} onClose={props.onClose}>
        <box flexDirection="column" marginTop={1}>
          <text fg={C.dim}>
            {t('Credentials resolved from settings/env; use /model to switch.')}
          </text>
        </box>
      </Shell>
    );
  }
  return <AuthDialogFlow {...props} config={props.config} />;
}

function AuthDialogFlow({
  config,
  settings,
  onClose,
  notify,
  initialError,
}: AuthDialogProps & { config: Config }) {
  const [errorMessage, setErrorMessage] = useState<string | null>(
    initialError ?? null,
  );

  // -- Submit (useAuth.handleProviderSubmit parity: same install-plan write
  // path, feedback message and auth telemetry; dialog-local error surface) --

  const handleProviderSubmit = useCallback(
    async (providerConfig: ProviderConfig, inputs: ProviderSetupInputs) => {
      try {
        const plan = buildInstallPlan(
          providerConfig,
          inputs,
          getProviderModels(settings.merged.modelProviders),
        );
        await applyProviderInstallPlan(plan, {
          settings: createLoadedSettingsAdapter(settings),
          reloadModelProviders: (mp) => config.reloadModelProvidersConfig(mp),
          syncAuthState: (authType, modelId, baseUrl) =>
            config.syncModelSelection(authType, modelId, baseUrl),
          refreshAuth: (authType) => config.refreshAuth(authType),
        });
        notify?.(
          t(
            'Successfully configured {{provider}}. Use /model to switch models.',
            {
              provider: providerConfig.label,
            },
          ),
        );
        logAuth(config, new AuthEvent(plan.authType, 'manual', 'success'));
        onClose();
      } catch (error) {
        const msg = t('Failed to authenticate. Message: {{message}}', {
          message: getErrorMessage(error),
        });
        setErrorMessage(msg);
        logAuth(
          config,
          new AuthEvent(providerConfig.protocol, 'manual', 'error', msg),
        );
      }
    },
    [settings, config, notify, onClose],
  );

  const setupFlow = useProviderSetupFlow(
    handleProviderSubmit,
    settings.merged.modelProviders,
    getRawModelProviders(settings),
  );

  // The dialog opens straight on the local-server setup, prefilled with the
  // model IDs already saved for it.
  const { start } = setupFlow;
  useLayoutEffect(() => {
    const saved = findExistingProviderModels(
      customProvider,
      settings.merged.modelProviders,
    );
    start(customProvider, saved?.models.map((m) => m.id) ?? []);
    // Mount-only: re-running would throw away what the user typed.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // -- Esc (raw input, consumed before parsed-key dispatch) -----------------

  const renderer = useRenderer();
  useLayoutEffect(() => {
    const onRaw = (seq: string): boolean => {
      if (seq !== '\x1b') return false;
      if (setupFlow.state.stepIndex > 1) {
        setErrorMessage(null);
        setupFlow.goBack();
        return true;
      }
      // The swallow is for an error the dialog armed itself; a boot-seeded
      // initialError must fall through, or the auto-opened dialog could never
      // be dismissed with Esc.
      if (initialError && errorMessage === initialError) {
        // ...and falling through means reaching the unauthenticated arm when
        // no auth type exists yet, which would overwrite the boot diagnostic
        // with the must-connect message and wedge the dialog shut (R2-1).
        onClose();
        return true;
      }
      if (errorMessage) return true;
      if (config.getAuthType() === undefined) {
        setErrorMessage(
          t(
            'You must connect a provider to proceed. Press Ctrl+C again to exit.',
          ),
        );
        return true;
      }
      onClose();
      return true;
    };
    renderer.addInputHandler(onRaw);
    return () => renderer.removeInputHandler(onRaw);
  }, [renderer, setupFlow, errorMessage, initialError, config, onClose]);

  // -- View title -------------------------------------------------------------

  const viewTitle = useMemo(() => {
    const { provider, stepIndex, totalSteps, step } = setupFlow.state;
    return t('{{flowTitle}} · Step {{step}}/{{total}} · {{stepLabel}}', {
      flowTitle: (provider ?? customProvider).label,
      step: String(stepIndex),
      total: String(totalSteps),
      stepLabel: getStepLabel(step),
    });
  }, [setupFlow.state]);

  // -- Render -------------------------------------------------------------------

  return (
    <Shell title={viewTitle} onClose={onClose} borderStyle="single">
      <SetupSteps flow={setupFlow} />
      {errorMessage && (
        <box marginTop={1}>
          <text fg={C.red}>{errorMessage}</text>
        </box>
      )}
    </Shell>
  );
}
