/**
 * Before the credential sheet writes an account's own exclusion list: has the hub's copy changed
 * since the sheet read it? The sheet edits a snapshot taken when it opened, and the Models screen
 * (or another operator) may have changed the list since; writing the snapshot would undo that.
 */
import { sameRuleSet } from './accessRule';

export type AccountListFreshness =
  { status: 'untouched' } | { status: 'fresh' } | { status: 'stale'; current: string[] | null };

export async function checkAccountListFresh(input: {
  /** The save writes the list at all. */
  touched: boolean;
  /** The list as the sheet read it when it opened. */
  openedWith: readonly string[] | null;
  /** Re-reads the list from the hub. */
  read: () => Promise<string[] | null>;
}): Promise<AccountListFreshness> {
  if (!input.touched) return { status: 'untouched' };
  const current = await input.read();
  return sameRuleSet(current, input.openedWith)
    ? { status: 'fresh' }
    : { status: 'stale', current };
}
