import { Fragment } from 'react';
import { useTranslation } from 'react-i18next';
import { Fact, FactSection, type FactState } from '@/components/ui/FactPanel';
import type { ClaudeQuotaState } from '@/types';
import { resolveResetMs } from '@/utils/quota';
import { claudeExtraUsageNotes, formatClaudeMoney } from '../providers/claude/presentation';

/** Dollar balances are independent of plan quota; missing amounts remain explicit. */
export function ClaudeBalanceFacts({
  quota,
  formatDate,
}: {
  quota: ClaudeQuotaState;
  formatDate: (value: number) => string;
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
  return (
    <FactSection title={t('account_details.balances')}>
      {extra && (
        <>
          <Fact
            label={t('claude_quota.extra_usage_label')}
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
          <Fact
            label={t('account_details.spent')}
            {...money(extra.usedCredits, extra.currency ?? 'USD', 100)}
          />
          <Fact
            label={t('account_details.limit')}
            {...money(extra.monthlyLimit, extra.currency ?? 'USD', 100)}
          />
          {extra.utilization !== null && (
            <Fact
              label={t('account_details.spending')}
              state="known"
              value={t('claude_quota.usage_utilization', { percent: extra.utilization })}
            />
          )}
          {notes.length > 0 && (
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
