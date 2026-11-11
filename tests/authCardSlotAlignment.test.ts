/**
 * Credential cards in one grid row show the same section at the same height. Quota rows get this
 * from fixed slots: a window the account does not report still renders its row, as a placeholder,
 * so every row below it stays where the neighbouring cards have theirs. The rest comes from CSS
 * subgrid, which the source checks below pin to the markup's track counts.
 */
import { beforeAll, describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import i18n from '@/i18n';
import { ClaudeQuotaBody } from '@/features/quota/providers/claude/ClaudeQuotaBody';
import { QUOTA_CLASS_KEYS, bindQuotaClasses } from '@/features/quota/types';
import { CARD_TRACKS, QUOTA_TRACKS, claudeQuotaRowSlots } from '@/features/authFiles/quotaSlot';
import type { ClaudeQuotaState, ClaudeQuotaWindow } from '@/types';

const classes = bindQuotaClasses(
  Object.fromEntries(QUOTA_CLASS_KEYS.map((key) => [key, key])),
  'test-host'
);
beforeAll(() => i18n.changeLanguage('en'));

const window = (id: string, label: string, used: number): ClaudeQuotaWindow => ({
  id,
  label,
  labelKey: `claude_quota.${id.replaceAll('-', '_')}`,
  usedPercent: used,
  resetLabel: '',
});
const render = (windows: ClaudeQuotaWindow[], extra: Partial<ClaudeQuotaState> = {}) =>
  renderToStaticMarkup(
    createElement(ClaudeQuotaBody, {
      quota: { status: 'success', windows, planType: 'plan_max', ...extra },
      classes,
      factsInPanel: true,
      fixedSlots: true,
    })
  );
/** The quota rows in the order they appear: [slot id, filled?, label]. */
const rows = (html: string) =>
  [
    ...html.matchAll(/<div class="quotaRow"([^>]*)>.*?<span class="quotaModel">([^<]*)<\/span>/g),
  ].map(([, attrs, label]) => [
    attrs.match(/data-slot="([^"]+)"/)?.[1],
    attrs.includes('data-slot-filled'),
    label,
  ]);

describe('Claude quota rows have a fixed slot each', () => {
  const full = [
    window('five-hour', '5-hour limit', 38),
    window('seven-day', '7-day limit', 71),
    window('seven-day-fable', '7-day Fable 5', 12),
  ];

  test('an account without the 5-hour window keeps its slot, as a labelled placeholder', () => {
    const always = new Set(
      claudeQuotaRowSlots()
        .filter((s) => s.always)
        .map((s) => s.id)
    );
    const html = rows(render(full.slice(1))).filter(([slot]) => always.has(slot as string));
    expect(html).toEqual([
      ['five-hour', false, '5-hour limit'],
      ['seven-day', true, '7-day limit'],
      ['seven-day-fable', true, '7-day Fable 5'],
    ]);
  });

  test('a placeholder is a row of the same markup: a dash for the value and an empty bar', () => {
    const html = render(full.slice(1));
    const placeholder = html.split('data-slot="five-hour"')[1].split('data-slot="seven-day"')[0];
    expect(placeholder).toContain('<span class="quotaPercent">–</span>');
    expect(placeholder).toContain('class="quotaBarFill quotaBarFillMedium" style="width:0%"');
  });

  test('every account renders the same slots in the same order, whatever it reports', () => {
    const order = (html: string) => rows(html).map(([slot]) => slot);
    const canonical = claudeQuotaRowSlots().map((slot) => slot.id);
    expect(order(render([]))).toEqual(canonical);
    expect(order(render(full))).toEqual(canonical);
    expect(canonical.slice(0, 2)).toEqual(['five-hour', 'seven-day']);
    expect(canonical.at(-1)).toBe('seven-day-fable');
  });

  test('a window outside the always-shown three keeps its canonical place and is filled', () => {
    const html = rows(
      render([...full.slice(0, 2), window('seven-day-opus', '7-day Opus', 5), full[2]])
    );
    const ids = html.map(([slot]) => slot);
    expect(ids.indexOf('seven-day')).toBeLessThan(ids.indexOf('seven-day-opus'));
    expect(ids.indexOf('seven-day-opus')).toBeLessThan(ids.indexOf('seven-day-fable'));
    expect(html.find(([slot]) => slot === 'seven-day-opus')?.[1]).toBe(true);
  });

  test('optional windows render on every card, so one can match a neighbour that has it', () => {
    const html = render(full);
    expect(html).toContain('data-slot="seven-day-opus" data-slot-optional');
    expect(html).not.toContain('data-slot="five-hour" data-slot-optional');
  });

  test('the plan chip row is always there, so the rows below do not move', () => {
    const noPlan = render(full, { planType: null });
    expect(noPlan).toContain('class="codexPlan"');
    expect(noPlan).toContain('data-slot-empty');
    expect(render(full)).not.toContain('data-slot-empty');
  });

  test('without fixed slots (the Quota page) nothing is added', () => {
    const html = renderToStaticMarkup(
      createElement(ClaudeQuotaBody, {
        quota: { status: 'success', windows: full.slice(1) },
        classes,
        factsInPanel: true,
      })
    );
    expect(html).not.toContain('data-slot');
    expect(html).not.toContain('5-hour limit');
  });
});

describe('the card is a subgrid whose track count matches its markup', () => {
  const read = (path: string) => readFileSync(join(import.meta.dir, '..', path), 'utf8');
  const cardScss = read('src/features/authFiles/components/AuthFileCard.module.scss');
  const quotaScss = read('src/features/authFiles/components/AuthFileQuota.module.scss');
  const detailsScss = read('src/features/quota/components/AccountDetails.module.scss');
  const pageScss = read('src/features/authFiles/AuthFilesPage.module.scss');

  test('card, quota section and account details all take their rows from the grid', () => {
    for (const scss of [cardScss, quotaScss, detailsScss])
      expect(scss).toContain('grid-template-rows: subgrid');
    expect(pageScss).toContain('row-gap: 0');
  });

  test('every optional row kind is revealed grid-wide, and none of the always-shown ones', () => {
    for (const slot of claudeQuotaRowSlots()) {
      const listed = new RegExp(`@each \\$kind in [^{]*(?<![\\w-])${slot.id}(?![\\w-])`).test(
        pageScss
      );
      expect(listed).toBe(!slot.always);
    }
    expect(quotaScss).toContain('.quotaRow[data-slot-optional]:not([data-slot-filled])');
  });

  test('the SCSS track counts are the ones quotaSlot.ts exports', () => {
    expect(cardScss).toContain(`$card-tracks: ${CARD_TRACKS.full};`);
    expect(cardScss).toContain(`$card-tracks-compact: ${CARD_TRACKS.compact};`);
    expect(quotaScss).toContain(`$quota-tracks: ${QUOTA_TRACKS.total};`);
    expect(detailsScss).toContain(`$details-tracks: ${QUOTA_TRACKS.details};`);
    // head + identity + requests + file meta + quota + footer
    expect(CARD_TRACKS.full).toBe(5 + QUOTA_TRACKS.total);
    expect(CARD_TRACKS.compact).toBe(5);
    // head + body + details (its summary and the section tracks)
    expect(QUOTA_TRACKS.total).toBe(2 + QUOTA_TRACKS.details);
  });
});
