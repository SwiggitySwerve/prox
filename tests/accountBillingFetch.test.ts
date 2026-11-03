import { expect, test } from 'bun:test';
import { testQuotaDependencies } from './helpers/quotaDependencies';
import { createCodexQuotaConfig } from '@/features/quota/providers/codex/data';
import { createClaudeQuotaConfig } from '@/features/quota/providers/claude/data';
import type { ApiCallRequest } from '@/services/api/apiCall';
import i18n from '@/i18n';
import usage from './fixtures/claude-oauth-usage.json';

const subscription = {
  entitlement: {
    subscription_plan: 'plus',
    expires_at: '2026-11-04T12:00:00Z',
    renews_at: null,
    cancels_at: '2026-11-04T12:00:00Z',
    billing_period: 'monthly',
    scheduled_plan_change: null,
    is_delinquent: false,
    grace_period_end_timestamp: null,
  },
  last_active_subscription: { will_renew: false, cancellation_outcome: 'deactivate' },
};
const calls: ApiCallRequest[] = [];
const deps = {
  ...testQuotaDependencies,
  apiCallApi: {
    request: async (request: ApiCallRequest) => {
      calls.push(request);
      const body = request.url.includes('subscriptions')
        ? subscription
        : request.url.includes('rate-limit-reset-credits')
          ? { credits: [], available_count: 0 }
          : request.url.includes('oauth/profile')
            ? {
                organization: {
                  subscription_status: 'active',
                  subscription_created_at: '2026-09-13T12:00:00Z',
                  billing_type: 'stripe_subscription',
                },
                account: { has_claude_pro: true },
              }
            : request.url.includes('oauth/usage')
              ? usage
              : { plan_type: 'plus', rate_limit: {} };
      return { statusCode: 200, header: {}, body, bodyText: JSON.stringify(body) };
    },
  },
};

test('Codex keeps structured subscription billing through the existing fetch and success state', async () => {
  calls.length = 0;
  const config = createCodexQuotaConfig(deps);
  const data = await config.fetchQuota(
    {
      name: 'fixture.json',
      authIndex: 'synthetic',
      id_token: {
        chatgpt_account_id: 'synthetic-account',
        chatgpt_subscription_active_until: '2026-12-01T00:00:00Z',
      },
    },
    i18n.t
  );
  expect(config.buildSuccessState(data).billing).toMatchObject({
    provider: 'codex',
    willRenew: false,
    endsAtMs: Date.parse('2026-11-04T12:00:00Z'),
  });
  expect(calls.filter((call) => call.url.includes('subscriptions'))).toHaveLength(1);
  expect(JSON.stringify(data.billing)).not.toContain('synthetic-account');
});
test('Claude keeps billing from its existing profile request', async () => {
  calls.length = 0;
  const config = createClaudeQuotaConfig(deps);
  const data = await config.fetchQuota({ name: 'fixture.json', authIndex: 'synthetic' }, i18n.t);
  expect(config.buildSuccessState(data).billing).toEqual({
    provider: 'claude',
    status: 'active',
    activeSinceMs: Date.parse('2026-09-13T12:00:00Z'),
    billingType: 'stripe_subscription',
  });
  expect(calls.filter((call) => call.url.includes('oauth/profile'))).toHaveLength(1);
});
