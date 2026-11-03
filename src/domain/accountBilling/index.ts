import { parseTimestampMs } from '../../utils/timestamp';
import { isRecord } from '../../utils/helpers';

export type AccountBilling =
  | {
      provider: 'codex';
      plan: string;
      renewsAtMs: number | null;
      endsAtMs: number | null;
      willRenew: boolean | null;
      nextPlan: { plan: string; atMs: number } | null;
      overdue: boolean;
      graceEndsAtMs: number | null;
    }
  | {
      provider: 'claude';
      status: string;
      activeSinceMs: number | null;
      billingType: string | null;
    };
export type BillingFact = {
  labelKey: string;
  tone?: 'overdue';
} & (
  | { state: 'known'; value: string | number; kind: 'date' | 'text' | 'key'; asideDateMs?: number }
  | { state: 'estimated'; value: number; kind: 'date'; basisKey: string }
  | { state: 'notReported'; reasonKey: string }
  | { state: 'notApplicable'; reasonKey: string }
);
function bodyRecord(body: unknown): Record<string, unknown> | null {
  if (typeof body === 'string') {
    try {
      body = JSON.parse(body);
    } catch {
      return null;
    }
  }
  return isRecord(body) ? body : null;
}
function text(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 && value.length <= 256 ? value : null;
}
function timestamp(value: unknown): number | null {
  const ms =
    typeof value === 'number'
      ? Math.abs(value) < 1e12
        ? value * 1000
        : value
      : parseTimestampMs(value);
  return Number.isFinite(ms) && Math.abs(ms) <= 8.64e15 ? ms : null;
}
export function billingFromCodexSubscription(body: unknown): AccountBilling | null {
  const record = bodyRecord(body);
  const e = record?.entitlement;
  if (!isRecord(e) || !text(e.subscription_plan)) return null;
  const subscription = isRecord(record?.last_active_subscription)
    ? record.last_active_subscription
    : {};
  const change = isRecord(e.scheduled_plan_change) ? e.scheduled_plan_change : {};
  const changeAt = timestamp(change.changes_at);
  return {
    provider: 'codex',
    plan: text(e.subscription_plan)!,
    renewsAtMs: timestamp(e.renews_at),
    endsAtMs: timestamp(e.cancels_at) ?? timestamp(e.expires_at),
    willRenew:
      typeof subscription.will_renew === 'boolean'
        ? subscription.will_renew
        : subscription.cancellation_outcome === 'deactivate'
          ? false
          : null,
    nextPlan:
      text(change.plan_type) && changeAt !== null
        ? { plan: text(change.plan_type)!, atMs: changeAt }
        : null,
    overdue: e.is_delinquent === true,
    graceEndsAtMs: timestamp(e.grace_period_end_timestamp),
  };
}
export function billingFromClaudeProfile(body: unknown): AccountBilling | null {
  const organization = bodyRecord(body)?.organization;
  if (!isRecord(organization) || !text(organization.subscription_status)) return null;
  return {
    provider: 'claude',
    status: text(organization.subscription_status)!,
    activeSinceMs: timestamp(organization.subscription_created_at),
    billingType: text(organization.billing_type),
  };
}
/** UTC anniversary preserves the original day and time; short months clamp, never drift. */
function nextAnniversary(startMs: number, nowMs: number): number {
  const start = new Date(startMs);
  const now = new Date(nowMs);
  const at = (month: number) => {
    const date = new Date(
      Date.UTC(
        now.getUTCFullYear(),
        month,
        1,
        start.getUTCHours(),
        start.getUTCMinutes(),
        start.getUTCSeconds(),
        start.getUTCMilliseconds()
      )
    );
    const last = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 0)).getUTCDate();
    date.setUTCDate(Math.min(start.getUTCDate(), last));
    return date.getTime();
  };
  const current = at(now.getUTCMonth());
  return current > nowMs ? current : at(now.getUTCMonth() + 1);
}
/** ChatGPT plan codes as the page names them elsewhere (server/quota/plans.ts labels). */
const CODEX_PLAN_NAMES: Record<string, string> = {
  free: 'Free',
  plus: 'Plus',
  pro: 'Pro',
  prolite: 'Pro Lite',
  promax: 'Pro 500',
  team: 'Team',
  business: 'Business',
  enterprise: 'Enterprise',
};
export const codexPlanName = (code: string) =>
  CODEX_PLAN_NAMES[code.toLowerCase()] ?? code.charAt(0).toUpperCase() + code.slice(1);

export type BillingExpiryFallback = {
  value: string | number | null | undefined;
  source?: 'subscriptions.active_until' | 'id_token';
};
export function billingFacts(
  billing: AccountBilling | null,
  nowMs: number,
  fallback?: BillingExpiryFallback
): BillingFact[] {
  const missing = (labelKey = 'billing_status'): BillingFact => ({
    labelKey,
    state: 'notReported',
    reasonKey: 'billing_not_reported_reason',
  });
  const date = (labelKey: string, value: number | null): BillingFact =>
    value === null ? missing(labelKey) : { labelKey, state: 'known', kind: 'date', value };
  if (!billing) {
    const expiry = timestamp(fallback?.value);
    return expiry === null
      ? [missing()]
      : [
          {
            labelKey: 'billing_ends',
            state: 'estimated',
            kind: 'date',
            value: expiry,
            basisKey:
              fallback?.source === 'subscriptions.active_until'
                ? 'billing_active_until_basis'
                : 'billing_id_token_basis',
          },
        ];
  }
  if (billing.provider === 'claude') {
    if (billing.status !== 'active')
      return [
        { labelKey: 'billing_status', state: 'notApplicable', reasonKey: 'billing_no_paid_plan' },
      ];
    return [
      date('billing_active_since', billing.activeSinceMs),
      billing.activeSinceMs !== null &&
      billing.activeSinceMs <= nowMs &&
      billing.billingType === 'stripe_subscription'
        ? {
            labelKey: 'billing_renews',
            state: 'estimated',
            kind: 'date',
            value: nextAnniversary(billing.activeSinceMs, nowMs),
            basisKey: 'billing_estimate_basis',
          }
        : missing('billing_renews'),
    ];
  }
  if (billing.plan === 'free')
    return [
      { labelKey: 'billing_status', state: 'notApplicable', reasonKey: 'billing_no_paid_plan' },
    ];
  const facts: BillingFact[] = [
    billing.willRenew === true
      ? date('billing_renews', billing.renewsAtMs)
      : billing.willRenew === false
        ? date('billing_ends', billing.endsAtMs)
        : missing(),
  ];
  if (billing.nextPlan)
    facts.push({
      labelKey: 'billing_next_plan',
      state: 'known',
      kind: 'text',
      value: codexPlanName(billing.nextPlan.plan),
      asideDateMs: billing.nextPlan.atMs,
    });
  if (billing.overdue) {
    facts.push({
      labelKey: 'billing_payment',
      state: 'known',
      kind: 'key',
      value: 'billing_overdue',
      tone: 'overdue',
    });
    if (billing.graceEndsAtMs !== null)
      facts.push(date('billing_grace_ends', billing.graceEndsAtMs));
  }
  return facts;
}
