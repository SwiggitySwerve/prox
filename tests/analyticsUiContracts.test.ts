import { beforeEach, describe, expect, spyOn, test } from 'bun:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import { readFileSync } from 'node:fs';
import i18n from '../src/i18n';
import { apiClient } from '../src/services/api/client';
import { createAnalyticsApi } from '../src/services/api/analytics';
import { ApiClient } from '../src/services/api/transport';
import { AnalyticsPage } from '../src/features/analytics/AnalyticsPage';
import { AnalyticsChart } from '../src/features/analytics/AnalyticsChart';
import { AnalyticsViews } from '../src/features/analytics/AnalyticsViews';
import { RequestDetails, RequestTable } from '../src/features/analytics/RequestTable';
import { ModelRates } from '../src/features/analytics/ModelRates';
import { barGeometry } from '../src/features/analytics/chartGeometry';
import { analyticsNumber } from '../src/features/analytics/format';
import {
  analyticsTabs,
  bucketQuery,
  nextPageQuery,
  rangeQuery,
  withoutCursor,
} from '../src/features/analytics/queryState';
import { analyticsUiRequest, analyticsUiResponse } from './fixtures/analyticsUi';

const read = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
const noop = () => {};
beforeEach(async () => {
  await i18n.changeLanguage('en');
});

describe('Analytics query and transport contracts', () => {
  test('all ranges are UTC and use server-supported bucket sizes', () => {
    expect(rangeQuery('1h', 10_000_000)).toMatchObject({
      from_ms: 6_400_000,
      to_ms: 10_000_000,
      time_zone: 'UTC',
      granularity: 'hour',
    });
    expect(rangeQuery('24h', 100_000_000).from_ms).toBe(13_600_000);
    expect(rangeQuery('7d', 1_000_000_000)).toMatchObject({
      from_ms: 395_200_000,
      granularity: 'day',
    });
    expect(rangeQuery('30d', 3_000_000_000).from_ms).toBe(408_000_000);
  });
  test('bucket drilldown intersects the UTC bucket and keeps filters, clearing the cursor', () => {
    const query = {
      ...rangeQuery('24h', 10_000_000),
      from_ms: 1_000_000,
      provider: 'claude',
      model: 'alias',
      search: 'trace',
      outcome: 'failed' as const,
      before_ms: 5,
      before_id: 7,
    };
    expect(bucketQuery(query, 0)).toEqual({
      ...withoutCursor(query),
      from_ms: 1_000_000,
      to_ms: 3_600_000,
    });
    expect(bucketQuery(query, 7_200_000)).toEqual({
      ...withoutCursor(query),
      from_ms: 7_200_000,
      to_ms: 10_000_000,
    });
  });
  test('paging preserves filters and the server tie-breaker, including zero cursors', () => {
    const query = { ...rangeQuery('7d', 2_000_000_000), model: 'billing-alias', search: 'trace' };
    expect(nextPageQuery(query, analyticsUiResponse.requests)).toEqual({
      ...query,
      before_ms: 1793233800000,
      before_id: 1,
    });
    expect(
      nextPageQuery(query, {
        ...analyticsUiResponse.requests,
        next_before_ms: 0,
        next_before_id: 0,
      })?.before_id
    ).toBe(0);
    expect(
      nextPageQuery(query, { ...analyticsUiResponse.requests, next_before_id: null })
    ).toBeNull();
    expect(nextPageQuery(query, { ...analyticsUiResponse.requests, has_more: false })).toBeNull();
  });
  test('POST uses a captured connection and forwards the query and AbortSignal unchanged', async () => {
    const captured = new ApiClient();
    const capture = spyOn(apiClient, 'captureConnection').mockReturnValue(captured);
    const post = spyOn(captured, 'post').mockResolvedValue(analyticsUiResponse);
    try {
      const query = rangeQuery('1h', 1_000_000_000);
      const signal = new AbortController().signal;
      expect(await createAnalyticsApi().query(query, signal)).toBe(analyticsUiResponse);
      expect(capture).toHaveBeenCalledTimes(1);
      expect(post).toHaveBeenCalledWith('/prox/analytics', query, { signal });
    } finally {
      post.mockRestore();
      capture.mockRestore();
    }
  });
  test('effect guards response publication, cancellation and session identity', () => {
    const source = read('src/features/analytics/useAnalytics.ts');
    expect(source).toContain('new AbortController()');
    expect(source).toContain('controller.abort()');
    expect(source).toContain('observer.getSnapshot() === session');
    expect(source).toContain('apiClient.getConnectionRevision() === revision');
    expect(source).toContain('sessionResult?.query === query');
    expect(source).toContain('result?.session === session');
    expect(source).toContain('createPoolSessionObserver');
  });
  test('refresh advances the selected window and clears paging while preserving filters', () => {
    const source = read('src/features/analytics/AnalyticsPage.tsx');
    const reload = source.slice(source.indexOf('const reload ='), source.indexOf('return <'));
    expect(reload).toContain('rangeQuery(range, Date.now())');
    expect(reload).toContain('withoutCursor(query)');
    expect(reload).toContain('to_ms: interval.to_ms');
    expect(reload).toContain('setPages([');
  });
});

