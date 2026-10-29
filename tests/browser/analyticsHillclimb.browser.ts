import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { test, expect } from './analyticsHarness';
import type { AnalyticsScenario } from '../fixtures/analyticsUi';

// Visual-review capture only: `HILLCLIMB_OUT=<dir> playwright test analyticsHillclimb`.
// Writes a full-height screenshot plus DOM geometry per screen for measured checks.
const out = process.env.HILLCLIMB_OUT;
test.skip(!out, 'HILLCLIMB_OUT not set');

const GEOMETRY = () => {
  const root = document.querySelector('main') ?? document.body;
  const visible = (e: Element) => {
    const b = e.getBoundingClientRect();
    return b.width > 0 && b.height > 0 && e.checkVisibility({ checkVisibilityCSS: true });
  };
  const rect = (e: Element) => {
    const b = e.getBoundingClientRect();
    return { x: b.x, y: b.y, w: b.width, h: b.height };
  };
  const controls = [
    ...root.querySelectorAll('button,select,input,summary,a,[role=button],[role=tab]'),
  ]
    .filter(visible)
    .map((e) => ({
      text: (e.getAttribute('aria-label') || e.textContent || '').trim().slice(0, 80),
      tag: e.tagName,
      ...rect(e),
    }));
  const clipped = [...root.querySelectorAll('*')]
    .filter(
      (e) =>
        visible(e) &&
        (e as HTMLElement).clientWidth > 2 &&
        e.scrollWidth > (e as HTMLElement).clientWidth + 1 &&
        getComputedStyle(e).overflowX !== 'visible' &&
        !e.matches('[role=region], [class*=tableScroll], [role=tablist]')
    )
    .map((e) => ({ tag: e.tagName, class: String(e.className).slice(0, 80) }));
  const text: Array<Record<string, unknown>> = [];
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  while (walker.nextNode()) {
    const node = walker.currentNode;
    const e = node.parentElement;
    if (!e || !node.textContent?.trim() || !visible(e) || e.closest('svg,[class*=srOnly]'))
      continue;
    const s = getComputedStyle(e);
    const range = document.createRange();
    range.selectNodeContents(node);
    // Text scrolled out of a table region is not painted; measure only its visible part.
    const clip = e.closest('[role=region], [role=tablist]')?.getBoundingClientRect();
    for (const b of range.getClientRects()) {
      if (b.width <= 2 || b.height <= 2) continue;
      if (clip && (b.left < clip.left - 1 || b.right > clip.right + 1)) continue;
      text.push({
        text: node.textContent.trim().slice(0, 60),
        x: b.x,
        y: b.y,
        w: b.width,
        h: b.height,
        size: parseFloat(s.fontSize),
        weight: parseInt(s.fontWeight) || 400,
        disabled: !!e.closest(':disabled'),
      });
    }
  }
  // Series swatches carry meaning; measure them from pixels, not CSS.
  const swatches = [...root.querySelectorAll('ul[aria-label] li')]
    .filter(visible)
    .map((li) => ({ label: li.textContent?.trim(), ...rect(li.querySelector('svg')!) }));
  return {
    pageWidth: document.documentElement.clientWidth,
    scrollWidth: document.documentElement.scrollWidth,
    controls,
    clipped,
    text,
    swatches,
  };
};

const screens: Array<{
  name: string;
  tab: string;
  scenario: AnalyticsScenario;
  status?: number;
  loading?: boolean;
}> = [
  { name: 'overview', tab: 'Overview', scenario: 'large' },
  { name: 'tokens', tab: 'Tokens & Cache', scenario: 'large' },
  { name: 'cost', tab: 'Cost', scenario: 'large' },
  { name: 'performance', tab: 'Performance', scenario: 'large' },
  { name: 'requests', tab: 'Requests', scenario: 'large' },
  { name: 'rates', tab: 'Model Rates', scenario: 'large' },
  { name: 'empty', tab: 'Overview', scenario: 'empty' },
  { name: 'unknown', tab: 'Performance', scenario: 'unknown' },
  { name: 'error', tab: 'Overview', scenario: 'ready', status: 503 },
  { name: 'loading', tab: 'Overview', scenario: 'ready', loading: true },
];

// Every screen at ultrawide, laptop and phone; the chart-heavy tabs at the sizes between.
const sizes: Array<[number, number, 'all' | 'charts']> = [
  [3440, 1300, 'all'],
  [2560, 1300, 'charts'],
  [1920, 1000, 'charts'],
  [1440, 900, 'all'],
  [1280, 720, 'charts'],
  [1024, 768, 'charts'],
  [768, 1024, 'charts'],
  [390, 844, 'all'],
];
for (const [width, height, set] of sizes) {
  for (const screen of set === 'all'
    ? screens
    : screens.filter((s) => ['overview', 'tokens'].includes(s.name))) {
    test(`capture ${screen.name} ${width}`, async ({ page, app }) => {
      await page.setViewportSize({ width, height });
      app.scenario = screen.scenario;
      app.hold = !!screen.loading;
      await app.login();
      if (screen.loading) {
        await expect(page.getByText('Loading analytics…')).toBeVisible();
      } else {
        await app.loaded();
        await app.tab(screen.tab);
      }
      if (screen.status) {
        app.status = screen.status;
        await page.getByRole('button', { name: 'Refresh', exact: true }).click();
        await expect(page.getByRole('alert')).toBeVisible();
      }
      // First screen as the user sees it on load, then the whole page.
      const dir = join(out!, `${screen.name}-${width}`);
      mkdirSync(join(out!, 'fold'), { recursive: true });
      await page.waitForTimeout(150);
      await page.screenshot({
        path: join(out!, 'fold', `${screen.name}-${width}.png`),
        animations: 'disabled',
      });
      // The app scrolls inside main; grow the viewport so one capture holds the whole page.
      const full = await page.evaluate(() => document.querySelector('main')!.scrollHeight);
      await page.setViewportSize({ width, height: Math.min(6000, full + 40) });
      await page.waitForTimeout(150);
      await page.screenshot({ path: `${dir}.png`, animations: 'disabled' });
      writeFileSync(`${dir}.json`, JSON.stringify(await page.evaluate(GEOMETRY)));
      app.release();
      expect(app.errors).toEqual([]);
    });
  }
}
