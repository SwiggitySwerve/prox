import { afterEach, describe, expect, spyOn, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildAccounts } from '../server/quota/accounts';
import { ResetClaimRefusal, ResetClaims } from '../server/quota/claims';
import { QuotaCollector, quotaSamples } from '../server/quota/collector';
import { buildDashboard, type DashboardOptions } from '../server/quota/domain';
import { planWeight } from '../server/quota/plans';
import { QuotaStore } from '../server/quota/store';
import { DAY_MS, HOUR_MS } from '../server/quota/types';
import { validateSourceManifest } from '../src/domain/providerSources/manifest';
import { laneOf, poolWindowId } from '../src/domain/quotaWindows/lanes';
import {
  readViewState,
  resolveViewProvider,
  visibleProviders,
} from '../src/features/quotaPool/model/viewState';
import {
  ANTIGRAVITY_CODE_ASSIST_URL,
  ANTIGRAVITY_QUOTA_URLS,
  CLAUDE_USAGE_URL,
} from '../src/utils/quota/constants';

const NOW = 1_800_000_000_000;
const SENTINEL = 'SYNTHETIC_PRIVATE_GEMINI_VALUE';
const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0).reverse()) cleanup();
});

function temporary() {
  const root = mkdtempSync(join(tmpdir(), 'prox-gemini-pool-'));
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  return root;
}

/** The live retrieveUserQuotaSummary shape (2026-11-21), values synthetic. */
function summary(geminiWeekly = 0.9, gemini5h = 0.75) {
  return {
    groups: [
      {
        displayName: 'Gemini Models',
        buckets: [
          {
            bucketId: 'gemini-weekly',
            displayName: 'Weekly Limit Remaining',
            window: 'weekly',
            resetTime: new Date(NOW + 5 * DAY_MS).toISOString(),
            remainingFraction: geminiWeekly,
          },
          {
            bucketId: 'gemini-5h',
            displayName: 'Five Hour Limit Remaining',
            window: '5h',
            resetTime: new Date(NOW + 2 * HOUR_MS).toISOString(),
            remainingFraction: gemini5h,
          },
        ],
      },
      {
        displayName: 'Claude and GPT models',
        buckets: [
          {
            bucketId: '3p-weekly',
            displayName: 'Weekly Limit Remaining',
            window: 'weekly',
            resetTime: new Date(NOW + 5 * DAY_MS).toISOString(),
            remainingFraction: 0.5,
          },
          {
            bucketId: '3p-5h',
            displayName: 'Five Hour Limit Remaining',
            window: '5h',
            resetTime: new Date(NOW + 2 * HOUR_MS).toISOString(),
            remainingFraction: 1,
          },
        ],
      },
    ],
  };
}

