export const formatUsdFromCents = (cents: number | null): string => {
  if (cents === null) return '--';
  return new Intl.NumberFormat(undefined, {
    style: 'currency',
    currency: 'USD',
  }).format(cents / 100);
};

export const formatXaiProductPercent = (value: number | null): string | null =>
  value === null ? null : `${Math.round(Math.max(0, Math.min(100, value)))}%`;
