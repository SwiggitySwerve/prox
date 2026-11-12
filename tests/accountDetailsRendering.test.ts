import { beforeAll, describe, expect, mock, test } from 'bun:test';
import { join } from 'node:path';
import { createElement as h } from 'react';
import { renderToStaticMarkup as render } from 'react-dom/server';
import { I18nextProvider } from 'react-i18next';
import i18n from '@/i18n';
import { SourceSessions } from '@/services/api/sourceSession';
import { createQuotaAdapters } from '@/features/quota/providers';
import { QUOTA_CLASS_KEYS, bindQuotaClasses } from '@/features/quota/types';
import type { ClaudeQuotaState, CodexQuotaState } from '@/types';
import { CodexQuotaBody } from '@/features/quota/providers/codex/CodexQuotaBody';

for (const path of [
  'src/features/quota/components/QuotaBody.module.scss',
  'src/features/authFiles/components/AuthFileQuota.module.scss',
  'src/features/quota/components/QuotaCard.module.scss',
  'src/features/quota/components/AccountDetails.module.scss',
  'src/components/ui/FactPanel/FactPanel.module.scss',
])
  mock.module(join(import.meta.dir, '..', path), () => ({
    default: new Proxy({}, { get: (_, key) => (typeof key === 'string' ? key : undefined) }),
  }));
const { QuotaCard } = await import('@/features/quota/components/QuotaCard');
const { AccountDetails } = await import('@/features/quota/components/AccountDetails');
const { AuthFileQuotaSection } =
  await import('@/features/authFiles/components/AuthFileQuotaSection');
const { AuthFilesSourceProvider, useAuthFilesSource } =
  await import('@/features/authFiles/AuthFilesSourceContext');
const translations = i18n.cloneInstance({ lng: 'en' });
beforeAll(() => translations.changeLanguage('en'));
const source = {
  instanceId: 'fixture',
  label: 'Fixture',
  apiBase: 'https://fixture.invalid',
  publicBasePath: '',
  aliases: [],
  authScope: 'fixture',
};
const sessions = new SourceSessions();
sessions.configure([{ ...source, managementKey: 'fixture-only', configurationRevision: '1' }]);
const session = sessions.captureSource('fixture');
const adapters = createQuotaAdapters(session);
const file = { name: 'synthetic.json', type: 'codex', authIndex: 'fixture-index' };
const codex: CodexQuotaState = {
  status: 'success',
  planType: 'plus',
  windows: [],
  creditBalance: '42',
  rateLimitResetCreditsAvailableCount: 1,
  rateLimitResetCredits: [{ id: 'one', expiresAt: '2026-12-01T00:00:00Z' }],
  billing: {
    provider: 'codex',
    plan: 'plus',
    willRenew: true,
    renewsAtMs: Date.UTC(2026, 11, 1),
    endsAtMs: null,
    nextPlan: { plan: 'prolite', atMs: Date.UTC(2026, 11, 1) },
    overdue: false,
    graceEndsAtMs: null,
  },
};
const claude: ClaudeQuotaState = {
  status: 'success',
  windows: [],
  planType: 'plan_pro',
  billing: {
    provider: 'claude',
    status: 'active',
    activeSinceMs: Date.UTC(2026, 8, 3),
    billingType: 'stripe_subscription',
  },
};
const markup = (element: ReturnType<typeof h>) =>
  render(h(I18nextProvider, { i18n: translations }, element));
