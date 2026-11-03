import { useTranslation } from 'react-i18next';
import {
  billingFacts,
  type BillingExpiryFallback,
  type AccountBilling,
} from '@/domain/accountBilling';
import { Fact } from './FactPanel';

/** Shared presentation of the domain billing copy model. */
export function BillingFacts({
  billing,
  nowMs,
  formatDate,
  fallback,
}: {
  billing: AccountBilling | null;
  fallback?: BillingExpiryFallback;
  nowMs: number;
  formatDate: (value: number) => string;
}) {
  const { t } = useTranslation();
  return billingFacts(billing, nowMs, fallback).map((fact) => {
    const label = t(`quota_pool.${fact.labelKey}`);
    if (fact.state === 'notReported' || fact.state === 'notApplicable')
      return (
        <Fact
          key={fact.labelKey}
          label={label}
          state={fact.state}
          reason={t(`quota_pool.${fact.reasonKey}`)}
        />
      );
    if (fact.state === 'estimated')
      return (
        <Fact
          key={fact.labelKey}
          label={label}
          state="estimated"
          value={formatDate(fact.value)}
          basis={t(`quota_pool.${fact.basisKey}`)}
        />
      );
    return (
      <Fact
        key={fact.labelKey}
        label={label}
        state="known"
        tone={fact.tone}
        value={
          fact.kind === 'date'
            ? formatDate(fact.value as number)
            : fact.kind === 'key'
              ? t(`quota_pool.${fact.value}`)
              : fact.value
        }
        aside={fact.asideDateMs !== undefined ? formatDate(fact.asideDateMs) : undefined}
      />
    );
  });
}
