// Cold restored deep-link load: counts requests and time to visible analytics data.
import { chromium } from '/home/swerve/.t3/worktrees/prox-quota-hillclimb/t3-1a2f7901-a3da4fb0695ec3aa/node_modules/playwright/index.mjs';
import { readFileSync } from 'node:fs';
const port = process.argv[2] ?? '15180';
const runs = Number(process.argv[3] ?? 7);
const origin = `http://127.0.0.1:${port}`;
const link = `${origin}/#/analytics?tab=overview&range=7d&bucket=hour`;
const key = readFileSync(`${process.env.HOME}/.config/cli-proxy-rerank/management-key`, 'utf8').trim();
const browser = await chromium.launch();
// Sign in once with Remember password to create the saved session.
const ctx0 = await browser.newContext({ viewport: { width: 1440, height: 1000 }, locale: 'en-US' });
const p0 = await ctx0.newPage();
await p0.goto(`${origin}/#/login`);
await p0.locator('input[type=password]').fill(key);
const remember = p0.getByRole('checkbox', { name: 'Remember password' });
if (!(await remember.isChecked())) await remember.check({ force: true });
await p0.getByRole('button', { name: 'Login', exact: true }).click();
await p0.waitForURL((u) => !u.hash.startsWith('#/login'), { timeout: 20000 });
const state = await ctx0.storageState();
await ctx0.close();
const results = [];
for (let i = 0; i < runs; i++) {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 1000 }, locale: 'en-US', storageState: state });
  const page = await ctx.newPage();
  await page.addInitScript(() => {
    const seen = [location.hash];
    window.__hashes = seen;
    const rec = () => { if (seen.at(-1) !== location.hash) seen.push(location.hash); };
    for (const k of ['pushState', 'replaceState']) {
      const orig = history[k].bind(history);
      history[k] = (...a) => { const r = orig(...a); rec(); return r; };
    }
    addEventListener('hashchange', rec);
  });
  const reqs = [];
  page.on('request', (r) => { const u = new URL(r.url()); if (u.pathname !== '/') reqs.push(`${r.method()} ${u.pathname}`); });
  const t0 = Date.now();
  await page.goto(link);
  await page.locator('#analytics-panel[aria-busy="false"]').waitFor({ timeout: 20000 });
  await page.locator('aside[aria-label="Data coverage"]').waitFor({ state: 'visible', timeout: 20000 });
  const nav = await page.evaluate(() => {
    const n = performance.getEntriesByType('navigation')[0];
    const res = performance.getEntriesByType('resource').filter((e) => /config$|analytics$|sources.json$/.test(e.name)).map((e) => `${new URL(e.name).pathname.replace('/v8/management','')} ${Math.round(e.startTime)}-${Math.round(e.responseEnd)}`);
    return { visible: performance.now(), responseEnd: n.responseEnd, domInteractive: n.domInteractive, res };
  });
  const hashes = await page.evaluate(() => window.__hashes);
  await page.waitForTimeout(1500); // let trailing requests show up
  const config = reqs.filter((r) => /\/config$/.test(r) && r.startsWith('GET')).length;
  results.push({ res: nav.res, ms: Math.round(nav.visible), domInteractive: Math.round(nav.domInteractive), wall: Date.now() - t0, config, login: hashes.some((h) => h.startsWith('#/login')), hashes, reqs });
  await ctx.close();
}
await browser.close();
const med = (a) => { const s = [...a].sort((x, y) => x - y); return s[Math.floor(s.length / 2)]; };
for (const r of results) console.log(r.ms, 'ms visible | domInteractive', r.domInteractive, '| /config x', r.config, '| via login', r.login, '|', r.hashes.join(' -> '), '\n   ', r.res.join(' | '));
console.log('median visible ms', med(results.map((r) => r.ms)), 'median domInteractive', med(results.map((r) => r.domInteractive)));
const counts = {}; for (const q of results[0].reqs) counts[q] = (counts[q] ?? 0) + 1;
console.log('run 1 requests:', JSON.stringify(counts, null, 1));
