import type { CSSProperties } from 'react';
import { useTranslation } from 'react-i18next';
import { Fact, FactPanel, FactSection, type FactState } from '@/components/ui/FactPanel';
import { BillingFacts } from '@/components/ui/FactPanel/BillingFacts';
import { useNow } from '@/hooks/useNow';
import type {
  ClaudeQuotaState,
  CodexQuotaState,
  DevinQuotaState,
  PluginQuotaState,
  XaiQuotaState,
} from '@/types';
import { parseIsoToMs } from '@/utils/quota';
import { formatPoolDate } from '@/features/quotaPool/presentation';
import type { QuotaCardState } from '../providers';
import type { QuotaProviderType } from '../providers/types';
import type { useClaudeResetGrants } from '../providers/claude/ClaudeResetGrants';
import { remainingClaudeResetGrants } from '../providers/claude/presentation';
import { ClaudeBalanceFacts } from './ClaudeBalanceFacts';
import { formatMetric } from '../providers/plugin/presentation';
import { formatUsdFromCents, formatXaiProductPercent } from '../providers/xai/presentation';
import styles from './AccountDetails.module.scss';

type Props = {
  provider: QuotaProviderType;
  /** Absent when usage hasn't loaded; Claude's reset grants are read separately. */
  quota?: QuotaCardState;
  name: string;
  claudeReset?: ReturnType<typeof useClaudeResetGrants>;
  reset?: { disabled: boolean; onClick: () => void };
};

