import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import {
  AUTH_FILES_CHANGED_EVENT,
  notifyAuthFilesChanged,
} from '../src/features/authFiles/authFilesEvents';
import { createAuthFilesApi } from '../src/services/api/authFiles';
import type { SourceOwner, SourceSession } from '../src/services/api/sourceSession';
import {
  useCredentialInventoryStore,
  type CredentialChange,
  type InventoryRuntime,
} from '../src/stores/useCredentialInventoryStore';

const owner: SourceOwner = { instanceId: 'codex-primary', sessionEpoch: 0, sourceGeneration: 1 };
const previousWindow = (globalThis as { window?: unknown }).window;
let events: { type: string; detail: unknown }[];
let log: string[];
let syncGate: Promise<void> | undefined;
let syncFails = false;

function runtime(): InventoryRuntime {
  return {
    sources: () => [
      {
        instanceId: owner.instanceId,
        owner,
        list: async () => {
          log.push('list');
          return [];
        },
      },
    ],
    readVersion: async () => ({ status: 'changed', version: 'v1' }),
    sync: async (change: CredentialChange) => {
      log.push(`sync:${change.reason}:${(change.deletedNames ?? []).join(',')}`);
      await syncGate;
      if (syncFails) throw new Error('sync failed');
    },
    visible: () => true,
    onVisibilityChange: () => () => {},
    every: () => () => {},
    channel: { post: () => log.push('broadcast'), subscribe: () => () => {}, close: () => {} },
  };
}

beforeEach(() => {
  events = [];
  log = [];
  syncGate = undefined;
  syncFails = false;
  const target = new EventTarget();
  (globalThis as { window?: unknown }).window = {
    dispatchEvent: (event: Event) => {
      events.push({ type: event.type, detail: (event as CustomEvent).detail });
      log.push(`event:${event.type}`);
      return true;
    },
    addEventListener: target.addEventListener.bind(target),
  };
  useCredentialInventoryStore.getState().reset();
  useCredentialInventoryStore.getState().configure(runtime());
});
afterEach(() => {
  useCredentialInventoryStore.getState().configure(null);
  (globalThis as { window?: unknown }).window = previousWindow;
});

describe('notifyAuthFilesChanged', () => {
  test('syncs the server, refreshes the store, tells other tabs, then raises the window event', async () => {
    await notifyAuthFilesChanged(owner, { reason: 'delete', deletedNames: ['a.json'] });
    expect(log).toEqual([
      'sync:delete:a.json',
      'list',
      'broadcast',
      `event:${AUTH_FILES_CHANGED_EVENT}`,
    ]);
    expect(events).toEqual([{ type: AUTH_FILES_CHANGED_EVENT, detail: owner }]);
    expect(useCredentialInventoryStore.getState().revision).toBe(1);
  });

  test('does not resolve until the server sync has answered', async () => {
    let release: () => void = () => {};
    syncGate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let done = false;
    const pending = notifyAuthFilesChanged(owner).then(() => {
      done = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(done).toBe(false);
    expect(log).toEqual(['sync:change:']);
    release();
    await pending;
    expect(done).toBe(true);
  });

  test('never rejects, and still refreshes and raises the event, when the sync fails', async () => {
    syncFails = true;
    await expect(notifyAuthFilesChanged(owner)).resolves.toBeUndefined();
    expect(log).toContain('list');
    expect(events).toHaveLength(1);
  });

  test('works before the store is wired to a browser: only the window event is raised', async () => {
    useCredentialInventoryStore.getState().configure(null);
    await notifyAuthFilesChanged(owner);
    expect(events).toHaveLength(1);
    expect(log).toEqual([`event:${AUTH_FILES_CHANGED_EVENT}`]);
  });

  test('delete-all fires it too, after the DELETE succeeded', async () => {
    const requests: string[] = [];
    const management = {
      delete: async (url: string, config?: { params?: unknown }) => {
        requests.push(`DELETE ${url} ${JSON.stringify(config?.params)}`);
        log.push('delete-all');
        return { status: 'ok' };
      },
    };
    const session = {
      owner,
      signal: new AbortController().signal,
      management,
      assertCurrent: () => {},
    } as unknown as SourceSession;
    await createAuthFilesApi(session).deleteAll();
    expect(requests).toEqual(['DELETE /credentials {"all":true}']);
    expect(log).toEqual([
      'delete-all',
      'sync:delete:',
      'list',
      'broadcast',
      `event:${AUTH_FILES_CHANGED_EVENT}`,
    ]);
  });

  test('a failed delete-all announces nothing', async () => {
    const session = {
      owner,
      signal: new AbortController().signal,
      management: {
        delete: async () => {
          throw new Error('denied');
        },
      },
      assertCurrent: () => {},
    } as unknown as SourceSession;
    await expect(createAuthFilesApi(session).deleteAll()).rejects.toThrow('denied');
    expect(log).toEqual([]);
    expect(events).toEqual([]);
  });
});
