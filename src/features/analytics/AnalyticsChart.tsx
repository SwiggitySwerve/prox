import { useId, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { analyticsNumber, analyticsShortTime } from './format';
import { barGeometry, type ChartDatum } from './chartGeometry';
import styles from './AnalyticsPage.module.scss';

export function AnalyticsChart({
  title,
  data,
  currency = false,
  from,
  to,
  interval,
  onSelect,
}: {
  title: string;
  data: ChartDatum[];
  currency?: boolean;
  from?: number;
  to?: number;
  interval?: number;
  onSelect?: (key: string) => void;
}) {
  const { t, i18n } = useTranslation();
  const id = useId();
  const [readout, setReadout] = useState<ChartDatum | null>(null);
  const bars = barGeometry(data, from, to, interval);
  return (
    <section className={styles.panel} aria-labelledby={id}>
      <h3 id={id}>{title}</h3>
      {data.length === 0 ? (
        <p className={styles.muted}>{t('analytics.empty_chart')}</p>
      ) : (
        <>
          <div className={styles.chartScale}>
            {analyticsNumber(
              data.some((d) => d.value !== null)
                ? Math.max(0, ...data.map((d) => d.value ?? 0))
                : null,
              i18n.language,
              currency
            )}
          </div>
          <svg
            viewBox="0 0 600 150"
            preserveAspectRatio="none"
            className={styles.chart}
            role="group"
            aria-labelledby={`${id}-title`}
          >
            <title id={`${id}-title`}>{title}</title>
            <desc>{t(onSelect ? 'analytics.chart_help' : 'analytics.chart_reference_help')}</desc>
            <line x1="24" y1="136" x2="576" y2="136" className={styles.axis} />
            {bars.map((bar) => (
              <g key={bar.key}>
                {bar.height !== null && (
                  <rect
                    x={bar.x}
                    y={136 - bar.height}
                    width={bar.width}
                    height={Math.max(1, bar.height)}
                    className={styles.bar}
                  />
                )}
                <rect
                  x={bar.x}
                  y="16"
                  width={bar.width}
                  height="124"
                  fill="transparent"
                  role={onSelect ? 'button' : 'img'}
                  tabIndex={onSelect ? 0 : undefined}
                  aria-label={`${bar.label}: ${bar.value === null ? t('analytics.unavailable_value') : analyticsNumber(bar.value, i18n.language, currency)}`}
                  onFocus={() => setReadout(bar)}
                  onMouseEnter={() => setReadout(bar)}
                  onClick={() => onSelect?.(bar.key)}
                  onKeyDown={(event) => {
                    if (onSelect && (event.key === 'Enter' || event.key === ' ')) {
                      event.preventDefault();
                      onSelect(bar.key);
                    }
                  }}
                >
                  <title>{`${bar.label}: ${analyticsNumber(bar.value, i18n.language, currency)}`}</title>
                </rect>
              </g>
            ))}
          </svg>
          <div className={styles.chartLabels} aria-hidden="true">
            {[data[0], ...(data.length > 1 ? [data[data.length - 1]] : [])].map((point) => (
              <span key={point.key} title={point.label}>
                {point.at === undefined
                  ? point.label
                  : `${analyticsShortTime(point.at, i18n.language, interval === 86_400_000)} UTC`}
              </span>
            ))}
          </div>
          <output className={styles.chartReadout} aria-live="polite">
            {readout
              ? `${readout.label}: ${analyticsNumber(readout.value, i18n.language, currency)}`
              : t(onSelect ? 'analytics.chart_readout_hint' : 'analytics.chart_reference_hint')}
          </output>
          <details className={styles.readout}>
            <summary>{t('analytics.table_alternative')}</summary>
            <div className={styles.tableScroll} tabIndex={0} role="region" aria-label={title}>
              <table>
                <caption className={styles.srOnly}>{title}</caption>
                <thead>
                  <tr>
                    <th scope="col">{t('analytics.bucket_category')}</th>
                    <th scope="col">{title}</th>
                  </tr>
                </thead>
                <tbody>
                  {data.map((d) => (
                    <tr key={d.key}>
                      <th scope="row">
                        {onSelect ? (
                          <button
                            type="button"
                            className={styles.textButton}
                            onClick={() => onSelect(d.key)}
                          >
                            {d.label}
                          </button>
                        ) : (
                          d.label
                        )}
                      </th>
                      <td>
                        {d.value === null
                          ? t('analytics.unavailable_value')
                          : analyticsNumber(d.value, i18n.language, currency)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </details>
        </>
      )}
    </section>
  );
}
