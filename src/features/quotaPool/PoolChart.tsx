import { useEffect, useId, useRef, useState, type PointerEvent } from 'react';
import { useTranslation } from 'react-i18next';
import type { PoolDashboard, QuotaPool, PoolTrace, PoolProviderId } from '@/domain/quotaPool/types';
import {
  chartFrame as defaultChartFrame,
  fitChartFrame,
  chartGeometry,
  chartSamples,
  stackSamples,
  bandSegments,
  dayTicks,
  hourTicks,
  inRange,
  viewRange,
  metricField,
  type ChartMode,
} from './chartGeometry';
import { formatPoolDate, formatPoolNumber, formatPoolTick } from './presentation';
import styles from './QuotaPoolPage.module.scss';

type ChartPool = PoolTrace & {
  provider: PoolProviderId | 'total';
  sourceLabel?: string;
  instanceId?: string;
};

interface ChartProps {
  dashboard: Pick<PoolDashboard, 'fromMs' | 'toMs' | 'nowMs' | 'window'>;
  mode: ChartMode;
  savedData?: boolean;
  minimized?: boolean;
  stackedTotal?: PoolTrace;
}

export function PoolChart({ pool, ...props }: ChartProps & { pool: QuotaPool }) {
  return <PoolChartView {...props} pools={[pool]} />;
}

export function PoolComparisonChart(props: ChartProps & { pools: ChartPool[] }) {
  return <PoolChartView {...props} comparison />;
}

