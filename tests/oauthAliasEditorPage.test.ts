import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';

const LOCALES = ['en', 'zh-CN', 'zh-TW', 'ru', 'vi', 'ko'];
const page = readFileSync('src/pages/AuthFilesOAuthModelAliasEditPage.tsx', 'utf8');

describe('alias editor page', () => {
  test('notification.load_failed exists, translated, in every locale', () => {
    const texts = LOCALES.map(
      (locale) =>
        JSON.parse(readFileSync(`src/i18n/locales/${locale}.json`, 'utf8')).notification
          .load_failed as string
    );
    texts.forEach((text) => expect(text.length).toBeGreaterThan(0));
    expect(new Set(texts).size).toBe(LOCALES.length);
    expect(page).toContain("t('notification.load_failed')");
  });

  test('has the Models header pattern: breadcrumb, one h1, a Save action, no second heading', () => {
    expect(page).toContain("t('nav.auth_files')");
    expect(page).toContain("t('model_access.title')");
    expect(page).toContain("t('model_access.tab_aliases')");
    expect(page.match(/<h1[ >]/g)).toHaveLength(1);
    expect(page).toContain("t('common.save')");
    expect(page).not.toContain("t('oauth_model_alias.title')");
    expect(page).not.toContain('SecondaryScreenShell');
  });

  test('reads the provider exclusion lists from the shared store instead of copying them', () => {
    expect(page).not.toMatch(/useState<Record<string, string\[\]>>/);
    expect(page).not.toContain('setExcluded');
    expect(page).toContain('modelAccessSlices.providerLists');
  });

  test('a provider in the link fixes the provider; the picker is for links without one', () => {
    expect(page).toMatch(/providerLocked \?[\s\S]*?: \(\s*<OAuthEditorProviderCard/);
  });
});
