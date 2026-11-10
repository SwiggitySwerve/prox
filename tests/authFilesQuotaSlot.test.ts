import { describe, expect, test } from 'bun:test';
import {
  INITIAL_PAGE_QUOTA_REFRESH,
  pageQuotaRefreshReducer,
  quotaRefreshTargets,
  quotaUnavailableReason,
  selectQuotaSlotState,
  type PageQuotaRefresh,
  type PageQuotaRefreshEvent,
} from '@/features/authFiles/quotaSlot';
import type { AuthFileItem } from '@/types';

const claude: AuthFileItem = { name: 'claude-a.json', type: 'claude', authIndex: 'a-0' };
const disabled: AuthFileItem = { ...claude, name: 'claude-b.json', disabled: true };
const runtime: AuthFileItem = { ...claude, name: 'runtime', runtime_only: true };
const gemini: AuthFileItem = { name: 'gemini.json', type: 'gemini-cli' };
const codex: AuthFileItem = { name: 'codex.json', type: 'codex', authIndex: 'b-0' };

describe('which shown credentials can have quota', () => {
  test('disabled, runtime-only and unsupported providers are left out, each with its reason', () => {
    expect(quotaUnavailableReason(claude, 'all')).toBeNull();
    expect(quotaUnavailableReason(disabled, 'all')).toBe('disabled');
    expect(quotaUnavailableReason(runtime, 'all')).toBe('runtime');
    expect(quotaUnavailableReason(gemini, 'all')).toBe('unsupported');
    expect(quotaUnavailableReason({ ...disabled, disabled: 'true' }, 'all')).toBe('disabled');
  });

  test('targets keep the shown order and carry the quota type', () => {
    const targets = quotaRefreshTargets([gemini, codex, runtime, claude, disabled], 'all');
    expect(targets.map((entry) => [entry.file.name, entry.type])).toEqual([
      ['codex.json', 'codex'],
      ['claude-a.json', 'claude'],
    ]);
  });

  test('a provider tab narrows the targets to that provider', () => {
    expect(quotaRefreshTargets([codex, claude], 'codex').map((entry) => entry.type)).toEqual([
      'codex',
    ]);
  });
});

describe('quota slot state', () => {
  test('a credential that cannot have quota always shows "no quota", whatever is cached', () => {
    expect(selectQuotaSlotState({ reason: 'disabled', status: 'success', hasData: true })).toEqual({
      kind: 'unavailable',
      reason: 'disabled',
    });
  });

  test('nothing loaded, loading, loaded and failed', () => {
    expect(selectQuotaSlotState({ reason: null, status: undefined, hasData: false })).toEqual({
      kind: 'idle',
    });
    expect(selectQuotaSlotState({ reason: null, status: 'idle', hasData: false }).kind).toBe(
      'idle'
    );
    expect(selectQuotaSlotState({ reason: null, status: 'loading', hasData: false }).kind).toBe(
      'loading'
    );
    expect(selectQuotaSlotState({ reason: null, status: 'success', hasData: true })).toEqual({
      kind: 'loaded',
      refreshing: false,
      stale: false,
    });
    expect(selectQuotaSlotState({ reason: null, status: 'error', hasData: false }).kind).toBe(
      'failed'
    );
  });

  test('retained data stays on screen while it reloads or after a failed reload', () => {
    expect(selectQuotaSlotState({ reason: null, status: 'loading', hasData: true })).toEqual({
      kind: 'loaded',
      refreshing: true,
      stale: false,
    });
    expect(selectQuotaSlotState({ reason: null, status: 'error', hasData: true })).toEqual({
      kind: 'loaded',
      refreshing: false,
      stale: true,
    });
  });
});

describe('page-wide quota refresh progress', () => {
  const run = (
    events: PageQuotaRefreshEvent[],
    from: PageQuotaRefresh = INITIAL_PAGE_QUOTA_REFRESH
  ) => events.reduce(pageQuotaRefreshReducer, from);

  test('counts settled and failed cards up to the total, then finishes', () => {
    const running = run([
      { type: 'start', total: 3 },
      { type: 'settled', ok: true },
      { type: 'settled', ok: false },
    ]);
    expect(running).toEqual({ status: 'running', total: 3, settled: 2, failed: 1 });
    expect(run([{ type: 'settled', ok: true }, { type: 'finish' }], running)).toEqual({
      status: 'done',
      total: 3,
      settled: 3,
      failed: 1,
    });
  });

  test('never counts past the total, and ignores results outside a run', () => {
    const state = run([
      { type: 'settled', ok: false },
      { type: 'start', total: 1 },
      { type: 'settled', ok: true },
      { type: 'settled', ok: false },
    ]);
    expect(state).toEqual({ status: 'running', total: 1, settled: 1, failed: 0 });
  });

  test('a second start while running is ignored; a new run after one finished resets', () => {
    const running = run([{ type: 'start', total: 2 }]);
    expect(pageQuotaRefreshReducer(running, { type: 'start', total: 9 })).toBe(running);
    const done = run([{ type: 'settled', ok: false }, { type: 'finish' }], running);
    expect(pageQuotaRefreshReducer(done, { type: 'start', total: 4 })).toEqual({
      status: 'running',
      total: 4,
      settled: 0,
      failed: 0,
    });
  });

  test('a run with nothing to load does not start', () => {
    expect(pageQuotaRefreshReducer(INITIAL_PAGE_QUOTA_REFRESH, { type: 'start', total: 0 })).toBe(
      INITIAL_PAGE_QUOTA_REFRESH
    );
  });
});