function fixture() {
  const root = temporary();
  const source = (instanceId: string, providers: string[]) => {
    const managementKeyFile = join(root, `${instanceId}.key`);
    writeFileSync(managementKeyFile, `synthetic-key-${instanceId}`);
    return {
      instanceId,
      label: `Label ${instanceId}`,
      publicBasePath: `/${instanceId}`,
      aliases: [],
      authScope: 'shared',
      providers,
      upstreamOrigin: `http://${instanceId}.invalid`,
      managementKeyFile,
    };
  };
  const manifest = validateSourceManifest({
    schemaVersion: 1,
    defaultInstanceId: 'claude-src',
    history: { upstreamOrigin: 'http://history.invalid', managementKeyFile: join(root, 'x.key') },
    sources: [source('claude-src', ['claude']), source('gemini-src', ['antigravity'])],
  });
  const inventories = new Map<string, unknown>([
    [
      'claude-src',
      {
        files: [
          {
            provider: 'claude',
            type: 'claude',
            auth_index: 'claude-index',
            name: 'claude.json',
            email: 'claude@example.test',
            disabled: false,
          },
        ],
      },
    ],
    [
      'gemini-src',
      {
        files: [
          {
            provider: 'antigravity',
            type: 'antigravity',
            auth_index: 'gemini-index',
            name: 'antigravity.json',
            email: 'gemini@example.test',
            disabled: false,
            project_id: 'synthetic-project',
            metadata: { access_token: SENTINEL },
          },
        ],
      },
    ],
  ]);
  const calls: { instanceId: string; body?: Record<string, unknown> }[] = [];
  let quota: unknown = summary();
  let tier = 'g1-ultra-lite-tier';
  const fetcher = Object.assign(
    async (input: string | URL | Request, init: RequestInit = {}) => {
      const url = new URL(input instanceof Request ? input.url : input.toString());
      const instanceId = url.hostname.replace('.invalid', '');
      const body = init.body ? JSON.parse(String(init.body)) : undefined;
      calls.push({ instanceId, body });
      if (!body) return Response.json(inventories.get(instanceId));
      if (body.url === ANTIGRAVITY_QUOTA_URLS[0])
        return Response.json({ status_code: 200, body: JSON.stringify(quota) });
      if (body.url === ANTIGRAVITY_CODE_ASSIST_URL)
        return Response.json({
          status_code: 200,
          body: { paidTier: { id: tier, name: 'Google AI Ultra' } },
        });
      if (body.url === `${CLAUDE_USAGE_URL}?cedar_ember=1&skip_spend=1`)
        return Response.json({
          status_code: 200,
          body: {
            seven_day: { utilization: 20, resets_at: new Date(NOW + DAY_MS).toISOString() },
            five_hour: { utilization: 20, resets_at: new Date(NOW + HOUR_MS).toISOString() },
          },
        });
      return Response.json({ status_code: 404, body: '' });
    },
    { preconnect: () => {} }
  ) satisfies typeof fetch;
  const store = new QuotaStore(':memory:');
  cleanups.push(() => store.close());
  const collector = new QuotaCollector(store, {
    sources: manifest.sources,
    revision: 'synthetic-revision',
    fetcher,
    now: () => NOW,
  });
  cleanups.push(() => collector.stop());
  const options: DashboardOptions = {
    nowMs: NOW,
    window: 'weekly',
    lookbackHours: 3,
    multiplier: 1,
    offsetDays: 0,
    reveal: false,
  };
  const dashboard = (window: DashboardOptions['window'] = 'weekly') =>
    buildDashboard(
      store.listAccounts(),
      store.listSamples(0, NOW),
      { ...options, window },
      {
        historyStartedAtMs: NOW,
        lastRefreshAtMs: NOW,
        nextRefreshAtMs: NOW,
        refreshing: false,
        issues: collector.issues,
        sources: collector.sources,
        windows: collector.windows,
      }
    );
  return {
    store,
    collector,
    calls,
    dashboard,
    setQuota: (value: unknown) => (quota = value),
    setTier: (value: string) => (tier = value),
  };
}

