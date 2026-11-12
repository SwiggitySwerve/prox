import type { Page } from '@playwright/test';
import { test, expect } from './analyticsHarness';

const link = '/#/analytics?tab=overview&range=7d&bucket=hour';
const linkUrl = /#\/analytics\?tab=overview&range=7d&bucket=hour$/;

async function signIn(page: Page) {
  await page.locator('input[type=password]').fill('synthetic-management-key');
  const remember = page.getByRole('checkbox', { name: 'Remember password' });
  if (!(await remember.isChecked())) await remember.check({ force: true });
  await page.getByRole('button', { name: 'Login', exact: true }).click();
}

/** Every hash the page shows, including ones replaced within the same task. */
async function recordHashes(page: Page) {
  await page.addInitScript(() => {
    const seen = [location.hash];
    (window as unknown as { __hashes: string[] }).__hashes = seen;
    const record = () => {
      if (seen.at(-1) !== location.hash) seen.push(location.hash);
    };
    for (const name of ['pushState', 'replaceState'] as const) {
      const original = history[name].bind(history);
      history[name] = (...args: Parameters<History['pushState']>) => {
        original(...args);
        record();
      };
    }
    addEventListener('hashchange', record);
  });
  return () => page.evaluate(() => (window as unknown as { __hashes: string[] }).__hashes);
}

function countConfigReads(page: Page) {
  const reads: string[] = [];
  page.on('request', (request) => {
    const { pathname } = new URL(request.url());
    if (request.method() === 'GET' && pathname.endsWith('/v8/management/config')) {
      reads.push(pathname);
    }
  });
  return reads;
}

test('a deep link survives manual login and a restored session', async ({ page, app }) => {
  await page.goto(link);
  await signIn(page);
  await expect(page).toHaveURL(linkUrl);
  await app.loaded();
  await page.reload();
  await expect(page).toHaveURL(linkUrl);
  await app.loaded();
  expect(app.queries.at(-1)?.granularity).toBe('hour');
});

test('a cold load with a saved session restores in place with one config read', async ({
  page,
  app,
}) => {
  await page.goto(link);
  await signIn(page);
  await app.loaded();

  const hashes = await recordHashes(page);
  const reads = countConfigReads(page);
  await page.reload();
  await expect(page).toHaveURL(linkUrl);
  await app.loaded();
  expect(app.queries.at(-1)?.granularity).toBe('hour');
  expect(await hashes(), 'the restored load never visits the login page').not.toContainEqual(
    expect.stringMatching(/^#\/login/)
  );
  // A beat for any trailing reads to be issued.
  await page.waitForTimeout(500);
  expect(reads).toEqual(['/v8/management/config']);
});

test('a saved session the server refuses lands on the login form', async ({ page, app }) => {
  await page.goto(link);
  await signIn(page);
  await app.loaded();

  await page.route('**/v8/management/config', (route) =>
    route.fulfill({ status: 401, json: { error: 'Synthetic unauthorized' } })
  );
  await page.reload();
  await expect(page).toHaveURL(/#\/login$/);
  await expect(page.locator('input[type=password]')).toBeVisible();
  await expect(page.locator('#analytics-panel')).toHaveCount(0);

  // Signing in again still returns to the original deep link.
  await page.unroute('**/v8/management/config');
  await signIn(page);
  await expect(page).toHaveURL(linkUrl);
  await app.loaded();
});

test('logging out lands on the login form and a reload stays there', async ({ page, app }) => {
  await page.goto(link);
  await signIn(page);
  await app.loaded();

  await page.getByRole('button', { name: 'Logout', exact: true }).click();
  await expect(page).toHaveURL(/#\/login$/);
  await expect(page.locator('input[type=password]')).toBeVisible();

  await page.goto(link);
  await expect(page).toHaveURL(/#\/login$/);
  await expect(page.locator('input[type=password]')).toBeVisible();
  await expect(page.locator('#analytics-panel')).toHaveCount(0);
});
