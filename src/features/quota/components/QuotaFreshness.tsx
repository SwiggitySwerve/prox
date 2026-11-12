import { useTranslation } from 'react-i18next';
import { useSecondNow } from '@/hooks/useNow';
import { quotaAge } from '../quotaFreshness';

/**
 * "updated 25s ago": when this card's quota was last read. A refresh within a minute of that
 * reuses the reading, so the label says how current the shown numbers are. Its own component so
 * only this text re-renders every second.
 */
export function QuotaFreshness({
  fetchedAt,
  className,
  now: fixedNow,
}: {
  fetchedAt: number | undefined;
  className?: string;
  /** Fixed time, for static rendering. */
  now?: number;
}) {
  const { t } = useTranslation();
  const ticking = useSecondNow(fetchedAt !== undefined && fixedNow === undefined);
  const age = quotaAge(fetchedAt, fixedNow ?? ticking);
  if (!age) return null;
  return (
    <span className={className} data-quota-fetched-at={fetchedAt}>
      {t(`auth_files.quota_updated_${age.unit}`, { count: age.count })}
    </span>
  );
}
