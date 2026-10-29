import type { ComponentType } from 'react';
import { useTranslation } from 'react-i18next';
import type { AnalyticsMetrics, AnalyticsResponse } from '@/domain/analytics/types';
import {
  IconAlertTriangle,
  IconBot,
  IconCheck,
  IconCopy,
  IconDollarSign,
  IconDownload,
  IconFilterAll,
  IconInfo,
  IconInbox,
  IconModelCluster,
  IconPencil,
  IconSatellite,
  IconTimer,
  IconUpload,
} from '@/components/ui/icons';
import { AnalyticsChart } from './AnalyticsChart';
import { lineSegments } from './chartGeometry';
import { analyticsCompact, analyticsMoney, analyticsNumber } from './format';
import type { AnalyticsTab } from './queryState';
import { TrendChart, type TrendSeries } from './TrendChart';
import styles from './AnalyticsPage.module.scss';

type Metric =
  | 'calls'
  | 'failure_calls'
  | 'total_tokens'
  | 'input_tokens'
  | 'output_tokens'
  | 'cache_read_tokens'
  | 'cache_creation_tokens'
  | 'reasoning_tokens'
  | 'uncached_input_tokens'
  | 'average_latency_ms'
  | 'p95_latency_ms'
  | 'p95_ttft_ms'
  | 'cost'
  | 'priced_calls'
  | 'unpriced_calls';
type View = Exclude<AnalyticsTab, 'rates' | 'requests'>;

/** One colour per charted metric on every tab, never a provider, status or warning colour. */
const METRIC_COLOR: Partial<Record<Metric, string>> = {
  calls: 'var(--analytics-requests)',
  total_tokens: 'var(--analytics-tokens)',
  input_tokens: 'var(--analytics-tokens)',
  // Token series share the token ink and are told apart by line style.
  output_tokens: 'var(--analytics-tokens)',
  cache_read_tokens: 'var(--analytics-tokens)',
  cost: 'var(--analytics-cost)',
};
const ICONS: Record<Metric, ComponentType<{ size?: number }>> = {
  calls: IconInbox,
  failure_calls: IconAlertTriangle,
  total_tokens: IconModelCluster,
  input_tokens: IconDownload,
  output_tokens: IconUpload,
  cache_read_tokens: IconCopy,
  cache_creation_tokens: IconPencil,
  reasoning_tokens: IconBot,
  uncached_input_tokens: IconFilterAll,
  average_latency_ms: IconTimer,
  p95_latency_ms: IconTimer,
  p95_ttft_ms: IconSatellite,
  cost: IconDollarSign,
  priced_calls: IconCheck,
  unpriced_calls: IconInfo,
};
const cards: Record<View, Metric[]> = {
  overview: [
    'calls',
    'failure_calls',
    'cost',
    'p95_latency_ms',
    'total_tokens',
    'input_tokens',
    'output_tokens',
    'cache_read_tokens',
  ],
  tokens: [
    'input_tokens',
    'uncached_input_tokens',
    'output_tokens',
    'cache_read_tokens',
    'cache_creation_tokens',
    'reasoning_tokens',
  ],
  cost: ['cost', 'priced_calls', 'unpriced_calls'],
  performance: ['p95_latency_ms', 'average_latency_ms', 'p95_ttft_ms'],
};
/** Durations share one millisecond scale and one ink, told apart by line style. */
const trends: Record<View, { metric: Metric; dash?: TrendSeries['dash'] }[]> = {
  overview: [{ metric: 'calls' }, { metric: 'total_tokens' }, { metric: 'cost' }],
  tokens: [
    { metric: 'total_tokens' },
    { metric: 'output_tokens', dash: 'dashed' },
    { metric: 'cache_read_tokens', dash: 'dotted' },
  ],
  cost: [{ metric: 'cost' }],
  // TTFT has its own chart: mixed methods, and far smaller than execution durations.
  performance: [{ metric: 'p95_latency_ms' }, { metric: 'average_latency_ms', dash: 'dashed' }],
};
const breakdowns: Record<View, Metric> = {
  overview: 'calls',
  tokens: 'output_tokens',
  cost: 'cost',
  performance: 'p95_latency_ms',
};
const valueOf = (metrics: AnalyticsMetrics, metric: Metric): number | null =>
  metric === 'cost'
    ? metrics.cost.usd
    : metric === 'priced_calls' || metric === 'unpriced_calls'
      ? (metrics.cost[metric] ?? null)
      : metrics[metric];
