import type { AnalyticsQuery } from '@/domain/analytics/types';
import {
  analyticsTabs,
  buckets,
  ranges,
  type AnalyticsBucket,
  type AnalyticsRange,
  type AnalyticsTab,
} from './queryState';

/** The last Analytics view, restored on reload and in a new browser window on this machine. */
export type AnalyticsUiState = {
  tab: AnalyticsTab;
  range: AnalyticsRange;
  bucket: AnalyticsBucket;
  provider?: string;
  model?: string;
  outcome: AnalyticsQuery['outcome'];
  search?: string;
};

const KEY = 'analyticsPage.uiState';
const outcomes: readonly AnalyticsQuery['outcome'][] = ['all', 'success', 'failed'];
const oneOf = <T extends string>(values: readonly T[], value: unknown): T | undefined =>
  values.find((candidate) => candidate === value);
const text = (value: unknown) =>
  typeof value === 'string' && value.trim() && value.length <= 200 ? value : undefined;

/** Unknown or tampered fields fall back to defaults one by one; nothing is trusted wholesale. */
export function parseAnalyticsUiState(raw: string | null): Partial<AnalyticsUiState> {
  if (!raw) return {};
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return {};
  }
  if (!value || typeof value !== 'object') return {};
  const saved = value as Record<string, unknown>;
  return {
    tab: oneOf(analyticsTabs, saved.tab),
    range: oneOf(ranges, saved.range),
    bucket: oneOf(buckets, saved.bucket),
    provider: text(saved.provider),
    model: text(saved.model),
    outcome: oneOf(outcomes, saved.outcome),
    search: text(saved.search),
  };
}

export function readAnalyticsUiState(): Partial<AnalyticsUiState> {
  try {
    return parseAnalyticsUiState(window.localStorage.getItem(KEY));
  } catch {
    return {};
  }
}

export function writeAnalyticsUiState(state: AnalyticsUiState) {
  try {
    window.localStorage.setItem(KEY, JSON.stringify(state));
  } catch {
    // Storage can be full or blocked; the page still works, it just forgets.
  }
}
