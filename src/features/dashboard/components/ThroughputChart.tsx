import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Collapsible } from '@/components/ui/Collapsible';
import { formatPercent } from '@/utils/format';
import { TRAFFIC_BUCKET_MINUTES, type TrafficWindow } from '../types';
import { providerColor, type TrafficSeries } from '../providerSelection';
import { axisMax } from '../utils';
import styles from './ThroughputChart.module.scss';

/** 纵轴刻度条数（含 0），即 TICK_COUNT - 1 个间隔 */
const TICK_COUNT = 5;

/**
 * 桶时间标签。后端返回的是服务器本地时间字符串（"15:04-15:14"），
 * 优先使用它，而不是用浏览器时钟反推，避免时区不一致。
 */
function bucketRangeLabel(time: string | undefined, index: number, count: number): string {
  if (time) return time;
  const minutesAgo = (count - index) * TRAFFIC_BUCKET_MINUTES;
  return `-${minutesAgo}m`;
}

function bucketStartLabel(time: string | undefined, index: number, count: number): string {
  if (!time) return bucketRangeLabel(time, index, count);
  const [start] = time.split('-');
  return start?.trim() || time;
}

interface ThroughputChartProps {
  traffic: TrafficWindow;
  /** With several providers, columns stack by provider instead of by outcome. */
  series?: TrafficSeries[] | null;
}

