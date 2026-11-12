// Temporary CPAMP response oddities. Delete in P10, with explicit contract tests.
import type { AnalyticsCost, AnalyticsRequest } from '../../src/domain/analytics/types';
export function aggregateEstimate(cost: AnalyticsCost): AnalyticsCost {
  return {
    ...cost,
    status: cost.usd === null ? cost.status : 'partial',
    reasons: [...new Set([...cost.reasons, 'legacy-record-kind-unknown'])],
  };
}
export function sourceAttribution(page: readonly AnalyticsRequest[]): 'partial' | 'unavailable' {
  return page.some((row) => row.instance_id) ? 'partial' : 'unavailable';
}
