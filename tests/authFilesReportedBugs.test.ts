import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import {
  buildAuthFileFieldsPatch,
  type PrefixProxyEditorState,
} from '../src/features/authFiles/hooks/useAuthFilesPrefixProxyEditor';

const read = (path: string) => readFileSync(path, 'utf8');

describe('B1: batch enable/disable never leaves an unhandled rejection', () => {
  test('batchSetStatus handles a throw from its guarded section', () => {
    const source = read('src/features/authFiles/hooks/useAuthFilesData.ts');
    const body = source.slice(
      source.indexOf('const batchSetStatus = useCallback('),
      source.indexOf('const batchDownload = useCallback(')
    );
    // The body awaits the writes and then calls assertCurrent(), which throws when the source
    // changed meanwhile; without a catch that surfaces as an unhandled rejection in the handler.
    expect(body).toContain('sourceScope.assertCurrent()');
    expect(body).toMatch(/\} catch \(/);
    // A changed source is silent (the new view owns the screen); anything else is reported.
    expect(body).toMatch(/catch \([^)]*\) \{\s*if \(!sourceScope\.isCurrent\(\)\) return;/);
  });
});

describe('B2: the models dialog shows the effective state, not a provider-list guess', () => {
  test('the provider-list-only check is gone and the dialog resolves cells like the matrix', () => {
    expect(read('src/features/authFiles/constants.ts')).not.toContain('isModelExcluded');
    const dialog = read('src/features/authFiles/components/AuthFileModelsModal.tsx');
    expect(dialog).toContain('buildMatrix(inventory)');
    expect(dialog).toContain('useSourceModelAccess(');
    expect(dialog).not.toContain('getModelsForAuthFile');
  });
});

describe('B3: the credential sheet never writes excluded_models', () => {
  // An account's exclusion list has one editor: the Models screen (preview, stale check, rollback).
  // The sheet only summarizes it, so saving any other field must neither send nor clear the list.
  const editor = (json: Record<string, unknown>, extra: Record<string, unknown> = {}) =>
    ({
      fileName: 'a.json',
      json,
      providerKey: 'claude',
      prefix: '',
      proxyUrl: '',
      priority: '',
      weight: '',
      note: '',
      headersText: '',
      ...extra,
    }) as unknown as PrefixProxyEditorState;

  test('saving other fields sends no excluded_models, in either spelling', () => {
    for (const json of [
      { excluded_models: ['claude-3-*'] },
      { 'excluded-models': ['claude-3-*'] },
      { excluded_models: 'claude-3-*, claude-2' },
      {},
    ]) {
      const patch = buildAuthFileFieldsPatch(
        editor(json, {
          prefix: 'team',
          proxyUrl: 'http://proxy.invalid',
          priority: '5',
          note: 'n',
          noteTouched: true,
          disableCooling: true,
          disableCoolingTouched: true,
          // A stale editor state from an older build must not leak into the patch either.
          excludedModelsText: '',
          excludedModelsTouched: true,
        }),
        (key) => key
      );
      expect(patch).toEqual({
        prefix: 'team',
        proxy_url: 'http://proxy.invalid',
        priority: 5,
        note: 'n',
        disable_cooling: true,
      });
    }
  });

  test('the editor has no exclusion field, write path or stale check of its own', () => {
    const source = read('src/features/authFiles/hooks/useAuthFilesPrefixProxyEditor.ts');
    expect(source).not.toContain('excludedModels');
    expect(source).not.toContain('excluded_models');
    expect(source).not.toContain('checkAccountListFresh');
    expect(source).not.toContain('readAccountExcludedModels');
  });
});
