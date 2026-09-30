import type { InsightData } from '../../../src/services/insight/types/StaticInsightTypes';
import type { QualitativeInsights as QualitativeData } from '../../../src/services/insight/types/QualitativeInsightTypes';

declare global {
  interface Window {
    INSIGHT_DATA: InsightData;
  }
}

export type { InsightData, QualitativeData };
