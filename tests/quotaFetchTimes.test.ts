import { describe, expect, test } from 'bun:test';
import { createQuotaStore } from '../src/stores/useQuotaStore';
import type { CodexQuotaState } from '../src/types';

const loading = { status: 'loading', windows: [] } as unknown as CodexQuotaState;
const success = { status: 'success', windows: [] } as unknown as CodexQuotaState;
const failed = { status: 'error', windows: [], error: 'x' } as unknown as CodexQuotaState;

describe('quota store read times', () => {
  test('a read that lands (loading, then success) is stamped with the time it landed', () => {
    let now = 5_000;
    const store = createQuotaStore(() => now);
    store.getState().setCodexQuota({ 'a.json': loading });
    expect(store.getState().fetchedAt['a.json']).toBeUndefined();
    now = 7_000;
    store.getState().setCodexQuota((prev) => ({ ...prev, 'a.json': success }));
    expect(store.getState().fetchedAt['a.json']).toBe(7_000);
  });

  test('a later rewrite of the same success (enrichment) keeps the original time', () => {
    let now = 1_000;
    const store = createQuotaStore(() => now);
    store.getState().setCodexQuota({ 'a.json': loading });
    store.getState().setCodexQuota({ 'a.json': success });
    now = 40_000;
    store.getState().setCodexQuota({ 'a.json': { ...success } });
    expect(store.getState().fetchedAt['a.json']).toBe(1_000);
  });

  test('a failed read forgets the time, so the next refresh reads it again', () => {
    const store = createQuotaStore(() => 1_000);
    store.getState().setCodexQuota({ 'a.json': loading });
    store.getState().setCodexQuota({ 'a.json': success });
    store.getState().setCodexQuota({ 'a.json': loading });
    store.getState().setCodexQuota({ 'a.json': failed });
    expect(store.getState().fetchedAt['a.json']).toBeUndefined();
  });

  test('clearing a credential or the whole cache clears its time', () => {
    const store = createQuotaStore(() => 1_000);
    store.getState().setCodexQuota({ 'a.json': loading, 'b.json': loading });
    store.getState().setCodexQuota({ 'a.json': success, 'b.json': success });
    store.getState().clearQuotaCache(['a.json']);
    expect(store.getState().fetchedAt).toEqual({ 'b.json': 1_000 });
    store.getState().clearQuotaCache();
    expect(store.getState().fetchedAt).toEqual({});
  });
});
