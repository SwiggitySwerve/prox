import { describe, expect, test } from 'bun:test';
import {
  billingFromCodexSubscription,
  billingFromClaudeProfile,
  billingFacts,
} from '../src/domain/accountBilling';
const at = (date: string) => Date.parse(date);
const renewal = {
  entitlement: {
    subscription_plan: 'pro',
    renews_at: '2026-11-13T12:00:00Z',
    billing_period: 'monthly',
    scheduled_plan_change: { changes_at: '2026-11-13T12:00:00Z', plan_type: 'prolite' },
  },
  last_active_subscription: { will_renew: true },
};
describe('account billing', () => {
  test('Codex live renewal and scheduled plan change', () => {
    expect(billingFacts(billingFromCodexSubscription(JSON.stringify(renewal)), 0)).toEqual([
      {
        labelKey: 'billing_renews',
        state: 'known',
        kind: 'date',
        value: at('2026-11-13T12:00:00Z'),
      },
      {
        labelKey: 'billing_next_plan',
        state: 'known',
        kind: 'text',
        value: 'Pro Lite',
        asideDateMs: at('2026-11-13T12:00:00Z'),
      },
    ]);
  });
  test('Codex deactivation ends; cancellation date takes priority over expiry', () => {
    const body = {
      entitlement: { subscription_plan: 'plus', expires_at: '2026-11-04T00:00:00Z' },
      last_active_subscription: { will_renew: false, cancellation_outcome: 'deactivate' },
    };
    expect(billingFacts(billingFromCodexSubscription(body), 0)[0]).toMatchObject({
      labelKey: 'billing_ends',
      value: at('2026-11-04T00:00:00Z'),
    });
    expect(
      billingFacts(
        billingFromCodexSubscription({
          ...body,
          entitlement: { ...body.entitlement, cancels_at: 1800000000 },
        }),
        0
      )[0]
    ).toMatchObject({ value: 1800000000000 });
  });
  test.each([null, 1800000000000])('Codex overdue with grace %s', (grace) => {
    const facts = billingFacts(
      billingFromCodexSubscription({
        ...renewal,
        entitlement: {
          ...renewal.entitlement,
          is_delinquent: true,
          grace_period_end_timestamp: grace,
        },
      }),
      0
    );
    expect(facts).toContainEqual({
      labelKey: 'billing_payment',
      state: 'known',
      kind: 'key',
      value: 'billing_overdue',
      tone: 'overdue',
    });
    expect(facts.some((f) => f.labelKey === 'billing_grace_ends')).toBe(grace !== null);
  });
  test('malformed Codex fails soft', () => {
    for (const body of [null, 'bad', [], {}, { entitlement: { subscription_plan: 7 } }])
      expect(billingFromCodexSubscription(body)).toBeNull();
  });
  test('missing renewal decision never invents a renewal', () =>
    expect(
      billingFacts(
        billingFromCodexSubscription({
          entitlement: { subscription_plan: 'pro', expires_at: '2026-11-04' },
        }),
        0
      )[0].state
    ).toBe('notReported'));
  test.each([
    ['2026-01-31T12:30:00Z', '2026-02-01T00:00:00Z', '2026-02-28T12:30:00Z'],
    ['2024-01-31T12:30:00Z', '2024-02-01T00:00:00Z', '2024-02-29T12:30:00Z'],
    ['2026-01-31T12:30:00Z', '2026-02-28T12:30:00Z', '2026-03-31T12:30:00Z'],
    ['2026-01-31T12:30:00Z', '2026-12-31T12:30:00Z', '2027-01-31T12:30:00Z'],
  ])('Claude next anniversary %s at %s', (start, now, next) => {
    const billing = billingFromClaudeProfile({
      organization: {
        subscription_status: 'active',
        subscription_created_at: start,
        billing_type: 'stripe_subscription',
      },
    });
    expect(billingFacts(billing, at(now))[1]).toMatchObject({
      state: 'estimated',
      value: at(next),
      basisKey: 'billing_estimate_basis',
    });
  });
  test('Claude inactive, unknown billing type, malformed and missing data', () => {
    expect(billingFromClaudeProfile('bad')).toBeNull();
    expect(billingFacts(null, 0)[0].state).toBe('notReported');
    expect(
      billingFacts(
        billingFromClaudeProfile({
          organization: {
            subscription_status: 'cancelled',
            subscription_created_at: 1800000000,
            billing_type: 'stripe_subscription',
          },
        }),
        1800000000001
      )[0]
    ).toMatchObject({ state: 'notApplicable', reasonKey: 'billing_no_paid_plan' });
    expect(
      billingFacts(
        billingFromClaudeProfile({ organization: { subscription_status: 'active' } }),
        0
      )[1].state
    ).toBe('notReported');
  });
});
