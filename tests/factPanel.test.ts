import { beforeAll, expect, test } from 'bun:test';
import { createElement as h } from 'react';
import { renderToStaticMarkup as render } from 'react-dom/server';
import { Fact, FactPanel, FactSection } from '../src/components/ui/FactPanel';
import i18n from '../src/i18n';
beforeAll(() => i18n.changeLanguage('en'));
test('Fact renders all four states with visible basis or reason', () => {
  const markup = render(
    h(
      FactPanel,
      null,
      h(FactSection, {
        title: 'Billing',
        children: [
          h(Fact, { key: 'known', label: 'Renews', state: 'known', value: 'Nov 13' }),
          h(Fact, {
            key: 'estimate',
            label: 'Renews',
            state: 'estimated',
            value: 'Nov 14',
            basis: 'Monthly anniversary',
          }),
          h(Fact, {
            key: 'missing',
            label: 'Subscription',
            state: 'notReported',
            reason: 'Provider has not reported billing',
          }),
          h(Fact, {
            key: 'na',
            label: 'Subscription',
            state: 'notApplicable',
            reason: 'No paid plan',
          }),
        ],
      })
    )
  );
  expect(markup).toContain('<dl><div');
  expect(markup).toContain('<dt>Renews</dt><dd>');
  for (const word of [
    'Nov 13',
    'Estimated',
    'Monthly anniversary',
    'Not reported',
    'Provider has not reported billing',
    'No paid plan',
  ])
    expect(markup).toContain(word);
  expect(markup).not.toContain('title=');
  expect(markup).not.toContain('—');
});
test('FactPanel rejects a second accent section', () => {
  expect(() =>
    render(
      h(
        FactPanel,
        null,
        [1, 2].map((n) =>
          h(FactSection, { key: n, title: 'Reset', tone: 'accent', children: null })
        )
      )
    )
  ).toThrow('at most one accent');
});
test('section action has contextual name and describes its always visible note', () => {
  const markup = render(
    h(FactSection, {
      title: 'Manual resets',
      tone: 'accent',
      action: { label: 'Use reset', context: 'for Ada', disabled: true, onClick: () => {} },
      note: 'Usable once a limit is reached',
      children: h(Fact, { label: 'Held', state: 'known', value: '2 held' }),
    })
  );
  const id = markup.match(/aria-describedby="([^"]+)"/)![1];
  expect(markup).toContain(`id="${id}" role="status"`);
  expect(markup).toContain('Usable once a limit is reached');
  expect(markup).toContain(' for Ada');
  expect(markup).toContain('disabled=""');
});

test('overdue fact pairs the critical tone and icon with visible payment text', () => {
  const markup = render(
    h(Fact, { label: 'Payment', state: 'known', value: 'Payment overdue', tone: 'overdue' })
  );
  expect(markup).toContain('data-tone="overdue"');
  expect(markup).toContain('<svg');
  expect(markup).toContain('aria-hidden="true"');
  expect(markup).toContain('Payment overdue');
});