const isDuration = (metric: Metric) => metric.endsWith('_ms');

export function AnalyticsViews({
  tab,
  data,
  onBucket,
  onModel,
  onProvider,
}: {
  tab: View;
  data: AnalyticsResponse;
  onBucket: (bucket: number) => void;
  onModel: (model: string) => void;
  onProvider: (provider: string) => void;
}) {
  const { t, i18n } = useTranslation();
  const interval = data.granularity === 'day' ? 86_400_000 : 3_600_000;
  const trend = trends[tab];
  const breakdownMetric = breakdowns[tab];
  const breakdownFormat =
    breakdownMetric === 'cost' ? 'money' : isDuration(breakdownMetric) ? 'exact' : 'compact';
  const hasSamples = data.timeline.length + data.providers.length + data.models.length > 0;
  const label = (metric: Metric) =>
    metric === 'priced_calls' || metric === 'unpriced_calls'
      ? t(`analytics.${metric === 'priced_calls' ? 'priced_events' : 'unpriced_events'}`)
      : t(`analytics.metrics.${metric}`);
  const display = (metric: Metric, value: number | null) =>
    metric === 'cost'
      ? analyticsMoney(value, i18n.language)
      : isDuration(metric)
        ? analyticsNumber(value, i18n.language)
        : analyticsCompact(value, i18n.language);
  // Sublines add a related server value that has no card of its own on this tab.
  const subline = (metric: Metric): string | null => {
    const s = data.summary;
    // An unavailable cost already says so in the value; don't repeat it.
    if (metric === 'cost')
      return s.cost.usd === null ? null : t(`analytics.price_status.${s.cost.status}`);
    if (tab !== 'overview') return null;
    const n = (value: number | null) => analyticsCompact(value, i18n.language);
    switch (metric) {
      case 'calls':
        return t('analytics.card.succeeded', { value: n(s.success_calls) });
      case 'failure_calls':
        return t('analytics.card.of_events', { value: n(s.calls) });
      case 'p95_latency_ms':
        return s.p95_ttft_ms === null
          ? null
          : t('analytics.card.ttft', {
              value: `${analyticsNumber(s.p95_ttft_ms, i18n.language)} ms`,
            });
      case 'total_tokens':
        return t('analytics.card.reasoning', { value: n(s.reasoning_tokens) });
      case 'input_tokens':
        return s.uncached_input_tokens === null
          ? null
          : t('analytics.card.uncached', { value: n(s.uncached_input_tokens) });
      case 'cache_read_tokens':
        return t('analytics.card.writes', { value: n(s.cache_creation_tokens) });
      default:
        return null;
    }
  };
  return (
    <>
      <div className={styles.metrics} data-count={cards[tab].length} data-tab={tab}>
        {cards[tab].map((metric) => {
          const Icon = ICONS[metric];
          const value = valueOf(data.summary, metric);
          // A metric keeps its ink on every tab; failures turn red only when there are some.
          const color =
            metric === 'failure_calls'
              ? value
                ? 'var(--error-color)'
                : undefined
              : METRIC_COLOR[metric];
          const spark = lineSegments(
            data.timeline.map((p) => ({ at: p.bucket_ms, value: valueOf(p, metric) })),
            {
              from: data.from_ms,
              to: data.to_ms,
              interval,
              left: 0,
              right: 100,
              top: 2,
              bottom: 26,
            }
          );
          // A sparkline only adds context to a known total that actually varies.
          const sparkValues = data.timeline
            .map((p) => valueOf(p, metric))
            .filter((v): v is number => v !== null);
          const sparkShown = value !== null && new Set(sparkValues).size > 1;
          // A missing total with hourly values says why, so the chart below doesn't look wrong.
          const sub =
            value === null && sparkValues.length > 0
              ? t('analytics.card.hourly_only')
              : subline(metric);
          return (
            <article
              key={metric}
              className={styles.metric}
              style={color ? { ['--metric-color' as string]: color } : undefined}
              data-tone={color ? 'metric' : 'neutral'}
              data-spark={sparkShown}
            >
              <span className={styles.metricLabel}>
                <span className={styles.metricIcon} aria-hidden="true">
                  <Icon size={14} />
                </span>
                {label(metric)}
              </span>
              <strong
                title={analyticsNumber(value, i18n.language, metric === 'cost')}
                className={metric === 'failure_calls' && value ? styles.failure : undefined}
                data-unavailable={value === null}
              >
                {display(metric, value)}
              </strong>
              <small>{sub ?? ' '}</small>
              {sparkShown ? (
                <svg
                  viewBox="0 0 100 28"
                  preserveAspectRatio="none"
                  className={styles.spark}
                  data-charted={color !== undefined}
                  aria-hidden="true"
                >
                  {/* Runs of one or two hours read as specks at card size; the trend chart marks them. */}
                  {spark.segments
                    .filter((segment) => segment.length > 2)
                    .map((segment, index) => (
                      <path
                        key={index}
                        d={segment.map(([x, y], i) => `${i ? 'L' : 'M'}${x},${y}`).join(' ')}
                        vectorEffect="non-scaling-stroke"
                      />
                    ))}
                </svg>
              ) : (
                // The page-level empty state already says nothing was retained.
                value !== null &&
                data.summary.calls > 0 && (
                  <span className={styles.noSpark}>
                    {t(
                      sparkValues.length > 0
                        ? 'analytics.no_hourly_change'
                        : 'analytics.no_hourly_series'
                    )}
                  </span>
                )
              )}
            </article>
          );
        })}
      </div>
      {tab === 'tokens' && <p className={styles.notice}>{t('analytics.tokens_note')}</p>}
      {tab === 'cost' && (
        <div className={styles.notice}>
          <p>{t('analytics.price_note')}</p>
          {data.summary.cost.reasons.length > 0 && <p>{data.summary.cost.reasons.join(' · ')}</p>}
        </div>
      )}
      {tab === 'performance' && <p className={styles.notice}>{t('analytics.timing_note')}</p>}
      {/* With nothing retained the page notice explains it; empty charts would only repeat it. */}
      {hasSamples && (
        <>
          <TrendChart
            title={t(`analytics.trend.${tab}`)}
            series={trend.map(({ metric, dash }) => ({
              key: metric,
              label: t(`analytics.metrics.${metric}`),
              color: METRIC_COLOR[metric] ?? 'var(--primary-color)',
              dash,
              currency: metric === 'cost',
            }))}
            points={data.timeline.map((point) => ({
              at: point.bucket_ms,
              values: trend.map(({ metric }) => valueOf(point, metric)),
            }))}
            from={data.from_ms}
            to={data.to_ms}
            interval={interval}
            sharedScale={tab === 'performance'}
            onSelect={onBucket}
          />
          {tab === 'performance' && (
            <TrendChart
              title={t('analytics.metrics.p95_ttft_ms')}
              series={[
                {
                  key: 'p95_ttft_ms',
                  label: t('analytics.metrics.p95_ttft_ms'),
                  color: 'var(--primary-color)',
                },
              ]}
              points={data.timeline.map((point) => ({
                at: point.bucket_ms,
                values: [point.p95_ttft_ms],
              }))}
              from={data.from_ms}
              to={data.to_ms}
              interval={interval}
              onSelect={onBucket}
            />
          )}
          <div className={styles.chartGrid}>
            <AnalyticsChart
              title={`${t('analytics.by_provider')} · ${t(`analytics.metrics.${breakdownMetric}`)}`}
              format={breakdownFormat}
              data={data.providers.map((p) => ({
                key: p.key,
                label: p.label,
                value: valueOf(p, breakdownMetric),
              }))}
              onSelect={onProvider}
            />
            <AnalyticsChart
              title={`${t('analytics.by_model')} · ${t(`analytics.metrics.${breakdownMetric}`)}`}
              format={breakdownFormat}
              data={data.models.map((m) => ({
                key: m.key,
                label: m.label,
                value: valueOf(m, breakdownMetric),
              }))}
              onSelect={onModel}
            />
          </div>
        </>
      )}
    </>
  );
}
