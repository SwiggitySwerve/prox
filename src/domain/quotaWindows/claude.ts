import type { TFunction } from 'i18next';
import type { ClaudeUsagePayload, ClaudeUsageWindow, ClaudeQuotaWindow } from '@/types';
import { normalizeNumberValue, normalizeStringValue } from '@/utils/quota/parsers';
import { formatQuotaResetTime } from '@/utils/quota/formatters';
import { resolveResetMs, claudePeriodHours } from '@/utils/quota/resetInstants';
import { CLAUDE_USAGE_WINDOW_KEYS } from '@/utils/quota/constants';

const findFableUsageLimit = (payload: ClaudeUsagePayload) => {
  if (!Array.isArray(payload.limits)) return null;

  const candidates = payload.limits.filter((limit) => {
    const kind = (normalizeStringValue(limit?.kind) ?? '').trim().toLowerCase();
    const modelName = (normalizeStringValue(limit?.scope?.model?.display_name) ?? '')
      .trim()
      .toLowerCase();
    const isFable = modelName === 'fable' || modelName === 'fable 5';
    return kind === 'weekly_scoped' && isFable && normalizeNumberValue(limit?.percent) !== null;
  });

  return candidates.find((limit) => limit.is_active === true) ?? candidates[0] ?? null;
};

const isDollarDenominatedWindow = (window: ClaudeUsageWindow) =>
  normalizeNumberValue(window.limit_dollars) !== null ||
  normalizeNumberValue(window.used_dollars) !== null ||
  normalizeNumberValue(window.remaining_dollars) !== null;

export const buildClaudeQuotaWindows = (
  payload: ClaudeUsagePayload,
  t: TFunction
): ClaudeQuotaWindow[] => {
  const windows: ClaudeQuotaWindow[] = [];
  const fableLimit = findFableUsageLimit(payload);

  for (const { key, id, labelKey } of CLAUDE_USAGE_WINDOW_KEYS) {
    const window = payload[key as keyof ClaudeUsagePayload];
    if (!window || typeof window !== 'object' || !('utilization' in window)) continue;
    const typedWindow = window as ClaudeUsageWindow;
    const isCreditPool = key === 'iguana_necktie' && isDollarDenominatedWindow(typedWindow);
    // Cloud-session dollar credits are not a subscription quota window. Exclude
    // them here so credential cards and the pool collector share the same rule.
    if (isCreditPool || (key === 'iguana_necktie' && fableLimit)) continue;
    const usedPercent = normalizeNumberValue(typedWindow.utilization);
    const resetLabel = formatQuotaResetTime(typedWindow.resets_at ?? undefined);
    windows.push({
      id,
      label: t(labelKey),
      labelKey,
      usedPercent,
      resetLabel,
      // Claude states the period nowhere in the payload, so it comes from the
      // key: `five_hour` is the rolling window, everything else is weekly.
      resetAtMs: resolveResetMs([typedWindow.resets_at]),
      periodHours: claudePeriodHours(key),
    });
  }

  if (fableLimit) {
    const usedPercent = normalizeNumberValue(fableLimit.percent);
    if (usedPercent !== null) {
      windows.push({
        id: 'seven-day-fable',
        label: t('claude_quota.seven_day_fable'),
        labelKey: 'claude_quota.seven_day_fable',
        usedPercent,
        resetLabel: formatQuotaResetTime(fableLimit.resets_at ?? undefined),
        // `weekly_scoped` is a 7-day window by definition, so the timeline can
        // place this row alongside the ones derived from the named keys.
        resetAtMs: resolveResetMs([fableLimit.resets_at]),
        periodHours: claudePeriodHours('seven_day'),
      });
    }
  }

  return windows;
};
