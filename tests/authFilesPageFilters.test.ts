import { describe, expect, test } from 'bun:test';
import { countCredentials } from '@/features/authFiles/credentialFacts';
import {
  deletableShown,
  filterAuthFiles,
  groupByProvider,
  matchesStatusFilter,
  modelsScreenPath,
  providerGroupOf,
  providerOfAuthFile,
  resolveProviderFilter,
  resolveSourceFilter,
  summarizeSources,
} from '@/features/authFiles/unifiedList';
import type { AuthFileItem } from '@/types';

const file = (name: string, type: string | undefined, extra: Partial<AuthFileItem> = {}) =>
  ({ name, type, email: `${name}@example.invalid`, ...extra }) as AuthFileItem;

const FILES = [
  file('alice-1', 'claude'),
  file('alice-2', 'claude', { disabled: true }),
  file('bob', 'claude'),
  file('carol', 'claude', { status: 'error', statusMessage: 'unauthorized' }),
  file('dave', 'codex'),
  file('key', 'claude', { runtimeOnly: true } as Partial<AuthFileItem>),
];
const NO_FILTERS = { provider: 'all', statusFilterMode: 'all' as const, search: '' };

describe('the status chips agree with the counts', () => {
  test('a credential with a problem is not counted as active by the Active chip', () => {
    const counts = countCredentials(FILES);
    const shown = (mode: 'enabled' | 'problem' | 'disabled') =>
      FILES.filter((item) => matchesStatusFilter(item, mode)).length;
    expect(shown('enabled')).toBe(counts.active);
    expect(shown('problem')).toBe(counts.problem);
    expect(shown('disabled')).toBe(counts.disabled);
    expect(shown('enabled') + shown('problem') + shown('disabled')).toBe(counts.total);
  });

  test('status "disabled" in the file counts as disabled for the chip as well', () => {
    const item = file('x', 'claude', { status: 'disabled' });
    expect(matchesStatusFilter(item, 'disabled')).toBe(true);
    expect(matchesStatusFilter(item, 'enabled')).toBe(false);
  });
});

describe('delete all removes exactly what the group shows', () => {
  test('the search box narrows the deletion', () => {
    const targets = deletableShown(FILES, { ...NO_FILTERS, search: 'alice' });
    expect(targets.map((item) => item.name)).toEqual(['alice-1', 'alice-2']);
  });

  test('status and provider narrow it; runtime-only credentials are never deleted', () => {
    expect(
      deletableShown(FILES, { ...NO_FILTERS, provider: 'claude' }).map((item) => item.name)
    ).toEqual(['alice-1', 'alice-2', 'bob', 'carol']);
    expect(
      deletableShown(FILES, { ...NO_FILTERS, statusFilterMode: 'problem' }).map((i) => i.name)
    ).toEqual(['carol']);
  });
});

describe('credentials without a usable type form one "Other" group', () => {
  const odd = [file('a', 'empty'), file('b', undefined), file('c', 'unknown'), file('d', 'claude')];

  test('every placeholder type maps to the same group key', () => {
    expect(odd.map(providerGroupOf)).toEqual(['unknown', 'unknown', 'unknown', 'claude']);
  });

  test('filtering by that group shows all of them, and they are grouped together', () => {
    expect(filterAuthFiles(odd, { ...NO_FILTERS, provider: 'unknown' })).toHaveLength(3);
    expect(groupByProvider(odd).map((item) => item.name)).toEqual(['d', 'a', 'b', 'c']);
  });

  test('providerOfAuthFile stays exported and returns the raw provider key', () => {
    expect(providerOfAuthFile(file('x', 'Claude'))).toBe('claude');
  });
});

describe('persisted filters that no longer apply fall back to "all"', () => {
  test('a provider with no credentials in scope', () => {
    expect(resolveProviderFilter('gemini', ['claude', 'codex'])).toBe('all');
    expect(resolveProviderFilter('codex', ['claude', 'codex'])).toBe('codex');
    expect(resolveProviderFilter('all', [])).toBe('all');
  });

  test('a source that is gone, or the only one left (its pills are hidden)', () => {
    expect(resolveSourceFilter('gone', ['alpha', 'beta'])).toBe('all');
    expect(resolveSourceFilter('beta', ['alpha', 'beta'])).toBe('beta');
    expect(resolveSourceFilter('alpha', ['alpha'])).toBe('all');
    expect(resolveSourceFilter('all', [])).toBe('all');
  });
});

describe('one way into the Models screen', () => {
  test('a provider group links to its provider', () => {
    expect(modelsScreenPath('alpha', 'claude')).toBe(
      '/auth-files/models?source=alpha&provider=claude'
    );
  });

  test('an account links to the Rules tab with its own list selected', () => {
    const url = new URL(modelsScreenPath('alpha', 'claude', 'team a.json'), 'http://x.invalid');
    expect(url.pathname).toBe('/auth-files/models');
    expect(Object.fromEntries(url.searchParams)).toEqual({
      source: 'alpha',
      provider: 'claude',
      tab: 'rules',
      list: 'account:team a.json',
    });
  });
});

describe('page summary states no false numbers', () => {
  test('loading until every source has answered once', () => {
    expect(
      summarizeSources([
        { state: 'ready', files: FILES },
        { state: 'loading', files: undefined },
      ])
    ).toEqual({ status: 'loading' });
  });

  test('an unreachable source is counted as unreachable, never as zero credentials', () => {
    const summary = summarizeSources([
      { state: 'ready', files: FILES },
      { state: 'error', files: undefined },
    ]);
    expect(summary).toEqual({
      status: 'ready',
      sources: 2,
      unreachable: 1,
      counts: countCredentials(FILES),
    });
  });
});
