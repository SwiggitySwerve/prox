import { beforeAll, expect, mock, test } from 'bun:test';
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