describe('Gemini (Antigravity) in the quota pool', () => {
  test('an Antigravity source is collected and pooled with its Gemini windows and Ultra weight', async () => {
    const f = fixture();
    await f.collector.refresh();

    // The Gemini hub is inventoried for Antigravity only; the Claude hub never for Antigravity.
    expect(
      f.collector.inventorySources.map(({ instanceId, provider }) => [instanceId, provider])
    ).toEqual([
      ['claude-src', 'claude'],
      ['claude-src', 'codex'],
      ['gemini-src', 'antigravity'],
    ]);
    const quotaCall = f.calls.find((call) => call.body?.url === ANTIGRAVITY_QUOTA_URLS[0])!;
    expect(quotaCall.instanceId).toBe('gemini-src');
    expect(quotaCall.body).toMatchObject({
      authIndex: 'gemini-index',
      method: 'POST',
      data: JSON.stringify({ project: 'synthetic-project' }),
    });
    expect(f.collector.issues).toEqual([]);

    const weekly = f.dashboard('weekly');
    const pool = weekly.pools.find((entry) => entry.provider === 'antigravity')!;
    expect(pool.instanceId).toBe('gemini-src');
    expect(pool.accountCount).toBe(1);
    // The fixture account is Ultra Lite: 5 base plans.
    expect(pool.capacityPoints).toBe(500);
    expect(pool.remainingPoints).toBeCloseTo(450, 6);
    const [account] = pool.accounts;
    expect(account.label).toBe('Gemini 1');
    expect(account.plan).toEqual({ label: 'Ultra Lite', capacityPoints: 500, known: true });
    expect(account.status).toBe('ok');
    // The Claude and GPT group rides along as its own namespaced window, never in the pool balance.
    expect(account.windows.map((window) => [window.id, laneOf('antigravity', window.id)])).toEqual([
      ['five-hour', 'five-hour'],
      ['weekly', 'weekly'],
      ['claude-and-gpt-models:3p-5h', 'model'],
      ['claude-and-gpt-models:3p-weekly', 'model'],
    ]);
    expect(weekly.combined?.antigravity?.series?.capacityPoints).toBe(500);
    expect(weekly.combined?.all.series?.capacityPoints).toBe(500 + 100);

    const fiveHour = f.dashboard('five-hour');
    expect(
      fiveHour.pools.find((entry) => entry.provider === 'antigravity')!.remainingPoints
    ).toBeCloseTo(375, 6);
    // No empty Gemini card beside the Claude hub, and no Claude card beside the Gemini hub.
    expect(weekly.pools.map((entry) => [entry.instanceId, entry.provider])).toEqual([
      ['claude-src', 'claude'],
      ['gemini-src', 'antigravity'],
    ]);
    expect(JSON.stringify(weekly)).not.toContain(SENTINEL);
  });

  test('a reading without the Gemini group records explicit missing windows, not zero', () => {
    const { samples } = quotaSamples(
      'antigravity',
      'account',
      { groups: [summary().groups[1]] },
      NOW
    );
    expect(samples.map((s) => [s.window, s.remainingPercent])).toEqual([
      ['weekly', null],
      ['five-hour', null],
    ]);
    expect(() => quotaSamples('antigravity', 'account', { nope: true }, NOW)).toThrow();
    expect(poolWindowId('antigravity', 'weekly')).toBe('weekly');
    expect(poolWindowId('antigravity', 'five-hour')).toBe('five-hour');
  });

  test('non-Gemini buckets cannot collide with Gemini pool ids even if named gemini-weekly or weekly', () => {
    const colliding = {
      groups: [
        {
          displayName: 'Claude and GPT models',
          buckets: [
            {
              bucketId: 'gemini-weekly',
              displayName: 'Weekly Limit Remaining',
              window: 'weekly',
              resetTime: new Date(NOW + 5 * DAY_MS).toISOString(),
              remainingFraction: 0.31,
            },
            {
              bucketId: 'weekly',
              displayName: 'Weekly Limit Remaining',
              window: 'weekly',
              resetTime: new Date(NOW + 5 * DAY_MS).toISOString(),
              remainingFraction: 0.31,
            },
            {
              bucketId: 'five-hour',
              displayName: 'Five Hour Limit Remaining',
              window: '5h',
              resetTime: new Date(NOW + 2 * HOUR_MS).toISOString(),
              remainingFraction: 0.31,
            },
          ],
        },
        {
          displayName: 'Gemini Models',
          buckets: [
            {
              bucketId: 'weekly',
              displayName: 'Unrecognized Weekly',
              window: 'weekly',
              resetTime: new Date(NOW + 5 * DAY_MS).toISOString(),
              remainingFraction: 0.25,
            },
            {
              bucketId: 'toString',
              displayName: 'Inherited Key Bucket',
              window: 'weekly',
              resetTime: new Date(NOW + 5 * DAY_MS).toISOString(),
              remainingFraction: 0.4,
            },
          ],
        },
        {
          displayName: 'Claude and GPT models',
          buckets: [
            {
              bucketId: 'toString',
              displayName: 'Inherited Key Third Party',
              window: 'weekly',
              resetTime: new Date(NOW + 5 * DAY_MS).toISOString(),
              remainingFraction: 0.5,
            },
          ],
        },
      ],
    };
    const { samples, windows } = quotaSamples('antigravity', 'account', colliding, NOW);
    expect(samples.map((s) => [s.window, s.remainingPercent])).toEqual([
      ['weekly', null],
      ['five-hour', null],
    ]);
    expect(windows.map((w) => [w.id, laneOf('antigravity', w.id)])).toEqual([
      ['claude-and-gpt-models:five-hour', 'model'],
      ['claude-and-gpt-models:gemini-weekly', 'model'],
      ['claude-and-gpt-models:weekly', 'model'],
      ['gemini-models:toString', 'model'],
      ['gemini-models:weekly', 'model'],
      ['claude-and-gpt-models:toString', 'model'],
    ]);
    // Inherited object keys must stay plain strings and survive JSON serialization intact.
    const serialized = JSON.parse(JSON.stringify(windows)) as typeof windows;
    expect(serialized.every((w) => typeof w.id === 'string' && typeof w.labelKey === 'string')).toBe(
      true
    );
  });

  test('malformed 200 and transport errors fall through to the next Antigravity endpoint, while abort stops', async () => {
    const makeCollector = (
      handler: (url: string, signal?: AbortSignal) => Promise<Response> | Response
    ) => {
      const root = temporary();
      const managementKeyFile = join(root, 'gemini.key');
      writeFileSync(managementKeyFile, 'synthetic-key-gemini');
      const manifest = validateSourceManifest({
        schemaVersion: 1,
        defaultInstanceId: 'gemini-src',
        history: { upstreamOrigin: 'http://history.invalid', managementKeyFile },
        sources: [
          {
            instanceId: 'gemini-src',
            label: 'Gemini',
            publicBasePath: '/gemini',
            aliases: [],
            authScope: 'shared',
            providers: ['antigravity'],
            upstreamOrigin: 'http://gemini-src.invalid',
            managementKeyFile,
          },
        ],
      });
      const attempted: string[] = [];
      const fetcher = Object.assign(
        async (_input: string | URL | Request, init: RequestInit = {}) => {
          const body = init.body ? JSON.parse(String(init.body)) : undefined;
          if (!body) {
            return Response.json({
              files: [
                {
                  provider: 'antigravity',
                  type: 'antigravity',
                  auth_index: 'gemini-index',
                  name: 'antigravity.json',
                  email: 'gemini@example.test',
                  disabled: false,
                  project_id: 'synthetic-project',
                },
              ],
            });
          }
          if (body.url === ANTIGRAVITY_CODE_ASSIST_URL) {
            return Response.json({
              status_code: 200,
              body: { paidTier: { id: 'g1-ultra-tier', name: 'Google AI Ultra' } },
            });
          }
          attempted.push(String(body.url));
          return handler(String(body.url), init.signal ?? undefined);
        },
        { preconnect: () => {} }
      ) satisfies typeof fetch;
      const store = new QuotaStore(':memory:');
      cleanups.push(() => store.close());
      const collector = new QuotaCollector(store, {
        sources: manifest.sources,
        revision: 'synthetic-revision',
        fetcher,
        now: () => NOW,
      });
      cleanups.push(() => collector.stop());
      return { store, collector, attempted };
    };

    // Case 1: invalid HTTP 200 on first endpoint (including malformed nested group/buckets) falls through.
    const malformed = makeCollector((url) =>
      url === ANTIGRAVITY_QUOTA_URLS[0]
        ? Response.json({
            status_code: 200,
            body: JSON.stringify({ groups: [{ displayName: 'Gemini Models', buckets: {} }] }),
          })
        : Response.json({ status_code: 200, body: JSON.stringify(summary(0.8, 0.6)) })
    );
    await malformed.collector.refresh();
    expect(malformed.attempted).toEqual(ANTIGRAVITY_QUOTA_URLS.slice(0, 2));
    expect(malformed.collector.issues).toEqual([]);
    expect(malformed.store.listSamples(0, NOW).find((s) => s.window === 'weekly')?.remainingPercent)
      .toBeCloseTo(80, 6);

    // Case 1b: a bare "%" fraction is malformed and falls through to the next endpoint instead of recording 0%.
    const barePercent = makeCollector((url) =>
      url === ANTIGRAVITY_QUOTA_URLS[0]
        ? Response.json({
            status_code: 200,
            body: JSON.stringify({
              groups: [
                {
                  displayName: 'Gemini Models',
                  buckets: [
                    {
                      bucketId: 'gemini-weekly',
                      window: 'weekly',
                      remainingFraction: '%',
                    },
                  ],
                },
              ],
            }),
          })
        : Response.json({ status_code: 200, body: JSON.stringify(summary(0.85, 0.65)) })
    );
    await barePercent.collector.refresh();
    expect(barePercent.attempted).toEqual(ANTIGRAVITY_QUOTA_URLS.slice(0, 2));
    expect(barePercent.collector.issues).toEqual([]);
    expect(barePercent.store.listSamples(0, NOW).find((s) => s.window === 'weekly')?.remainingPercent)
      .toBeCloseTo(85, 6);

    // Case 1c: unpersistable or out-of-Date-range resetTime falls through for both pooled and model windows.
    for (const [resetTime, modelWindow] of [
      ['1e20', false],
      ['8640000000000001', false],
      ['8640000000000001', true],
    ] as const) {
      const badReset = makeCollector((url) =>
        url === ANTIGRAVITY_QUOTA_URLS[0]
          ? Response.json({
              status_code: 200,
              body: JSON.stringify({
                groups: modelWindow
                  ? [
                      summary().groups[0],
                      {
                        displayName: 'Claude and GPT models',
                        buckets: [
                          {
                            bucketId: '3p-weekly',
                            window: 'weekly',
                            resetTime,
                            remainingFraction: 0.5,
                          },
                        ],
                      },
                    ]
                  : [
                      {
                        displayName: 'Gemini Models',
                        buckets: [
                          {
                            bucketId: 'gemini-weekly',
                            window: 'weekly',
                            resetTime,
                            remainingFraction: 0.9,
                          },
                        ],
                      },
                    ],
              }),
            })
          : Response.json({ status_code: 200, body: JSON.stringify(summary(0.72, 0.52)) })
      );
      await badReset.collector.refresh();
      expect(badReset.attempted).toEqual(ANTIGRAVITY_QUOTA_URLS.slice(0, 2));
      expect(badReset.collector.issues).toEqual([]);
      expect(
        badReset.store.listSamples(0, NOW).find((s) => s.window === 'weekly')?.remainingPercent
      ).toBeCloseTo(72, 6);
    }

    // Case 1d: duplicate pooled window IDs with conflicting balances are rejected and fall through.
    const duplicatePool = makeCollector((url) =>
      url === ANTIGRAVITY_QUOTA_URLS[0]
        ? Response.json({
            status_code: 200,
            body: JSON.stringify({
              groups: [
                {
                  displayName: 'Gemini Models',
                  buckets: [
                    {
                      bucketId: 'gemini-weekly',
                      window: 'weekly',
                      resetTime: new Date(NOW + 5 * DAY_MS).toISOString(),
                      remainingFraction: 0.9,
                    },
                    {
                      bucketId: 'gemini-weekly',
                      window: 'weekly',
                      resetTime: new Date(NOW + 5 * DAY_MS).toISOString(),
                      remainingFraction: 0.2,
                    },
                  ],
                },
              ],
            }),
          })
        : Response.json({ status_code: 200, body: JSON.stringify(summary(0.64, 0.44)) })
    );
    await duplicatePool.collector.refresh();
    expect(duplicatePool.attempted).toEqual(ANTIGRAVITY_QUOTA_URLS.slice(0, 2));
    expect(duplicatePool.collector.issues).toEqual([]);
    expect(
      duplicatePool.store.listSamples(0, NOW).find((s) => s.window === 'weekly')?.remainingPercent
    ).toBeCloseTo(64, 6);

    // Malformed bucket fractions also fail validation instead of recording missing or zero observations.
    for (const badFraction of ['bad', '%', '  % ', 1.5]) {
      expect(() =>
        quotaSamples(
          'antigravity',
          'account',
          {
            groups: [
              {
                displayName: 'Gemini Models',
                buckets: [{ bucketId: 'gemini-weekly', remainingFraction: badFraction }],
              },
            ],
          },
          NOW
        )
      ).toThrow();
    }

    // Case 2: transport error on first endpoint falls through to valid second endpoint.
    const transport = makeCollector((url) => {
      if (url === ANTIGRAVITY_QUOTA_URLS[0]) throw new Error('upstream reset');
      return Response.json({ status_code: 200, body: JSON.stringify(summary(0.7, 0.5)) });
    });
    await transport.collector.refresh();
    expect(transport.attempted).toEqual(ANTIGRAVITY_QUOTA_URLS.slice(0, 2));
    expect(transport.collector.issues).toEqual([]);
    expect(transport.store.listSamples(0, NOW).find((s) => s.window === 'weekly')?.remainingPercent)
      .toBeCloseTo(70, 6);

    // Case 2b: a daily host can answer 200 with only the Claude/GPT group. That is not a missing
    // Gemini pool: the next endpoint is asked, and its Gemini windows are recorded.
    const thirdPartyOnly = () => ({ groups: summary().groups.slice(1) });
    const partial = makeCollector((url) =>
      url === ANTIGRAVITY_QUOTA_URLS[0]
        ? Response.json({ status_code: 200, body: JSON.stringify(thirdPartyOnly()) })
        : Response.json({
            status_code: 200,
            body: JSON.stringify({ groups: summary(0.6, 0.4).groups.slice(0, 1) }),
          })
    );
    await partial.collector.refresh();
    expect(partial.attempted).toEqual(ANTIGRAVITY_QUOTA_URLS.slice(0, 2));
    expect(partial.collector.issues).toEqual([]);
    const partialSamples = partial.store.listSamples(0, NOW);
    expect(partialSamples.find((s) => s.window === 'weekly')?.remainingPercent).toBeCloseTo(60, 6);
    expect(partialSamples.find((s) => s.window === 'five-hour')?.remainingPercent).toBeCloseTo(
      40,
      6
    );
    // The Claude/GPT windows of the first answer are kept beside the Gemini ones.
    const partialAccount = partial.store.listAccounts()[0]!;
    expect(
      (partial.collector.windows.get(partialAccount.id) ?? []).map((window) => window.id).sort()
    ).toEqual([
      'claude-and-gpt-models:3p-5h',
      'claude-and-gpt-models:3p-weekly',
      'five-hour',
      'weekly',
    ]);

    // Case 2c: no endpoint has a Gemini group, so the Claude/GPT answer stands and the pool
    // windows are recorded as missing, as before.
    const noGemini = makeCollector(() =>
      Response.json({ status_code: 200, body: JSON.stringify(thirdPartyOnly()) })
    );
    await noGemini.collector.refresh();
    expect(noGemini.attempted).toEqual(ANTIGRAVITY_QUOTA_URLS);
    expect(noGemini.collector.issues).toEqual([]);
    expect(
      noGemini.store.listSamples(0, NOW).find((s) => s.window === 'weekly')?.remainingPercent
    ).toBeNull();

    // Case 3: stopping/aborting during the first endpoint does not attempt the second.
    let releaseFirst!: () => void;
    const firstReached = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const aborted = makeCollector(async (_url, signal) => {
      releaseFirst();
      await new Promise((_resolve, reject) => {
        signal?.addEventListener('abort', () => reject(new Error('Aborted')), { once: true });
      });
      return Response.json({ status_code: 200, body: JSON.stringify(summary()) });
    });
    const refreshPromise = aborted.collector.refresh().catch(() => {});
    await firstReached;
    aborted.collector.stop();
    await refreshPromise;
    expect(aborted.attempted).toEqual([ANTIGRAVITY_QUOTA_URLS[0]]);

    // Case 4: failed Gemini poll logs status, retry-after and header names without any account suffix.
    const failed = makeCollector(() =>
      Response.json({
        status_code: 429,
        header: { 'Retry-After': ['45'], 'X-Secret-Cookie': [SENTINEL] },
        body: '',
      })
    );
    const logged = spyOn(console, 'error').mockImplementation(() => {});
    await failed.collector.refresh();
    const lines = logged.mock.calls.map((call) => call.join(' '));
    logged.mockRestore();
    const geminiAccount = failed.store.listAccounts()[0]!;
    expect(lines).toContainEqual(
      'Quota request failed: antigravity 429 retry-after=45 headers=retry-after,x-secret-cookie'
    );
    expect(lines.join('\n')).not.toContain('account=');
    expect(lines.join('\n')).not.toContain(geminiAccount.id.slice(-8));
    expect(lines.join('\n')).not.toContain(SENTINEL);
  });

  test('Google AI Ultra counts 2000 points, Ultra Lite 500; other tiers stay unknown', () => {
    expect(planWeight('antigravity', 'g1-ultra-tier')).toEqual({
      multiplier: 20,
      label: 'Ultra',
      known: true,
    });
    // Ultra Lite is the lower tier (user direction, 21 Nov 2026): 5 base plans, like Claude Max.
    expect(planWeight('antigravity', 'g1-ultra-lite-tier')).toEqual({
      multiplier: 5,
      label: 'Ultra Lite',
      known: true,
    });
    expect(planWeight('antigravity', 'g1-pro-tier')).toEqual({
      multiplier: 1,
      label: 'g1-pro-tier',
      known: false,
    });
  });

  test('/v1/accounts still serves only Claude and Codex accounts', async () => {
    const f = fixture();
    await f.collector.refresh();
    const body = buildAccounts({
      accounts: f.store.listAccounts(),
      latestSamples: f.store.latestSamples(),
      windows: f.collector.windows,
      resets: f.collector.resets,
      billing: f.collector.billing,
      balances: f.collector.balances,
      nowMs: NOW,
      reveal: false,
      collection: { lastRefreshAtMs: NOW, nextRefreshAtMs: NOW, refreshing: false },
    });
    expect(body.accounts.map((account) => account.provider)).toEqual(['claude']);
  });

  test('a reset claim on a Gemini account is refused before anything is sent', async () => {
    const f = fixture();
    await f.collector.refresh();
    const account = f.store.listAccounts().find((entry) => entry.provider === 'antigravity')!;
    const sent = f.calls.length;
    const claims = new ResetClaims({ store: f.store, collector: f.collector, now: () => NOW });
    const refusal = await claims
      .claim({ accountId: account.id, clientRequestId: 'synthetic-request' })
      .catch((error: unknown) => error);
    expect(refusal).toBeInstanceOf(ResetClaimRefusal);
    expect((refusal as ResetClaimRefusal).httpStatus).toBe(400);
    expect(f.calls.length).toBe(sent);
    expect(f.store.listResetEvents({})).toEqual([]);
  });
});

