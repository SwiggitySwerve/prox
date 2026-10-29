import { test, expect } from './analyticsHarness';
import type { AnalyticsScenario } from '../fixtures/analyticsUi';

const tabs = ['Overview', 'Tokens & Cache', 'Cost', 'Performance', 'Requests', 'Model Rates'];

test('all controls, keyboard drilldown, paging, details and model schedules', async ({
  page,
  app,
}) => {
  await app.login();
  await app.loaded();
  for (const name of tabs) await app.tab(name);
  await page
    .locator('summary')
    .filter({ hasText: /^Rate details$/ })
    .first()
    .click();
  await expect(page.getByText('fast: $6.00 / $30.00', { exact: true })).toBeVisible();
  await expect(page.getByText(/Offline synthetic source/)).toBeVisible();
  await page.screenshot({
    path: test.info().outputPath('expanded-rates.png'),
    animations: 'disabled',
  });
  // The first-token chart has unmeasured hours, so its table must say Unavailable.
  await app.tab('Performance');
  const alternative = page
    .locator('section')
    .filter({ has: page.getByRole('heading', { name: /^p95 reported TTFT/ }) })
    .locator('details');
  await alternative.locator('summary').click();
  await expect(alternative.locator('table')).toBeVisible();
  await expect(alternative.locator('table')).toContainText('Unavailable');
  await page.screenshot({
    path: test.info().outputPath('chart-table.png'),
    animations: 'disabled',
  });
  await app.tab('Requests');
  const details = page.getByRole('button', { name: 'Open event synthetic-event-2', exact: true });
  await details.click();
  await expect(page.getByRole('dialog')).toContainText('192.0.2.10');
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog')).not.toBeVisible();
  await expect(details).toBeFocused();
  await app.change(() => page.getByRole('button', { name: 'Next', exact: true }).click());
  expect(app.queries.at(-1)?.before_id).toBe(1);
  await expect(page.getByRole('button', { name: 'Next', exact: true })).toBeDisabled();
  await app.change(() => page.getByRole('button', { name: 'Previous', exact: true }).click());
  expect(app.queries.at(-1)?.before_id).toBeUndefined();
  await app.change(() =>
    page.getByRole('combobox', { name: 'Provider', exact: true }).selectOption('claude')
  );
  await app.change(() =>
    page.getByRole('combobox', { name: 'Model', exact: true }).selectOption('fixture-model')
  );
  await page.getByRole('searchbox').fill('synthetic-trace');
  await app.change(() => page.getByRole('button', { name: 'Apply', exact: true }).click());
  await app.tab('Overview');
  const bar = page.locator('svg rect[role=button]').first();
  await bar.focus();
  await expect(page.locator('output').first()).toContainText('UTC');
  await app.change(() => page.keyboard.press('Enter'));
  await expect(page.getByRole('tab', { name: 'Requests', exact: true })).toHaveAttribute(
    'aria-selected',
    'true'
  );
  expect(app.queries.at(-1)).toMatchObject({
    provider: 'claude',
    model: 'fixture-model',
    search: 'synthetic-trace',
  });
  expect(app.queries.at(-1)!.to_ms - app.queries.at(-1)!.from_ms).toBe(3_600_000);
  await app.change(() => page.getByRole('button', { name: 'Refresh', exact: true }).click());
  expect(app.queries.at(-1)!.to_ms - app.queries.at(-1)!.from_ms).toBe(86_400_000);
  await app.change(() => page.getByRole('button', { name: 'Clear filters', exact: true }).click());
  expect(app.queries.at(-1)?.provider).toBeUndefined();
  for (const [range, span] of [
    ['1h', 3_600_000],
    ['7d', 604_800_000],
    ['30d', 2_592_000_000],
  ] as const) {
    await app.change(() =>
      page.getByRole('combobox', { name: 'Time range', exact: false }).selectOption(range)
    );
    expect(app.queries.at(-1)!.to_ms - app.queries.at(-1)!.from_ms).toBe(span);
  }
  await app.change(() =>
    page.getByRole('combobox', { name: 'Recorded outcome', exact: true }).selectOption('failed')
  );
  await expect(page.locator('tbody')).toContainText('Failed');
});