const noop = () => {};
test('Codex card keeps facts and Use reset with its visible reason inside Account details', () => {
  const html = markup(
    h(QuotaCard, {
      entry: { file, type: 'codex' },
      adapter: adapters.codex,
      quota: codex,
      resolvedTheme: 'dark',
      canRefresh: true,
      resetting: false,
      onRefresh: noop,
      onReset: noop,
    })
  );
  const [before, details] = html.split('<details');
  expect(before).toContain('codexPlan');
  expect(before).not.toContain('Credit balance');
  expect(before).not.toContain('Manual resets');
  expect(details).toContain('<summary>Account details</summary>');
  for (const word of ['Credit balance', '42', 'Renews', 'Next plan', 'Manual resets', 'Reset 1'])
    expect(details).toContain(word);
  expect(details).toMatch(
    /<header><h4>Manual resets<\/h4><button[^>]+aria-describedby="[^"]+"[^>]*>Use reset/
  );
  // The note states the reset's status; the confirmation dialog carries the spend wording.
  expect(details).toContain('role="status" class="note">Usable now</p>');
  expect(details?.split('<footer')[1]).not.toContain('Use reset');
  expect(details?.split('<footer')[1]).toContain('Refresh');
});
test('Claude card renders estimated billing and its reset action with a visible loading reason', () => {
  const html = markup(
    h(QuotaCard, {
      entry: { file: { ...file, type: 'claude' }, type: 'claude' },
      adapter: adapters.claude,
      quota: claude,
      resolvedTheme: 'dark',
      canRefresh: true,
      resetting: false,
      onRefresh: noop,
      onReset: noop,
    })
  );
  const [before, details] = html.split('<details');
  expect(before).not.toContain('Manual resets');
  expect(before).not.toContain('Resets remaining');
  for (const word of [
    'Active since',
    'Renews',
    'Estimated',
    'Monthly anniversary',
    'Manual resets',
    'Checking…',
  ])
    expect(details).toContain(word);
  expect(details).toMatch(
    /<header><h4>Manual resets<\/h4><button[^>]*disabled=""[^>]*aria-describedby="[^"]+"[^>]*>Use reset/
  );
});
test('a failed Claude usage read still shows Manual resets and its reason', () => {
  // Reset grants are read separately from usage; a usage failure must not hide the action.
  const html = markup(
    h(QuotaCard, {
      entry: { file: { ...file, type: 'claude' }, type: 'claude' },
      adapter: adapters.claude,
      quota: { status: 'error', error: 'Usage unavailable' } as never,
      resolvedTheme: 'dark',
      canRefresh: true,
      resetting: false,
      onRefresh: noop,
      onReset: noop,
    })
  );
  expect(html).toContain('<details');
  expect(html).toMatch(
    /<h4>Manual resets<\/h4><button[^>]*aria-describedby="[^"]+"[^>]*>Use reset/
  );
  expect(html).toContain('role="status" class="note">');
});
test('Claude panel renders reset inventory and disabled reason without chip markup', () => {
  const html = markup(
    h(AccountDetails, {
      provider: 'claude',
      quota: claude,
      name: 'Fixture',
      claudeReset: {
        count: 2,
        grants: [
          {
            id: 'grant',
            label: 'Bonus',
            resetsLeft: 2,
            resetsTotal: 3,
            endsAt: '2026-12-01T00:00:00Z',
          },
        ],
        busy: false,
        blocked: true,
        confirm: noop,
        message: 'read_error',
        buttonLabel: 'use',
      },
    })
  );
  expect(html).toContain('Bonus');
  expect(html).toContain('2 / 3 resets remaining');
  expect(html).toContain(translations.t('claude_reset.read_error'));
  expect(html).not.toContain('codexPlanItem');
});
test('AuthFileQuotaSection renders the same facts and keeps only its refresh icon in the header', () => {
  function SeededSection() {
    const { quotaStore } = useAuthFilesSource();
    // Zustand's server snapshot reads the initial store; seed this isolated fixture only.
    Object.assign(quotaStore.getInitialState(), { codexQuota: { [file.name]: codex } });
    return h(AuthFileQuotaSection, { file, quotaType: 'codex', disableControls: false });
  }
  const html = markup(h(AuthFilesSourceProvider, { source, session, children: h(SeededSection) }));
  expect(html).toContain('<summary>Account details</summary>');
  expect(html).toContain('<dt>Credit balance</dt>');
  expect(html).toContain('Use reset');
  const head = html.split('class="quotaHead"')[1].split('</div>')[0];
  expect(head).not.toContain('Use reset');
  expect(head).toContain('aria-label="Refresh quota only for this credential"');
  expect(html).toContain('data-quota-state="loaded"');
});
test('Account details is closed unless defaultOpen is asked for; the user can still toggle it', () => {
  const props = { provider: 'codex', quota: codex, name: 'Fixture' } as const;
  expect(markup(h(AccountDetails, props))).not.toMatch(/<details[^>]*\sopen/);
  const open = markup(h(AccountDetails, { ...props, defaultOpen: true }));
  expect(open).toMatch(/<details[^>]*\sopen=""/);
  expect(open).toContain('<summary>Account details</summary>');
});
test('Quota page cards stay collapsed while Auth Files cards open Account details by default', () => {
  const card = markup(
    h(QuotaCard, {
      entry: { file, type: 'codex' },
      adapter: adapters.codex,
      quota: codex,
      resolvedTheme: 'dark',
      canRefresh: true,
      resetting: false,
      onRefresh: noop,
      onReset: noop,
    })
  );
  expect(card).not.toMatch(/<details[^>]*\sopen/);
  function SeededSection() {
    const { quotaStore } = useAuthFilesSource();
    Object.assign(quotaStore.getInitialState(), { codexQuota: { [file.name]: codex } });
    return h(AuthFileQuotaSection, { file, quotaType: 'codex', disableControls: false });
  }
  const section = markup(
    h(AuthFilesSourceProvider, { source, session, children: h(SeededSection) })
  );
  expect(section).toMatch(/<details[^>]*\sopen=""/);
});
test('factsInPanel=false preserves the default Codex body markup', () => {
  const classes = bindQuotaClasses(
    Object.fromEntries(QUOTA_CLASS_KEYS.map((key) => [key, key])),
    'fixture'
  );
  const implicit = markup(h(CodexQuotaBody, { quota: codex, classes }));
  const explicit = markup(h(CodexQuotaBody, { quota: codex, classes, factsInPanel: false }));
  expect(explicit).toBe(implicit);
  expect(explicit).toContain('<span class="codexPlanLabel">Credit balance</span>');
  expect(explicit).toContain('codexResetCreditRow');
  expect(markup(h(CodexQuotaBody, { quota: codex, classes, factsInPanel: true }))).not.toContain(
    'codexResetCreditRow'
  );
});