export function ThroughputChart({ traffic, series }: ThroughputChartProps) {
  const { t } = useTranslation();
  const [activeIndex, setActiveIndex] = useState<number | null>(null);

  const { buckets, totalSuccess, totalFailure, total, peakIndex, peakTotal } = traffic;
  const scaleMax = useMemo(() => axisMax(peakTotal, TICK_COUNT - 1), [peakTotal]);

  const ticks = useMemo(
    () =>
      Array.from({ length: TICK_COUNT }, (_, index) => {
        const ratio = 1 - index / (TICK_COUNT - 1);
        return { ratio, value: Math.round(scaleMax * ratio) };
      }),
    [scaleMax]
  );

  const xAxisTicks = useMemo(() => {
    if (buckets.length === 0) return [];
    const positions = [0, Math.floor((buckets.length - 1) / 2), buckets.length - 1];
    return Array.from(new Set(positions)).map((index) => ({
      index,
      label: bucketStartLabel(buckets[index]?.time, index, buckets.length),
    }));
  }, [buckets]);

  const summary = t('dashboard.traffic_chart_summary', {
    total,
    success: totalSuccess,
    failed: totalFailure,
    minutes: traffic.windowMinutes,
  });

  const stacked = series && series.length > 1 ? series : null;
  const activeBucket = activeIndex === null ? null : buckets[activeIndex];
  const activeTotal = activeBucket ? activeBucket.success + activeBucket.failed : 0;

  if (buckets.length === 0) {
    return (
      <div className={styles.placeholder}>
        <p className={styles.placeholderTitle}>{t('dashboard.traffic_unavailable')}</p>
        <p className={styles.placeholderHint}>{t('dashboard.traffic_unavailable_hint')}</p>
      </div>
    );
  }

  return (
    <figure className={styles.chart}>
      {/* 两条序列 → 图例常驻，并直接带上数值（浅色主题下绿色对比度偏低，数值即为补偿） */}
      <figcaption className={styles.legend}>
        {stacked?.map((entry) => (
          <span key={entry.id} className={styles.legendItem}>
            <span
              className={styles.legendSwatch}
              style={{ background: providerColor(entry.brand) }}
              aria-hidden="true"
            />
            {entry.name}
            <b className={styles.legendValue}>{entry.total.toLocaleString()}</b>
          </span>
        ))}
        {/* Stacked by provider, outcome has no colour in the bars, so it carries no swatch. */}
        <span className={styles.legendItem}>
          {!stacked && (
            <span className={`${styles.legendSwatch} ${styles.swatchSuccess}`} aria-hidden="true" />
          )}
          {t('stats.success')}
          <b className={styles.legendValue}>{totalSuccess.toLocaleString()}</b>
        </span>
        <span className={styles.legendItem}>
          {!stacked && (
            <span className={`${styles.legendSwatch} ${styles.swatchFailure}`} aria-hidden="true" />
          )}
          {t('stats.failure')}
          <b className={styles.legendValue}>{totalFailure.toLocaleString()}</b>
        </span>
      </figcaption>

      <div className={styles.plot}>
        <div className={styles.yAxis} aria-hidden="true">
          {ticks.map((tick) => (
            <span
              key={tick.ratio}
              className={styles.yTick}
              style={{ top: `${(1 - tick.ratio) * 100}%` }}
            >
              {tick.value.toLocaleString()}
            </span>
          ))}
        </div>

        <div className={styles.canvas}>
          <div className={styles.gridlines} aria-hidden="true">
            {ticks.map((tick) => (
              <span
                key={tick.ratio}
                className={styles.gridline}
                style={{ top: `${(1 - tick.ratio) * 100}%` }}
              />
            ))}
          </div>

          <div
            className={styles.columns}
            role="img"
            aria-label={summary}
            onMouseLeave={() => setActiveIndex(null)}
          >
            {buckets.map((bucket, index) => {
              const bucketTotal = bucket.success + bucket.failed;
              const successHeight = (bucket.success / scaleMax) * 100;
              const failureHeight = (bucket.failed / scaleMax) * 100;
              const hasBoth = bucket.success > 0 && bucket.failed > 0;
              /* 级差按桶数归一化：不管窗口多长，整波入场都收在 360ms 内 */
              const barDelayMs =
                buckets.length > 1 ? Math.round((index / (buckets.length - 1)) * 360) : 0;

              return (
                <div
                  key={bucket.time ?? index}
                  className={`${styles.column} ${activeIndex === index ? styles.columnActive : ''}`}
                  onMouseEnter={() => setActiveIndex(index)}
                  onClick={() => setActiveIndex((current) => (current === index ? null : index))}
                >
                  {/* 峰值直标放在 scaleY 容器之外，避免入场时被一起挤压 */}
                  {index === peakIndex && peakTotal > 0 && (
                    <span
                      className={styles.peakLabel}
                      style={{ bottom: `${Math.min(100, (bucketTotal / scaleMax) * 100)}%` }}
                    >
                      {peakTotal.toLocaleString()}
                    </span>
                  )}
                  <div
                    className={styles.stack}
                    style={{ '--bar-delay': `${barDelayMs}ms` } as React.CSSProperties}
                  >
                    {stacked &&
                      [...stacked].reverse().map((entry, order, top) => {
                        const part = entry.buckets[index];
                        const value = part ? part.success + part.failed : 0;
                        if (value === 0) return null;
                        const below = top.slice(order + 1).some((other) => {
                          const lower = other.buckets[index];
                          return lower && lower.success + lower.failed > 0;
                        });
                        const above = top.slice(0, order).some((other) => {
                          const upper = other.buckets[index];
                          return upper && upper.success + upper.failed > 0;
                        });
                        return (
                          <span
                            key={entry.id}
                            className={`${styles.segment} ${below ? styles.segmentGap : ''} ${
                              above ? styles.segmentSquareTop : ''
                            }`}
                            style={{
                              height: `${(value / scaleMax) * 100}%`,
                              background: providerColor(entry.brand),
                            }}
                          />
                        );
                      })}
                    {!stacked && bucket.failed > 0 && (
                      <span
                        className={`${styles.segment} ${styles.segmentFailure} ${
                          hasBoth ? styles.segmentGap : ''
                        }`}
                        style={{ height: `${failureHeight}%` }}
                      />
                    )}
                    {!stacked && bucket.success > 0 && (
                      <span
                        className={`${styles.segment} ${styles.segmentSuccess} ${
                          bucket.failed > 0 ? styles.segmentSquareTop : ''
                        }`}
                        style={{ height: `${successHeight}%` }}
                      />
                    )}
                    {bucketTotal === 0 && <span className={styles.idleTick} />}
                  </div>
                </div>
              );
            })}
          </div>

          {total === 0 && <p className={styles.noRequests}>{t('status_bar.no_requests')}</p>}

          {activeBucket && (
            <div
              className={styles.tooltip}
              style={{
                left: `${((activeIndex! + 0.5) / buckets.length) * 100}%`,
                transform:
                  activeIndex! < buckets.length * 0.15
                    ? 'translateX(-12%)'
                    : activeIndex! > buckets.length * 0.85
                      ? 'translateX(-88%)'
                      : 'translateX(-50%)',
              }}
              role="status"
            >
              <span className={styles.tooltipTime}>
                {bucketRangeLabel(activeBucket.time, activeIndex!, buckets.length)}
              </span>
              {stacked?.map((entry) => {
                const part = entry.buckets[activeIndex!];
                return (
                  <span key={entry.id} className={styles.tooltipRow}>
                    <span
                      className={styles.legendSwatch}
                      style={{ background: providerColor(entry.brand) }}
                      aria-hidden="true"
                    />
                    {entry.name}
                    <b>{(part ? part.success + part.failed : 0).toLocaleString()}</b>
                  </span>
                );
              })}
              <span className={styles.tooltipRow}>
                {!stacked && (
                  <span
                    className={`${styles.legendSwatch} ${styles.swatchSuccess}`}
                    aria-hidden="true"
                  />
                )}
                {t('stats.success')}
                <b>{activeBucket.success.toLocaleString()}</b>
              </span>
              <span className={styles.tooltipRow}>
                {!stacked && (
                  <span
                    className={`${styles.legendSwatch} ${styles.swatchFailure}`}
                    aria-hidden="true"
                  />
                )}
                {t('stats.failure')}
                <b>{activeBucket.failed.toLocaleString()}</b>
              </span>
              <span className={styles.tooltipRate}>
                {activeTotal > 0
                  ? formatPercent((activeBucket.success / activeTotal) * 100)
                  : t('status_bar.no_requests')}
              </span>
            </div>
          )}
        </div>
      </div>

      <div className={styles.xAxis} aria-hidden="true">
        {xAxisTicks.map((tick) => (
          <span
            key={tick.index}
            className={styles.xTick}
            style={{ left: `${((tick.index + 0.5) / buckets.length) * 100}%` }}
          >
            {tick.label}
          </span>
        ))}
      </div>

      <Collapsible className={styles.tableToggle} label={t('dashboard.traffic_table')}>
        <table className={styles.table}>
          <thead>
            <tr>
              <th scope="col">{t('dashboard.traffic_table_window')}</th>
              {stacked?.map((entry) => (
                <th key={entry.id} scope="col">
                  {entry.name}
                </th>
              ))}
              <th scope="col">{t('stats.success')}</th>
              <th scope="col">{t('stats.failure')}</th>
              <th scope="col">{t('dashboard.success_rate')}</th>
            </tr>
          </thead>
          <tbody>
            {buckets.map((bucket, index) => {
              const bucketTotal = bucket.success + bucket.failed;
              return (
                <tr key={bucket.time ?? index}>
                  <th scope="row">{bucketRangeLabel(bucket.time, index, buckets.length)}</th>
                  {stacked?.map((entry) => {
                    const part = entry.buckets[index];
                    return (
                      <td key={entry.id}>
                        {(part ? part.success + part.failed : 0).toLocaleString()}
                      </td>
                    );
                  })}
                  <td>{bucket.success.toLocaleString()}</td>
                  <td>{bucket.failed.toLocaleString()}</td>
                  <td>
                    {bucketTotal > 0 ? formatPercent((bucket.success / bucketTotal) * 100) : '—'}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </Collapsible>
    </figure>
  );
}
