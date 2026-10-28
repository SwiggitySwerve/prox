import type { PoolProviderId } from '../../src/domain/quotaPool/types';

/**
 * Subscription weight in base-plan units: one unit is the provider's $20 plan (Claude Pro,
 * ChatGPT Plus), and 100 quota points equal one unit. Multipliers are the providers' published
 * "N times Pro/Plus" allowances (Oct 2026): Claude Max 5x/20x; ChatGPT Pro 200 is 10x Plus and
 * Pro 500 ("promax") 25x. ChatGPT reports both Pro 100 and Pro 200 as "pro"; it is counted as
 * the $200 plan. Unknown plans count as one unit and are marked unknown.
 */
const PLANS: Record<PoolProviderId, Record<string, { multiplier: number; label: string }>> = {
  claude: {
    claude_pro: { multiplier: 1, label: 'Pro' },
    default_claude_pro: { multiplier: 1, label: 'Pro' },
    default_claude_max_5x: { multiplier: 5, label: 'Max 5x' },
    default_claude_max_20x: { multiplier: 20, label: 'Max 20x' },
  },
  codex: {
    plus: { multiplier: 1, label: 'Plus' },
    pro: { multiplier: 10, label: 'Pro' },
    promax: { multiplier: 25, label: 'Pro 500' },
  },
};

export const POINTS_PER_UNIT = 100;

export function planWeight(
  provider: PoolProviderId,
  plan: string | null | undefined
): { multiplier: number; label: string | null; known: boolean } {
  const entry = plan ? PLANS[provider][plan] : undefined;
  return entry ? { ...entry, known: true } : { multiplier: 1, label: plan || null, known: false };
}

function parse(body: unknown): Record<string, unknown> | null {
  if (typeof body === 'string') {
    try {
      body = JSON.parse(body);
    } catch {
      return null;
    }
  }
  return body && typeof body === 'object' ? (body as Record<string, unknown>) : null;
}

/** ChatGPT's usage response names the plan, e.g. "pro" or "promax". */
export function planFromCodexUsage(body: unknown): string | null {
  const plan = parse(body)?.plan_type;
  return typeof plan === 'string' && plan ? plan : null;
}

/** Claude's OAuth profile names the plan as a rate-limit tier, else an organization type. */
export function planFromClaudeProfile(body: unknown): string | null {
  const organization = parse(body)?.organization;
  if (!organization || typeof organization !== 'object') return null;
  const { rate_limit_tier: tier, organization_type: type } = organization as Record<
    string,
    unknown
  >;
  if (typeof tier === 'string' && tier) return tier;
  return typeof type === 'string' && type ? type : null;
}
