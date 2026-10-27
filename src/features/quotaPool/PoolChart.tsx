import { useEffect, useId, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { PoolDashboard, QuotaPool } from '@/domain/quotaPool/types';
import {
  chartFrame as defaultChartFrame,
  fitChartFrame,
  chartGeometry,
  chartSamples,
  metricField,
  type ChartMode,
} from './chartGeometry';
import { formatPoolDate, formatPoolNumber } from './presentation';
import styles from './QuotaPoolPage.module.scss';

export function PoolChart({
  pool,
  dashboard,
  mode,
}: {
  pool: QuotaPool;
  dashboard: Pick<PoolDashboard, 'fromMs' | 'toMs' | 'nowMs'>;
  mode: ChartMode;
}) {
  const { t, i18n } = useTranslation();
  const id = useId();
  const container = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(defaultChartFrame.width);
  useEffect(() => {
    const element = container.current;
    if (!element) return;
    const update = () => {
      const next = element.getBoundingClientRect().width;
      if (next > 0) setWidth(next);
    };
    update();
    const observer = new ResizeObserver(update);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  const chartFrame = fitChartFrame(width);
  const tickCount = width < 480 ? 3 : width < 850 ? 5 : 8;
  const [selected, setSelected] = useState<number | null>(null);
  const { fromMs, toMs, nowMs } = dashboard;
  const samples = chartSamples(pool.recorded, pool.projected, mode).filter(
    ({ point }) => point.atMs >= fromMs && point.atMs <= toMs
  );
  const geometry = chartGeometry(samples, mode, pool.capacityPoints, fromMs, toMs, chartFrame);
  const { x, y, min, max, segments } = geometry;
  const field = metricField[mode];
  const sample = selected === null ? undefined : samples[Math.min(selected, samples.length - 1)];
  const unit = t(`quota_pool.${mode === 'remaining' ? 'points' : 'points_hour'}`);
  const number = (value: number | null) => formatPoolNumber(value, i18n.language);
  const date = (value: number) => formatPoolDate(value, i18n.language);
  const visible = (at: number | null): at is number => at !== null && at >= fromMs && at <= toMs;
  // Keep dense five-hour reset labels legible; every reset still has a tick and title.
  let lastLabelX = -Infinity;
  const resetMarkers = pool.resets
    .filter((reset) => visible(reset.atMs) && reset.gainPoints > 0)
    .map((reset) => {
      const showLabel =
        x(reset.atMs) - lastLabelX >= 100 &&
        (!visible(nowMs) || Math.abs(x(reset.atMs) - x(nowMs)) >= 60);
      if (showLabel) lastLabelX = x(reset.atMs);
      return { ...reset, showLabel };
    });
  const hasValues = samples.some(({ point }) => point[field] !== null);
  const description = sample
    ? `${date(sample.point.atMs)} · ${sample.point[field] === null ? t('quota_pool.no_observation') : `${number(sample.point[field])} ${unit}`} · ${t(`quota_pool.${sample.projected ? 'projected' : 'recorded'}`)}`
    : t('quota_pool.inspect_hint');

  return (
    <div className={styles.chart} ref={container}>
      <div className={styles.chartReadout} id={`${id}-readout`} aria-live="polite">
        {description}
      </div>
      <svg
        viewBox={`0 0 ${chartFrame.width} ${chartFrame.height}`}
        role="img"
        aria-labelledby={`${id}-title ${id}-desc`}
        onPointerMove={(event) => {
          const bounds = event.currentTarget.getBoundingClientRect();
          const cursorX = ((event.clientX - bounds.left) / bounds.width) * chartFrame.width;
          let closest = 0;
          for (let index = 1; index < samples.length; index += 1) {
            if (
              Math.abs(x(samples[index].point.atMs) - cursorX) <=
              Math.abs(x(samples[closest].point.atMs) - cursorX)
            )
              closest = index;
          }
          if (samples.length) setSelected(closest);
        }}
      >
        <title id={`${id}-title`}>
          {t('quota_pool.chart_title', {
            provider: t(`quota_pool.${pool.provider}`),
            mode: t(`quota_pool.${mode}`),
          })}
        </title>
        <desc id={`${id}-desc`}>{t('quota_pool.chart_description')}</desc>
        <defs>
          <linearGradient id={`${id}-fill`} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="var(--pool-accent)" stopOpacity=".19" />
            <stop offset="100%" stopColor="var(--pool-accent)" stopOpacity="0" />
          </linearGradient>
          <clipPath id={`${id}-clip`}>
            <rect
              x={chartFrame.left}
              y={chartFrame.top - 3}
              width={chartFrame.right - chartFrame.left}
              height={chartFrame.bottom - chartFrame.top + 6}
            />
          </clipPath>
        </defs>
        {(min === max ? [min] : [min, (min + max) / 2, max]).map((value, index) => (
          <g key={index} className={styles.grid}>
            <line x1={chartFrame.left} x2={chartFrame.right} y1={y(value)} y2={y(value)} />
            <text x={chartFrame.left - 10} y={y(value) + 4} textAnchor="end">
              {number(value)}
            </text>
          </g>
        ))}
        {Array.from({ length: tickCount }, (_, index) => {
          const at = fromMs + ((toMs - fromMs) * index) / (tickCount - 1);
          return (
            <g key={index} className={styles.grid}>
              <line x1={x(at)} x2={x(at)} y1={chartFrame.top} y2={chartFrame.bottom} />
              <text
                x={x(at)}
                y={chartFrame.bottom + 26}
                textAnchor={index === 0 ? 'start' : index === tickCount - 1 ? 'end' : 'middle'}
              >
                {formatPoolDate(at, i18n.language, true)}
              </text>
            </g>
          );
        })}
        <g clipPath={`url(#${id}-clip)`}>
          {[false, true].map((projected) =>
            segments(projected).map((path, index) => {
              const firstX = path.slice(1).split(',')[0];
              const lastX = path.split(' L').slice(-1)[0]?.replace(/^M/, '').split(',')[0];
              return (
                <g key={`${projected}-${index}`}>
                  {mode === 'remaining' && (
                    <path
                      d={`${path} L${lastX},${y(0)} L${firstX},${y(0)} Z`}
                      fill={`url(#${id}-fill)`}
                    />
                  )}
                  <path
                    d={path}
                    fill="none"
                    stroke="var(--pool-accent)"
                    strokeWidth="2.4"
                    strokeDasharray={projected ? '7 5' : undefined}
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  />
                </g>
              );
            })
          )}
          {samples.map(({ point, projected }, index) =>
            point[field] === null ? null : (
              <circle
                key={index}
                cx={x(point.atMs)}
                cy={y(point[field])}
                r={samples.length < 3 ? 3 : 1.5}
                fill="var(--pool-accent)"
                opacity={projected ? 0.6 : 1}
              />
            )
          )}
          {visible(nowMs) && (
            <line
              x1={x(nowMs)}
              x2={x(nowMs)}
              y1={chartFrame.top}
              y2={chartFrame.bottom}
              className={styles.nowLine}
            />
          )}
          {sample && sample.point[field] !== null && (
            <>
              <line
                x1={x(sample.point.atMs)}
                x2={x(sample.point.atMs)}
                y1={chartFrame.top}
                y2={chartFrame.bottom}
                stroke="var(--pool-accent)"
                opacity=".5"
              />
              <circle
                cx={x(sample.point.atMs)}
                cy={y(sample.point[field])}
                r="5"
                fill="var(--pool-accent)"
                stroke="#111"
                strokeWidth="2"
              />
            </>
          )}
          {mode === 'remaining' && visible(pool.poolEmptyAtMs) && (
            <circle
              cx={x(pool.poolEmptyAtMs)}
              cy={y(0)}
              r="5"
              fill="#111"
              stroke="var(--pool-accent)"
              strokeWidth="2"
            >
              <title>{`${t('quota_pool.pool_empty')}: ${date(pool.poolEmptyAtMs)}`}</title>
            </circle>
          )}
        </g>
        {visible(nowMs) && (
          <text
            className={styles.nowLabel}
            x={x(nowMs)}
            y={chartFrame.top - 12}
            textAnchor="middle"
          >
            {t('quota_pool.now')}
          </text>
        )}
        {mode === 'remaining' &&
          resetMarkers.map((reset, index) => (
            <g key={`${reset.atMs}-${index}`} className={styles.resetMarker}>
              <line
                x1={x(reset.atMs)}
                x2={x(reset.atMs)}
                y1={chartFrame.top}
                y2={chartFrame.top + 11}
              />
              {reset.showLabel && (
                <text x={x(reset.atMs)} y={chartFrame.top - 18} textAnchor="middle">
                  +{number(reset.gainPoints)}
                </text>
              )}
              <title>{`${t('quota_pool.reset')}: ${date(reset.atMs)} · +${number(reset.gainPoints)} ${unit}`}</title>
            </g>
          ))}
        {!hasValues && (
          <text
            x={(chartFrame.left + chartFrame.right) / 2}
            y={chartFrame.height / 2}
            textAnchor="middle"
            className={styles.emptyChart}
          >
            {t('quota_pool.no_history')}
          </text>
        )}
      </svg>
      <div className={styles.chartFooter}>
        <div className={styles.legend}>
          <span>{unit}</span>
          <span>
            <i />
            {t('quota_pool.recorded')}
          </span>
          {mode === 'remaining' && (
            <span>
              <i className={styles.dashed} />
              {t('quota_pool.projected')}
            </span>
          )}
        </div>
        {samples.length > 0 && (
          <label className={styles.inspect}>
            <span>{t('quota_pool.inspect')}</span>
            <input
              type="range"
              min="0"
              max={samples.length - 1}
              value={selected ?? 0}
              aria-describedby={`${id}-readout`}
              aria-valuetext={sample ? description : t('quota_pool.inspect_hint')}
              onFocus={() => setSelected((current) => current ?? 0)}
              onChange={(event) => setSelected(Number(event.target.value))}
            />
          </label>
        )}
      </div>
    </div>
  );
}
