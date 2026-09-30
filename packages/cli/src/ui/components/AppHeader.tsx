/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { useMemo } from 'react';
import { Box } from 'ink';
import { Header, AuthDisplayType } from './Header.js';
import { Tips } from './Tips.js';
import { useSettings } from '../contexts/SettingsContext.js';
import { useConfig } from '../contexts/ConfigContext.js';
import { useUIState } from '../contexts/UIStateContext.js';
import { resolveCustomBanner } from '../utils/customBanner.js';

interface AppHeaderProps {
  version: string;
}

export const AppHeader = ({ version }: AppHeaderProps) => {
  const settings = useSettings();
  const config = useConfig();
  const contentGeneratorConfig = config.getContentGeneratorConfig();
  const authType = contentGeneratorConfig?.authType;
  const { currentModel } = useUIState();
  const model = config.getModelsConfig().getModelDisplayName(currentModel);
  const targetDir = config.getTargetDir();
  const showBanner =
    !config.getScreenReader() && !settings.merged.ui?.hideBanner;
  const showTips = !(settings.merged.ui?.hideTips || config.getScreenReader());

  const authDisplayType = authType
    ? AuthDisplayType.API_KEY
    : AuthDisplayType.UNKNOWN;

  // Resolve once per (settings identity) — file reads and sanitization are
  // not free, and the merged settings reference is stable across renders
  // until a settings hot-reload swaps it.
  const resolvedBanner = useMemo(
    () => (showBanner ? resolveCustomBanner(settings) : undefined),
    [showBanner, settings],
  );

  return (
    <Box flexDirection="column">
      {showBanner && (
        <Header
          version={version}
          authDisplayType={authDisplayType}
          model={model}
          workingDirectory={targetDir}
          customAsciiArt={resolvedBanner?.asciiArt}
          customBannerTitle={resolvedBanner?.title}
          customBannerSubtitle={resolvedBanner?.subtitle}
        />
      )}
      {showTips && <Tips />}
    </Box>
  );
};
