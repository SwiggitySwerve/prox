/**
 * The compact Account details on an Auth Files card: a reset grant reads as its kind on the row and
 * its upstream description on a muted line under it, and the extra-usage amounts the provider left
 * out are named once instead of a "Not reported" fact each.
 */
import { beforeAll, describe, expect, test } from 'bun:test';
import i18n from '@/i18n';
import type { AnthropicResetGrant } from '@/services/api/claudeResetGrants';
import type { ClaudeExtraUsage } from '@/types';
import {
  claudeResetGrantName,
  claudeResetGrantParts,
  unreportedClaudeExtraUsage,
} from '@/features/quota/providers/claude/presentation';

const t = i18n.getFixedT('en');
beforeAll(() => i18n.changeLanguage('en'));

const grant = (kind: AnthropicResetGrant['kind'], label: string): AnthropicResetGrant => ({
  id: 'grant',
  label,
  resetsTotal: 1,
  resetsLeft: 1,
  startsAt: null,
  endsAt: '2030-12-10T22:00:00Z',
  clears: ['five_hour', 'seven_day'],
  paused: false,
  usableNow: true,
  useRequiresLimit: false,
  percentUsed: {},
  kind,
});

describe('claudeResetGrantParts', () => {
  test('splits the kind from a description that says more than the kind', () => {
    expect(claudeResetGrantParts(grant('full', 'One full limit reset (November 2026)'), t)).toEqual(
      { kind: 'Full reset', description: 'One full limit reset (November 2026)' }
    );
  });

  test('a label that only repeats the kind, or none, gives no description', () => {
    expect(claudeResetGrantParts(grant('weekly', 'weekly RESET'), t)).toEqual({
      kind: 'Weekly reset',
      description: null,
    });
    expect(claudeResetGrantParts(grant('fable', ''), t)).toEqual({
      kind: 'Fable reset',
      description: null,
    });
  });

  test('the one-line name is still the kind and the description joined', () => {
    expect(claudeResetGrantName(grant('fable', 'New model launch'), t)).toBe(
      'Fable reset · New model launch'
    );
    expect(claudeResetGrantName(grant('session', '5-hour reset'), t)).toBe('5-hour reset');
  });
});

describe('unreportedClaudeExtraUsage', () => {
  const extra = (patch: Partial<ClaudeExtraUsage>): ClaudeExtraUsage => ({
    isEnabled: false,
    monthlyLimit: null,
    usedCredits: null,
    utilization: null,
    currency: null,
    disabledReason: null,
    userDisabled: null,
    spendLimitReached: null,
    ...patch,
  });

  test('names both amounts when neither is reported', () => {
    expect(unreportedClaudeExtraUsage(extra({}))).toEqual(['spent', 'limit']);
  });

  test('a reported amount, zero included, is not in the list', () => {
    expect(unreportedClaudeExtraUsage(extra({ usedCredits: 0 }))).toEqual(['limit']);
    expect(unreportedClaudeExtraUsage(extra({ monthlyLimit: 5000 }))).toEqual(['spent']);
    expect(unreportedClaudeExtraUsage(extra({ usedCredits: 12, monthlyLimit: 5000 }))).toEqual([]);
  });
});
