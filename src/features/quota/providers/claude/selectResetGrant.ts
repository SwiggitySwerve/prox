import {
  anthropicResetGrantBlocker,
  type AnthropicResetGrantStatus,
} from '@/services/api/claudeResetGrants';

/** A grant with no end never expires, so it sorts after every dated one. */
const endOf = (endsAt: string | null) => {
  const at = endsAt ? Date.parse(endsAt) : NaN;
  return Number.isFinite(at) ? at : Infinity;
};

/**
 * Spend the usable grant that expires first, so no reset lapses while a later one is used. Among
 * grants ending together, prefer the upstream recommendation, then stable ID ordering.
 */
export function selectResetGrant(status: AnthropicResetGrantStatus, now: number) {
  if (status.cooldownUntil && Date.parse(status.cooldownUntil) > now) return undefined;
  const usable = status.grants.filter(
    (grant) =>
      !anthropicResetGrantBlocker(status, grant.id) &&
      (!grant.startsAt || Date.parse(grant.startsAt) <= now) &&
      (!grant.endsAt || Date.parse(grant.endsAt) > now)
  );
  return usable.sort(
    (a, b) =>
      endOf(a.endsAt) - endOf(b.endsAt) ||
      Number(b.id === status.nextGrantId) - Number(a.id === status.nextGrantId) ||
      (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)
  )[0];
}
