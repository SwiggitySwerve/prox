import { beforeAll, describe, expect, test } from 'bun:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import i18n from '../src/i18n/index';
import { OAuthModelAliasCard } from '../src/features/authFiles/components/OAuthModelAliasCard';

const noop = () => {};
const noopAsync = async () => {};

describe('OAuth configuration load guards', () => {
  // Assertions read English copy; do not depend on another test having switched the language.
  beforeAll(async () => {
    await i18n.changeLanguage('en');
  });

  test('disables model-alias writes and exposes retry after a load failure', () => {
    const markup = renderToStaticMarkup(
      createElement(OAuthModelAliasCard, {
        disableControls: false,
        viewMode: 'list',
        onViewModeChange: noop,
        onRetry: noop,
        onAdd: noop,
        onEditProvider: noop,
        onDeleteProvider: noop,
        modelAliasError: 'load',
        modelAlias: {},
        allProviderModels: {},
        onUpdate: noopAsync,
        onDeleteLink: noop,
        onToggleFork: noopAsync,
        onRenameAlias: noopAsync,
        onDeleteAlias: noop,
      })
    );

    expect(markup).toContain('disabled=""');
    expect(markup).toContain('empty-action');
  });
});
