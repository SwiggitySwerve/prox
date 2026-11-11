import type { TFunction } from 'i18next';
import type { ClaudeExtraUsage } from '@/types';
import type { AnthropicResetGrant } from '@/services/api/claudeResetGrants';
import { parseIsoToMs } from '@/utils/quota';
import { groupHeldResets } from '@/features/quotaPool/resetAccounts';
export const formatClaudeMoney = (
  language: string | undefined,
  value: number | null,
  currency = 'USD',
  divisor = 1
): string => {
  if (value === null) return '--';
  try {
    return new Intl.NumberFormat(language, {
      style: 'currency',
      currency,
    }).format(value / divisor);
  } catch {
    return `${(value / divisor).toFixed(2)} ${currency}`;
  }
};

export const claudeExtraUsageNotes = (extraUsage: ClaudeExtraUsage | null, t: TFunction) =>
  extraUsage
    ? [
        extraUsage.userDisabled ? t('claude_quota.extra_usage_user_disabled') : '',
        extraUsage.spendLimitReached ? t('claude_quota.extra_usage_spend_limit_reached') : '',
        extraUsage.disabledReason
          ? t('claude_quota.extra_usage_disabled_reason', { reason: extraUsage.disabledReason })
          : '',
      ].filter(Boolean)
    : [];

/** The grant's kind, and its upstream label as a description when that says more than the kind. */
export const claudeResetGrantParts = (grant: AnthropicResetGrant, t: TFunction) => {
  const kind = t(`claude_reset.kind_${grant.kind}`);
  const description =
    grant.label && grant.label.toLocaleLowerCase() !== kind.toLocaleLowerCase()
      ? grant.label
      : null;
  return { kind, description };
};

/** The grant's kind, then its upstream label when that says more than the kind does. */
export const claudeResetGrantName = (grant: AnthropicResetGrant, t: TFunction) => {
  const { kind, description } = claudeResetGrantParts(grant, t);
  return description ? `${kind} · ${description}` : kind;
};

/**
 * One row per held reset on a compact card: grants of one kind that end together share a row, as
 * the Accounts page groups them ("Fable reset × 2"), with their counts summed and each distinct
 * description kept. A grant with no expiry keeps a row of its own, after the dated ones.
 */
export const groupClaudeResetGrants = (grants: readonly AnthropicResetGrant[], t: TFunction) => {
  const dated = grants.flatMap((grant) => {
    const at = parseIsoToMs(grant.endsAt);
    return at === null ? [] : [{ at, kind: grant.kind, grant }];
  });
  const row = (at: number | null, members: readonly AnthropicResetGrant[]) => ({
    id: members[0]!.id,
    at,
    kind: members[0]!.kind,
    count: members.length,
    left: members.reduce((sum, grant) => sum + grant.resetsLeft, 0),
    total: members.reduce((sum, grant) => sum + grant.resetsTotal, 0),
    descriptions: [
      ...new Set(members.flatMap((grant) => claudeResetGrantParts(grant, t).description ?? [])),
    ],
  });
  return [
    ...groupHeldResets(dated).map(({ at, kind }) =>
      row(
        at,
        dated.filter((entry) => entry.at === at && entry.kind === kind).map((entry) => entry.grant)
      )
    ),
    ...grants
      .filter((grant) => parseIsoToMs(grant.endsAt) === null)
      .map((grant) => row(null, [grant])),
  ];
};

/** Extra-usage amounts the provider left out, so a compact card can name them once. */
export const unreportedClaudeExtraUsage = (extra: ClaudeExtraUsage) =>
  (['spent', 'limit'] as const).filter(
    (amount) => (amount === 'spent' ? extra.usedCredits : extra.monthlyLimit) === null
  );

export const remainingClaudeResetGrants = (grants: readonly AnthropicResetGrant[]) =>
  grants
    .filter((grant) => grant.resetsLeft > 0)
    .sort((a, b) => (parseIsoToMs(a.endsAt) ?? Infinity) - (parseIsoToMs(b.endsAt) ?? Infinity));
