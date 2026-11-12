import { beforeAll, describe, expect, mock, test } from 'bun:test';
import { join } from 'node:path';
import { createElement as h, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { I18nextProvider } from 'react-i18next';
import i18n from '@/i18n';
import { SourceSessions } from '@/services/api/sourceSession';
import type { CodexQuotaState } from '@/types';

// The quota host binds CSS-module classes at import; identity proxies stand in for them.
for (const path of [
  'src/features/quota/components/QuotaBody.module.scss',
  'src/features/authFiles/components/AuthFileQuota.module.scss',
  'src/features/quota/components/AccountDetails.module.scss',
  'src/components/ui/FactPanel/FactPanel.module.scss',
])
  mock.module(join(import.meta.dir, '..', path), () => ({
    default: new Proxy({}, { get: (_, key) => (typeof key === 'string' ? key : undefined) }),
  }));
const { AuthFileQuotaSection, AuthFileQuotaUnavailable } =
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
const file = { name: 'slot.json', type: 'codex', authIndex: 'fixture-index' };

function renderSlot(seed: CodexQuotaState | undefined) {
  function Seeded() {
    const { quotaStore } = useAuthFilesSource();
    // Zustand's server snapshot reads the initial store; seed this isolated fixture only.
    Object.assign(quotaStore.getInitialState(), { codexQuota: seed ? { [file.name]: seed } : {} });
    return h(AuthFileQuotaSection, { file, quotaType: 'codex', disableControls: false });
  }
  return markup(h(AuthFilesSourceProvider, { source, session, children: h(Seeded) }));
}
const markup = (node: ReactNode) =>
  renderToStaticMarkup(h(I18nextProvider, { i18n: translations }, node));
const head = (html: string) => html.split('class="quotaHead"')[1].split('</div>')[0];

describe('the quota slot has one frame in every state', () => {
  test('not loaded: empty tracks and a muted "Not loaded", no click-to-refresh box', () => {
    const html = renderSlot(undefined);
    expect(html).toContain('data-quota-state="idle"');
    expect(head(html)).toContain('Not loaded');
    expect(html.match(/class="placeholderRow"/g)).toHaveLength(3);
    expect(html).not.toContain('Click here to refresh quota');
  });

  test('loading: the same tracks, shimmering', () => {
    const html = renderSlot({ status: 'loading', windows: [] });
    expect(html).toContain('data-quota-state="loading"');
    expect(html).toContain('quotaPlaceholderLoading');
    expect(html.match(/class="placeholderRow"/g)).toHaveLength(3);
  });

  test('failed: the message and a retry in the slot, not a toast', () => {
    const html = renderSlot({ status: 'error', windows: [], error: 'upstream said no' });
    expect(html).toContain('data-quota-state="failed"');
    expect(html).toContain('upstream said no');
    expect(html).toMatch(/<button[^>]*>.*Try again/);
    expect(head(html)).toContain('Could not load');
  });

  test('no quota: same frame, a disabled refresh icon that says why', () => {
    const html = markup(h(AuthFileQuotaUnavailable, { reason: 'runtime' }));
    expect(html).toContain('data-quota-state="unavailable"');
    expect(html).toContain('No quota for this credential');
    expect(head(html)).toMatch(/<button[^>]*disabled=""[^>]*title="Held in memory/);
  });

  test('every state has the label and the refresh icon in the same header', () => {
    for (const html of [
      renderSlot(undefined),
      renderSlot({ status: 'loading', windows: [] }),
      renderSlot({ status: 'error', windows: [], error: 'x' }),
      markup(h(AuthFileQuotaUnavailable, { reason: 'unsupported' })),
    ]) {
      expect(head(html)).toContain('class="quotaEyebrow">Quota</span>');
      expect(head(html)).toContain('aria-label="Refresh quota only for this credential"');
    }
  });
});

test('no locale keeps the old "disabled credentials are not checked" reason', async () => {
  for (const locale of ['en', 'zh-CN', 'zh-TW', 'ru', 'ko', 'vi']) {
    const dictionary = JSON.parse(await Bun.file(`src/i18n/locales/${locale}.json`).text());
    expect(dictionary.auth_files.quota_none_disabled).toBeUndefined();
    expect(typeof dictionary.quota_management.account_off).toBe('string');
    expect(typeof dictionary.quota_management.account_off_hint).toBe('string');
  }
});
