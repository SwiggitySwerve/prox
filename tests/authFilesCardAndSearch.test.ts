import { beforeAll, describe, expect, test } from 'bun:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { readFileSync } from 'node:fs';
import i18n from '../src/i18n/index';
import { AuthFilesToolbar } from '@/features/authFiles/components/AuthFilesToolbar';

const noop = () => {};

// The card cannot be rendered under Bun (its quota section binds CSS-module classes at import,
// see authFileCard.test.ts), so the card is checked as a source contract plus its strings.
const card = readFileSync('src/features/authFiles/components/AuthFileCard.tsx', 'utf8');

describe('credential cards', () => {
  beforeAll(async () => {
    await i18n.changeLanguage('en');
  });

  test('a runtime credential is labelled "Runtime only" in the identity line, not beside it', () => {
    const header = card.split('<header')[1].split('</header>')[0];
    expect(header).not.toContain('type_virtual');
    const identityLine = card.split('<div className={styles.identityLine}>')[1].split('</div>')[0];
    expect(identityLine).toContain(
      "<span className={styles.runtimeLabel}>{t('auth_files.type_virtual')}</span>"
    );
    expect(identityLine).toContain('{identity.secondary ?? identity.fullName}');
    expect(i18n.t('auth_files.type_virtual')).toBe('Runtime only');
  });

  test('every card has its meta row; without a file it says so instead of disappearing', () => {
    expect(card).not.toContain('showMetaRow');
    expect(card).toContain('<div className={styles.metaRow}>');
    expect(card).toContain("isRuntimeOnly ? t('auth_files.meta_no_file') : '– · –'");
    expect(i18n.t('auth_files.meta_no_file')).toBe('No file · held in memory');
  });

  test('every card has the same five actions in the same order; one that does not apply says why', () => {
    const footer = card.split('<footer')[1].split('</footer>')[0];
    expect(card).not.toContain('{(!isRuntimeOnly || showModelsButton) && (');
    expect(card).not.toContain('/ai-providers');
    const order = [
      'data-card-models={file.name}',
      'onClick={() => onManualRefresh(file)}',
      'onClick={() => onDownload(file.name)}',
      'data-card-settings={file.name}',
      'onClick={() => onDelete(file.name)}',
    ].map((marker) => footer.indexOf(marker));
    expect(order.every((index) => index >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    // No action is conditionally rendered; runtime-only cards disable them with a reason.
    expect(footer).not.toMatch(/\{(?:!isRuntimeOnly|showModelsButton|showManualRefreshButton) &&/);
    expect(footer.match(/runtimeReason/g)?.length).toBeGreaterThanOrEqual(4);
    expect(i18n.t('auth_files.models_button')).toBe('Served models');
  });

  test('the quota slot is always there outside compact mode, "no quota" when it cannot load', () => {
    expect(card).toContain("<AuthFileQuotaUnavailable reason={quotaReason ?? 'unsupported'} />");
    expect(card).toContain('{!compact &&');
    expect(i18n.t('auth_files.quota_none')).toBe('No quota for this credential');
  });
});

describe('search box', () => {
  beforeAll(async () => {
    await i18n.changeLanguage('en');
  });

  test('a short placeholder; the syntax help moves to the title', () => {
    const html = renderToStaticMarkup(
      createElement(AuthFilesToolbar, {
        search: '',
        onSearchChange: noop,
        statusFilterMode: 'all',
        statusFilterOptions: [
          { value: 'all', label: 'All', count: null },
          { value: 'enabled', label: 'Active', count: 3 },
        ],
        onStatusFilterChange: noop,
        sortMode: 'default',
        sortOptions: [{ value: 'default', label: 'Default' }],
        onSortModeChange: noop,
        pageSizeInput: '9',
        onPageSizeInputChange: noop,
        onPageSizeCommit: noop,
        compactMode: false,
        onCompactModeChange: noop,
      })
    );
    expect(html).toContain('placeholder="Search credentials"');
    expect(html).toMatch(/title="[^"]*\* as a wildcard/);
    // Unknown counts render as a dash, never as 0.
    expect(html).toMatch(/>All<span[^>]*>–<\/span>/);
    expect(html).toMatch(/>Active<span[^>]*>3<\/span>/);
  });
});