for (const width of [1440, 1024, 390]) {
  test(`visual matrix at ${width}px`, async ({ page, app }, info) => {
    await page.setViewportSize({ width, height: width === 390 ? 844 : 1000 });
    app.scenario = 'large';
    await app.login();
    await app.loaded();
    for (const name of tabs) {
      await app.tab(name);
      await expect
        .poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth))
        .toBe(true);
      const metrics = await page.locator('article[class*=metric] strong').evaluateAll((els) =>
        els.map((el) => {
          const rect = el.getBoundingClientRect();
          return {
            height: rect.height,
            line: parseFloat(getComputedStyle(el).lineHeight),
            width: rect.width,
            scroll: el.scrollWidth,
          };
        })
      );
      expect(metrics.every((m) => m.height <= m.line + 1 && m.scroll <= m.width + 1)).toBe(true);
      if (name === 'Model Rates') {
        expect(
          await page
            .locator('table[class*=rates] td:nth-child(n+5):nth-child(-n+8)')
            .evaluateAll((els) =>
              els.every((el) => {
                const range = document.createRange();
                range.selectNodeContents(el);
                // One line of text: all boxes, including screen-reader text, sit on one line box.
                const tops = [...range.getClientRects()].map((r) => r.top);
                return Math.max(...tops) - Math.min(...tops) < 8;
              })
            )
        ).toBe(true);
      }
      if (name === 'Requests') {
        expect(
          await page
            .locator('td:last-child button')
            .evaluateAll((els) => els.every((el) => getComputedStyle(el).whiteSpace === 'nowrap'))
        ).toBe(true);
      }
      await page.screenshot({
        path: info.outputPath(`${name.replaceAll(' ', '-')}.png`),
        animations: 'disabled',
      });
      // Inspect lower charts/tables too; the app scrolls inside main, not the document.
      await page
        .locator('#analytics-panel')
        .evaluate((el) => el.lastElementChild?.scrollIntoView({ block: 'end' }));
      await page.screenshot({
        path: info.outputPath(`${name.replaceAll(' ', '-')}-bottom.png`),
        animations: 'disabled',
      });
      await page.getByRole('heading', { name: 'Analytics', exact: true }).scrollIntoViewIfNeeded();
    }
    await app.tab('Requests');
    await page.getByRole('button', { name: 'Open event synthetic-event-2', exact: true }).click();
    await expect(page.getByRole('dialog')).toBeVisible();
    await page.screenshot({ path: info.outputPath('details.png'), animations: 'disabled' });
    await page
      .getByRole('dialog')
      .locator('dl')
      .last()
      .evaluate((el) => el.lastElementChild?.scrollIntoView({ block: 'end' }));
    await page.screenshot({ path: info.outputPath('details-bottom.png'), animations: 'disabled' });
    await page.keyboard.press('Escape');
  });
}

for (const scenario of ['empty', 'unknown', 'zero'] as AnalyticsScenario[]) {
  test(`${scenario} data stays truthful`, async ({ page, app }, info) => {
    app.scenario = scenario;
    await app.login();
    await app.loaded();
    for (const name of ['Overview', 'Performance', 'Requests', 'Model Rates']) {
      await app.tab(name);
      await page.screenshot({ path: info.outputPath(`${name}.png`), animations: 'disabled' });
    }
    if (scenario === 'empty') {
      await expect(page.getByText('No model rates or registrations were returned.')).toBeVisible();
      await app.tab('Requests');
      await expect(page.getByRole('button', { name: 'Next', exact: true })).toBeDisabled();
    } else {
      await app.tab('Performance');
      const values = page.locator('article[class*=metric] strong');
      await expect(values).toHaveText(
        scenario === 'unknown' ? ['Unavailable', 'Unavailable', 'Unavailable'] : ['0', '0', '0']
      );
    }
  });
}

