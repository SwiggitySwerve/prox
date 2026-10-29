import { useId, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { lineSegments, niceMaximum, timeTicks } from './chartGeometry';
import { analyticsCompact, analyticsNumber, analyticsShortTime, analyticsTime } from './format';
import styles from './AnalyticsPage.module.scss';

export interface TrendSeries {
  key: string;
  label: string;
  /** CSS colour for the line; meaning is fixed per metric across the page. */
  color: string;
  dash?: 'dashed' | 'dotted';
  currency?: boolean;
}
export interface TrendPoint {
  at: number;
  values: (number | null)[];
}

const FRAME = { left: 0, right: 1000, top: 10, bottom: 230 };
const TICKS = [1, 0.75, 0.5, 0.25, 0];
const DASH = { dashed: '7 5', dotted: '1.5 5' };

/**
 * Several timeline series on one time axis. Each line uses its own scale unless `sharedScale`
 * (same unit); a missing bucket or null value breaks the line instead of bridging it.
 */
export function TrendChart({
  title,
  series,
  points,
  from,
  to,
  interval,
  sharedScale = false,
  onSelect,
}: {
  title: string;
  series: TrendSeries[];
  points: TrendPoint[];
  from: number;
  to: number;
  interval: number;
  sharedScale?: boolean;
  onSelect?: (at: number) => void;
}) {
  const { t, i18n } = useTranslation();
  const id = useId();
  const [inspected, setInspected] = useState<number | null>(null);
  const daily = interval >= 86_400_000;
  const frame = { ...FRAME, from, to, interval };
  // Axis maxima are rounded so the quarter ticks read as round values.
  const peak = (index: number) => Math.max(0, ...points.map((p) => p.values[index] ?? 0));
  const shared = niceMaximum(Math.max(0, ...series.map((_, index) => peak(index))));
  const lines = series.map((_, index) =>
    lineSegments(
      points.map((p) => ({ at: p.at, value: p.values[index] })),
      frame,
      sharedScale ? shared : niceMaximum(peak(index))
    )
  );
  const measured = series.map((_, index) => points.some((p) => p.values[index] !== null));
  const single = series.length === 1;
  const value = (index: number, v: number | null | undefined) =>
    analyticsNumber(v ?? null, i18n.language, series[index].currency);
  const pointLabel = (point: TrendPoint) =>
    `${analyticsTime(point.at, i18n.language)} UTC · ${series
      .map((s, index) => `${s.label}: ${value(index, point.values[index])}`)
      .join(' · ')}`;
  const current = points.find((p) => p.at === inspected);
  const axes = sharedScale
    ? [0]
    : series
        .map((_, index) => index)
        .filter((index) => measured[index])
        .slice(0, 3);
  const pct = (at: number) => ((at - from) / Math.max(1, to - from)) * 100;
  const tick = (index: number, fraction: number) => {
    const v = lines[index].maximum * fraction;
    // One format per axis, chosen by its maximum, so ticks never mix 5,000 with 10K.
    return series[index].currency || lines[index].maximum >= 10_000
      ? analyticsCompact(v, i18n.language, series[index].currency)
      : analyticsNumber(v, i18n.language);
  };
  return (
    <section className={`${styles.panel} ${styles.trend}`} aria-labelledby={id}>
      <div className={styles.trendHeader}>
        <h3 id={id}>{title}</h3>
        {!single && (
          <ul className={styles.legend} aria-label={t('analytics.legend')}>
            {series.map((s, index) => (
              <li key={s.key} data-empty={!measured[index]}>
                <svg viewBox="0 0 24 8" aria-hidden="true">
                  <line
                    x1="2"
                    y1="4"
                    x2="22"
                    y2="4"
                    style={{ stroke: s.color }}
                    strokeDasharray={s.dash ? DASH[s.dash] : undefined}
                  />
                </svg>
                {s.label}
                {!measured[index] && ` · ${t('analytics.no_data')}`}
                {/* Narrow screens drop the coloured right axes; their ranges move here. */}
                {!sharedScale && index > 0 && measured[index] && (
                  <span className={styles.narrowOnly}> · 0–{tick(index, 1)}</span>
                )}
              </li>
            ))}
          </ul>
        )}
      </div>
      {!measured.some(Boolean) ? (
        <p className={styles.muted}>{t('analytics.empty_chart')}</p>
      ) : (
        <>
          <div className={styles.trendPlot} data-axes={axes.length}>
            {axes.map((index) => (
              <div
                key={index}
                className={styles.trendAxis}
                data-side={index === 0 ? 'left' : 'right'}
                style={{ color: sharedScale ? undefined : series[index].color }}
                aria-hidden="true"
              >
                {TICKS.map((fraction) => (
                  <span key={fraction}>{tick(index, fraction)}</span>
                ))}
              </div>
            ))}
            <svg
              viewBox={`0 0 ${FRAME.right} 240`}
              preserveAspectRatio="none"
              className={styles.trendSvg}
              role="group"
              aria-labelledby={`${id}-title`}
              onMouseLeave={() => setInspected(null)}
            >
              <title id={`${id}-title`}>{title}</title>
              <desc>{t('analytics.trend_help')}</desc>
              {TICKS.map((tick) => (
                <line
                  key={tick}
                  x1={FRAME.left}
                  x2={FRAME.right}
                  y1={FRAME.bottom - tick * (FRAME.bottom - FRAME.top)}
                  y2={FRAME.bottom - tick * (FRAME.bottom - FRAME.top)}
                  className={tick === 0 ? styles.axis : styles.gridLine}
                  vectorEffect="non-scaling-stroke"
                />
              ))}
              {lines.map((line, index) =>
                line.segments.map((segment, part) => {
                  const path = segment.map(([x, y], i) => `${i ? 'L' : 'M'}${x},${y}`).join(' ');
                  return (
                    <g key={`${series[index].key}-${part}`}>
                      {index === 0 && segment.length > 2 && (
                        <path
                          d={`${path} L${segment[segment.length - 1][0]},${FRAME.bottom} L${segment[0][0]},${FRAME.bottom} Z`}
                          style={{ fill: series[index].color }}
                          className={styles.trendArea}
                        />
                      )}
                      {segment.length > 1 ? (
                        <path
                          d={path}
                          style={{ stroke: series[index].color }}
                          strokeDasharray={
                            series[index].dash ? DASH[series[index].dash] : undefined
                          }
                          className={styles.trendLine}
                          vectorEffect="non-scaling-stroke"
                        />
                      ) : (
                        // An isolated measured hour: a visible marker, not a 1px stub.
                        <path
                          d={`${path} l0.01,0`}
                          style={{ stroke: series[index].color }}
                          className={styles.trendPoint}
                          vectorEffect="non-scaling-stroke"
                        />
                      )}
                    </g>
                  );
                })
              )}
              {current && (
                <g aria-hidden="true">
                  <line
                    x1={lines[0].x(current.at)}
                    x2={lines[0].x(current.at)}
                    y1={FRAME.top}
                    y2={FRAME.bottom}
                    className={styles.guide}
                    vectorEffect="non-scaling-stroke"
                  />
                  {current.values.map((v, index) =>
                    v === null ? null : (
                      <path
                        key={index}
                        d={`M${lines[index].x(current.at)},${lines[index].y(v)} l0.01,0`}
                        style={{ stroke: series[index].color }}
                        className={styles.trendDot}
                        vectorEffect="non-scaling-stroke"
                      />
                    )
                  )}
                </g>
              )}
              {points.map((point) => {
                const left = Math.max(from, point.at);
                const right = Math.min(to, point.at + interval);
                const x = ((left - from) / Math.max(1, to - from)) * FRAME.right;
                const width = Math.max(1, ((right - left) / Math.max(1, to - from)) * FRAME.right);
                return (
                  <rect
                    key={point.at}
                    x={x}
                    y="0"
                    width={width}
                    height="240"
                    fill="transparent"
                    className={styles.hit}
                    role={onSelect ? 'button' : 'img'}
                    tabIndex={onSelect ? 0 : undefined}
                    aria-label={pointLabel(point)}
                    onFocus={() => setInspected(point.at)}
                    onMouseEnter={() => setInspected(point.at)}
                    onClick={() => onSelect?.(point.at)}
                    onKeyDown={(event) => {
                      if (onSelect && (event.key === 'Enter' || event.key === ' ')) {
                        event.preventDefault();
                        onSelect(point.at);
                      }
                    }}
                  />
                );
              })}
            </svg>
            <div className={styles.trendTime} aria-hidden="true">
              {timeTicks(from, to, interval, 6).map((at, index) => (
                <span
                  key={at}
                  style={{ left: `${pct(at)}%` }}
                  data-edge={pct(at) < 4 ? 'start' : pct(at) > 96 ? 'end' : undefined}
                  // Narrow screens show every other label.
                  data-minor={index % 2 === 1}
                >
                  {analyticsShortTime(at, i18n.language, daily)}
                </span>
              ))}
            </div>
          </div>
          <p className={styles.trendScale}>
            {single ? (
              t('analytics.trend_gaps')
            ) : sharedScale ? (
              t('analytics.trend_shared_scale')
            ) : (
              <>
                <span className={styles.wideOnly}>{t('analytics.trend_own_scale')}</span>
                <span className={styles.narrowOnly}>{t('analytics.trend_own_scale_narrow')}</span>
              </>
            )}
          </p>
          <output className={styles.chartReadout} aria-live="polite">
            {current
              ? pointLabel(current)
              : t(onSelect ? 'analytics.trend_hint' : 'analytics.trend_reference_hint')}
          </output>
          <details className={styles.readout}>
            <summary>{t('analytics.table_alternative')}</summary>
            <div className={styles.tableScroll} tabIndex={0} role="region" aria-label={title}>
              <table>
                <caption className={styles.srOnly}>{title}</caption>
                <thead>
                  <tr>
                    <th scope="col">{t('analytics.bucket_category')}</th>
                    {series.map((s) => (
                      <th scope="col" key={s.key}>
                        {s.label}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {points.map((point) => (
                    <tr key={point.at}>
                      <th scope="row">
                        {onSelect ? (
                          <button
                            type="button"
                            className={styles.textButton}
                            onClick={() => onSelect(point.at)}
                          >
                            {analyticsTime(point.at, i18n.language)} UTC
                          </button>
                        ) : (
                          `${analyticsTime(point.at, i18n.language)} UTC`
                        )}
                      </th>
                      {series.map((s, index) => (
                        <td key={s.key}>{value(index, point.values[index])}</td>
                      ))}
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
