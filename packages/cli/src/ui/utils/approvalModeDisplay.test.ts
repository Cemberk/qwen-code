/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import { ApprovalMode } from '@qwen-code/qwen-code-core';
import {
  formatApprovalModeDescription,
  formatApprovalModeName,
} from './approvalModeDisplay.js';
import { setLanguageAsync } from '../../i18n/index.js';

describe('approval mode display', () => {
  describe('formatApprovalModeName', () => {
    it('formats all modes as friendly names', () => {
      expect(formatApprovalModeName(ApprovalMode.PLAN)).toBe('plan mode');
      expect(formatApprovalModeName(ApprovalMode.DEFAULT)).toBe(
        'Ask permissions',
      );
      expect(formatApprovalModeName(ApprovalMode.AUTO_EDIT)).toBe(
        'auto-accept edits',
      );
      expect(formatApprovalModeName(ApprovalMode.AUTO)).toBe('Auto mode');
      expect(formatApprovalModeName(ApprovalMode.YOLO)).toBe('YOLO mode');
    });

    it('formats mode names with the active locale', async () => {
      await setLanguageAsync('fr');
      try {
        expect(formatApprovalModeName(ApprovalMode.PLAN)).toBe('mode plan');
        expect(formatApprovalModeName(ApprovalMode.DEFAULT)).toBe(
          "Demander l'autorisation",
        );
        expect(formatApprovalModeName(ApprovalMode.AUTO_EDIT)).toBe(
          'acceptation automatique des modifications',
        );
        expect(formatApprovalModeName(ApprovalMode.AUTO)).toBe('Mode auto');
        expect(formatApprovalModeName(ApprovalMode.YOLO)).toBe('Mode YOLO');
      } finally {
        await setLanguageAsync('en');
      }
    });
  });

  describe('formatApprovalModeDescription', () => {
    it('uses a specific classifier description for auto mode', () => {
      expect(formatApprovalModeDescription(ApprovalMode.AUTO)).toBe(
        'Use classifier to automatically approve safe tool calls',
      );
    });

    it('describes the remaining modes', () => {
      expect(formatApprovalModeDescription(ApprovalMode.PLAN)).toBe(
        'Analyze only, do not modify files or execute commands',
      );
      expect(formatApprovalModeDescription(ApprovalMode.DEFAULT)).toBe(
        'Require approval for file edits or shell commands',
      );
      expect(formatApprovalModeDescription(ApprovalMode.AUTO_EDIT)).toBe(
        'Automatically approve file edits',
      );
      expect(formatApprovalModeDescription(ApprovalMode.YOLO)).toBe(
        'Automatically approve all tools',
      );
    });

    it('formats descriptions with the active locale', async () => {
      await setLanguageAsync('fr');
      try {
        expect(formatApprovalModeDescription(ApprovalMode.PLAN)).toBe(
          'Analyser uniquement, ne pas modifier les fichiers ni exécuter des commandes',
        );
        expect(formatApprovalModeDescription(ApprovalMode.DEFAULT)).toBe(
          "Demander l'approbation pour les modifications de fichiers ou les commandes shell",
        );
        expect(formatApprovalModeDescription(ApprovalMode.AUTO_EDIT)).toBe(
          'Approuver automatiquement les modifications de fichiers',
        );
        expect(formatApprovalModeDescription(ApprovalMode.AUTO)).toBe(
          'Utiliser le classificateur pour approuver automatiquement les appels d’outils sûrs',
        );
        expect(formatApprovalModeDescription(ApprovalMode.YOLO)).toBe(
          'Approuver automatiquement tous les outils',
        );
      } finally {
        await setLanguageAsync('en');
      }
    });
  });
});
