/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import type {
  Extension,
  Config,
  ExtensionScope,
} from '@qwen-code/qwen-code-core';

/**
 * Scope groups used to organize the Installed tab.
 */
export type InstalledGroup = 'favorites' | 'user' | 'project' | 'disabled';

/** Minimal display info for an MCP server shown in the Installed tab. */
export interface InstalledMcpInfo {
  name: string;
  status: string;
  scope: 'user' | 'project' | 'extension';
  isDisabled: boolean;
  transport: string;
  toolCount: number;
}

/** A single row in the Installed tab — either a plugin/extension or an MCP. */
export type InstalledItem =
  | {
      kind: 'plugin';
      key: string;
      name: string;
      extension: Extension;
      isActive: boolean;
      isFavorite: boolean;
      scope: ExtensionScope;
      group: InstalledGroup;
    }
  | {
      kind: 'mcp';
      key: string;
      name: string;
      mcp: InstalledMcpInfo;
      isActive: boolean;
      isFavorite: boolean;
      group: InstalledGroup;
      /** Set when the MCP server is bundled with an extension; the row is
       * rendered indented under that extension. */
      parentExtension?: string;
    };

/**
 * Props for step navigation.
 */
export interface StepNavigationProps {
  onNavigateToStep: (step: string) => void;
  onNavigateBack: () => void;
}

/**
 * Props for the uninstall confirmation step.
 */
export interface UninstallConfirmStepProps extends StepNavigationProps {
  selectedExtension: Extension | null;
  onConfirm: (extension: Extension) => Promise<void>;
}

/**
 * Props for the ExtensionsManagerDialog component.
 */
export interface ExtensionsManagerDialogProps {
  onClose: () => void;
  config: Config | null;
}
