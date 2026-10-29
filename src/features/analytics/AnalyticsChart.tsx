import { useId, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { analyticsCompact, analyticsMoney, analyticsNumber } from './format';
import type { ChartDatum } from './chartGeometry';
import styles from './AnalyticsPage.module.scss';

/** Provider identity colours; other categories use the neutral bar. */
const categoryColor = (key: string) =>
  key === 'claude' ? 'var(--claude-color)' : key === 'codex' ? 'var(--codex-color)' : undefined;

/**
 * Categories ranked by their server-supplied value as horizontal bars, so long names stay
 * readable. Missing values sort last and draw no bar; the table repeats every value.
 */
export function AnalyticsChart({
  title,
  data,
  format = 'compact',
  onSelect,
}: {
  title: string;
  data: ChartDatum[];
  /** compact: 12.5K counts; exact: durations; money: dollars to the cent. */
  format?: 'compact' | 'exact' | 'money';
  onSelect?: (key: string) => void;
}) {
  const { t, i18n } = useTranslation();
  const id = useId();
  const [inspectedKey, setInspectedKey] = useState<string | null>(null);
  const readout = data.find((point) => point.key === inspectedKey);
  const maximum = Math.max(0, ...data.map((d) => d.value ?? 0));
  const ranked = [...data].sort((a, b) => (b.value ?? -Infinity) - (a.value ?? -Infinity));
  const currency = format === 'money';
  const exact = (value: number | null) => analyticsNumber(value, i18n.language, currency);
  const shown = (value: number | null) =>
    format === 'money'
      ? analyticsMoney(value, i18n.language)
      : format === 'exact'
        ? analyticsNumber(value, i18n.language)
        : analyticsCompact(value, i18n.language);
  return (
    <section className={`${styles.panel} ${styles.breakdown}`} aria-labelledby={id}>
      <h3 id={id}>{title}</h3>
      {data.length === 0 ? (
        <p className={styles.muted}>{t('analytics.empty_chart')}</p>
      ) : (
        <>
          <ol className={styles.ranked}>
            {ranked.map((d) => {
              const content = (
                <>
                  <span className={styles.rankedLabel} title={d.label}>
                    {categoryColor(d.key) && (
                      <span
                        className={styles.categoryDot}
                        style={{ background: categoryColor(d.key) }}
                        aria-hidden="true"
                      />
                    )}
                    {d.label}
                  </span>
                  {/* A missing value draws no track: an empty track would read as zero. */}
                  {d.value !== null && (
                    <span className={styles.rankedTrack} aria-hidden="true">
                      <span
                        style={{
                          width: `${maximum > 0 ? Math.max(0.5, (d.value / maximum) * 100) : 0}%`,
                          background: categoryColor(d.key),
                        }}
                      />
                    </span>
                  )}
                  <strong title={exact(d.value)} data-unavailable={d.value === null}>
                    {shown(d.value)}
                  </strong>
                </>
              );
              return (
                <li key={d.key}>
                  {onSelect ? (
                    <button
                      type="button"
                      className={styles.rankedRow}
                      aria-label={`${d.label}: ${exact(d.value)}`}
                      onFocus={() => setInspectedKey(d.key)}
                      onMouseEnter={() => setInspectedKey(d.key)}
                      onClick={() => onSelect(d.key)}
                    >
                      {content}
                    </button>
                  ) : (
                    <div className={styles.rankedRow} onMouseEnter={() => setInspectedKey(d.key)}>
                      {content}
                    </div>
                  )}
                </li>
              );
            })}
          </ol>
          <output className={styles.chartReadout} aria-live="polite">
            {readout ? `${readout.label}: ${exact(readout.value)}` : null}
          </output>
          {data.some((d) => d.value !== null) && (
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
                          {d.value === null ? t('analytics.unavailable_value') : exact(d.value)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </details>
          )}
        </>
      )}
    </section>
  );
}
