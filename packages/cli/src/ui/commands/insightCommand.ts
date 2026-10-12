/**
 * @license
 * Copyright 2025 Qwen Code
 * SPDX-License-Identifier: Apache-2.0
 */

import type { CommandContext, SlashCommand } from './types.js';
import { CommandKind } from './types.js';
import { MessageType } from '../types.js';
import type { HistoryItemInsightProgress } from '../types.js';
import { t } from '../../i18n/index.js';
import { join } from 'path';
import { pathToFileURL } from 'node:url';
import { StaticInsightGenerator } from '../../services/insight/generators/StaticInsightGenerator.js';
import {
  createDebugLogger,
  openBrowserSecurely,
  Storage,
} from '@qwen-code/qwen-code-core';

const logger = createDebugLogger('DataProcessor');

export const insightCommand: SlashCommand = {
  name: 'insight',
  get description() {
    return t(
      'generate personalized programming insights from your chat history',
    );
  },
  kind: CommandKind.BUILT_IN,
  supportedModes: ['interactive', 'non_interactive'] as const,
  action: async (context: CommandContext) => {
    try {
      context.ui.setDebugMessage(t('Generating insights...'));

      const projectsDir = join(Storage.getRuntimeBaseDir(), 'projects');
      if (!context.services.config) {
        if (context.executionMode !== 'interactive') {
          return {
            type: 'message',
            messageType: 'error',
            content: 'Config service is not available.',
          };
        }
        throw new Error('Config service is not available');
      }
      const insightGenerator = new StaticInsightGenerator(
        context.services.config,
      );

      if (context.executionMode === 'non_interactive') {
        // non_interactive: run synchronously and return a single message
        try {
          const outputPath = await insightGenerator.generateStaticInsight(
            projectsDir,
            () => {
              // progress callback is no-op in non_interactive mode
            },
          );
          return {
            type: 'message',
            messageType: 'info',
            content: t('Insight report generated at: {{path}}', {
              path: outputPath,
            }),
          };
        } catch (error) {
          return {
            type: 'message',
            messageType: 'error',
            content: t('Failed to generate insights: {{error}}', {
              error: (error as Error).message,
            }),
          };
        }
      }

      const updateProgress = (
        stage: string,
        progress: number,
        detail?: string,
      ) => {
        const progressItem: HistoryItemInsightProgress = {
          type: MessageType.INSIGHT_PROGRESS,
          progress: {
            stage,
            progress,
            detail,
          },
        };
        context.ui.setPendingItem(progressItem);
      };

      context.ui.addItem(
        {
          type: MessageType.INFO,
          text: t('This may take a couple minutes. Sit tight!'),
        },
        Date.now(),
      );

      updateProgress(t('Starting insight generation...'), 0);

      const outputPath = await insightGenerator.generateStaticInsight(
        projectsDir,
        updateProgress,
      );

      context.ui.setPendingItem(null);

      context.ui.addItem(
        {
          type: MessageType.INFO,
          text: t('Insight report generated successfully!'),
        },
        Date.now(),
      );

      context.ui.addItem(
        {
          type: MessageType.INFO,
          text: t(
            'Insights generated at: {{path}}. If the browser does not open automatically, open this file manually.',
            {
              path: outputPath,
            },
          ),
        },
        Date.now(),
      );

      try {
        await openBrowserSecurely(pathToFileURL(outputPath).href, {
          allowedFilePaths: [outputPath],
        });
      } catch (browserError) {
        logger.error('Failed to open browser automatically:', browserError);
      }

      context.ui.setDebugMessage(t('Insights ready.'));
      return;
    } catch (error) {
      context.ui.setPendingItem(null);

      if (context.executionMode !== 'interactive') {
        return {
          type: 'message',
          messageType: 'error',
          content: `Failed to generate insights: ${(error as Error).message}`,
        };
      }

      context.ui.addItem(
        {
          type: MessageType.ERROR,
          text: t('Failed to generate insights: {{error}}', {
            error: (error as Error).message,
          }),
        },
        Date.now(),
      );

      logger.error('Insight generation error:', error);
      return;
    }
  },
};
