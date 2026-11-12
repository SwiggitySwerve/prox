import type { Page } from '@playwright/test';
import { test, expect } from './analyticsHarness';

const link = '/#/analytics?tab=overview&range=7d&bucket=hour';

async function signIn(page: Page) {
  await page.locator('input[type=password]').fill('synthetic-management-key');
  const remember = page.getByRole('checkbox', { name: 'Remember password' });
  if (!(await remember.isChecked())) await remember.check({ force: true });
  await page.getByRole('button', { name: 'Login', exact: true }).click();
}

test('a deep link survives manual login and a restored session', async ({ page, app }) => {
  await page.goto(link);
  await signIn(page);
  await expect(page).toHaveURL(/#\/analytics\?tab=overview&range=7d&bucket=hour$/);
  await app.loaded();
  // A cold load with the saved session goes through /login and must land on the same view.
  await page.reload();
  await expect(page).toHaveURL(/#\/analytics\?tab=overview&range=7d&bucket=hour$/);
  await app.loaded();
  expect(app.queries.at(-1)?.granularity).toBe('hour');
});
