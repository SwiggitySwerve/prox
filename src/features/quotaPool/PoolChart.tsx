import { useId, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { PoolDashboard, QuotaPool } from '@/domain/quotaPool/types';
import { chartGeometry, chartSamples, metricField, type ChartMode } from './chartGeometry';
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
  const [selected, setSelected] = useState<number | null>(null);
  const { fromMs, toMs, nowMs } = dashboard;
  const samples = chartSamples(pool.recorded, pool.projected, mode).filter(
    ({ point }) => point.atMs >= fromMs && point.atMs <= toMs
  );
  const geometry = chartGeometry(samples, mode, pool.capacityPoints, fromMs, toMs);
  const { x, y, min, max, segments } = geometry;
  const field = metricField[mode];
  const sample = selected === null ? undefined : samples[Math.min(selected, samples.length - 1)];
  const unit = t(`quota_pool.${mode === 'remaining' ? 'points' : 'points_hour'}`);
  const number = (value: number | null) => formatPoolNumber(value, i18n.language);
  const date = (value: number) => formatPoolDate(value, i18n.language);
  const visible = (at: number | null): at is number => at !== null && at >= fromMs && at <= toMs;
  const hasValues = samples.some(({ point }) => point[field] !== null);
  const description = sample
    ? `${date(sample.point.atMs)} · ${sample.point[field] === null ? t('quota_pool.no_observation') : `${number(sample.point[field])} ${unit}`} · ${t(`quota_pool.${sample.projected ? 'projected' : 'recorded'}`)}`
    : t('quota_pool.inspect_hint');

  return (
    <div className={styles.chart}>
      <div className={styles.chartReadout} id={`${id}-readout`} aria-live="polite">
        {description}
      </div>
      <svg
        viewBox="0 0 1000 300"
        role="img"
        aria-labelledby={`${id}-title ${id}-desc`}
        onPointerMove={(event) => {
          const bounds = event.currentTarget.getBoundingClientRect();
          const cursorX = ((event.clientX - bounds.left) / bounds.width) * 1000;
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
            <rect x="64" y="35" width="912" height="222" />
          </clipPath>
        </defs>
        {(min === max ? [min] : [min, (min + max) / 2, max]).map((value, index) => (
          <g key={index} className={styles.grid}>
            <line x1="64" x2="976" y1={y(value)} y2={y(value)} />
            <text x="54" y={y(value) + 4} textAnchor="end">
              {number(value)}
            </text>
          </g>
        ))}
        {Array.from({ length: 8 }, (_, index) => {
          const at = fromMs + ((toMs - fromMs) * index) / 7;
          return (
            <g key={index} className={styles.grid}>
              <line x1={x(at)} x2={x(at)} y1="38" y2="254" />
              <text
                x={x(at)}
                y="280"
                textAnchor={index === 0 ? 'start' : index === 7 ? 'end' : 'middle'}
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
            <line x1={x(nowMs)} x2={x(nowMs)} y1="38" y2="254" className={styles.nowLine} />
          )}
          {sample && sample.point[field] !== null && (
            <>
              <line
                x1={x(sample.point.atMs)}
                x2={x(sample.point.atMs)}
                y1="38"
                y2="254"
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
          <text className={styles.nowLabel} x={x(nowMs)} y="26" textAnchor="middle">
            {t('quota_pool.now')}
          </text>
        )}
        {mode === 'remaining' &&
          pool.resets
            .filter((reset) => visible(reset.atMs))
            .map((reset, index) => (
              <g key={`${reset.atMs}-${index}`} className={styles.resetMarker}>
                <line x1={x(reset.atMs)} x2={x(reset.atMs)} y1="38" y2="49" />
                <text x={x(reset.atMs)} y={index % 2 ? 17 : 30} textAnchor="middle">
                  +{number(reset.gainPoints)}
                </text>
                <title>{`${t('quota_pool.reset')}: ${date(reset.atMs)} · +${number(reset.gainPoints)} ${unit}`}</title>
              </g>
            ))}
        {!hasValues && (
          <text x="520" y="150" textAnchor="middle" className={styles.emptyChart}>
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
