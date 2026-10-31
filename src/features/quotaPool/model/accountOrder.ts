import type { PoolAccount } from '@/domain/quotaPool/types';

export type AccountSort = 'name' | 'lowest';

/** The lowest remaining percentage across an account's limits, or null when it reports none. */
export function lowestPercent(account: PoolAccount): number | null {
  const values = [
    ...account.windows.flatMap((limit) =>
      limit.remainingPercent === null ? [] : [limit.remainingPercent]
    ),
    ...(account.remainingPercent === null ? [] : [account.remainingPercent]),
  ];
  return values.length ? Math.min(...values) : null;
}

/**
 * Name order is the default: it stays put across the 15-second reloads, unlike a value order.
 * Lowest-first puts accounts without data on top, since they are the ones needing attention.
 */
export function sortAccounts<T extends PoolAccount>(
  accounts: readonly T[],
  sort: AccountSort,
  name: (account: T) => string,
  locale: string
): T[] {
  const collator = new Intl.Collator(locale, { numeric: true, sensitivity: 'base' });
  const byName = (a: T, b: T) => collator.compare(name(a), name(b)) || a.id.localeCompare(b.id);
  return [...accounts].sort((a, b) => {
    if (sort === 'lowest') {
      const pa = lowestPercent(a);
      const pb = lowestPercent(b);
      if (pa === null || pb === null) {
        if (pa !== pb) return pa === null ? -1 : 1;
      } else if (pa !== pb) {
        return pa - pb;
      }
    }
    return byName(a, b);
  });
}
