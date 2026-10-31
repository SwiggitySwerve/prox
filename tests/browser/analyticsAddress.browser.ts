import type { Page } from '@playwright/test';
import { test, expect } from './analyticsHarness';

const remembered = {
  tab: 'overview',
  range: '24h',
  bucket: 'hour',
  provider: 'codex',
  model: 'fixture-model',
  outcome: 'failed',
  search: 'old-search',
};
const link = '#/analytics?tab=overview&range=24h&bucket=hour&provider=claude';
const go = (page: Page, hash: string) =>
  page.evaluate((value) => void (window.location.hash = value), hash);

test('a provider in the address starts a fresh view, not the remembered filters', async ({
  page,
  app,
}) => {
  await app.login();
  await app.loaded();
  await page.evaluate(
    (state) => window.localStorage.setItem('analyticsPage.uiState', JSON.stringify(state)),
    remembered
  );
  await go(page, '#/quota');
  await expect(page.locator('#analytics-panel')).toHaveCount(0);
  const before = app.queries.length;
  await go(page, link);
  await expect.poll(() => app.queries.length).toBeGreaterThan(before);
  await app.loaded();
  const query = app.queries.at(-1)!;
  expect(query).toMatchObject({ provider: 'claude', outcome: 'all' });
  expect(query.model).toBeUndefined();
  expect(query.search).toBeUndefined();
  await expect(page.getByRole('combobox', { name: 'Provider', exact: true })).toHaveValue('claude');
  await expect(page.getByRole('searchbox')).toHaveValue('');
  expect(page.url()).toContain('provider=claude');
});

test('an address change while Analytics is open applies the provider', async ({ page, app }) => {
  await app.login();
  await app.loaded();
  await app.change(() =>
    page.getByRole('combobox', { name: 'Provider', exact: true }).selectOption('codex')
  );
  await app.change(() =>
    page.getByRole('combobox', { name: 'Model', exact: true }).selectOption('fixture-model')
  );
  await app.change(() => go(page, link));
  expect(app.queries.at(-1)).toMatchObject({ provider: 'claude', outcome: 'all' });
  expect(app.queries.at(-1)!.model).toBeUndefined();
  await expect(page.getByRole('combobox', { name: 'Provider', exact: true })).toHaveValue('claude');
});

test('the address follows the provider filter, and a bare address keeps it', async ({
  page,
  app,
}) => {
  await app.login();
  await app.loaded();
  expect(page.url()).not.toContain('provider=');
  await app.change(() =>
    page.getByRole('combobox', { name: 'Provider', exact: true }).selectOption('claude')
  );
  await expect.poll(() => page.url()).toContain('provider=claude');
  await app.change(() => page.getByRole('button', { name: 'Clear filters', exact: true }).click());
  await expect.poll(() => page.url()).not.toContain('provider=');
  // Opening Analytics from the menu (no provider in the address) must not drop a filter.
  await app.change(() =>
    page.getByRole('combobox', { name: 'Provider', exact: true }).selectOption('codex')
  );
  await go(page, '#/analytics');
  await expect.poll(() => page.url()).toContain('provider=codex');
  await expect(page.getByRole('combobox', { name: 'Provider', exact: true })).toHaveValue('codex');
});
