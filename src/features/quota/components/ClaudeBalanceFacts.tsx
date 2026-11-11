import { Fragment } from 'react';
import { useTranslation } from 'react-i18next';
import { Fact, FactSection, type FactState } from '@/components/ui/FactPanel';
import type { ClaudeQuotaState } from '@/types';
import { resolveResetMs } from '@/utils/quota';
import {
  claudeExtraUsageNotes,
  formatClaudeMoney,
  unreportedClaudeExtraUsage,
} from '../providers/claude/presentation';

/** Dollar balances are independent of plan quota; missing amounts remain explicit. */
export function ClaudeBalanceFacts({
  quota,
  formatDate,
  compact = false,
}: {
  quota: ClaudeQuotaState;
  formatDate: (value: number) => string;
  /**
   * A card's tight layout: the spent and limit amounts the provider left out are named once on
   * the Extra usage line, with its status notes, instead of a "Not reported" fact each.
   */
  compact?: boolean;
}) {
  const { t, i18n } = useTranslation();
  const extra = quota.extraUsage;
  if (!extra && !quota.dollarWindows?.length) return null;
  const missing = (): FactState => ({
    state: 'notReported',
    reason: t('account_details.not_reported_reason'),
  });
  const money = (value: number | null, currency = 'USD', divisor = 1): FactState =>
    value === null
      ? missing()
      : {
          state: 'known',
          value: formatClaudeMoney(i18n.resolvedLanguage, value, currency, divisor),
        };
  const notes = claudeExtraUsageNotes(extra ?? null, t);
  const unreported = compact && extra ? unreportedClaudeExtraUsage(extra) : [];
  const collapsed = (amount: 'spent' | 'limit') => unreported.includes(amount);
  const extraNote = [
    ...(compact ? notes : []),
    ...(unreported.length ? [t(`account_details.unreported_${unreported.join('_')}`)] : []),
  ].join(' · ');
  return (
    <FactSection title={t('account_details.balances')}>
      {extra && (
        <>
          <Fact
            label={t('claude_quota.extra_usage_label')}
            note={extraNote || undefined}
            {...(extra.isEnabled === null
              ? missing()
              : {
                  state: 'known',
                  value: t(
                    extra.isEnabled
                      ? 'claude_quota.extra_usage_enabled'
                      : 'claude_quota.extra_usage_disabled'
                  ),
                })}
          />
          {!collapsed('spent') && (
            <Fact
              label={t('account_details.spent')}
              {...money(extra.usedCredits, extra.currency ?? 'USD', 100)}
            />
          )}
          {!collapsed('limit') && (
            <Fact
              label={t('account_details.limit')}
              {...money(extra.monthlyLimit, extra.currency ?? 'USD', 100)}
            />
          )}
          {extra.utilization !== null && (
            <Fact
              label={t('account_details.spending')}
              state="known"
              value={t('claude_quota.usage_utilization', { percent: extra.utilization })}
            />
          )}
          {!compact && notes.length > 0 && (
            <Fact label={t('account_details.status')} state="known" value={notes.join(' · ')} />
          )}
        </>
      )}
      {quota.dollarWindows?.map((balance) => {
        const resetAt = resolveResetMs([balance.resetsAt]);
        return (
          <Fragment key={balance.key}>
            <Fact
              label={balance.key}
              {...(balance.remainingDollars === null
                ? missing()
                : {
                    state: 'known',
                    value: t('claude_quota.dollar_balance_remaining', {
                      amount: formatClaudeMoney(i18n.resolvedLanguage, balance.remainingDollars),
                    }),
                  })}
            />
            <Fact
              label={`${balance.key} · ${t('account_details.spent')}`}
              {...money(balance.usedDollars)}
            />
            <Fact
              label={`${balance.key} · ${t('account_details.limit')}`}
              {...money(balance.limitDollars)}
            />
            <Fact
              label={`${balance.key} · ${t('claude_quota.balance_reset')}`}
              {...(resetAt === null ? missing() : { state: 'known', value: formatDate(resetAt) })}
            />
          </Fragment>
        );
      })}
    </FactSection>
  );
}