function PoolChartView({
  pools,
  dashboard,
  mode,
  savedData = false,
  minimized = false,
  comparison = false,
  stackedTotal,
}: ChartProps & { pools: ChartPool[]; comparison?: boolean }) {
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
  const chartFrame = fitChartFrame(
    width,
    savedData || pools.some((pool) => pool.forecastState !== 'ready') || mode !== 'remaining',
    minimized,
    formatPoolNumber(
      Math.max(0, stackedTotal?.capacityPoints ?? 0, ...pools.map((pool) => pool.capacityPoints)),
      i18n.language
    ).length
  );
  const tickCount = width < 480 ? 3 : width < 850 ? 5 : 8;
  // null = not yet inspected: show the newest recorded sample, i.e. the current reading.
  const [inspected, setInspected] = useState<number | null>(null);
  const { fromMs, toMs } = viewRange(dashboard, mode);
  const { nowMs } = dashboard;
  // Two days or less: one tick per few hours instead of one per day.
  const hourly = toMs - fromMs <= 2.5 * 86_400_000;
  const field = metricField[mode];
  const rawSeries = pools.map((pool) => {
    const samples = inRange(chartSamples(pool.recorded, pool.projected, mode), fromMs, toMs);
    return {
      pool,
      samples,
      sparseProjection: samples.filter((sample) => sample.projected).length < 3,
    };
  });
  const totalSamples = stackedTotal
    ? inRange(chartSamples(stackedTotal.recorded, stackedTotal.projected, mode), fromMs, toMs)
    : [];
  const stacked = stackedTotal
    ? stackSamples(
        rawSeries.map((series) => series.samples),
        totalSamples,
        mode
      )
    : undefined;
  const series = rawSeries.map((series, index) => {
    const samples = series.samples.map((sample, at) => {
      const position = stacked ? (stacked[index][at]?.upper ?? null) : sample.point[field];
      return {
        ...sample,
        position,
        base: stacked?.[index][at]?.lower ?? 0,
        point: stacked && position === null ? { ...sample.point, [field]: null } : sample.point,
      };
    });
    return {
      ...series,
      samples,
      plotSamples: samples.map((sample) => ({
        ...sample,
        point: { ...sample.point, [field]: sample.position },
      })),
      band: stacked?.[index],
    };
  });
  const samples = series.flatMap(({ pool, samples }) =>
    samples.map((sample) => ({ ...sample, pool }))
  );
  // Order inspection by time without joining or resampling separate source traces.
  if (comparison) samples.sort((a, b) => a.point.atMs - b.point.atMs);
  const poolLabel = (pool: ChartPool) =>
    `${t(`quota_pool.${pool.provider}`)}${pool.sourceLabel || pool.instanceId ? ` · ${pool.sourceLabel ?? pool.instanceId}` : ''}`;
  const geometry = chartGeometry(
    stacked
      ? stacked.flatMap((layer) =>
          layer.flatMap((sample) =>
            [sample.lower, sample.upper].map((value) => ({
              ...sample,
              point: { ...sample.point, [field]: value },
            }))
          )
        )
      : samples,
    mode,
    stackedTotal?.capacityPoints ?? Math.max(0, ...pools.map((pool) => pool.capacityPoints)),
    fromMs,
    toMs,
    chartFrame
  );
  const { x, y, min, max, segments } = geometry;
  const latestRecorded = samples.reduce(
    (latest, { point, projected }, index) => (!projected && point.atMs <= nowMs ? index : latest),
    0
  );
  const selected = Math.max(0, Math.min(inspected ?? latestRecorded, samples.length - 1));
  const sample = samples[Math.min(selected, samples.length - 1)];
  const unit = t(`quota_pool.${mode === 'remaining' ? 'points' : 'points_hour'}`);
  const number = (value: number | null) => formatPoolNumber(value, i18n.language);
  const date = (value: number) => formatPoolDate(value, i18n.language);
  const visible = (at: number | null): at is number => at !== null && at >= fromMs && at <= toMs;
  // Keep dense five-hour reset labels legible; every reset still has a tick and title.
  let lastLabelX = -Infinity;
  const resetMarkers = (comparison ? [] : pools)
    .flatMap((pool) => pool.resets)
    .filter((reset) => visible(reset.atMs) && reset.gainPoints > 0)
    .map((reset) => {
      const showLabel =
        x(reset.atMs) - lastLabelX >= 100 &&
        (!visible(nowMs) || Math.abs(x(reset.atMs) - x(nowMs)) >= 60);
      if (showLabel) lastLabelX = x(reset.atMs);
      return { ...reset, showLabel };
    });
  const hasValues = samples.some(({ point }) => point[field] !== null);
  const hasProjection = samples.some(({ point, projected }) => projected && point[field] !== null);
  // On a combined chart, state every provider's value at the selected moment, not one of them.
  const readingAt = sample
    ? comparison
      ? samples
          .filter(
            (other) =>
              other.point.atMs === sample.point.atMs && other.projected === sample.projected
          )
          .filter(
            (other, index, all) =>
              all.findIndex((first) => poolLabel(first.pool) === poolLabel(other.pool)) === index
          )
      : [sample]
    : [];
  const readingValue = (other: (typeof samples)[number]) =>
    other.point[field] === null ? t('quota_pool.no_observation') : number(other.point[field]);
  // A moment with no value is not a recording: say so once, without a Recorded/Projected tag.
  const unobserved = readingAt.every((other) => other.point[field] === null);
  const readingText = !sample
    ? ''
    : unobserved
      ? `${t('quota_pool.no_observation')} · ${date(sample.point.atMs)}`
      : readingAt.length > 1
        ? `${readingAt.map((other) => `${poolLabel(other.pool)}: ${readingValue(other)}`).join(' · ')}${readingAt.some((other) => other.point[field] !== null) ? ` ${unit}` : ''}`
        : `${comparison ? `${poolLabel(sample.pool)} · ` : ''}${date(sample.point.atMs)} · ${sample.point[field] === null ? t('quota_pool.no_observation') : `${number(sample.point[field])} ${unit}`}`;
  const latestPrefix = selected === latestRecorded ? `${t('quota_pool.latest_reading')} · ` : '';
  const description = sample
    ? unobserved
      ? readingText
      : `${latestPrefix}${readingAt.length > 1 ? `${date(sample.point.atMs)} · ` : ''}${readingText}${sample.projected ? ` · ${t('quota_pool.projected')}` : ''}`
    : t('quota_pool.inspect_hint');

  const selectAtPointer = (event: PointerEvent<SVGSVGElement>) => {
    const bounds = event.currentTarget.getBoundingClientRect();
    const cursorX = ((event.clientX - bounds.left) / bounds.width) * chartFrame.width;
    const cursorY = ((event.clientY - bounds.top) / bounds.height) * chartFrame.height;
    const distance = (index: number) => {
      const { point, position, base } = samples[index];
      const dx = Math.abs(x(point.atMs) - cursorX);
      // On an overlay, equal timestamps must still allow either provider to be inspected.
      if (stackedTotal && position !== null) {
        const top = Math.min(y(position), y(base));
        const bottom = Math.max(y(position), y(base));
        return Math.hypot(dx, Math.max(top - cursorY, 0, cursorY - bottom));
      }
      return comparison && position !== null ? Math.hypot(dx, y(position) - cursorY) : dx;
    };
    let closest = 0;
    for (let index = 1; index < samples.length; index += 1) {
      if (distance(index) <= distance(closest)) closest = index;
    }
    if (samples.length) setInspected(closest);
  };

  return (
    <div className={styles.chart} ref={container}>
      <svg
        viewBox={`0 0 ${chartFrame.width} ${chartFrame.height}`}
        role="img"
        aria-labelledby={`${id}-title ${id}-desc`}
        aria-describedby={`${id}-readout`}
        tabIndex={samples.length > 1 ? 0 : undefined}
        onPointerDown={selectAtPointer}
        onPointerMove={selectAtPointer}
        onKeyDown={(event) => {
          const last = samples.length - 1;
          const next =
            event.key === 'ArrowLeft'
              ? Math.max(0, selected - 1)
              : event.key === 'ArrowRight'
                ? Math.min(last, selected + 1)
                : event.key === 'Home'
                  ? 0
                  : event.key === 'End'
                    ? last
                    : null;
          if (next === null || last < 1) return;
          event.preventDefault();
          setInspected(next);
        }}
      >
        <title id={`${id}-title`}>
          {t('quota_pool.chart_title', {
            provider: comparison
              ? t('quota_pool.combined_usage')
              : t(`quota_pool.${pools[0].provider}`),
            mode: t(`quota_pool.${mode}`),
          })}
        </title>
        <desc id={`${id}-desc`}>
          {t(
            stackedTotal
              ? mode === 'remaining'
                ? 'quota_pool.stacked_description'
                : 'quota_pool.stacked_rate_description'
              : comparison
                ? 'quota_pool.combined_description'
                : 'quota_pool.chart_description'
          )}
        </desc>
        <defs>
          <linearGradient id={`${id}-fill`} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="var(--pool-accent)" stopOpacity=".19" />
            <stop offset="100%" stopColor="var(--pool-accent)" stopOpacity="0" />
          </linearGradient>
          <clipPath id={`${id}-clip`}>
            <rect
              x={chartFrame.left - 6}
              y={chartFrame.top - 6}
              width={chartFrame.right - chartFrame.left + 12}
              height={chartFrame.bottom - chartFrame.top + 12}
            />
          </clipPath>
        </defs>
        <text className={styles.axisUnit} x={0} y={chartFrame.top - 14}>
          {unit}
        </text>
        {(min === max ? [min] : [min, (min + max) / 2, max]).map((value, index) => (
          <g key={index} className={styles.grid}>
            <line x1={chartFrame.left} x2={chartFrame.right} y1={y(value)} y2={y(value)} />
            <text x={chartFrame.left - 10} y={y(value) + 4} textAnchor="end">
              {number(value)}
            </text>
          </g>
        ))}
        {(hourly ? hourTicks : dayTicks)(fromMs, toMs, tickCount).map((at) => {
          const edge = 40;
          return (
            <g key={at} className={styles.grid}>
              <line x1={x(at)} x2={x(at)} y1={chartFrame.top} y2={chartFrame.bottom} />
              <text
                x={x(at)}
                y={chartFrame.bottom + 26}
                textAnchor={
                  x(at) - chartFrame.left < edge
                    ? 'start'
                    : chartFrame.right - x(at) < edge
                      ? 'end'
                      : 'middle'
                }
              >
                {formatPoolTick(at, i18n.language, hourly)}
              </text>
            </g>
          );
        })}
        <g clipPath={`url(#${id}-clip)`}>
          {series.map(
            (
              { pool, samples: seriesSamples, plotSamples, band, sparseProjection },
              seriesIndex
            ) => (
              <g
                key={seriesIndex}
                className={styles[pool.provider]}
                data-series={pool.instanceId ?? pool.provider}
              >
                {band &&
                  [false, true].flatMap((projected) =>
                    bandSegments(band, projected, x, y).map((path, index) => (
                      <path
                        key={`band-${projected}-${index}`}
                        data-stack-band={projected ? 'projected' : 'recorded'}
                        d={path}
                        fill="var(--pool-accent)"
                        fillOpacity={projected ? 0.14 : 0.3}
                      />
                    ))
                  )}
                {[false, true].map((projected) =>
                  segments(projected, plotSamples).map((path, index) => {
                    const firstX = path.slice(1).split(',')[0];
                    const lastX = path.split(' L').slice(-1)[0]?.replace(/^M/, '').split(',')[0];
                    return (
                      <g key={`${projected}-${index}`}>
                        {mode === 'remaining' && !comparison && (
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
                {seriesSamples.map(({ point, projected, position }, index) =>
                  position === null || (projected && !sparseProjection) ? null : (
                    <circle
                      key={index}
                      cx={x(point.atMs)}
                      cy={y(position!)}
                      r={seriesSamples.length < 3 ? 3 : 1.5}
                      fill="var(--pool-accent)"
                      opacity={projected ? 0.6 : 1}
                    />
                  )
                )}
              </g>
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
          {sample && sample.position !== null && (
            <g className={styles[sample.pool.provider]}>
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
                cy={y(sample.position)}
                r="5"
                fill="var(--pool-accent)"
                stroke="#111"
                strokeWidth="2"
              />
            </g>
          )}
          {mode === 'remaining' &&
            !stackedTotal &&
            pools.map(
              (pool, index) =>
                visible(pool.poolEmptyAtMs) && (
                  <circle
                    key={index}
                    className={styles[pool.provider]}
                    cx={x(pool.poolEmptyAtMs)}
                    cy={y(0)}
                    r="5"
                    fill="#111"
                    stroke="var(--pool-accent)"
                    strokeWidth="2"
                  >
                    <title>{`${t('quota_pool.pool_empty')}: ${date(pool.poolEmptyAtMs)}`}</title>
                  </circle>
                )
            )}
        </g>
        {visible(nowMs) && (
          <text
            className={styles.nowLabel}
            x={x(nowMs)}
            y={chartFrame.top - 12}
            // Near an edge (rate views end at the snapshot) the label turns inward to stay inside.
            textAnchor={
              chartFrame.right - x(nowMs) < 60
                ? 'end'
                : x(nowMs) - chartFrame.left < 60
                  ? 'start'
                  : 'middle'
            }
          >
            {t(`quota_pool.${savedData ? 'saved_snapshot' : 'snapshot'}`)}
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
        {/* The card's status chip and strip already explain degraded forecasts, and the page note
            explains rate views; only a ready pool with no projection needs saying here. */}
        {hasValues &&
          !hasProjection &&
          mode === 'remaining' &&
          pools.every((pool) => pool.forecastState === 'ready') &&
          visible(nowMs) &&
          x(nowMs) < chartFrame.right - 130 && (
            <text
              x={(x(nowMs) + chartFrame.right) / 2}
              y={(chartFrame.top + chartFrame.bottom) / 2}
              textAnchor="middle"
              className={styles.emptyChart}
            >
              {t('quota_pool.projection_unavailable')}
            </text>
          )}
      </svg>
      <div className={styles.chartFooter}>
        <div className={styles.legend}>
          {comparison &&
            pools.map((pool, index) => (
              <span key={index} className={styles[pool.provider]}>
                <i />
                {poolLabel(pool)}
                {pool.forecastState !== 'ready' &&
                  ` · ${t(`quota_pool.state.${pool.forecastState}`)}`}
              </span>
            ))}
          <span>
            <i />
            {t('quota_pool.recorded')}
          </span>
          {hasProjection && (
            <span>
              <i className={styles.dashed} />
              {t('quota_pool.projected')}
            </span>
          )}
          {mode === 'remaining' && resetMarkers.length > 0 && (
            <span>
              <i className={styles.resetKey} />
              {t('quota_pool.scheduled_reset')}
            </span>
          )}
        </div>
      </div>
      <div className={styles.inspectionRow}>
        <div className={styles.chartReadout} id={`${id}-readout`} aria-live="polite">
          {description}
          {samples.length === 1 && ` · ${t('quota_pool.single_sample')}`}
        </div>
      </div>
    </div>
  );
}
