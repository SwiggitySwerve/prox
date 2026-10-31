import { test, expect } from './analyticsHarness';

// The first visit to the Dashboard route makes Vite compile it, which outlasts the default.
const cold = { timeout: 30_000 };
// A cold Vite cache can re-optimize dependencies and reload the page on that first visit.
test.describe.configure({ retries: 1 });

const credential = {
  name: 'claude-1.json',
  type: 'claude',
  auth_index: '1',
  success: 5,
  failed: 1,
};
const hour = 3_600_000;

test('a fleet row opens the exact Analytics view behind its number', async ({ page, app }) => {
  app.validDiscovery = true;
  app.credentials = [credential];
  app.rawComplete = true;
  await app.login();
  await page.evaluate(() => void (window.location.hash = '#/dashboard'));
  const row = page.getByRole('link', { name: 'Open Claude in Analytics', exact: true });
  await expect(row).toBeVisible(cold);
  const dashboardQuery = app.queries.at(-1)!;
  expect(dashboardQuery).toMatchObject({
    provider: 'claude',
    granularity: 'hour',
    time_zone: 'UTC',
    outcome: 'all',
  });
  expect(dashboardQuery.to_ms - dashboardQuery.from_ms).toBe(24 * hour);
  await expect(row).toHaveAttribute(
    'href',
    '#/analytics?tab=overview&range=24h&bucket=hour&provider=claude'
  );
  await app.change(() => row.click());
  const analyticsQuery = app.queries.at(-1)!;
  // The same window and filters; only the page size differs (the Dashboard asks for no rows).
  expect({ ...analyticsQuery, limit: 0 }).toEqual({ ...dashboardQuery, limit: 0 });
  await expect(page.getByRole('combobox', { name: 'Provider', exact: true })).toHaveValue('claude');
});

test('the chart says its hours are local, and rows are labelled by what they count', async ({
  page,
  app,
}) => {
  app.validDiscovery = true;
  app.credentials = [credential];
  app.rawComplete = true;
  await app.login();
  await page.evaluate(() => void (window.location.hash = '#/dashboard'));
  await expect(
    page.getByText('Hours are shown in your local time; Analytics uses UTC.')
  ).toBeVisible(cold);
  await expect(
    page.getByText('Volume and success rate per provider over the same window.')
  ).toBeVisible();
});

test('without usable analytics the rows use the counters, say so, and do not link', async ({
  page,
  app,
}) => {
  app.validDiscovery = true;
  app.credentials = [credential];
  app.status = 503;
  await app.login();
  await page.evaluate(() => void (window.location.hash = '#/dashboard'));
  await expect(page.getByText(/since the proxy last restarted/, { exact: false })).toBeVisible(
    cold
  );
  await expect(page.getByRole('link', { name: /in Analytics$/ })).toHaveCount(0);
  await expect(page.getByText('Hours are shown in your local time')).toHaveCount(0);
});
