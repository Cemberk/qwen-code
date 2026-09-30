/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  type ExtensionUpdateState,
  extensionUpdatesReducer,
  initialExtensionUpdatesState,
} from '../state/extensions.js';
import { useCallback, useMemo, useReducer } from 'react';
import {
  type ConfirmationRequest,
  type SettingInputRequest,
  type PluginChoiceRequest,
} from '../types.js';
import { checkExhaustive } from '../../utils/checks.js';

type ConfirmationRequestWrapper = {
  prompt: React.ReactNode;
  onConfirm: (confirmed: boolean) => void;
};

type ConfirmationRequestAction =
  | { type: 'add'; request: ConfirmationRequestWrapper }
  | { type: 'remove'; request: ConfirmationRequestWrapper };

function confirmationRequestsReducer(
  state: ConfirmationRequestWrapper[],
  action: ConfirmationRequestAction,
): ConfirmationRequestWrapper[] {
  switch (action.type) {
    case 'add':
      return [...state, action.request];
    case 'remove':
      return state.filter((r) => r !== action.request);
    default:
      checkExhaustive(action);
      return state;
  }
}

export const useConfirmUpdateRequests = () => {
  const [
    confirmUpdateExtensionRequests,
    dispatchConfirmUpdateExtensionRequests,
  ] = useReducer(confirmationRequestsReducer, []);
  const addConfirmUpdateExtensionRequest = useCallback(
    (original: ConfirmationRequest) => {
      const wrappedRequest = {
        prompt: original.prompt,
        onConfirm: (confirmed: boolean) => {
          // Remove it from the outstanding list of requests by identity.
          dispatchConfirmUpdateExtensionRequests({
            type: 'remove',
            request: wrappedRequest,
          });
          original.onConfirm(confirmed);
        },
      };
      dispatchConfirmUpdateExtensionRequests({
        type: 'add',
        request: wrappedRequest,
      });
    },
    [dispatchConfirmUpdateExtensionRequests],
  );
  return {
    addConfirmUpdateExtensionRequest,
    confirmUpdateExtensionRequests,
    dispatchConfirmUpdateExtensionRequests,
  };
};

type SettingInputRequestWrapper = {
  settingName: string;
  settingDescription: string;
  sensitive: boolean;
  onSubmit: (value: string) => void;
  onCancel: () => void;
};

type SettingInputRequestAction =
  | { type: 'add'; request: SettingInputRequestWrapper }
  | { type: 'remove'; request: SettingInputRequestWrapper };

function settingInputRequestsReducer(
  state: SettingInputRequestWrapper[],
  action: SettingInputRequestAction,
): SettingInputRequestWrapper[] {
  switch (action.type) {
    case 'add':
      return [...state, action.request];
    case 'remove':
      return state.filter((r) => r !== action.request);
    default:
      checkExhaustive(action);
      return state;
  }
}

export const useSettingInputRequests = () => {
  const [settingInputRequests, dispatchSettingInputRequests] = useReducer(
    settingInputRequestsReducer,
    [],
  );
  const addSettingInputRequest = useCallback(
    (original: SettingInputRequest) => {
      const wrappedRequest: SettingInputRequestWrapper = {
        settingName: original.settingName,
        settingDescription: original.settingDescription,
        sensitive: original.sensitive,
        onSubmit: (value: string) => {
          // Remove it from the outstanding list of requests by identity.
          dispatchSettingInputRequests({
            type: 'remove',
            request: wrappedRequest,
          });
          original.onSubmit(value);
        },
        onCancel: () => {
          dispatchSettingInputRequests({
            type: 'remove',
            request: wrappedRequest,
          });
          original.onCancel();
        },
      };
      dispatchSettingInputRequests({
        type: 'add',
        request: wrappedRequest,
      });
    },
    [dispatchSettingInputRequests],
  );
  return {
    addSettingInputRequest,
    settingInputRequests,
    dispatchSettingInputRequests,
  };
};

type PluginChoiceRequestWrapper = {
  marketplaceName: string;
  plugins: Array<{ name: string; description?: string }>;
  onSelect: (pluginName: string) => void;
  onCancel: () => void;
};

type PluginChoiceRequestAction =
  | { type: 'add'; request: PluginChoiceRequestWrapper }
  | { type: 'remove'; request: PluginChoiceRequestWrapper };

function pluginChoiceRequestsReducer(
  state: PluginChoiceRequestWrapper[],
  action: PluginChoiceRequestAction,
): PluginChoiceRequestWrapper[] {
  switch (action.type) {
    case 'add':
      return [...state, action.request];
    case 'remove':
      return state.filter((r) => r !== action.request);
    default:
      checkExhaustive(action);
      return state;
  }
}

export const usePluginChoiceRequests = () => {
  const [pluginChoiceRequests, dispatchPluginChoiceRequests] = useReducer(
    pluginChoiceRequestsReducer,
    [],
  );
  const addPluginChoiceRequest = useCallback(
    (original: PluginChoiceRequest) => {
      const wrappedRequest: PluginChoiceRequestWrapper = {
        marketplaceName: original.marketplaceName,
        plugins: original.plugins,
        onSelect: (pluginName: string) => {
          dispatchPluginChoiceRequests({
            type: 'remove',
            request: wrappedRequest,
          });
          original.onSelect(pluginName);
        },
        onCancel: () => {
          dispatchPluginChoiceRequests({
            type: 'remove',
            request: wrappedRequest,
          });
          original.onCancel();
        },
      };
      dispatchPluginChoiceRequests({
        type: 'add',
        request: wrappedRequest,
      });
    },
    [dispatchPluginChoiceRequests],
  );
  return {
    addPluginChoiceRequest,
    pluginChoiceRequests,
    dispatchPluginChoiceRequests,
  };
};

export const useExtensionUpdates = () => {
  const [extensionsUpdateState, dispatchExtensionStateUpdate] = useReducer(
    extensionUpdatesReducer,
    initialExtensionUpdatesState,
  );

  const extensionsUpdateStateComputed = useMemo(() => {
    const result = new Map<string, ExtensionUpdateState>();
    for (const [
      key,
      value,
    ] of extensionsUpdateState.extensionStatuses.entries()) {
      result.set(key, value.status);
    }
    return result;
  }, [extensionsUpdateState]);

  return {
    extensionsUpdateState: extensionsUpdateStateComputed,
    extensionsUpdateStateInternal: extensionsUpdateState.extensionStatuses,
    dispatchExtensionStateUpdate,
  };
};
