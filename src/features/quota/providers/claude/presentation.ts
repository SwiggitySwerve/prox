import type { TFunction } from 'i18next';
import type { ClaudeExtraUsage } from '@/types';
import type { AnthropicResetGrant } from '@/services/api/claudeResetGrants';
import { parseIsoToMs } from '@/utils/quota';
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

export const remainingClaudeResetGrants = (grants: readonly AnthropicResetGrant[]) =>
  grants
    .filter((grant) => grant.resetsLeft > 0)
    .sort((a, b) => (parseIsoToMs(a.endsAt) ?? Infinity) - (parseIsoToMs(b.endsAt) ?? Infinity));
