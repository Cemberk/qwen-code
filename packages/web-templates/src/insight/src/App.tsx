import ReactDOM from 'react-dom/client';
import { StatsRow } from './Header';
import {
  AtAGlance,
  NavToc,
  type NavTocSection,
  ProjectAreas,
  InteractionStyle,
  ImpressiveWorkflows,
  FrictionPoints,
  Improvements,
  FutureOpportunities,
  MemorableMoment,
} from './Qualitative';
import './styles.css';
import type { InsightData } from './types';
import { dayKey, parseDayKey } from './dates';
// eslint-disable-next-line @typescript-eslint/no-unused-vars
import React from 'react';

// Keep in sync with packages/cli/src/services/insight/generators/DataProcessor.ts.
function hasMeaningfulValue(value: unknown): boolean {
  if (typeof value === 'string') {
    return value.trim().length > 0;
  }

  if (typeof value === 'number') {
    return Number.isFinite(value) && value !== 0;
  }

  if (typeof value === 'boolean') {
    return value;
  }

  if (Array.isArray(value)) {
    return value.some((item) => hasMeaningfulValue(item));
  }

  if (value && typeof value === 'object') {
    return Object.values(value).some((item) => hasMeaningfulValue(item));
  }

  return false;
}

function hasRecordEntries(
  value?: Record<string, number> | Array<[string, number]>,
): boolean {
  if (Array.isArray(value)) {
    return value.some(([, count]) => Number.isFinite(count) && count !== 0);
  }

  return (
    !!value &&
    Object.values(value).some((count) => Number.isFinite(count) && count !== 0)
  );
}

function hasMeaningfulArray(value: unknown): boolean {
  return Array.isArray(value) && value.some((item) => hasMeaningfulValue(item));
}

// Main App Component
function InsightApp({ data }: { data: InsightData }) {
  if (!data) {
    return (
      <div className="text-center text-slate-600">
        No insight data available
      </div>
    );
  }

  // Calculate date range
  const heatmapKeys = Object.keys(data.heatmap || {});
  let dateRangeStr = '';
  if (heatmapKeys.length > 0) {
    const dates = heatmapKeys.map((d) => parseDayKey(d));
    const timestamps = dates.map((d) => d.getTime());
    const minDate = new Date(Math.min(...timestamps));
    const maxDate = new Date(Math.max(...timestamps));
    const formatDate = (d: Date) => dayKey(d);
    dateRangeStr = `${formatDate(minDate)} to ${formatDate(maxDate)}`;
  }

  const showAtAGlance = hasMeaningfulValue(data.qualitative?.atAGlance);
  const showProjectAreas =
    !!data.qualitative &&
    (hasMeaningfulValue(data.qualitative.projectAreas) ||
      hasRecordEntries(data.topGoals) ||
      hasRecordEntries(data.topTools));
  const showInteractionStyle = hasMeaningfulValue(
    data.qualitative?.interactionStyle,
  );
  const showImpressiveWorkflows =
    !!data.qualitative &&
    (hasMeaningfulValue(data.qualitative.impressiveWorkflows) ||
      hasRecordEntries(data.primarySuccess) ||
      hasRecordEntries(data.outcomes));
  const showFrictionPoints =
    !!data.qualitative &&
    (hasMeaningfulValue(data.qualitative.frictionPoints) ||
      hasRecordEntries(data.satisfaction) ||
      hasRecordEntries(data.friction));
  const showFeatures =
    !!data.qualitative &&
    (hasMeaningfulArray(data.qualitative.improvements?.Qwen_md_additions) ||
      hasMeaningfulArray(data.qualitative.improvements?.features_to_try));
  const showPatterns =
    !!data.qualitative &&
    hasMeaningfulArray(data.qualitative.improvements?.usage_patterns);
  const showFutureOpportunities = hasMeaningfulValue(
    data.qualitative?.futureOpportunities,
  );
  const showMemorableMoment = hasMeaningfulValue(
    data.qualitative?.memorableMoment,
  );

  const navSections: NavTocSection[] = [];
  if (showProjectAreas) {
    navSections.push({ href: '#section-work', label: 'What You Work On' });
  }
  if (showInteractionStyle) {
    navSections.push({
      href: '#section-usage',
      label: 'How You Use Qwen Code',
    });
  }
  if (showImpressiveWorkflows) {
    navSections.push({ href: '#section-wins', label: 'Impressive Things' });
  }
  if (showFrictionPoints) {
    navSections.push({
      href: '#section-friction',
      label: 'Where Things Go Wrong',
    });
  }
  if (showFeatures) {
    navSections.push({ href: '#section-features', label: 'Features to Try' });
  }
  if (showPatterns) {
    navSections.push({
      href: '#section-patterns',
      label: 'New Usage Patterns',
    });
  }
  if (showFutureOpportunities) {
    navSections.push({ href: '#section-horizon', label: 'On the Horizon' });
  }

  const atAGlanceTargetSections = {
    wins: showImpressiveWorkflows,
    friction: showFrictionPoints,
    features: showFeatures,
    horizon: showFutureOpportunities,
  };

  return (
    <div>
      {/* Elegant Header */}
      <header className="insights-header">
        <div className="header-content">
          <div className="header-title-section">
            <h1 className="header-title">Qwen Code Insights</h1>
            <p className="header-subtitle">
              {data.totalMessages
                ? `${data.totalMessages.toLocaleString()} messages across ${data.totalSessions?.toLocaleString()} sessions`
                : 'Your personalized coding journey and patterns'}
              {dateRangeStr && ` · ${dateRangeStr}`}
            </p>
          </div>
        </div>
      </header>

      {showAtAGlance && data.qualitative && (
        <AtAGlance
          qualitative={data.qualitative}
          targetSections={atAGlanceTargetSections}
        />
      )}

      {navSections.length > 0 && <NavToc sections={navSections} />}

      <StatsRow data={data} />

      {showProjectAreas && data.qualitative && (
        <ProjectAreas
          qualitative={data.qualitative}
          topGoals={data.topGoals}
          topTools={data.topTools}
        />
      )}

      {showInteractionStyle && data.qualitative && (
        <InteractionStyle qualitative={data.qualitative} insights={data} />
      )}

      {showImpressiveWorkflows && (
        <ImpressiveWorkflows
          qualitative={data.qualitative}
          primarySuccess={data.primarySuccess ?? {}}
          outcomes={data.outcomes ?? {}}
        />
      )}

      {showFrictionPoints && (
        <FrictionPoints
          qualitative={data.qualitative}
          satisfaction={data.satisfaction ?? {}}
          friction={data.friction ?? {}}
        />
      )}

      {(showFeatures || showPatterns) && data.qualitative && (
        <Improvements qualitative={data.qualitative} />
      )}

      {showFutureOpportunities && data.qualitative && (
        <FutureOpportunities qualitative={data.qualitative} />
      )}

      {showMemorableMoment && data.qualitative && (
        <MemorableMoment qualitative={data.qualitative} />
      )}
    </div>
  );
}

// App Initialization - Mount React app when DOM is ready
const container = document.getElementById('react-root');
if (container && window.INSIGHT_DATA && ReactDOM) {
  const root = ReactDOM.createRoot(container);
  root.render(<InsightApp data={window.INSIGHT_DATA} />);
} else {
  console.error('Failed to mount React app:', {
    container: !!container,
    data: !!window.INSIGHT_DATA,
    ReactDOM: !!ReactDOM,
  });
}
