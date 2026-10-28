export const formatPoolNumber = (value: number | null, locale: string) =>
  value === null ? '—' : new Intl.NumberFormat(locale, { maximumFractionDigits: 1 }).format(value);

// Shared visual warning treatment for full and compact account layouts.
export const isLowQuota = (remainingPercent: number | null) =>
  remainingPercent !== null && remainingPercent < 20;

export const formatPoolDate = (value: number | null, locale: string, short = false) => {
  if (value === null) return '—';
  const parts = new Intl.DateTimeFormat(
    locale,
    short
      ? { month: 'short', day: 'numeric' }
      : {
          month: 'short',
          day: 'numeric',
          hour: 'numeric',
          minute: '2-digit',
          timeZoneName: 'short',
        }
  ).formatToParts(value);
  // Wrap between date and time, never orphan the day period or timezone.
  let timeStarted = false;
  return parts
    .map((part) => {
      if (part.type === 'hour') timeStarted = true;
      return timeStarted ? part.value.replace(/\s/gu, '\u00a0') : part.value;
    })
    .join('');
};
