/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  AuthEvent,
  getErrorMessage,
  logAuth,
  type AuthType,
  type Config,
  buildInstallPlan,
  getProviderModels,
  applyProviderInstallPlan,
  type ProviderConfig,
  type ProviderSetupInputs,
  BUILT_IN_LOCAL_MODELS,
  validateLocalModels,
  withLocalModelProviders,
} from '@qwen-code/qwen-code-core';
import { useCallback, useMemo, useRef, useState } from 'react';
import type { LoadedSettings } from '../../config/settings.js';
import { createLoadedSettingsAdapter } from '../../config/loadedSettingsAdapter.js';
import { MessageType } from '../types.js';
import type { HistoryItemWithoutId } from '../types.js';
import { t } from '../../i18n/index.js';

/**
 * Normalize model IDs: split by comma, trim, deduplicate, remove empty.
 */
export function normalizeModelIds(modelIdsInput: string): string[] {
  return modelIdsInput
    .split(',')
    .map((id) => id.trim())
    .filter((id, index, array) => id.length > 0 && array.indexOf(id) === index);
}

/**
 * Mask an API key for display: show first 3 and last 4 chars.
 */
export function maskApiKey(apiKey: string): string {
  const trimmed = apiKey.trim();
  if (trimmed.length === 0) return '(not set)';
  if (trimmed.length <= 6) return '***';
  return `${trimmed.slice(0, 3)}...${trimmed.slice(-4)}`;
}

export type AuthUiState = {
  authError: string | null;
  isAuthDialogOpen: boolean;
  isAuthenticating: boolean;
};

export type AuthController = {
  state: AuthUiState;
  actions: {
    onAuthError: (error: string | null) => void;
    /** Close the /auth dialog without changing the active provider. */
    closeAuthDialog: () => void;
    /** Persist a provider's install plan and switch to it. */
    handleProviderSubmit: (
      providerConfig: ProviderConfig,
      inputs: ProviderSetupInputs,
    ) => Promise<void>;
    openAuthDialog: () => void;
  };
};

export const useAuthCommand = (
  settings: LoadedSettings,
  config: Config,
  addItem: (item: HistoryItemWithoutId, timestamp: number) => void,
  onAuthChange?: () => void,
) => {
  const unAuthenticated = config.getAuthType() === undefined;

  const [authError, setAuthError] = useState<string | null>(null);
  const [isAuthenticating, setIsAuthenticating] = useState(false);
  const [isAuthDialogOpen, setIsAuthDialogOpen] = useState(unAuthenticated);
  // The dialog also auto-opens at startup when unauthenticated; only a
  // command-opened dialog has an /auth invocation record to pair with.
  const openedViaCommandRef = useRef(false);

  // -- Shared helpers -------------------------------------------------------

  const onAuthError = useCallback((error: string | null) => {
    setAuthError(error);
    if (error) {
      setIsAuthDialogOpen(true);
    }
  }, []);

  const handleAuthFailure = useCallback(
    (error: unknown, authType: AuthType) => {
      setIsAuthenticating(false);
      const msg = t('Failed to authenticate. Message: {{message}}', {
        message: getErrorMessage(error),
      });
      onAuthError(msg);
      logAuth(config, new AuthEvent(authType, 'manual', 'error', msg));
    },
    [onAuthError, config],
  );

  const completeAuthentication = useCallback(() => {
    setAuthError(null);
    setIsAuthDialogOpen(false);
    setIsAuthenticating(false);
    onAuthChange?.();
  }, [onAuthChange]);

  // -- Provider connect -----------------------------------------------------

  const handleProviderSubmit = useCallback(
    async (providerConfig: ProviderConfig, inputs: ProviderSetupInputs) => {
      const protocol = providerConfig.protocol;
      try {
        setIsAuthenticating(true);
        setAuthError(null);

        const plan = buildInstallPlan(
          providerConfig,
          inputs,
          getProviderModels(settings.merged.modelProviders),
        );
        await applyProviderInstallPlan(plan, {
          settings: createLoadedSettingsAdapter(settings),
          // Keep the local models listed ahead of the saved providers.
          reloadModelProviders: (mp) =>
            config.reloadModelProvidersConfig(
              withLocalModelProviders(
                mp,
                validateLocalModels(
                  settings.merged.localModels ?? BUILT_IN_LOCAL_MODELS,
                ),
              ),
            ),
          syncAuthState: (authType, modelId, baseUrl) =>
            config.syncModelSelection(authType, modelId, baseUrl),
          refreshAuth: (authType) => config.refreshAuth(authType),
        });

        completeAuthentication();

        const feedbackItem: HistoryItemWithoutId & Record<string, unknown> = {
          type: MessageType.INFO,
          text: t(
            'Successfully configured {{provider}}. Use /model to switch models.',
            { provider: providerConfig.label },
          ),
        };
        addItem(feedbackItem, Date.now());
        if (openedViaCommandRef.current) {
          openedViaCommandRef.current = false;
          config.getChatRecordingService?.()?.recordSlashCommand({
            phase: 'result',
            rawCommand: '/auth',
            outputHistoryItems: [feedbackItem],
          });
        }

        logAuth(config, new AuthEvent(protocol, 'manual', 'success'));
      } catch (error) {
        handleAuthFailure(error, protocol);
      }
    },
    [settings, config, completeAuthentication, addItem, handleAuthFailure],
  );

  // -- Dialog open / close / cancel ----------------------------------------

  const openAuthDialog = useCallback(() => {
    openedViaCommandRef.current = true;
    setIsAuthDialogOpen(true);
  }, []);

  const closeAuthDialog = useCallback(() => {
    openedViaCommandRef.current = false;
    setIsAuthDialogOpen(false);
    setAuthError(null);
  }, []);

  // -- Public interface ----------------------------------------------------

  const state = useMemo<AuthUiState>(
    () => ({
      authError,
      isAuthDialogOpen,
      isAuthenticating,
    }),
    [authError, isAuthDialogOpen, isAuthenticating],
  );

  const actions = useMemo<AuthController['actions']>(
    () => ({
      onAuthError,
      closeAuthDialog,
      handleProviderSubmit,
      openAuthDialog,
    }),
    [onAuthError, closeAuthDialog, handleProviderSubmit, openAuthDialog],
  );

  return {
    authError,
    onAuthError,
    isAuthDialogOpen,
    isAuthenticating,
    closeAuthDialog,
    handleProviderSubmit,
    openAuthDialog,
    state,
    actions,
  };
};
