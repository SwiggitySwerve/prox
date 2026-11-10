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

  test('a runtime credential is labelled "Runtime only" under the name, not beside it', () => {
    const header = card.split('<header')[1].split('</header>')[0];
    expect(header).not.toContain('type_virtual');
    expect(card).toContain(
      "{isRuntimeOnly && <span className={styles.runtimeLabel}>{t('auth_files.type_virtual')}</span>}"
    );
    expect(i18n.t('auth_files.type_virtual')).toBe('Runtime only');
  });

  test('its meta row is left out when there is no size or modified time', () => {
    expect(card).toContain("const hasFileMeta = Boolean(file.size) || modifiedText !== '-';");
    expect(card).toContain('{showMetaRow && (');
  });

  test('it gets no empty footer, and file cards keep "Served models"', () => {
    // The hub holds it in memory: there is no file to act on and it is not a config API key.
    expect(card).toContain('{(!isRuntimeOnly || showModelsButton) && (');
    expect(card).not.toContain('/ai-providers');
    const footer = card.split('<footer')[1].split('</footer>')[0];
    expect(footer).toContain('data-card-models={file.name}');
    expect(footer).toContain('data-card-settings={file.name}');
    expect(i18n.t('auth_files.models_button')).toBe('Served models');
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
