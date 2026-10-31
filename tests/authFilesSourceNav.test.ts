import { describe, expect, test } from 'bun:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { I18nextProvider } from 'react-i18next';
import { createInstance } from 'i18next';
import en from '@/i18n/locales/en.json';
import { AuthFilesSourceNav } from '@/features/authFiles/components/AuthFilesSourceNav';
import type { SourceView } from '@/services/providerSources/registry';

const view = (instanceId: string, label: string) =>
  ({ source: { instanceId, label } }) as unknown as SourceView;

function render(sources: SourceView[]) {
  const i18n = createInstance({ lng: 'en', resources: { en: { translation: en } } });
  void i18n.init();
  return renderToStaticMarkup(
    createElement(I18nextProvider, { i18n }, createElement(AuthFilesSourceNav, { sources }))
  );
}

describe('Auth Files source navigation', () => {
  test('names every source, so one below the fold is discoverable', () => {
    const html = render([view('codex-primary', 'GPT / Codex'), view('claude-primary', 'Claude')]);
    expect(html).toContain('GPT / Codex');
    expect(html).toContain('>Claude<');
    expect(html).toContain('aria-label="Management source"');
  });

  test('renders nothing for a single backend', () => {
    expect(render([view('external', 'host')])).toBe('');
  });
});