describe('quota_accounts provider constraint migration', () => {
  test('an existing claude/codex-only database accepts Antigravity and keeps every row', () => {
    const path = join(temporary(), 'quota.sqlite');
    const db = new Database(path);
    // The schema as shipped before Antigravity joined the pool.
    db.exec(`
      PRAGMA foreign_keys = ON;
      CREATE TABLE quota_accounts (
        id TEXT PRIMARY KEY,
        provider TEXT NOT NULL CHECK (provider IN ('claude', 'codex')),
        name TEXT NOT NULL, email TEXT,
        disabled INTEGER NOT NULL CHECK (disabled IN (0, 1)),
        retired INTEGER NOT NULL CHECK (retired IN (0, 1)),
        lastSeenAtMs INTEGER NOT NULL, lastErrorAtMs INTEGER, retiredAtMs INTEGER
      );
      CREATE INDEX quota_accounts_provider ON quota_accounts(provider);
      CREATE TABLE quota_samples (
        accountId TEXT NOT NULL REFERENCES quota_accounts(id),
        window TEXT NOT NULL, observedAtMs INTEGER NOT NULL, remainingPercent REAL,
        resetAtMs INTEGER, periodHours REAL, PRIMARY KEY (accountId, window, observedAtMs)
      );
      CREATE TABLE quota_account_sources (
        accountId TEXT PRIMARY KEY REFERENCES quota_accounts(id),
        instanceId TEXT NOT NULL, sourceAccountId TEXT NOT NULL UNIQUE
      );
      CREATE TABLE quota_account_plans (
        accountId TEXT PRIMARY KEY REFERENCES quota_accounts(id),
        plan TEXT NOT NULL, observedAtMs INTEGER NOT NULL
      );
      INSERT INTO quota_accounts VALUES ('c1', 'claude', 'c.json', 'c@example.test', 0, 0, ${NOW}, NULL, NULL);
      INSERT INTO quota_samples VALUES ('c1', 'weekly', ${NOW}, 80, ${NOW + DAY_MS}, 168);
      INSERT INTO quota_account_sources VALUES ('c1', 'claude-src', 'claude-src:c1');
      INSERT INTO quota_account_plans VALUES ('c1', 'default_claude_max', ${NOW});
    `);
    db.close();

    for (let open = 0; open < 2; open += 1) {
      const store = new QuotaStore(path, () => NOW);
      store.recordInventory(
        'antigravity',
        [
          {
            id: 'gemini-src:antigravity:g1',
            provider: 'antigravity',
            instanceId: 'gemini-src',
            name: 'g.json',
            email: null,
            disabled: false,
            retired: false,
            lastSeenAtMs: NOW,
            lastErrorAtMs: null,
          },
        ],
        NOW,
        'gemini-src'
      );
      expect(store.listAccounts().map((a) => [a.id, a.provider, a.plan ?? null])).toEqual([
        ['gemini-src:antigravity:g1', 'antigravity', null],
        ['c1', 'claude', 'default_claude_max'],
      ]);
      expect(store.listSamples(0, NOW).map((s) => s.accountId)).toEqual(['c1']);
      store.close();
    }
    const check = new Database(path, { readonly: true });
    expect(check.query('PRAGMA foreign_key_check').all()).toEqual([]);
    expect(
      check
        .query<{ name: string }, []>(
          "SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'quota_accounts'"
        )
        .all()
        .map((row) => row.name)
    ).toContain('quota_accounts_provider');
    const migratedCols = check.query('PRAGMA table_info(quota_accounts)').all();
    const migratedSql = check
      .query<{ sql: string }, []>(
        "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'quota_accounts'"
      )
      .get()?.sql;
    check.close();

    // Fresh and migrated databases share the exact same table definition.
    const freshPath = join(temporary(), 'fresh.sqlite');
    const freshStore = new QuotaStore(freshPath, () => NOW);
    freshStore.close();
    const freshCheck = new Database(freshPath, { readonly: true });
    expect(migratedCols).toEqual(freshCheck.query('PRAGMA table_info(quota_accounts)').all());
    const normalizeSql = (sql: string | undefined) =>
      sql?.replace('"quota_accounts"', 'quota_accounts').replace(/\s+/g, ' ').trim();
    expect(normalizeSql(migratedSql)).toBe(
      normalizeSql(
        freshCheck
          .query<{ sql: string }, []>(
            "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'quota_accounts'"
          )
          .get()?.sql
      )
    );
    freshCheck.close();
  });
});

describe('Quota Management view state', () => {
  test('a link can select the Gemini pool, and installations without Gemini hide it and fall back', () => {
    expect(readViewState(new URLSearchParams('provider=antigravity')).provider).toBe('antigravity');
    const withoutGemini = visibleProviders([{ provider: 'claude' }, { provider: 'codex' }]);
    const withGemini = visibleProviders([{ provider: 'claude' }, { provider: 'antigravity' }]);
    expect(withoutGemini).toEqual(['all', 'claude', 'codex']);
    expect(withGemini).toEqual(['all', 'claude', 'codex', 'antigravity']);
    expect(resolveViewProvider('antigravity', withoutGemini)).toBe('all');
    expect(resolveViewProvider('antigravity', withGemini)).toBe('antigravity');
  });
});
