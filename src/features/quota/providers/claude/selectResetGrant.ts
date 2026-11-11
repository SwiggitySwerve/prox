import {
  anthropicResetGrantBlocker,
  type AnthropicResetGrant,
  type AnthropicResetGrantStatus,
} from '@/services/api/claudeResetGrants';

/** A grant with no end never expires, so it sorts after every dated one. */
const endOf = (endsAt: string | null) => {
  const at = endsAt ? Date.parse(endsAt) : NaN;
  return Number.isFinite(at) ? at : Infinity;
};

/**
 * Usable grants in spend order: the one that expires first leads, so no reset lapses while a
 * later one is used. Among grants ending together, prefer the upstream recommendation, then
 * stable ID ordering.
 */
export function usableResetGrants(status: AnthropicResetGrantStatus, now: number) {
  if (status.cooldownUntil && Date.parse(status.cooldownUntil) > now) return [];
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
  );
}

/** The grant a spend uses unless the operator picks another. */
export function selectResetGrant(status: AnthropicResetGrantStatus, now: number) {
  return usableResetGrants(status, now)[0];
}

export type ResetGrantChoice = { grant: AnthropicResetGrant; count: number };

/**
 * What the operator can tell apart: one choice per kind and expiry, in spend order. Grants that
 * share both are interchangeable, so the first in spend order stands for them and `count` adds
 * their resets.
 */
export function resetGrantChoices(
  status: AnthropicResetGrantStatus,
  now: number
): ResetGrantChoice[] {
  const choices = new Map<string, ResetGrantChoice>();
  for (const grant of usableResetGrants(status, now)) {
    const key = `${grant.kind}\0${endOf(grant.endsAt)}`;
    const choice = choices.get(key);
    if (choice) choice.count += grant.resetsLeft;
    else choices.set(key, { grant, count: grant.resetsLeft });
  }
  return [...choices.values()];
}
