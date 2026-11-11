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
  groupClaudeResetGrants,
  unreportedClaudeExtraUsage,
} from '@/features/quota/providers/claude/presentation';

const t = i18n.getFixedT('en');
beforeAll(() => i18n.changeLanguage('en'));

const grant = (
  kind: AnthropicResetGrant['kind'],
  label: string,
  endsAt: string | null = '2030-12-10T22:00:00Z',
  id = 'grant'
): AnthropicResetGrant => ({
  id,
  label,
  resetsTotal: 1,
  resetsLeft: 1,
  startsAt: null,
  endsAt,
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

describe('groupClaudeResetGrants', () => {
  const march = '2031-03-09T07:59:00Z';
  test('grants of one kind that end together share a row, with counts and descriptions kept', () => {
    const rows = groupClaudeResetGrants(
      [
        grant('weekly', 'Free limit reset', '2030-12-16T04:59:00Z', 'a'),
        grant('fable', 'New model launch', march, 'b'),
        grant('fable', 'Six months of tenure', march, 'c'),
        grant('fable', 'New model launch', march, 'd'),
      ],
      t
    );
    expect(rows).toEqual([
      {
        id: 'a',
        at: Date.parse('2030-12-16T04:59:00Z'),
        kind: 'weekly',
        count: 1,
        left: 1,
        total: 1,
        descriptions: ['Free limit reset'],
      },
      {
        id: 'b',
        at: Date.parse(march),
        kind: 'fable',
        count: 3,
        left: 3,
        total: 3,
        descriptions: ['New model launch', 'Six months of tenure'],
      },
    ]);
  });

  test('a different kind at the same time, or an undated grant, keeps its own row', () => {
    const rows = groupClaudeResetGrants(
      [grant('full', '', march, 'a'), grant('fable', '', march, 'b'), grant('full', '', null, 'c')],
      t
    );
    expect(rows.map(({ id, kind, at, count }) => [id, kind, at, count])).toEqual([
      ['a', 'full', Date.parse(march), 1],
      ['b', 'fable', Date.parse(march), 1],
      ['c', 'full', null, 1],
    ]);
    expect(rows[0]!.descriptions).toEqual([]);
  });
});
