/**
 * Parent-owned browser proof helper. Supply a Playwright Page whose entire app
 * connection is already synthetic, plus analyticsUiResponse from fixtures/analyticsUi.ts.
 * This helper never creates a login, reads auth files, or connects to production.
 * Example (in the parent's existing synthetic harness):
 *   await verifyAnalyticsUi(page, analyticsUiResponse);
 * Requires English locale and an authenticated synthetic app on loopback.
 */
import assert from 'node:assert/strict';

export async function verifyAnalyticsUi(page, fixture) {
  const origin = new URL(page.url());
  assert(
    ['127.0.0.1', 'localhost', '[::1]'].includes(origin.hostname),
    'Use a local synthetic app'
  );
  const queries = [];
  let failure = false;
  const routeHandler = async (route) => {
    const query = route.request().postDataJSON();
    queries.push(query);
    if (failure) {
      await route.fulfill({
        status: 503,
        contentType: 'application/json',
        body: JSON.stringify({
          error: 'analytics_unavailable',
          message: 'Synthetic dataset unavailable',
        }),
      });
      return;
    }
    const response = structuredClone(fixture);
    response.from_ms = query.from_ms;
    response.to_ms = query.to_ms;
    response.granularity = query.granularity;
    response.generated_at_ms = query.to_ms;
    const width = query.granularity === 'day' ? 86_400_000 : 3_600_000;
    const bucket = Math.floor(query.from_ms / width) * width;
    response.timeline = [
      { ...fixture.summary, bucket_ms: bucket },
      { ...fixture.summary, bucket_ms: bucket + width },
    ].filter((point) => point.bucket_ms < query.to_ms);
    if (query.before_id !== undefined) {
      response.requests = {
        ...fixture.requests,
        items: [{ ...fixture.requests.items[0], id: 'synthetic-next-page' }],
        has_more: false,
        next_before_ms: null,
        next_before_id: null,
      };
    }
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(response),
    });
  };
  const loaded = () => page.locator('#analytics-panel[aria-busy="false"]').waitFor();
  await page.route('**/prox/analytics', routeHandler);
  try {
    await page.goto(`${origin.origin}/#/analytics?tab=overview`);
    await loaded();
    assert.equal(await page.getByRole('tab').count(), 6);
    for (const tab of [
      'Overview',
      'Tokens & Cache',
      'Cost',
      'Performance',
      'Requests',
      'Model Rates',
    ]) {
      await page.getByRole('tab', { name: tab, exact: true }).click();
      assert.equal(
        await page.getByRole('tab', { name: tab, exact: true }).getAttribute('aria-selected'),
        'true'
      );
      assert.equal(await page.locator('#analytics-panel').getAttribute('aria-busy'), 'false');
    }
    await page.getByRole('tab', { name: 'Requests', exact: true }).click();
    await page
      .getByRole('button', { name: `Open event ${fixture.requests.items[0].id}`, exact: true })
      .click();
    await page.getByRole('dialog').waitFor();
    assert.ok((await page.getByRole('dialog').innerText()).includes('192.0.2.10'));
    await page.keyboard.press('Escape');
    await page.getByRole('dialog').waitFor({ state: 'hidden' });
    await page.getByRole('button', { name: 'Next', exact: true }).click();
    await loaded();
    assert.equal(queries.at(-1).before_id, fixture.requests.next_before_id);
    await page.getByRole('button', { name: 'Previous', exact: true }).click();
    await loaded();
    assert.equal(queries.at(-1).before_id, undefined);
    await page.getByRole('combobox', { name: 'Provider', exact: true }).selectOption('claude');
    await loaded();
    assert.equal(queries.at(-1).provider, 'claude');
    await page.getByRole('searchbox', { name: 'Search', exact: true }).fill('synthetic-trace');
    await page.getByRole('button', { name: 'Apply', exact: true }).click();
    await loaded();
    assert.equal(queries.at(-1).search, 'synthetic-trace');
    await page.getByRole('tab', { name: 'Overview', exact: true }).click();
    await page.locator('svg rect[role="button"]').first().focus();
    await page.keyboard.press('Enter');
    await loaded();
    assert.equal(
      await page.getByRole('tab', { name: 'Requests', exact: true }).getAttribute('aria-selected'),
      'true'
    );
    assert.equal(queries.at(-1).provider, 'claude');
    assert.equal(queries.at(-1).search, 'synthetic-trace');
    assert.ok(queries.at(-1).to_ms - queries.at(-1).from_ms <= 3_600_000);
    await page.getByRole('button', { name: 'Refresh', exact: true }).click();
    await loaded();
    assert.equal(queries.at(-1).to_ms - queries.at(-1).from_ms, 86_400_000);
    assert.equal(queries.at(-1).before_id, undefined);
    failure = true;
    await page.getByRole('button', { name: 'Refresh', exact: true }).click();
    await page.getByRole('alert').waitFor();
    assert.ok((await page.getByRole('alert').innerText()).includes('local analytics dataset'));
    failure = false;
    await page.getByRole('button', { name: 'Retry', exact: true }).click();
    await loaded();
    await page.setViewportSize({ width: 390, height: 844 });
    await page.emulateMedia({ reducedMotion: 'reduce' });
    for (const tab of [
      'Overview',
      'Tokens & Cache',
      'Cost',
      'Performance',
      'Requests',
      'Model Rates',
    ]) {
      await page.getByRole('tab', { name: tab, exact: true }).click();
      assert.ok(
        await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
        `${tab} overflows at 390px`
      );
    }
    return { queryCount: queries.length, tabs: 6, mobileWidth: 390 };
  } finally {
    await page.unroute('**/prox/analytics', routeHandler);
  }
}
