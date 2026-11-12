/**
 * The credential flow, end to end: the real UI, the real prox-history (store, collector, routes)
 * and two fake CLI-Proxy instances. Each scenario opens several screens in separate tabs of one
 * browser, changes credentials, and asserts that every screen shows the same membership.
 */
import type { BrowserContext, Page } from '@playwright/test';
import { expect, test, type CredentialFlow } from './credentialFlowHarness';

const KNOWN = ['alice', 'bob', 'carol', 'dave', 'erin'];
interface Model {
  codex: string[];
  claude: string[];
}
const START: Model = { codex: ['alice', 'bob'], claude: ['carol', 'dave'] };

const lines = async (page: Page) =>
  (await page.locator('body').innerText())
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
const badgeOf = (all: string[]) => {
  const label = all.find((line) => /^Authentication files: \d+$/.test(line));
  return label ? Number(label.split(': ')[1]) : null;
};
const numberAfter = (all: string[], anchor: string, offset: number) =>
  Number(all[all.indexOf(anchor) + offset]);

/** What each screen currently says about credentials, reduced to comparable facts. */
const reading = {
  files: async (page: Page) => {
    const all = await lines(page);
    return { badge: badgeOf(all), names: KNOWN.filter((name) => all.includes(name)) };
  },
  accounts: async (page: Page) => {
    const all = await lines(page);
    return { badge: badgeOf(all), names: KNOWN.filter((name) => all.includes(`${name}.json`)) };
  },
  pools: async (page: Page) => {
    const all = await lines(page);
    // "All pools", then the Claude chip and its count, then the Codex chip and its count.
    return {
      badge: badgeOf(all),
      claude: numberAfter(all, 'All pools', 2),
      codex: numberAfter(all, 'All pools', 4),
    };
  },
  dashboard: async (page: Page) => {
    const all = await lines(page);
    return {
      badge: badgeOf(all),
      total: numberAfter(all, 'Credentials', 1),
      // Each fleet row is the provider name, then "Credentials: n". Rows reorder with their data.
      fleet: Object.fromEntries(
        all.flatMap((line, index) =>
          /^Credentials: \d+$/.test(line)
            ? [[all[index - 1].toLowerCase(), Number(line.slice(13))]]
            : []
        )
      ),
    };
  },
  excluded: async (page: Page) => ({ badge: badgeOf(await lines(page)) }),
};
type Screen = keyof typeof reading;
const expected = (model: Model): Record<Screen, unknown> => {
  const total = model.codex.length + model.claude.length;
  const names = [...model.codex, ...model.claude].sort(
    (a, b) => KNOWN.indexOf(a) - KNOWN.indexOf(b)
  );
  return {
    files: { badge: total, names },
    accounts: { badge: total, names },
    pools: { badge: total, claude: model.claude.length, codex: model.codex.length },
    dashboard: {
      badge: total,
      total,
      fleet: { claude: model.claude.length, codex: model.codex.length },
    },
    excluded: { badge: total },
  };
};

const ROUTES: Record<Screen | 'providers' | 'analytics', string> = {
  files: '/auth-files',
  accounts: '/quota/accounts',
  pools: '/quota',
  dashboard: '/dashboard',
  // Exclusion lists moved to the Models screen's Rules tab; the old path now only redirects there.
  excluded: '/auth-files/models?tab=rules',
  providers: '/ai-providers',
  analytics: '/analytics',
};
type Tabs = Record<keyof typeof ROUTES, Page>;

async function openAll(flow: CredentialFlow, context: BrowserContext): Promise<Tabs> {
  const tabs = {} as Tabs;
  for (const [screen, hash] of Object.entries(ROUTES)) {
    tabs[screen as keyof typeof ROUTES] = await flow.open(context, hash);
  }
  // Analytics is canned, so only its own load state matters here.
  await expect(tabs.analytics.locator('#analytics-panel')).toHaveAttribute('aria-busy', 'false', {
    timeout: 30_000,
  });
  return tabs;
}
const analyticsText = (tabs: Tabs) => tabs.analytics.locator('#analytics-panel').innerText();
const providersText = (tabs: Tabs) => tabs.providers.getByRole('main').innerText();

async function screens(tabs: Tabs) {
  const out = {} as Record<Screen, unknown>;
  for (const screen of Object.keys(reading) as Screen[])
    out[screen] = await reading[screen](tabs[screen]);
  return out;
}
/** Every screen agrees with the model, and `within` says how soon. */
async function expectEveryScreen(tabs: Tabs, model: Model, within = 8000) {
  await expect
    .poll(() => screens(tabs), { timeout: within, intervals: [100] })
    .toEqual(expected(model));
}