test('Account details copy has identical keys and interpolation contracts in every locale', async () => {
  const locales = ['en', 'zh-CN', 'zh-TW', 'ru', 'ko', 'vi'];
  const dictionaries = await Promise.all(
    locales.map(
      async (locale) =>
        JSON.parse(await Bun.file(`src/i18n/locales/${locale}.json`).text())
          .account_details as Record<string, string>
    )
  );
  const keys = Object.keys(dictionaries[0]).sort();
  for (const dictionary of dictionaries) {
    expect(Object.keys(dictionary).sort()).toEqual(keys);
    for (const key of keys)
      expect(dictionary[key].match(/\{\{[^}]+\}\}/g) ?? []).toEqual(
        dictionaries[0][key].match(/\{\{[^}]+\}\}/g) ?? []
      );
  }
});

test('Claude balance panel preserves partial amounts and renders missing values explicitly', () => {
  const html = markup(
    h(AccountDetails, {
      provider: 'claude',
      name: 'Fixture',
      quota: {
        ...claude,
        extraUsage: {
          isEnabled: true,
          usedCredits: 1250,
          monthlyLimit: null,
          currency: 'USD',
          utilization: null,
          userDisabled: false,
          spendLimitReached: false,
          disabledReason: null,
        },
        dollarWindows: [
          {
            key: 'balance',
            remainingDollars: null,
            usedDollars: 5,
            limitDollars: 100,
            resetsAt: null,
          },
        ],
      } as ClaudeQuotaState,
    })
  );
  for (const value of [
    '$12.50',
    '$5.00',
    '$100.00',
    'Not reported',
    'The provider has not reported this detail.',
  ])
    expect(html).toContain(value);
  expect(html).not.toContain('>--<');
});

test('resource sheets use code facts, explicit missing states, and retain metadata disclosure', async () => {
  const { ResourceDetailView } = await import('@/features/providers/sheets/ResourceDetailView');
  const html = markup(
    h(ResourceDetailView, {
      resource: {
        id: 'fixture',
        brand: 'codex',
        originalIndex: 0,
        name: null,
        identifier: 'sy******56',
        apiKeyPreview: 'sy******56',
        apiKey: 'synthetic-only',
        authIndex: 'synthetic-index',
        baseUrl: 'https://fixture.invalid/a/long/path',
        proxyUrl: null,
        prefix: null,
        modelCount: 0,
        models: [],
        priority: 0,
        headerCount: 0,
        excludedModelCount: 0,
        apiKeyEntryCount: 0,
        disabled: false,
        flags: {},
        selector: { brand: 'codex', apiKey: 'synthetic-only', index: 0 },
        raw: {},
      },
    })
  );
  expect(html).toContain('<dt>Identifier</dt><dd><span class="code value">sy******56</span>');
  expect(html).toContain(
    '<dt>Base URL</dt><dd><span class="code value">https://fixture.invalid/a/long/path</span>'
  );
  // An empty setting is a choice, not something the provider failed to report.
  expect(html).toContain('<dt>Proxy URL</dt><dd><span class="code">Not set</span>');
  expect(html).not.toContain('<h4>Account details</h4>');
  expect(html).toContain('Metadata');
  expect(html).not.toContain('synthetic-only');
});