/** Both quota hosts use this one disclosure and the same fact states. */
export function AccountDetails({ provider, quota, name, claudeReset, reset }: Props) {
  const { t, i18n } = useTranslation();
  const now = useNow();
  const date = (value: number) => formatPoolDate(value, i18n.resolvedLanguage ?? i18n.language);
  const missing = (reason = 'account_details.not_reported_reason'): FactState => ({
    state: 'notReported',
    reason: t(reason),
  });
  const known = (value: string | number | null | undefined): FactState =>
    value == null ? missing() : { state: 'known', value };
  const dated = (value: number | null): FactState =>
    value == null ? missing() : { state: 'known', value: date(value) };
  const billing =
    provider === 'codex' || provider === 'claude'
      ? ((quota as CodexQuotaState | ClaudeQuotaState | undefined)?.billing ?? null)
      : null;
  const codex = provider === 'codex' && quota ? (quota as CodexQuotaState) : null;
  const claude = provider === 'claude' && quota ? (quota as ClaudeQuotaState) : null;
  const devin = provider === 'devin' && quota ? (quota as DevinQuotaState) : null;
  const xai = provider === 'xai' && quota ? (quota as XaiQuotaState).billing : null;
  const plugin = provider === 'plugin' && quota ? (quota as PluginQuotaState) : null;
  const held = codex ? codex.rateLimitResetCreditsAvailableCount : claudeReset?.count;
  const resetReason = claudeReset
    ? claudeReset.message
      ? t(`claude_reset.${claudeReset.message}`)
      : claudeReset.busy
        ? t('quota_pool.reset_loading')
        : claudeReset.blocked
          ? t(held == null ? 'quota_pool.reset_loading' : 'quota_pool.reset_claude_unavailable')
          : t('quota_pool.reset_usable')
    : held === 0
      ? t('quota_pool.reset_none')
      : reset?.disabled
        ? t('account_details.reset_disabled')
        : (held ?? 0) > 0
          ? t('quota_pool.reset_usable')
          : t('quota_pool.reset_not_reported_reason');
  const resetAction = claudeReset
    ? {
        label: t(
          claudeReset.buttonLabel === 'retry' ? 'claude_reset.retry' : 'quota_pool.use_reset'
        ),
        context: t('quota_pool.reset_action_context', { name }),
        disabled: claudeReset.blocked,
        onClick: claudeReset.confirm,
      }
    : reset && (held ?? 0) > 0
      ? {
          label: t('quota_pool.use_reset'),
          context: t('quota_pool.reset_action_context', { name }),
          ...reset,
        }
      : undefined;
  return (
    <details
      className={styles.details}
      style={
        {
          '--fact-accent':
            provider === 'claude'
              ? 'var(--claude-color)'
              : provider === 'codex'
                ? 'var(--codex-color)'
                : 'var(--text-secondary)',
        } as CSSProperties
      }
    >
      <summary>{t('account_details.title')}</summary>
      <FactPanel>
        <FactSection title={t('quota_pool.facts_billing')}>
          {(codex || claude) && (
            <BillingFacts
              billing={billing}
              nowMs={now}
              formatDate={date}
              fallback={
                codex
                  ? {
                      value: codex.subscriptionActiveUntil,
                      source: codex.subscriptionActiveUntilSource,
                    }
                  : undefined
              }
            />
          )}
          {codex && (
            <Fact
              label={t('codex_quota.credit_balance_label')}
              {...known(
                codex.creditsUnlimited ? t('codex_quota.credit_unlimited') : codex.creditBalance
              )}
            />
          )}
          {devin && <Fact label={t('quota_pool.billing_ends')} {...dated(devin.planEndMs)} />}
          {xai && (
            <>
              {xai.mode === 'paid-health' && (
                <Fact
                  label={t('account_details.status')}
                  state="known"
                  value={t('xai_quota.paid_health')}
                />
              )}
              <Fact
                label={t('xai_quota.pay_as_you_go_label')}
                {...known(
                  xai.onDemandCapCents == null
                    ? null
                    : xai.onDemandCapCents <= 0
                      ? t('xai_quota.pay_as_you_go_disabled')
                      : formatUsdFromCents(xai.onDemandCapCents)
                )}
              />
              <Fact
                label={t('xai_quota.prepaid')}
                {...known(
                  xai.prepaidBalanceCents == null
                    ? null
                    : formatUsdFromCents(xai.prepaidBalanceCents)
                )}
              />
            </>
          )}
          {!codex && !claude && !devin && !xai && (
            <Fact
              label={t('quota_pool.billing_status')}
              {...missing('quota_pool.billing_not_reported_reason')}
            />
          )}
        </FactSection>
        {(codex || claude || claudeReset) && (
          <FactSection
            title={t('quota_pool.resets')}
            tone="accent"
            {...(resetAction ? { action: resetAction, note: resetReason } : { action: undefined })}
          >
            <Fact
              label={t('quota_pool.reset_held_label')}
              {...(held == null
                ? missing('quota_pool.reset_not_reported_reason')
                : known(held === 0 ? t('quota_pool.reset_none') : held))}
            />
            {codex?.rateLimitResetCredits?.map((credit, index) => (
              <Fact
                key={credit.id || index}
                label={t('account_details.reset_expires', { index: index + 1 })}
                {...dated(parseIsoToMs(credit.expiresAt))}
              />
            ))}
            {codex?.rateLimitResetCreditsError && (
              <Fact
                label={t('account_details.expiry')}
                state="notReported"
                reason={codex.rateLimitResetCreditsError}
              />
            )}
            {remainingClaudeResetGrants(claudeReset?.grants ?? []).map((grant, index) => (
              <Fact
                key={grant.id}
                label={grant.label || t('claude_reset.grant_number', { index: index + 1 })}
                {...(parseIsoToMs(grant.endsAt) === null
                  ? missing('claude_reset.expiry_unknown')
                  : {
                      state: 'known',
                      value: date(parseIsoToMs(grant.endsAt)!),
                      aside: t('claude_reset.count', {
                        left: grant.resetsLeft,
                        total: grant.resetsTotal,
                      }),
                    })}
              />
            ))}
          </FactSection>
        )}
        {claude && <ClaudeBalanceFacts quota={claude} formatDate={date} />}
        {plugin && plugin.summary.length > 0 && (
          <FactSection title={t('account_details.balances')}>
            {plugin.summary.map((metric) => (
              <Fact
                key={metric.key}
                label={metric.label}
                state="known"
                value={formatMetric(metric)}
              />
            ))}
          </FactSection>
        )}
        {xai && xai.productUsage.length > 0 && (
          <FactSection title={t('xai_quota.usage_breakdown')}>
            {xai.productUsage.map((item) => (
              <Fact
                key={item.product}
                label={item.product}
                {...known(formatXaiProductPercent(item.usagePercent))}
              />
            ))}
          </FactSection>
        )}
      </FactPanel>
    </details>
  );
}