const deleteButton = (page: Page, name: string) =>
  page.locator(
    `xpath=//*[normalize-space(text())="${name}"]/ancestor::*[.//button[@title="Delete"]][1]//button[@title="Delete"]`
  );
async function removeInProx(page: Page, name: string) {
  await deleteButton(page, name).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Confirm' }).click();
}
async function uploadToClaude(page: Page, name: string, email: string) {
  const claudeSection = page.locator('input[type=file]').nth(1);
  await claudeSection.setInputFiles({
    name,
    mimeType: 'application/json',
    buffer: Buffer.from(JSON.stringify({ type: 'claude', email })),
  });
}
const live = async (flow: CredentialFlow) =>
  (await flow.state()).accounts
    .filter((account) => !account.retired)
    .map((a) => a.name)
    .sort();

// Seven tabs of the real app per scenario, the first of them cold-compiling its routes.
test.describe.configure({ timeout: 150_000 });

test('remove: every screen updates at once, the same-email credential on the other provider stays, Analytics is unchanged', async ({
  flow,
  context,
}) => {
  await flow.collect();
  const tabs = await openAll(flow, context);
  await expectEveryScreen(tabs, START, 30_000);
  const analyticsBefore = await analyticsText(tabs);
  const providersBefore = await providersText(tabs);
  const queriesBefore = flow.analytics.length;

  const started = Date.now();
  await removeInProx(tabs.files, 'alice');
  const after: Model = { codex: ['bob'], claude: ['carol', 'dave'] };
  // Well inside the 5 s poll: the other tabs were pushed, not polled.
  await expectEveryScreen(tabs, after, 4000);
  expect(Date.now() - started).toBeLessThan(4500);

  // carol shares alice's email but belongs to the other provider: she is still everywhere.
  await expect(tabs.files.getByText('shared@example.test')).toHaveCount(1);
  expect(await analyticsText(tabs)).toBe(analyticsBefore);
  expect(await providersText(tabs)).toBe(providersBefore);
  expect(flow.analytics.length).toBe(queriesBefore); // nothing asked Analytics to look again

  // The user deleted alice by name and the inventory confirmed it: her rows are gone now, not
  // after the 24 h grace. Nobody else was touched.
  const state = await flow.state();
  expect(state.accounts.find((account) => account.name === 'alice.json')).toBeUndefined();
  expect(state.accounts.every((account) => !account.retired)).toBe(true);
  expect(await live(flow)).toEqual(['bob.json', 'carol.json', 'dave.json']);
});

test('add: every screen shows the new credential at once, and the server polls it once', async ({
  flow,
  context,
}) => {
  await flow.collect();
  const tabs = await openAll(flow, context);
  await expectEveryScreen(tabs, START, 30_000);
  const providersBefore = await providersText(tabs);
  const usageBefore = (await flow.state()).usageCalls;

  await uploadToClaude(tabs.files, 'erin.json', 'erin@example.test');
  const after: Model = { codex: ['alice', 'bob'], claude: ['carol', 'dave', 'erin'] };
  await expectEveryScreen(tabs, after, 4000);
  expect(await providersText(tabs)).toBe(providersBefore);

  expect(await live(flow)).toEqual([
    'alice.json',
    'bob.json',
    'carol.json',
    'dave.json',
    'erin.json',
  ]);
  // The new account got its own first poll without waiting for the next collection.
  await expect
    .poll(async () => (await flow.state()).usageCalls - usageBefore)
    .toBeGreaterThanOrEqual(1);
});

test('external change: a credential added or removed outside Prox is found by the poll', async ({
  flow,
  context,
}) => {
  await flow.collect();
  const tabs = await openAll(flow, context);
  await expectEveryScreen(tabs, START, 30_000);
  const providersBefore = await providersText(tabs);

  await flow.removeOutside('codex', 'bob.json');
  await flow.advanceServerClock(10_000); // prox-history's last read is now stale
  const gone: Model = { codex: ['alice'], claude: ['carol', 'dave'] };
  await expectEveryScreen(tabs, gone, 9000); // one 5 s poll, with room
  // Absence alone only scrubs and hides; the rows wait out the 24 h grace.
  const retired = (await flow.state()).accounts.find((account) => account.name === 'retired');
  expect(retired).toMatchObject({ retired: true, email: null, provider: 'codex' });

  await flow.addOutside('codex', 'bob.json', 'bob@example.test');
  await flow.advanceServerClock(10_000);
  await expectEveryScreen(tabs, START, 9000);
  const restored = (await flow.state()).accounts.find(
    (account) => account.email === 'bob@example.test'
  );
  expect(restored).toMatchObject({ retired: false, name: 'bob.json' });
  expect(await providersText(tabs)).toBe(providersBefore);
});

