import { createElement, type ReactNode } from 'react';
import { AuthFilesSourceProvider } from '@/features/authFiles/AuthFilesSourceContext';
import { ProviderSourceProvider } from '@/features/providers/ProviderSourceContext';
import type { ManagementTransport, SourceSession } from '@/services/api/sourceSession';

/** A hub that refuses every request: static-markup tests must not reach the network. */
const refuse = (verb: string) => async () => {
  throw new Error(`Unexpected ${verb}`);
};
const transport: ManagementTransport = {
  get: refuse('GET'),
  post: refuse('POST'),
  put: refuse('PUT'),
  patch: refuse('PATCH'),
  delete: refuse('DELETE'),
  getRaw: refuse('raw GET'),
  postForm: refuse('form'),
};

export const fixtureSource = {
  instanceId: 'test',
  label: 'Test',
  apiBase: 'https://source.invalid',
  publicBasePath: '',
  aliases: [],
  authScope: 'test',
};

export const fixtureSession: SourceSession = {
  owner: { instanceId: 'test', sessionEpoch: 1, sourceGeneration: 1 },
  signal: new AbortController().signal,
  assertCurrent: () => {},
  management: transport,
};

/** Provider forms and sheets read their hub from this context. */
export const inProviderSource = (children: ReactNode) =>
  createElement(ProviderSourceProvider, {
    source: fixtureSource,
    session: fixtureSession,
    children,
  });

/** Auth-file sheets and cards read their hub from this context. */
export const inAuthFilesSource = (children: ReactNode) =>
  createElement(AuthFilesSourceProvider, {
    source: fixtureSource,
    session: fixtureSession,
    children,
  });
