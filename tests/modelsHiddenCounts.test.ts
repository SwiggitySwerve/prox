import { beforeAll, describe, expect, mock, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createElement as h } from 'react';
import { renderToStaticMarkup as render } from 'react-dom/server';
import { I18nextProvider } from 'react-i18next';
import i18n from '@/i18n';
import { buildMatrix } from '../src/features/authFiles/modelAccess/resolve';
import { inventory } from './fixtures/modelAccess';

mock.module(
  join(import.meta.dir, '..', 'src/features/authFiles/models/ModelsPage.module.scss'),
  () => ({
    default: new Proxy({}, { get: (_, key) => (typeof key === 'string' ? key : undefined) }),
  })
);
const { ModelAccessMatrix } = await import('@/features/authFiles/models/ModelAccessMatrix');
const translations = i18n.cloneInstance({ lng: 'en' });
beforeAll(() => translations.changeLanguage('en'));

const hub = inventory();
const rows = buildMatrix(hub);
const HIDDEN = 'claude-haiku-4-5';

function grid(hidden: string[]) {
  return render(
    h(
      I18nextProvider,
      { i18n: translations },
      h(ModelAccessMatrix, {
        provider: 'Claude',
        inventory: hub,
        overrides: new Map(),
        rows,
        accounts: hub.accounts,
        disabled: false,
        layout: 'table',
        failed: new Map(),
        onStage: () => {},
        hidden: new Set(hidden),
        hiddenOpen: false,
        onHiddenOpenChange: () => {},
        searching: false,
        onHide: () => {},
        note: null,
      })
    )
  );
}

/** Each account's header: its "n/m on" count and its all-models checkbox. */
function headers(html: string) {
  return Object.fromEntries(
    [...html.matchAll(/<th[^>]*data-account="([^"]+)"[^>]*>([\s\S]*?)<\/th>/g)].map((match) => [
      match[1],
      {
        count: /(\d+\/\d+ on)/.exec(match[2])?.[1],
        checkbox: /<button[^>]*data-account-switch[^>]*>/.exec(match[2])?.[0],
      },
    ])
  );
}

describe('hiding a model changes no count', () => {
  test('a hidden model that is on still counts in its accounts’ columns', () => {
    const shown = grid([]);
    const hidden = grid([HIDDEN]);
    // The row leaves the bands for the collapsed Hidden group...
    expect(shown).toContain(`data-model="${HIDDEN}"`);
    expect(hidden).not.toContain(`data-model="${HIDDEN}"`);
    expect(hidden).toContain('data-hidden-toggle');
    // ...and every column's count and checkbox state are what they were.
    expect(headers(hidden)).toEqual(headers(shown));
    // team-a serves claude-haiku-4-5: its column still says so.
    expect(headers(hidden)['team-a.json'].count).toBe('4/7 on');
    expect(headers(hidden)['team-a.json'].checkbox).toContain('aria-checked="mixed"');
  });

  test('the toolbar summary is counted before any model is hidden', () => {
    const section = readFileSync('src/features/authFiles/models/ModelsHubSection.tsx', 'utf8');
    const visibleRows = /const visibleRows = useMemo\(\(\) => (filterRows\([^)]*\))/.exec(
      section
    )?.[1];
    expect(visibleRows).toBe('filterRows(rows, modelQuery, view)');
    expect(section).toContain('const counts = countServed(visibleRows);');
    expect(section).toContain('const models = showsTable ? visibleRows.length : 0;');
  });
});
