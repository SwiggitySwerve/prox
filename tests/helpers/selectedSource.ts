import { spyOn } from 'bun:test';
import { createElement, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import { SelectedSourceBoundary } from '@/components/sources/SelectedSourceBoundary';
import { SourceSessions } from '@/services/api/sourceSession';
import { providerSources } from '@/stores/useProviderSources';

/** Render destination-owned components with a real session boundary and no network effects. */
export function renderInSelectedSource(children: ReactNode): string {
  const sessions = new SourceSessions();
  const source = {
    instanceId: 'test',
    label: 'Test source',
    apiBase: 'https://source.invalid',
    publicBasePath: '',
    aliases: [],
    authScope: 'test',
  };
  sessions.configure([
    { ...source, managementKey: 'fixture-management', configurationRevision: '1' },
  ]);
  const snapshot = spyOn(providerSources, 'getSnapshot').mockReturnValue({
    status: 'ready',
    resolution: { mode: 'external', revision: '1', selectedInstanceId: 'test', sources: [source] },
    sources: [
      {
        source,
        session: sessions.captureSource('test'),
        status: 'ready',
        version: null,
        supportsPlugin: false,
      },
    ],
  });
  try {
    return renderToStaticMarkup(
      createElement(MemoryRouter, null, createElement(SelectedSourceBoundary, { children }))
    );
  } finally {
    snapshot.mockRestore();
    sessions.reset();
  }
}
