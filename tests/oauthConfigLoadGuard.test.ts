import { beforeAll, describe, expect, test } from 'bun:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import i18n from '../src/i18n/index';
import { ModelAccessSummary } from '../src/features/authFiles/components/ModelAccessSummary';
import { OAuthModelAliasCard } from '../src/features/authFiles/components/OAuthModelAliasCard';

const noop = () => {};
const noopAsync = async () => {};

describe('OAuth configuration load guards', () => {
  // Assertions read English copy; do not depend on another test having switched the language.
  beforeAll(async () => {
    await i18n.changeLanguage('en');
  });

  // The provider-list card became the model-access summary; writes moved to the Models screen.
  const summary = (excludedError: 'loading' | 'load' | 'unsupported' | null) =>
    renderToStaticMarkup(
      createElement(ModelAccessSummary, {
        providers: ['claude'],
        excluded: { claude: ['claude-3-*', 'claude-sonnet-4-0'] },
        excludedError,
        modelAlias: { claude: [{ name: 'claude-opus-4-5', alias: 'opus' }] },
        onRetry: noop,
        onOpen: noop,
      })
    );

  test('after a load failure the summary offers retry and shows no stale counts', () => {
    const markup = summary('load');
    expect(markup).toContain('data-state="load"');
    expect(markup).toContain('role="alert"');
    expect(markup).toContain('Try again');
    expect(markup).not.toContain('Provider rules: 2');
  });

  test('loading, unsupported and ready are distinct, named states', () => {
    expect(summary('loading')).toContain('data-state="loading"');
    expect(summary('loading')).toContain('role="status"');
    expect(summary('unsupported')).toContain('data-state="unsupported"');
    const ready = summary(null);
    expect(ready).toContain('data-state="ready"');
    expect(ready).toContain('Provider rules: 2');
    expect(ready).toContain('Aliases: 1');
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
