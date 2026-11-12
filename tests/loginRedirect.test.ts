import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { redirectTarget } from '../src/router/redirectTarget';

const read = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');

describe('redirectTarget', () => {
  test('keeps the pathname, query and hash of the page that sent the user to login', () => {
    const from = {
      pathname: '/analytics',
      search: '?tab=overview&range=7d&bucket=hour',
      hash: '#x',
    };
    expect(redirectTarget({ from })).toBe('/analytics?tab=overview&range=7d&bucket=hour#x');
  });

  test('falls back to the dashboard when there is nothing usable', () => {
    expect(redirectTarget(null)).toBe('/');
    expect(redirectTarget({})).toBe('/');
    expect(redirectTarget({ from: { pathname: 42 } })).toBe('/');
  });

  test('stays in the app: no other origin, no login loop', () => {
    for (const pathname of [
      '//evil.example',
      'https://evil.example',
      '/\\evil.example',
      '/login',
      '/login/',
      '/login//',
      '/LOGIN',
    ]) {
      expect(redirectTarget({ from: { pathname, search: '?a=1' } })).toBe('/');
    }
  });

  test('ignores a search or hash that is not shaped like one', () => {
    expect(redirectTarget({ from: { pathname: '/analytics', search: 'x', hash: 'y' } })).toBe(
      '/analytics'
    );
  });
});

describe('LoginPage redirects', () => {
  const page = read('src/pages/LoginPage.tsx');

  test('a restored session navigates at once instead of waiting on a splash timer', () => {
    expect(page).not.toMatch(/setTimeout/);
  });

  test('no post-login redirect drops the query by reading only the pathname', () => {
    expect(page).not.toMatch(/\.from\?\.pathname/);
  });
});
