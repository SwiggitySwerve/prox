import { describe, expect, test } from 'bun:test';
import {
  QUOTA_REUSE_WINDOW_MS,
  quotaAge,
  splitQuotaTargets,
} from '../src/features/quota/quotaFreshness';
import type { AuthFileItem } from '../src/types';

const file = (name: string, extra: Partial<AuthFileItem> = {}) =>
  ({ name, type: 'claude', ...extra }) as AuthFileItem;
const entry = (name: string, extra: Partial<AuthFileItem> = {}) => ({
  file: file(name, extra),
  type: 'claude' as const,
});

describe('60 s quota reuse rule', () => {
  const now = 1_000_000;

  test('the window is 60 seconds', () => {
    expect(QUOTA_REUSE_WINDOW_MS).toBe(60_000);
  });

  test('never fetched, or fetched 60 s or more ago: fetched again', () => {
    const { due, reused } = splitQuotaTargets(
      [entry('a.json'), entry('b.json'), entry('c.json')],
      { 'b.json': now - 60_000, 'c.json': now - 600_000 },
      now
    );
    expect(due.map((target) => target.file.name)).toEqual(['a.json', 'b.json', 'c.json']);
    expect(reused).toEqual([]);
  });

  test('fetched successfully under 60 s ago: reused, the rest keep their order', () => {
    const { due, reused } = splitQuotaTargets(
      [entry('a.json'), entry('b.json'), entry('c.json')],
      { 'a.json': now - 59_999, 'c.json': now - 1 },
      now
    );
    expect(due.map((target) => target.file.name)).toEqual(['b.json']);
    expect(reused.map((target) => target.file.name)).toEqual(['a.json', 'c.json']);
  });

  test('keyed per credential: same file, other auth index of a plugin identity is not reused', () => {
    const one = entry('shared.json', { type: 'demo', supportsQuota: true, authIndex: '1' });
    const two = entry('shared.json', { type: 'demo', supportsQuota: true, authIndex: '2' });
    const { due, reused } = splitQuotaTargets([one, two], { 'shared.json\u00001': now - 5 }, now);
    expect(reused).toEqual([one]);
    expect(due).toEqual([two]);
  });

  test('a time in the future (clock moved back) is not trusted as fresh', () => {
    const { due } = splitQuotaTargets([entry('a.json')], { 'a.json': now + 5_000 }, now);
    expect(due).toHaveLength(1);
  });

  test('age reads in seconds under a minute, then minutes, then hours', () => {
    expect(quotaAge(now - 400, now)).toEqual({ unit: 'seconds', count: 0 });
    expect(quotaAge(now - 25_400, now)).toEqual({ unit: 'seconds', count: 25 });
    expect(quotaAge(now - 59_999, now)).toEqual({ unit: 'seconds', count: 59 });
    expect(quotaAge(now - 60_000, now)).toEqual({ unit: 'minutes', count: 1 });
    expect(quotaAge(now - 59 * 60_000, now)).toEqual({ unit: 'minutes', count: 59 });
    expect(quotaAge(now - 3 * 3_600_000, now)).toEqual({ unit: 'hours', count: 3 });
    expect(quotaAge(now + 9_000, now)).toEqual({ unit: 'seconds', count: 0 });
    expect(quotaAge(undefined, now)).toBeNull();
  });
});
