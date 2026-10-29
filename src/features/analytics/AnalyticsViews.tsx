import { useTranslation } from 'react-i18next';
import type { AnalyticsMetrics, AnalyticsResponse } from '@/domain/analytics/types';
import { AnalyticsChart } from './AnalyticsChart';
import { analyticsNumber, analyticsTime } from './format';
import type { AnalyticsTab } from './queryState';
import styles from './AnalyticsPage.module.scss';

type Metric =
  | 'calls'
  | 'failure_calls'
  | 'input_tokens'
  | 'output_tokens'
  | 'cache_read_tokens'
  | 'cache_creation_tokens'
  | 'reasoning_tokens'
  | 'uncached_input_tokens'
  | 'average_latency_ms'
  | 'p95_latency_ms'
  | 'p95_ttft_ms'
  | 'cost';
const viewMetrics: Record<Exclude<AnalyticsTab, 'rates' | 'requests'>, Metric[]> = {
  overview: ['calls', 'failure_calls', 'input_tokens', 'output_tokens', 'cost', 'p95_latency_ms'],
  tokens: [
    'input_tokens',
    'uncached_input_tokens',
    'output_tokens',
    'cache_read_tokens',
    'cache_creation_tokens',
    'reasoning_tokens',
  ],
  cost: ['cost'],
  performance: ['average_latency_ms', 'p95_latency_ms', 'p95_ttft_ms'],
};
const valueOf = (metrics: AnalyticsMetrics, metric: Metric) =>
  metric === 'cost' ? metrics.cost.usd : metrics[metric];

export function AnalyticsViews({
  tab,
  data,
  onBucket,
  onModel,
  onProvider,
}: {
  tab: Exclude<AnalyticsTab, 'requests' | 'rates'>;
  data: AnalyticsResponse;
  onBucket: (bucket: number) => void;
  onModel: (model: string) => void;
  onProvider: (provider: string) => void;
}) {
  const { t, i18n } = useTranslation();
  const metrics = viewMetrics[tab];
  const breakdownMetric: Metric =
    tab === 'cost'
      ? 'cost'
      : tab === 'tokens'
        ? 'output_tokens'
        : tab === 'performance'
          ? 'p95_latency_ms'
          : 'calls';
  return (
    <>
      <div className={styles.metrics}>
        {metrics.map((metric) => (
          <article key={metric} className={styles.metric}>
            <span>{t(`analytics.metrics.${metric}`)}</span>
            <strong>
              {analyticsNumber(valueOf(data.summary, metric), i18n.language, metric === 'cost')}
            </strong>
            {metric === 'cost' && (
              <small>{t(`analytics.price_status.${data.summary.cost.status}`)}</small>
            )}
          </article>
        ))}
      </div>
      {tab === 'tokens' && <p className={styles.notice}>{t('analytics.tokens_note')}</p>}
      {tab === 'cost' && (
        <div className={styles.notice}>
          <p>{t('analytics.price_note')}</p>
          <p>
            {t('analytics.priced_events')}:{' '}
            {analyticsNumber(data.summary.cost.priced_calls, i18n.language)} ·{' '}
            {t('analytics.unpriced_events')}:{' '}
            {analyticsNumber(data.summary.cost.unpriced_calls, i18n.language)}
          </p>
          {data.summary.cost.reasons.length > 0 && <p>{data.summary.cost.reasons.join(' · ')}</p>}
        </div>
      )}
      {tab === 'performance' && <p className={styles.notice}>{t('analytics.timing_note')}</p>}
      <div className={styles.chartGrid}>
        {metrics.map((metric) => (
          <AnalyticsChart
            key={metric}
            title={t(`analytics.metrics.${metric}`)}
            currency={metric === 'cost'}
            from={data.from_ms}
            to={data.to_ms}
            interval={data.granularity === 'day' ? 86_400_000 : 3_600_000}
            data={data.timeline.map((point) => ({
              key: String(point.bucket_ms),
              label: `${analyticsTime(point.bucket_ms, i18n.language)} UTC`,
              at: point.bucket_ms,
              value: valueOf(point, metric),
            }))}
            onSelect={(key) => onBucket(Number(key))}
          />
        ))}
      </div>
      <div className={styles.chartGrid}>
        <AnalyticsChart
          title={`${t('analytics.by_provider')} · ${t(`analytics.metrics.${breakdownMetric}`)}`}
          currency={breakdownMetric === 'cost'}
          data={data.providers.map((p) => ({
            key: p.key,
            label: p.label,
            value: valueOf(p, breakdownMetric),
          }))}
          onSelect={onProvider}
        />
        <AnalyticsChart
          title={`${t('analytics.by_model')} · ${t(`analytics.metrics.${breakdownMetric}`)}`}
          currency={breakdownMetric === 'cost'}
          data={data.models.map((m) => ({
            key: m.key,
            label: m.label,
            value: valueOf(m, breakdownMetric),
          }))}
          onSelect={onModel}
        />
      </div>
    </>
  );
}