const compactGrants = [
  {
    id: 'full',
    kind: 'full',
    label: 'One full limit reset (November 2026)',
    resetsLeft: 1,
    resetsTotal: 1,
    endsAt: '2030-12-10T22:00:00Z',
  },
  {
    id: 'free',
    kind: 'weekly',
    label: 'Weekly reset',
    resetsLeft: 1,
    resetsTotal: 2,
    endsAt: null,
  },
  ...['New model launch', "Six months' tenure"].map((label, n) => ({
    id: `fable-${n}`,
    kind: 'fable',
    label,
    resetsLeft: 1,
    resetsTotal: 1,
    endsAt: '2031-03-09T07:59:00Z',
  })),
];
const compactClaude = (extraUsage: ClaudeQuotaState['extraUsage']) =>
  markup(
    h(AccountDetails, {
      provider: 'claude',
      quota: { ...claude, extraUsage } as ClaudeQuotaState,
      name: 'Fixture',
      compact: true,
      claudeReset: {
        count: 3,
        grants: compactGrants,
        busy: false,
        blocked: false,
        confirm: noop,
        message: null,
        buttonLabel: 'choose',
      } as never,
    })
  );
const disabledExtra = {
  isEnabled: false,
  usedCredits: null,
  monthlyLimit: null,
  currency: null,
  utilization: null,
  userDisabled: true,
  spendLimitReached: false,
  disabledReason: null,
};

test('compact Account details puts the held count on the status line and one row per grant', () => {
  const html = compactClaude(disabledExtra);
  expect(html).toContain('data-compact="true"');
  expect(html).toContain('role="status" class="note">Usable now · 3 held</p>');
  expect(html).not.toContain('Resets held');
  // Kind and expiry on the row; what is left and the description on one clamped muted line.
  const badge = (kind: string, text: string) =>
    `<dt><span class="grantKind" data-kind="${kind}">${text}</span></dt>`;
  const full = html.split(badge('full', 'Full reset'))[1].split('</div>')[0];
  expect(full).toMatch(/<dd><span class="value">Dec 1[01], /);
  const note = '1/1 left · One full limit reset (November 2026)';
  expect(full).toContain(`<dd class="detail clamp" title="${note}">${note}</dd>`);
  // A label that only repeats the kind adds nothing; an unknown expiry still says so.
  const weekly = html.split(badge('weekly', 'Weekly reset'))[1].split('</div>')[0];
  expect(weekly).toContain('Not reported');
  expect(weekly).toContain(translations.t('claude_reset.expiry_unknown'));
  expect(weekly).toContain('title="1/2 left">1/2 left</dd>');
  // Resets of one kind that end together share a row, as on the Accounts page.
  const fable = html.split(badge('fable', 'Fable reset × 2'))[1].split('</div>')[0];
  expect(fable).toContain('2/2 left · New model launch · Six months&#x27; tenure</dd>');
  expect(html.split('data-kind="fable"').length).toBe(2);
  // The estimate's basis is one line too, with all of it in the tooltip.
  expect(html).toMatch(/<dd class="detail clamp" title="Estimated · Monthly anniversary[^"]+">/);
});

test('compact balances name unreported amounts once and keep every status and real value', () => {
  const html = compactClaude(disabledExtra);
  const balances = html.split('<h4>Balances</h4>')[1];
  expect(balances).toContain('<dt>Extra Usage</dt>');
  expect(balances).toContain('Disabled</span>');
  expect(balances).toContain('Disabled by user · Spent and limit not reported');
  expect(balances).not.toContain('<dt>Spent</dt>');
  expect(balances).not.toContain('<dt>Limit</dt>');
  expect(balances).not.toContain('<dt>Status</dt>');
  expect(balances).not.toContain('The provider has not reported this detail.');

  const partial = compactClaude({ ...disabledExtra, isEnabled: true, usedCredits: 1250 });
  const partialBalances = partial.split('<h4>Balances</h4>')[1];
  expect(partialBalances).toContain('<dt>Spent</dt>');
  expect(partialBalances).toContain('$12.50');
  expect(partialBalances).toContain('Disabled by user · Limit not reported');
  expect(partialBalances).not.toContain('<dt>Limit</dt>');
});

