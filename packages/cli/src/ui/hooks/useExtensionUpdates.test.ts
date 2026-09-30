/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */
// @vitest-environment jsdom

import { vi, describe, it, expect } from 'vitest';

import {
  useExtensionUpdates,
  useSettingInputRequests,
  useConfirmUpdateRequests,
  usePluginChoiceRequests,
} from './useExtensionUpdates.js';
import { ExtensionUpdateState } from '../state/extensions.js';
import { renderHook, act } from '@testing-library/react';

describe('useConfirmUpdateRequests', () => {
  it('should add a confirmation request', () => {
    const { result } = renderHook(() => useConfirmUpdateRequests());

    const onConfirm = vi.fn();
    act(() => {
      result.current.addConfirmUpdateExtensionRequest({
        prompt: 'Test prompt',
        onConfirm,
      });
    });

    expect(result.current.confirmUpdateExtensionRequests).toHaveLength(1);
    expect(result.current.confirmUpdateExtensionRequests[0].prompt).toBe(
      'Test prompt',
    );
  });

  it('should remove a confirmation request when confirmed', () => {
    const { result } = renderHook(() => useConfirmUpdateRequests());

    const onConfirm = vi.fn();
    act(() => {
      result.current.addConfirmUpdateExtensionRequest({
        prompt: 'Test prompt',
        onConfirm,
      });
    });

    expect(result.current.confirmUpdateExtensionRequests).toHaveLength(1);

    // Confirm the request
    act(() => {
      result.current.confirmUpdateExtensionRequests[0].onConfirm(true);
    });

    expect(result.current.confirmUpdateExtensionRequests).toHaveLength(0);
    expect(onConfirm).toHaveBeenCalledWith(true);
  });

  it('should handle multiple confirmation requests', () => {
    const { result } = renderHook(() => useConfirmUpdateRequests());

    const onConfirm1 = vi.fn();
    const onConfirm2 = vi.fn();

    act(() => {
      result.current.addConfirmUpdateExtensionRequest({
        prompt: 'Prompt 1',
        onConfirm: onConfirm1,
      });
      result.current.addConfirmUpdateExtensionRequest({
        prompt: 'Prompt 2',
        onConfirm: onConfirm2,
      });
    });

    expect(result.current.confirmUpdateExtensionRequests).toHaveLength(2);

    // Confirm first request
    act(() => {
      result.current.confirmUpdateExtensionRequests[0].onConfirm(false);
    });

    expect(result.current.confirmUpdateExtensionRequests).toHaveLength(1);
    expect(result.current.confirmUpdateExtensionRequests[0].prompt).toBe(
      'Prompt 2',
    );
    expect(onConfirm1).toHaveBeenCalledWith(false);
  });
});