describe('Analytics SSR presentation', () => {
  test('six tabs remain reachable and the authenticated sidebar includes Analytics under Observe', () => {
    const markup = renderToStaticMarkup(
      createElement(
        MemoryRouter,
        { initialEntries: ['/analytics?tab=cost'] },
        createElement(AnalyticsPage)
      )
    );
    expect(markup.match(/role="tab"/g) ?? []).toHaveLength(6);
    expect(markup).toContain('id="analytics-tab-cost" role="tab" aria-selected="true"');
    expect(markup).toContain('Loading analytics');
    const layout = read('src/components/layout/MainLayout.tsx');
    expect(
      layout.slice(layout.indexOf("id: 'observe'"), layout.indexOf("id: 'control'"))
    ).toContain("path: '/analytics'");
    expect(read('src/router/MainRoutes.tsx')).toContain(
      "path: '/analytics', element: <AnalyticsPage />"
    );
  });
  test('all aggregate views use full server totals, retain cautions and do not derive totals from request pages', () => {
    for (const tab of ['overview', 'tokens', 'cost', 'performance'] as const) {
      const markup = renderToStaticMarkup(
        createElement(AnalyticsViews, {
          tab,
          data: analyticsUiResponse,
          onBucket: noop,
          onModel: noop,
          onProvider: noop,
        })
      );
      expect(markup).toContain('View data table');
      expect(markup).toContain('Fixture model (billing alias)');
      expect(markup).not.toContain('NaN');
      if (tab === 'overview') expect(markup).toContain('<strong>128</strong>');
      if (tab === 'tokens') expect(markup).toContain('Legacy data cannot establish');
      if (tab === 'cost') expect(markup).toContain('Not subscription spend');
      if (tab === 'performance') {
        expect(markup).toContain('mixed methods');
        expect(markup).toContain('Unavailable');
      }
    }
  });
  test('null is unavailable and explicit zero remains numeric', () => {
    expect(analyticsNumber(null, 'en', true)).toBe('Unavailable');
    expect(analyticsNumber(0, 'en', true)).toBe('$0.00');
    expect(analyticsNumber(0, 'en')).toBe('0');
    expect(analyticsNumber(Infinity, 'en')).toBe('Unavailable');
  });
  test('safe details expose authorized operational fields, never arbitrary payload fields', () => {
    const request = {
      ...analyticsUiRequest,
      raw_headers: 'SYNTHETIC_SECRET_SENTINEL',
      prompt: 'SYNTHETIC_PROMPT_SENTINEL',
      latency_ms: null,
    };
    const markup = renderToStaticMarkup(createElement(RequestDetails, { request }));
    for (const expected of [
      '192.0.2.10',
      'SyntheticBrowser/1.0',
      'synthetic-trace',
      'synthetic-parent',
      'synthetic-session',
      '/v1/messages',
      'Unavailable',
      'output tokens / full execution second',
    ])
      expect(markup).toContain(expected);
    expect(markup).not.toContain('SYNTHETIC_SECRET_SENTINEL');
    expect(markup).not.toContain('SYNTHETIC_PROMPT_SENTINEL');
  });
  test('request token nulls and presence metadata are rendered exactly as projected by the backend', () => {
    const request = {
      ...analyticsUiRequest,
      usage_presence: 'unknown' as const,
      input_tokens: null,
      output_tokens: 42,
      cache_read_tokens: null,
      cache_creation_tokens: null,
      reasoning_tokens: null,
      total_tokens: null,
      output_tokens_per_second: null,
    };
    const details = renderToStaticMarkup(createElement(RequestDetails, { request }));
    expect(details).toContain('Presence unknown');
    expect(details).toContain('synthetic-parent-execution');
    expect(details).toContain('First response offset');
    expect(details).toContain('<dd>150</dd>');
    expect(details).toContain('<dd>42</dd>');
    const markup = renderToStaticMarkup(
      createElement(RequestTable, {
        data: { ...analyticsUiResponse.requests, items: [request] },
        selected: null,
        onSelect: noop,
        onPrevious: noop,
        onNext: noop,
        canPrevious: false,
        canNext: false,
        page: 1,
      })
    );
    expect(markup).toContain('Unavailable / 42');
    expect(markup).toContain('Unavailable / Unavailable');
    expect(markup).toContain('Presence unknown');
    // A reported zero stays zero; the renderer does not re-qualify usage based on field flags.
    const reportedZero = renderToStaticMarkup(
      createElement(RequestDetails, {
        request: { ...request, usage_presence: 'reported', cache_creation_tokens: 0 },
      })
    );
    expect(reportedZero).toContain('<dd>0</dd>');
  });
  test('request table has bounded scrolling, operational details and server pagination', () => {
    const markup = renderToStaticMarkup(
      createElement(RequestTable, {
        data: analyticsUiResponse.requests,
        selected: analyticsUiRequest,
        onSelect: noop,
        onPrevious: noop,
        onNext: noop,
        canPrevious: false,
        canNext: true,
        page: 1,
      })
    );
    expect(markup).toContain('128 retained events');
    expect(markup).toContain('Page 1');
    expect(markup).toContain('aria-modal="true"');
    expect(markup).toContain('aria-label="Open event synthetic-event-2"');
    expect(markup).toContain('Explicit zero rate');
  });
  test('rates include unused unpriced registrations, source failures and expandable tier schedules', () => {
    const markup = renderToStaticMarkup(createElement(ModelRates, { data: analyticsUiResponse }));
    for (const expected of [
      'unused-unpriced-model',
      'Offline synthetic source',
      'Synthetic source',
      'billing-fixture',
      '200000',
      'fast',
      'USD per million tokens',
      'current configured model rates',
      'Unavailable',
    ])
      expect(markup).toContain(expected);
    expect(markup).toContain('<summary>Rate details</summary>');
  });
  test('charts preserve timestamp gaps and nulls, and render keyboard controls and data tables', () => {
    const data = [
      { key: 'a', label: 'Start', at: 0, value: 4 },
      { key: 'b', label: 'Missing measurement', at: 2000, value: null },
      { key: 'c', label: 'End', at: 3000, value: 0 },
    ];
    const bars = barGeometry(data, 0, 4000, 1000);
    expect(bars[1].x - bars[0].x).toBe(276);
    expect(bars[1].height).toBeNull();
    expect(bars[2].height).toBe(0);
    const markup = renderToStaticMarkup(
      createElement(AnalyticsChart, {
        title: 'Synthetic counts',
        data,
        from: 0,
        to: 4000,
        interval: 1000,
        onSelect: noop,
      })
    );
    expect(markup).toContain('role="button" tabindex="0"');
    expect(markup).toContain('aria-label="Missing measurement: Unavailable"');
    expect(markup).toContain('<table>');
    expect(markup).not.toContain('<path');
    expect(markup).not.toContain('<text'); // Labels do not shrink with the SVG viewBox on mobile.
  });
  test('empty charts and rates have explicit empty states', () => {
    expect(
      renderToStaticMarkup(createElement(AnalyticsChart, { title: 'Empty', data: [] }))
    ).toContain('No samples');
    expect(
      renderToStaticMarkup(
        createElement(ModelRates, { data: { ...analyticsUiResponse, rates: [] } })
      )
    ).toContain('No model rates');
  });
  test('all locale keys and interpolation placeholders match', () => {
    const flatten = (value: Record<string, unknown>, prefix = ''): Record<string, string> =>
      Object.fromEntries(
        Object.entries(value).flatMap(([key, child]) =>
          typeof child === 'string'
            ? [[prefix + key, child]]
            : Object.entries(flatten(child as Record<string, unknown>, `${prefix}${key}.`))
        )
      );
    const dictionaries = ['en', 'zh-CN', 'zh-TW', 'ru', 'vi', 'ko'].map((locale) =>
      flatten(JSON.parse(read(`src/i18n/locales/${locale}.json`)).analytics)
    );
    for (const dictionary of dictionaries) {
      expect(Object.keys(dictionary).sort()).toEqual(Object.keys(dictionaries[0]).sort());
      for (const [key, value] of Object.entries(dictionary)) {
        expect(value.trim()).not.toBe('');
        expect(value.match(/{{\w+}}/g)?.sort()).toEqual(
          dictionaries[0][key].match(/{{\w+}}/g)?.sort()
        );
      }
    }
    for (const tab of analyticsTabs) expect(dictionaries[0][`tabs.${tab}`]).toBeTruthy();
  });
});