test('only the Auth Files card asks for the compact layout; the Quota page keeps its own', () => {
  const card = markup(
    h(QuotaCard, {
      entry: { file: { ...file, type: 'claude' }, type: 'claude' },
      adapter: adapters.claude,
      quota: claude,
      resolvedTheme: 'dark',
      canRefresh: true,
      resetting: false,
      onRefresh: noop,
      onReset: noop,
    })
  );
  expect(card).not.toContain('data-compact');
  expect(card).not.toContain('clamp');
  function SeededSection() {
    const { quotaStore } = useAuthFilesSource();
    Object.assign(quotaStore.getInitialState(), { codexQuota: { [file.name]: codex } });
    return h(AuthFileQuotaSection, { file, quotaType: 'codex', disableControls: false });
  }
  const section = markup(
    h(AuthFilesSourceProvider, { source, session, children: h(SeededSection) })
  );
  expect(section).toContain('data-compact="true"');
  // Codex keeps its held count with the reset status, and its credit balance stays a fact.
  expect(section).toContain('Usable now · 1 held');
  expect(section).toContain('<dt>Credit balance</dt>');
});

describe('a disabled account still shows its quota, marked as off, with its reset not usable', () => {
  const off = { ...file, disabled: true };
  const offHint =
    'Switched off: it serves no requests until enabled. Quota is shown for reference.';

  test('Quota page card: quota and Refresh stay, "Account off" shows and Use reset is blocked', () => {
    const html = markup(
      h(QuotaCard, {
        entry: { file: off, type: 'codex' },
        adapter: adapters.codex,
        quota: codex,
        resolvedTheme: 'dark',
        canRefresh: true,
        resetting: false,
        onRefresh: noop,
        onReset: noop,
      })
    );
    const [header] = html.split('</header>');
    expect(header).toContain(`title="${offHint}"`);
    expect(header).toContain('>Account off</span>');
    expect(html).toContain('codexPlan');
    expect(html).toMatch(/<h4>Manual resets<\/h4><button[^>]*disabled=""[^>]*>Use reset/);
    expect(html).toContain('The account is off; enable it to use a reset.');
    expect(html.split('<footer')[1]).not.toMatch(/<button[^>]*disabled=""/);
  });

  test('an enabled Quota page card carries no off marker', () => {
    const html = markup(
      h(QuotaCard, {
        entry: { file, type: 'codex' },
        adapter: adapters.codex,
        quota: codex,
        resolvedTheme: 'dark',
        canRefresh: true,
        resetting: false,
        onRefresh: noop,
        onReset: noop,
      })
    );
    expect(html).not.toContain('Account off');
  });

  test('Auth Files slot: loaded quota, the off marker in its header, refresh enabled', () => {
    function SeededSection() {
      const { quotaStore } = useAuthFilesSource();
      Object.assign(quotaStore.getInitialState(), { codexQuota: { [off.name]: codex } });
      return h(AuthFileQuotaSection, { file: off, quotaType: 'codex', disableControls: false });
    }
    const html = markup(
      h(AuthFilesSourceProvider, { source, session, children: h(SeededSection) })
    );
    expect(html).toContain('data-quota-state="loaded"');
    const head = html.split('class="quotaHead"')[1].split('</div>')[0];
    expect(head).toContain('>Account off</span>');
    expect(head).not.toMatch(/<button[^>]*disabled=""/);
    expect(html).toMatch(/<h4>Manual resets<\/h4><button[^>]*disabled=""[^>]*>Use reset/);
    expect(html).toContain('The account is off; enable it to use a reset.');
  });

  test('Claude: held resets on an off account say why they cannot be used', () => {
    const html = markup(
      h(AccountDetails, {
        provider: 'claude',
        quota: claude,
        name: 'Fixture',
        accountOff: true,
        claudeReset: {
          count: 1,
          grants: [{ id: 'g', label: 'Bonus', resetsLeft: 1, resetsTotal: 1, endsAt: null }],
          busy: false,
          blocked: true,
          confirm: noop,
          message: '',
          buttonLabel: 'use',
        },
      })
    );
    expect(html).toContain('The account is off; enable it to use a reset.');
    expect(html).not.toContain('Claude reports none usable right now');
  });
});
