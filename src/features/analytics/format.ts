import i18n from '@/i18n';

/** Presentation only: quantities and prices are supplied by the accounting owner. */
export function analyticsNumber(
  value: number | null | undefined,
  locale: string,
  currency = false
) {
  if (value === null || value === undefined || !Number.isFinite(value))
    return i18n.t('analytics.unavailable_value', { lng: locale });
  return new Intl.NumberFormat(
    locale,
    currency
      ? { style: 'currency', currency: 'USD', minimumFractionDigits: 2, maximumFractionDigits: 6 }
      : { maximumFractionDigits: 2 }
  ).format(value);
}
export function analyticsTime(value: number, locale: string) {
  return new Intl.DateTimeFormat(locale, {
    timeZone: 'UTC',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).format(value);
}

export function analyticsShortTime(value: number, locale: string, daily: boolean) {
  return new Intl.DateTimeFormat(
    locale,
    daily
      ? { timeZone: 'UTC', month: 'short', day: 'numeric' }
      : { timeZone: 'UTC', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }
  ).format(value);
}
