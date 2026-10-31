import { test as base, expect, type Page } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { parse } from 'yaml';
import type { AnalyticsQuery } from '../../src/domain/analytics/types';
import { analyticsScenario, type AnalyticsScenario } from '../fixtures/analyticsUi';

const origin = 'http://127.0.0.1:15173';
const config = parse(
  readFileSync(new URL('../fixtures/visualConfig-v8.yaml', import.meta.url), 'utf8')
);
const discovery = {
  schemaVersion: 1,
  revision: 'synthetic-browser-v1',
  defaultInstanceId: 'fixture-source',
  sources: [
    {
      instanceId: 'fixture-source',
      label: 'Synthetic source',
      publicBasePath: '',
      aliases: [],
      authScope: 'synthetic',
    },
  ],
};

export class AnalyticsHarness {
  scenario: AnalyticsScenario = 'ready';
  status = 200;
  settled = 0;
  queries: AnalyticsQuery[] = [];
  unexpected: string[] = [];
  errors: string[] = [];
  pending: Array<() => void> = [];
  hold = false;
  /** Credentials the Dashboard sees; empty by default. */
  credentials: Array<Record<string, unknown>> = [];
  /** Answer analytics as a complete retained ledger (the Dashboard only uses those). */
  rawComplete = false;
  /** Pages that use the source registry (Dashboard) need discovery the validator accepts. */
  validDiscovery = false;
  constructor(readonly page: Page) {}

  async install() {
    this.page.on('pageerror', (error) => this.errors.push(error.message));
    await this.page.clock.setFixedTime(new Date('2026-10-29T12:00:00Z'));
    await this.page.routeWebSocket('**/*', (socket) => socket.close());
    await this.page.route('**/*', async (route) => {
      const request = route.request();
      const url = new URL(request.url());
      const reply = (json: unknown, status = 200) =>
        route.fulfill({ status, json, headers: { 'X-CPA-Version': 'v8.0.44' } });
      if (url.origin !== origin) {
        this.unexpected.push(`${request.method()} ${url.origin}${url.pathname}`);
        return route.abort();
      }
      if (url.pathname.endsWith('/prox/analytics')) {
        expect(request.method()).toBe('POST');
        expect(request.headers().authorization).toBe('Bearer synthetic-management-key');
        const query = request.postDataJSON() as AnalyticsQuery;
        this.queries.push(query);
        // Capture the response at dispatch, so delayed responses exercise real stale-data guards.
        const response = analyticsScenario(this.scenario, query);
        if (this.rawComplete) response.coverage.raw_complete = true;
        const status = this.status;
        if (this.hold) await new Promise<void>((resolve) => this.pending.push(resolve));
        if (status !== 200) return reply({ error: 'Synthetic analytics failure' }, status);
        try {
          return await reply(response);
        } finally {
          this.settled++;
        }
      }
      if (url.pathname === '/prox/sources.json')
        return reply(this.validDiscovery ? { ...discovery, revision: 'a'.repeat(64) } : discovery);
      const path = url.pathname.replace(/^\/v8\/management/, '');
      if (request.method() === 'GET') {
        if (path === '/config') return reply(config);
        if (path === '/prox/pools') return reply({ error: 'Synthetic pool not collected' }, 503);
        if (path === '/auth-files') return reply({ files: [] });
        if (path === '/credentials') return reply({ files: this.credentials });
        if (path === '/config/access/api-keys') return reply(['synthetic-client-key']);
        if (path === '/usage') return reply({ usage: { total_requests: 0, apis: {} } });
        if (path === '/api-key-usage') return reply({});
        if (path === '/observability/usage/api-keys') return reply({});
        if (url.pathname === '/v1/models') return reply({ data: [] });
      }
      if (
        !url.pathname.includes('/management') &&
        !url.pathname.startsWith('/v1/') &&
        request.method() === 'GET' &&
        (url.pathname === '/' ||
          /^\/(src|node_modules|@vite|@react-refresh|@fs)\b/.test(url.pathname))
      ) {
        return route.continue();
      }
      this.unexpected.push(`${request.method()} ${url.pathname}`);
      return route.abort();
    });
  }

  release() {
    this.hold = false;
    this.pending.splice(0).forEach((resolve) => resolve());
  }

  async login() {
    await this.page.goto('/#/analytics');
    await this.page.locator('input[type=password]').fill('synthetic-management-key');
    const remember = this.page.getByRole('checkbox', { name: 'Remember password' });
    if (await remember.isChecked()) await remember.uncheck();
    await this.page.getByRole('button', { name: 'Login', exact: true }).click();
    const link = this.page.getByRole('link', { name: 'Analytics', exact: true });
    await link.waitFor({ state: 'attached' });
    const mobileMenu = this.page.getByRole('button', { name: 'Expand sidebar', exact: true });
    if (await mobileMenu.isVisible()) await mobileMenu.click();
    await link.click();
    const close = this.page.getByRole('button', { name: 'Close', exact: true });
    if (await close.isVisible()) await close.click();
  }

  async loaded() {
    await expect(this.page.locator('#analytics-panel')).toHaveAttribute('aria-busy', 'false');
    await expect(this.page.locator('aside[aria-label="Data coverage"]')).toBeVisible();
  }

  async change(action: () => Promise<unknown>) {
    const count = this.queries.length;
    await action();
    await expect.poll(() => this.queries.length).toBeGreaterThan(count);
    await this.loaded();
  }

  async tab(name: string) {
    const tab = this.page.getByRole('tab', { name, exact: true });
    await tab.click();
    await expect(tab).toHaveAttribute('aria-selected', 'true');
  }
}

export const test = base.extend<{ app: AnalyticsHarness }>({
  app: async ({ page }, run) => {
    const app = new AnalyticsHarness(page);
    await app.install();
    await run(app);
    app.release();
    expect(app.unexpected, 'No unmocked API or external request may reach a backend').toEqual([]);
    expect(app.errors, 'No browser runtime errors').toEqual([]);
  },
});
export { expect };