test('second tab: another tab is updated through the channel while its poller is paused', async ({
  flow,
  context,
}) => {
  await flow.collect();
  const acting = await flow.open(context, '/auth-files');
  const watching = await flow.open(context, '/quota/accounts');
  await expect
    .poll(() => reading.accounts(watching), { timeout: 30_000 })
    .toEqual(expected(START).accounts);
  // Hide the second tab: its 5 s poller must stop, leaving the channel as the only way in.
  // A poll is the conditional read (If-None-Match); a refresh also reads the version, but not so.
  const polls: string[] = [];
  watching.on('request', (request) => {
    if (request.url().includes('/prox/inventory') && request.headers()['if-none-match']) {
      polls.push(request.url());
    }
  });
  await watching.evaluate(() => {
    Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true });
    document.dispatchEvent(new Event('visibilitychange'));
  });

  await removeInProx(acting, 'alice');
  await expect
    .poll(() => reading.accounts(watching), { timeout: 3000, intervals: [100] })
    .toEqual({ badge: 3, names: ['bob', 'carol', 'dave'] });
  expect(polls).toEqual([]); // it never polled: the channel delivered the change

  // Shown again, it catches up at once instead of waiting out a 5 s tick.
  await flow.removeOutside('claude', 'dave.json');
  await flow.advanceServerClock(10_000);
  await watching.evaluate(() => {
    Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true });
    document.dispatchEvent(new Event('visibilitychange'));
  });
  await expect
    .poll(() => reading.accounts(watching), { timeout: 3000, intervals: [100] })
    .toEqual({ badge: 2, names: ['bob', 'carol'] });
  expect(polls.length).toBeGreaterThanOrEqual(1);
});

test('503 inventory: nothing retires, screens keep what they have, other sources carry on', async ({
  flow,
  context,
}) => {
  await flow.collect();
  const tabs = await openAll(flow, context);
  await expectEveryScreen(tabs, START, 30_000);

  await flow.failCredentials('codex', 503);
  await flow.removeOutside('codex', 'bob.json'); // unseen: nothing can read codex right now
  await flow.advanceServerClock(10_000);
  // Give prox-history's lazy reconcile and the UI's poll a full cycle to react to the failure.
  await tabs.files.waitForTimeout(6500);
  const inventory = await flow.history<{
    sources: { instanceId: string; provider: string; state: string; accounts: unknown[] }[];
  }>('/v1/inventory');
  const codex = inventory.sources.find(
    (s) => s.instanceId === 'codex-primary' && s.provider === 'codex'
  )!;
  expect(codex.state).toBe('unavailable');
  expect(codex.accounts).toHaveLength(2); // still its last known membership
  expect((await flow.state()).accounts.every((account) => !account.retired)).toBe(true);
  await expectEveryScreen(tabs, START, 2000); // nothing disappeared from any screen

  // A healthy source is not held hostage: deleting dave in Prox still purges him everywhere.
  await removeInProx(tabs.files, 'dave');
  await expect
    .poll(async () => (await screens(tabs)).dashboard, { timeout: 5000 })
    .toMatchObject({ fleet: { claude: 1, codex: 2 } });
  expect(
    (await flow.state()).accounts.find((account) => account.name === 'dave.json')
  ).toBeUndefined();
  expect(
    (await flow.state()).accounts.filter(
      (account) => account.provider === 'codex' && account.retired
    )
  ).toEqual([]);

  // When codex comes back the removal it missed is applied, and not before.
  await flow.failCredentials('codex', null);
  await flow.advanceServerClock(10_000);
  await expectEveryScreen(tabs, { codex: ['alice'], claude: ['carol'] }, 9000);
});

test('AI Providers lists API-key providers, so adding and removing credentials leaves it identical', async ({
  flow,
  context,
}) => {
  await flow.collect();
  const tabs = await openAll(flow, context);
  await expectEveryScreen(tabs, START, 30_000);
  const before = await providersText(tabs);
  const credentialReads: string[] = [];
  tabs.providers.on('request', (request) => {
    if (request.url().includes('/credentials')) credentialReads.push(request.url());
  });

  await uploadToClaude(tabs.files, 'erin.json', 'erin@example.test');
  await expectEveryScreen(
    tabs,
    { codex: ['alice', 'bob'], claude: ['carol', 'dave', 'erin'] },
    4000
  );
  expect(await providersText(tabs)).toBe(before);

  await removeInProx(tabs.files, 'erin');
  await expectEveryScreen(tabs, START, 4000);
  expect(await providersText(tabs)).toBe(before);
  // The screen did list again (every tab refreshes on a change) but never as a screen of its own:
  // the contract tests pin that. What matters here is that its content did not move.
  expect(await providersText(tabs)).toBe(before);
});
