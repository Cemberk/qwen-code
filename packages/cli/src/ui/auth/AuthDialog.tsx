/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type React from 'react';
import { useEffect, useState } from 'react';
import { Box, Text } from 'ink';
import { customProvider } from '@qwen-code/qwen-code-core/providers/presets/custom-provider.js';
import { findExistingProviderModels } from '@qwen-code/qwen-code-core/providers/provider-config.js';
import { theme } from '../semantic-colors.js';
import { useKeypress } from '../hooks/useKeypress.js';
import { useUIState } from '../contexts/UIStateContext.js';
import { useUIActions } from '../contexts/UIActionsContext.js';
import { useConfig } from '../contexts/ConfigContext.js';
import { useSettings } from '../contexts/SettingsContext.js';
import { t } from '../../i18n/index.js';
import { getRawModelProviders } from '../../config/loadedSettingsAdapter.js';
import {
  useProviderSetupFlow,
  type SetupStep,
} from './useProviderSetupFlow.js';
import { ProviderSetupSteps } from './ProviderSetupSteps.js';

function getStepLabel(step: SetupStep | null): string {
  switch (step) {
    case 'baseUrl':
      return t('Base URL');
    case 'apiKey':
      return t('API Key');
    case 'models':
      return t('Model IDs');
    case 'advancedConfig':
      return t('Advanced Config');
    case 'review':
      return t('Review');
    default:
      return '';
  }
}

/**
 * /auth: connect a local OpenAI-compatible server (base URL → API key →
 * model IDs → advanced config → review).
 */
export function AuthDialog(): React.JSX.Element {
  const {
    auth: { authError },
  } = useUIState();
  const {
    auth: { closeAuthDialog, handleProviderSubmit, onAuthError },
  } = useUIActions();
  const config = useConfig();
  const settings = useSettings();

  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  const setupFlow = useProviderSetupFlow(
    handleProviderSubmit,
    settings.merged.modelProviders,
    getRawModelProviders(settings),
  );

  // Open straight on the setup steps, pre-filling the model ids saved by an
  // earlier setup.
  const { start } = setupFlow;
  useEffect(() => {
    const saved = findExistingProviderModels(
      customProvider,
      settings.merged.modelProviders,
    );
    start(customProvider, saved?.models.map((model) => model.id) ?? []);
    // Only on mount: later settings writes must not restart the wizard.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [start]);

  useKeypress(
    (key) => {
      if (key.name !== 'escape') return;
      if (setupFlow.state.stepIndex > 1) {
        setErrorMessage(null);
        onAuthError(null);
        setupFlow.goBack();
        return;
      }
      if (errorMessage) return;
      if (config.getAuthType() === undefined) {
        setErrorMessage(
          t(
            'You must connect a provider to proceed. Press Ctrl+C again to exit.',
          ),
        );
        return;
      }
      closeAuthDialog();
    },
    { isActive: true },
  );

  const { provider, stepIndex, totalSteps, step } = setupFlow.state;
  const title = provider
    ? t('{{flowTitle}} · Step {{step}}/{{total}} · {{stepLabel}}', {
        flowTitle: provider.label,
        step: String(stepIndex),
        total: String(totalSteps),
        stepLabel: getStepLabel(step),
      })
    : customProvider.label;

  return (
    <Box
      borderStyle="single"
      borderColor={theme?.border?.default}
      flexDirection="column"
      padding={1}
      width="100%"
    >
      <Text bold>{title}</Text>

      <ProviderSetupSteps flow={setupFlow} />

      {(authError || errorMessage) && (
        <Box marginTop={1}>
          <Text color={theme.status.error}>{authError || errorMessage}</Text>
        </Box>
      )}
    </Box>
  );
}