describe('useSettingInputRequests', () => {
  it('should add a setting input request', () => {
    const { result } = renderHook(() => useSettingInputRequests());

    const onSubmit = vi.fn();
    const onCancel = vi.fn();
    act(() => {
      result.current.addSettingInputRequest({
        settingName: 'API_KEY',
        settingDescription: 'Enter your API key',
        sensitive: true,
        onSubmit,
        onCancel,
      });
    });

    expect(result.current.settingInputRequests).toHaveLength(1);
    expect(result.current.settingInputRequests[0].settingName).toBe('API_KEY');
    expect(result.current.settingInputRequests[0].settingDescription).toBe(
      'Enter your API key',
    );
    expect(result.current.settingInputRequests[0].sensitive).toBe(true);
  });

  it('should remove a setting input request when submitted', () => {
    const { result } = renderHook(() => useSettingInputRequests());

    const onSubmit = vi.fn();
    const onCancel = vi.fn();
    act(() => {
      result.current.addSettingInputRequest({
        settingName: 'API_KEY',
        settingDescription: 'Enter your API key',
        sensitive: true,
        onSubmit,
        onCancel,
      });
    });

    expect(result.current.settingInputRequests).toHaveLength(1);

    // Submit the value
    act(() => {
      result.current.settingInputRequests[0].onSubmit('my-secret-key');
    });

    expect(result.current.settingInputRequests).toHaveLength(0);
    expect(onSubmit).toHaveBeenCalledWith('my-secret-key');
    expect(onCancel).not.toHaveBeenCalled();
  });

  it('should remove a setting input request when cancelled', () => {
    const { result } = renderHook(() => useSettingInputRequests());

    const onSubmit = vi.fn();
    const onCancel = vi.fn();
    act(() => {
      result.current.addSettingInputRequest({
        settingName: 'API_KEY',
        settingDescription: 'Enter your API key',
        sensitive: true,
        onSubmit,
        onCancel,
      });
    });

    expect(result.current.settingInputRequests).toHaveLength(1);

    // Cancel the request
    act(() => {
      result.current.settingInputRequests[0].onCancel();
    });

    expect(result.current.settingInputRequests).toHaveLength(0);
    expect(onCancel).toHaveBeenCalled();
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it('should handle multiple setting input requests in sequence', () => {
    const { result } = renderHook(() => useSettingInputRequests());

    const onSubmit1 = vi.fn();
    const onCancel1 = vi.fn();
    const onSubmit2 = vi.fn();
    const onCancel2 = vi.fn();

    act(() => {
      result.current.addSettingInputRequest({
        settingName: 'USERNAME',
        settingDescription: 'Enter username',
        sensitive: false,
        onSubmit: onSubmit1,
        onCancel: onCancel1,
      });
      result.current.addSettingInputRequest({
        settingName: 'PASSWORD',
        settingDescription: 'Enter password',
        sensitive: true,
        onSubmit: onSubmit2,
        onCancel: onCancel2,
      });
    });

    expect(result.current.settingInputRequests).toHaveLength(2);

    // Submit first request
    act(() => {
      result.current.settingInputRequests[0].onSubmit('john_doe');
    });

    expect(result.current.settingInputRequests).toHaveLength(1);
    expect(result.current.settingInputRequests[0].settingName).toBe('PASSWORD');
    expect(onSubmit1).toHaveBeenCalledWith('john_doe');

    // Submit second request
    act(() => {
      result.current.settingInputRequests[0].onSubmit('secret123');
    });

    expect(result.current.settingInputRequests).toHaveLength(0);
    expect(onSubmit2).toHaveBeenCalledWith('secret123');
  });
});

describe('useExtensionUpdates', () => {
  it('starts empty and records dispatched update states', () => {
    const { result } = renderHook(() => useExtensionUpdates());
    expect(result.current.extensionsUpdateState.size).toBe(0);

    act(() => {
      result.current.dispatchExtensionStateUpdate({
        type: 'SET_STATE',
        payload: {
          name: 'test-extension',
          state: ExtensionUpdateState.UPDATE_AVAILABLE,
        },
      });
    });

    expect(result.current.extensionsUpdateState.get('test-extension')).toBe(
      ExtensionUpdateState.UPDATE_AVAILABLE,
    );
  });
});

describe('usePluginChoiceRequests', () => {
  it('should add a plugin choice request', () => {
    const { result } = renderHook(() => usePluginChoiceRequests());

    const onSelect = vi.fn();
    const onCancel = vi.fn();
    act(() => {
      result.current.addPluginChoiceRequest({
        marketplaceName: 'test-marketplace',
        plugins: [
          { name: 'plugin1', description: 'First plugin' },
          { name: 'plugin2', description: 'Second plugin' },
        ],
        onSelect,
        onCancel,
      });
    });

    expect(result.current.pluginChoiceRequests).toHaveLength(1);
    expect(result.current.pluginChoiceRequests[0].marketplaceName).toBe(
      'test-marketplace',
    );
    expect(result.current.pluginChoiceRequests[0].plugins).toHaveLength(2);
  });

  it('should remove a plugin choice request when a plugin is selected', () => {
    const { result } = renderHook(() => usePluginChoiceRequests());

    const onSelect = vi.fn();
    const onCancel = vi.fn();
    act(() => {
      result.current.addPluginChoiceRequest({
        marketplaceName: 'test-marketplace',
        plugins: [{ name: 'plugin1' }],
        onSelect,
        onCancel,
      });
    });

    expect(result.current.pluginChoiceRequests).toHaveLength(1);

    // Select a plugin
    act(() => {
      result.current.pluginChoiceRequests[0].onSelect('plugin1');
    });

    expect(result.current.pluginChoiceRequests).toHaveLength(0);
    expect(onSelect).toHaveBeenCalledWith('plugin1');
    expect(onCancel).not.toHaveBeenCalled();
  });

  it('should remove a plugin choice request when cancelled', () => {
    const { result } = renderHook(() => usePluginChoiceRequests());

    const onSelect = vi.fn();
    const onCancel = vi.fn();
    act(() => {
      result.current.addPluginChoiceRequest({
        marketplaceName: 'test-marketplace',
        plugins: [{ name: 'plugin1' }],
        onSelect,
        onCancel,
      });
    });

    expect(result.current.pluginChoiceRequests).toHaveLength(1);

    // Cancel the request
    act(() => {
      result.current.pluginChoiceRequests[0].onCancel();
    });

    expect(result.current.pluginChoiceRequests).toHaveLength(0);
    expect(onCancel).toHaveBeenCalled();
    expect(onSelect).not.toHaveBeenCalled();
  });

  it('should handle multiple plugin choice requests', () => {
    const { result } = renderHook(() => usePluginChoiceRequests());

    const onSelect1 = vi.fn();
    const onCancel1 = vi.fn();
    const onSelect2 = vi.fn();
    const onCancel2 = vi.fn();

    act(() => {
      result.current.addPluginChoiceRequest({
        marketplaceName: 'marketplace-1',
        plugins: [{ name: 'plugin1' }],
        onSelect: onSelect1,
        onCancel: onCancel1,
      });
      result.current.addPluginChoiceRequest({
        marketplaceName: 'marketplace-2',
        plugins: [{ name: 'plugin2' }],
        onSelect: onSelect2,
        onCancel: onCancel2,
      });
    });

    expect(result.current.pluginChoiceRequests).toHaveLength(2);

    // Select from first request
    act(() => {
      result.current.pluginChoiceRequests[0].onSelect('plugin1');
    });

    expect(result.current.pluginChoiceRequests).toHaveLength(1);
    expect(result.current.pluginChoiceRequests[0].marketplaceName).toBe(
      'marketplace-2',
    );
    expect(onSelect1).toHaveBeenCalledWith('plugin1');
  });
});
