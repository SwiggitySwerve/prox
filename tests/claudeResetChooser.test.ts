import { beforeAll, describe, expect, test } from 'bun:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import i18n from '@/i18n';
import { ClaudeResetChooser } from '@/features/quota/providers/claude/ClaudeResetChooser';
import type { ResetGrantChoice } from '@/features/quota/providers/claude/selectResetGrant';
import type { AnthropicResetGrant } from '@/services/api/claudeResetGrants';

const day = 86400_000;
const grant = (overrides: Partial<AnthropicResetGrant>): AnthropicResetGrant => ({
  id: 'weekly',
  label: '',
  resetsTotal: 1,
  resetsLeft: 1,
  startsAt: null,
  endsAt: new Date(Date.now() + 29 * day + 3600_000).toISOString(),
  clears: ['seven_day'],
  paused: false,
  usableNow: true,
  useRequiresLimit: false,
  percentUsed: {},
  kind: 'weekly',
  ...overrides,
});
const render = (choices: ResetGrantChoice[]) =>
  renderToStaticMarkup(
    createElement(ClaudeResetChooser, {
      name: 'claude-a.json',
      choices,
      onUse: async () => {},
    })
  );

beforeAll(async () => {
  await i18n.changeLanguage('en');
});

describe('Claude reset chooser', () => {
  test('lists each usable kind as a row with its own Use button, soonest first', () => {
    const weekly = grant({});
    const fable = grant({
      id: 'fable',
      kind: 'fable',
      endsAt: new Date(Date.now() + 117 * day + 3600_000).toISOString(),
    });
    const markup = render([
      { grant: weekly, count: 1 },
      { grant: fable, count: 2 },
    ]);
    expect(markup).not.toContain('type="radio"');
    expect(markup.match(/<button/g)).toHaveLength(2);
    // Each button says which reset it spends to a screen reader; the visible label stays short.
    expect(markup).toContain('aria-label="Use Weekly reset"');
    expect(markup).toContain('aria-label="Use Fable reset"');
    expect(markup.indexOf('Weekly reset')).toBeLessThan(markup.indexOf('Fable reset × 2'));
    expect(markup).toContain('Pick which reset to spend.');
    // A grouped row says a use spends one of them.
    expect(markup).toContain('in 117 days · Uses 1 of 2');
    // What a Fable reset does shows before it is used.
    expect(markup).toContain('returns what Fable models used');
    expect(markup).toContain('This can&#x27;t be undone.');
  });

  test('a single choice is one row with its button', () => {
    const markup = render([{ grant: grant({ endsAt: null }), count: 1 }]);
    expect(markup.match(/<button/g)).toHaveLength(1);
    expect(markup).toContain('Weekly reset');
    expect(markup).toContain('No expiry date');
    expect(markup).toContain('Spend one reset to clear eligible usage limits');
  });
});
