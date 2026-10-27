export const formatPoolNumber = (value: number | null, locale: string) =>
  value === null ? '—' : new Intl.NumberFormat(locale, { maximumFractionDigits: 1 }).format(value);

export const formatPoolDate = (value: number | null, locale: string, short = false) =>
  value === null
    ? '—'
    : new Intl.DateTimeFormat(
        locale,
        short
          ? { month: 'short', day: 'numeric' }
          : { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }
      ).format(value);
