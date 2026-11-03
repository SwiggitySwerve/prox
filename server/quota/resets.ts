import type { AccountResets, PoolProviderId } from '../../src/domain/quotaPool/types';
import {
  anthropicResetGrantBlocker,
  parseAnthropicResetGrantStatus,
} from '../../src/services/api/claudeResetGrants';
import { normalizeCodexResetCreditsPayload } from '../../src/utils/quota/resetCredits';
import { parseClaudeUsagePayload, parseCodexUsagePayload } from '../../src/utils/quota/parsers';
import { isRecord } from '../../src/utils/helpers';

/** Missing or malformed reset data must not replace the last successful reading. */
export function readAccountResets(
  provider: PoolProviderId,
  body: unknown,
  observedAtMs: number
): AccountResets | null {
  const payload =
    provider === 'claude' ? parseClaudeUsagePayload(body) : parseCodexUsagePayload(body);
  if (!isRecord(payload)) return null;
  if (provider === 'codex') {
    const summary = normalizeCodexResetCreditsPayload(payload.rate_limit_reset_credits);
    const available = summary.availableCount;
    const applicable = summary.applicableAvailableCount;
    if (
      summary.invalidPayload ||
      available === null ||
      applicable === null ||
      !Number.isInteger(available) ||
      available < 0 ||
      !Number.isInteger(applicable)
    )
      return null;
    const usable = Math.min(available, Math.max(0, applicable));
    const expiries = summary.credits
      .map((credit) => Date.parse(credit.expiresAt))
      .filter(Number.isFinite);
    return {
      available,
      usable,
      blocker: available > 0 && usable === 0 ? 'not_applicable' : null,
      nextExpiryAtMs: expiries.length ? Math.min(...expiries) : null,
      observedAtMs,
    };
  }

  const status = parseAnthropicResetGrantStatus(payload.cedar_ember);
  if (!status) return null;
  const held = status.grants.filter((grant) => grant.resetsLeft > 0);
  const available = held.reduce((sum, grant) => sum + grant.resetsLeft, 0);
  const cooldown = !!status.cooldownUntil && Date.parse(status.cooldownUntil) > observedAtMs;
  const usable = cooldown
    ? 0
    : held.reduce(
        (sum, grant) =>
          !anthropicResetGrantBlocker(status, grant.id) &&
          (!grant.startsAt || Date.parse(grant.startsAt) <= observedAtMs) &&
          (!grant.endsAt || Date.parse(grant.endsAt) > observedAtMs)
            ? sum + grant.resetsLeft
            : sum,
        0
      );
  const expiries = held.flatMap((grant) => (grant.endsAt ? [Date.parse(grant.endsAt)] : []));
  let blocker: AccountResets['blocker'] = null;
  if (!status.eligible) blocker = `ineligible:${status.ineligibleReason ?? 'unknown'}`;
  else if (available > 0 && usable === 0) {
    if (cooldown) blocker = 'cooldown';
    else if (held.some((grant) => grant.useRequiresLimit && !status.atLimit))
      blocker = 'not_limited';
    else if (held.some((grant) => grant.paused)) blocker = 'paused';
  }
  return {
    available,
    usable,
    blocker,
    nextExpiryAtMs: expiries.length ? Math.min(...expiries) : null,
    observedAtMs,
  };
}