test('loading, error, retry and obsolete responses', async ({ page, app }, info) => {
  app.hold = true;
  await app.login();
  await expect(page.getByText('Loading analytics…')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Refresh', exact: true })).toBeDisabled();
  await page.screenshot({ path: info.outputPath('loading.png'), animations: 'disabled' });
  await expect.poll(() => app.pending.length).toBeGreaterThan(0);
  app.release();
  await app.loaded();
  for (const status of [503, 404, 500]) {
    app.status = status;
    await page.getByRole('button', { name: 'Refresh', exact: true }).click();
    await expect(page.getByRole('alert')).toBeVisible();
    await expect(page.locator('article[class*=metric]')).toHaveCount(0);
    await page.screenshot({ path: info.outputPath(`error-${status}.png`), animations: 'disabled' });
    if (status === 503) {
      await page.setViewportSize({ width: 390, height: 844 });
      await page.screenshot({ path: info.outputPath('error-mobile.png'), animations: 'disabled' });
      await page.setViewportSize({ width: 1440, height: 1000 });
    }
    app.status = 200;
    await app.change(() => page.getByRole('button', { name: 'Retry', exact: true }).click());
  }
  app.hold = true;
  await page.getByRole('combobox', { name: 'Provider', exact: true }).selectOption('claude');
  await expect.poll(() => app.pending.length).toBeGreaterThan(0);
  await expect(
    page
      .getByRole('combobox', { name: 'Provider', exact: true })
      .getByRole('option', { name: 'codex', exact: true })
  ).toHaveCount(1);
  await expect(
    page.getByRole('combobox', { name: 'Model', exact: true }).locator('option')
  ).toHaveCount(3);
  app.hold = false;
  await app.change(() =>
    page.getByRole('combobox', { name: 'Provider', exact: true }).selectOption('codex')
  );
  await app.tab('Requests');
  await expect(page.locator('tbody')).toContainText('GPT / Codex');
  const settled = app.settled;
  app.release();
  await expect.poll(() => app.settled).toBeGreaterThan(settled);
  await expect(page.locator('#analytics-panel')).toHaveAttribute('aria-busy', 'false');
  await expect(page.locator('tbody')).not.toContainText('Claude');
});

test('chart inspection follows the selected metric instead of retaining an old value', async ({
  page,
  app,
}) => {
  await app.login();
  await app.loaded();
  const chart = page.locator('section').filter({
    has: page.getByRole('heading', { name: 'By provider · Retained events', exact: true }),
  });
  await chart.getByRole('button', { name: /^Claude: / }).focus();
  await expect(chart.locator('output')).toHaveText('Claude: 128');
  await app.tab('Tokens & Cache');
  const changed = page.locator('section').filter({
    has: page.getByRole('heading', { name: 'By provider · Reported output tokens', exact: true }),
  });
  await expect(changed.locator('output')).toHaveText('Claude: 12,500');
});

test('logging out while analytics is pending hides the previous session', async ({ page, app }) => {
  await app.login();
  await app.loaded();
  app.hold = true;
  await page.getByRole('button', { name: 'Refresh', exact: true }).click();
  await expect.poll(() => app.pending.length).toBeGreaterThan(0);
  await page.getByRole('button', { name: 'Logout', exact: true }).click();
  await expect(page.locator('input[type=password]')).toBeVisible();
  const settled = app.settled;
  app.release();
  await expect.poll(() => app.settled).toBeGreaterThan(settled);
  await expect(page.locator('#analytics-panel')).toHaveCount(0);
});

// The page opens on its first chart: header, filters, tabs and cards fit above it.
for (const [width, height] of [
  [3440, 1300],
  [2560, 1300],
  [1920, 1000],
  [1680, 950],
  [1440, 900],
] as const) {
  test(`first chart is on screen at ${width}x${height}`, async ({ page, app }) => {
    await page.setViewportSize({ width, height });
    app.scenario = 'large';
    await app.login();
    await app.loaded();
    // Filter buttons match the fields beside them.
    const heights = await page
      .locator('section[aria-label="Shared filters"] :is(select, input, button)')
      .evaluateAll((els) => els.map((el) => Math.round(el.getBoundingClientRect().height)));
    expect(new Set(heights).size, `control heights ${heights}`).toBe(1);
    for (const name of ['Overview', 'Tokens & Cache']) {
      await app.tab(name);
      const bottom = await page
        .locator('[class*=trendTime]')
        .first()
        .evaluate((el) => el.getBoundingClientRect().bottom);
      expect(bottom, `${name} chart bottom`).toBeLessThanOrEqual(height);
    }
  });
}
