import { describe, expect, test } from 'bun:test';
import {
  EDIT_SESSION_TRANSITIONS,
  INITIAL_EDIT_SESSION,
  InvalidTransitionError,
  pendingGuards,
  pendingWrites,
  transitionEditSession,
  type EditSession,
  type EditSessionEvent,
  type EditSessionStatus,
} from '../src/features/authFiles/modelAccess/editSession';
import {
  IDLE_LOAD,
  LOAD_TRANSITIONS,
  transitionLoad,
  type LoadState,
} from '../src/features/authFiles/modelAccess/loadState';
import type { WriteOutcome } from '../src/features/authFiles/modelAccess/execute';
import type { WritePlan } from '../src/features/authFiles/modelAccess/writePlan';

const intent = { type: 'provider-model', model: 'm', exclude: true } as const;
const plan: WritePlan = {
  intent,
  writes: [
    { target: { kind: 'account', name: 'b.json' }, before: null, after: ['m'] },
    { target: { kind: 'provider' }, before: null, after: ['m'] },
  ],
  blocked: [],
  notices: [],
  changes: [],
  canApply: true,
};
const ok = (index: number): WriteOutcome => ({ write: plan.writes[index], status: 'ok' });
const bad = (index: number): WriteOutcome => ({
  write: plan.writes[index],
  status: 'failed',
  message: 'no',
});

const applying = { plan, operation: 'apply' as const, undo: [] };
const undoing = { plan, operation: 'rollback' as const, outcomes: [bad(0), ok(1)] };
const STATES: Record<EditSessionStatus, EditSession> = {
  idle: INITIAL_EDIT_SESSION,
  choosing: { status: 'choosing', intent },
  previewing: { status: 'previewing', plan },
  saving: { status: 'saving', ...applying, outcomes: [] },
  saved: { status: 'saved', ...applying, outcomes: [ok(0), ok(1)], refresh: 'ok' },
  'partial-failure': {
    status: 'partial-failure',
    ...applying,
    outcomes: [bad(0), ok(1)],
    message: null,
    refresh: 'ok',
  },
  failed: {
    status: 'failed',
    ...applying,
    outcomes: [bad(0), bad(1)],
    message: null,
    refresh: 'ok',
  },
  stale: { status: 'stale', ...applying, outcomes: [], stale: [], refresh: 'ok' },
  'rolling-back': { status: 'rolling-back', ...undoing, undo: [] },
  'rolled-back': {
    status: 'rolled-back',
    ...undoing,
    undo: [{ write: { ...plan.writes[1], before: ['m'], after: null }, status: 'ok' }],
    refresh: 'ok',
  },
};
const EVENTS: EditSessionEvent[] = [
  { type: 'START', intent, plan },
  { type: 'CHOOSE', plan },
  { type: 'CANCEL' },
  { type: 'APPLY' },
  { type: 'SETTLED', result: { status: 'saved', outcomes: [ok(0), ok(1)] } },
  { type: 'ERROR', message: 'read refused' },
  { type: 'RETRY' },
  { type: 'ROLLBACK' },
  { type: 'REPLAN', plan },
  { type: 'DISMISS' },
  { type: 'REFRESH' },
  { type: 'REFRESHED', ok: false },
];

describe('model edit session', () => {
  test('the happy path: preview, apply, saved, dismiss', () => {
    let state = transitionEditSession(INITIAL_EDIT_SESSION, { type: 'START', intent, plan });
    expect(state.status).toBe('previewing');
    state = transitionEditSession(state, { type: 'APPLY' });
    expect(state).toMatchObject({ status: 'saving', operation: 'apply' });
    state = transitionEditSession(state, {
      type: 'SETTLED',
      result: { status: 'saved', outcomes: [ok(0), ok(1)] },
    });
    expect(state.status).toBe('saved');
    expect(transitionEditSession(state, { type: 'DISMISS' }).status).toBe('idle');
  });

  test('an inheriting account starts in choosing', () => {
    const state = transitionEditSession(INITIAL_EDIT_SESSION, {
      type: 'START',
      intent,
      plan: null,
    });
    expect(state).toEqual({ status: 'choosing', intent });
    expect(transitionEditSession(state, { type: 'CHOOSE', plan }).status).toBe('previewing');
  });

  test('partial failure, retry merges outcomes into saved', () => {
    let state = transitionEditSession(STATES.saving, {
      type: 'SETTLED',
      result: { status: 'partial-failure', outcomes: [bad(0), ok(1)] },
    });
    expect(state.status).toBe('partial-failure');
    state = transitionEditSession(state, { type: 'RETRY' });
    expect(state).toMatchObject({ status: 'saving', operation: 'apply' });
    state = transitionEditSession(state, {
      type: 'SETTLED',
      result: { status: 'saved', outcomes: [ok(0)] },
    });
    expect(state).toMatchObject({ status: 'saved', outcomes: [ok(0), ok(1)] });
  });

  test('a retry guards the lists that already landed, on top of the plan guards', () => {
    // b.json was written, the provider write failed. If someone undoes b.json before the retry,
    // retrying only the provider write must not report "saved".
    const guard = { target: { kind: 'account' as const, name: 'c.json' }, expected: null };
    const partial = { ...applying, plan: { ...plan, guards: [guard] }, outcomes: [ok(0), bad(1)] };
    expect(pendingGuards(partial)).toEqual([
      guard,
      { target: { kind: 'account', name: 'b.json' }, expected: ['m'] },
    ]);
    // A rollback restores lists as they were and depends on no other list.
    expect(pendingGuards({ ...undoing, undo: [] })).toEqual([]);
  });

  test('a retry that fails again stays a partial failure', () => {
    const retrying: EditSession = { status: 'saving', ...applying, outcomes: [bad(0), ok(1)] };
    const state = transitionEditSession(retrying, {
      type: 'SETTLED',
      result: { status: 'failed', outcomes: [bad(0)] },
    });
    expect(state.status).toBe('partial-failure');
  });

  test('rollback: all undone is rolled-back; an undo that fails is a failed rollback', () => {
    const undone = transitionEditSession(STATES['rolling-back'], {
      type: 'SETTLED',
      result: { status: 'saved', outcomes: [ok(1)] },
    });
    expect(undone.status).toBe('rolled-back');
    const stuck = transitionEditSession(STATES['rolling-back'], {
      type: 'SETTLED',
      result: { status: 'failed', outcomes: [bad(1)] },
    });
    expect(stuck).toMatchObject({ status: 'failed', operation: 'rollback' });
  });

  test('stale aborts to stale; replan returns to preview', () => {
    const state = transitionEditSession(STATES.saving, {
      type: 'SETTLED',
      result: {
        status: 'stale',
        stale: [{ target: { kind: 'provider' }, expected: null, actual: ['x'] }],
        outcomes: [],
      },
    });
    expect(state.status).toBe('stale');
    expect(transitionEditSession(state, { type: 'REPLAN', plan }).status).toBe('previewing');
  });

  test('a thrown read while saving is failed with the message', () => {
    expect(
      transitionEditSession(STATES.saving, { type: 'ERROR', message: 'read refused' })
    ).toMatchObject({
      status: 'failed',
      message: 'read refused',
    });
  });

  // "Exclude X everywhere": the account write landed, the provider write failed; Roll back.
  const partlyApplied = (): EditSession =>
    transitionEditSession(STATES.saving, {
      type: 'SETTLED',
      result: { status: 'partial-failure', outcomes: [ok(0), bad(1)] },
    });
  const undoAccount = { target: plan.writes[0].target, before: ['m'], after: null };

  test('a rollback whose check throws stays a rollback: retry re-runs the undo only', () => {
    let state = transitionEditSession(partlyApplied(), { type: 'ROLLBACK' });
    state = transitionEditSession(state, { type: 'ERROR', message: 'read refused' });
    expect(state).toMatchObject({
      status: 'failed',
      operation: 'rollback',
      message: 'read refused',
    });
    // Never the forward provider write the user was undoing.
    expect(pendingWrites(state)).toEqual([undoAccount]);
    state = transitionEditSession(state, { type: 'RETRY' });
    expect(state.status).toBe('rolling-back');
  });

  test('a retried rollback that completes ends in rolled-back, not saved', () => {
    let state = transitionEditSession(partlyApplied(), { type: 'ROLLBACK' });
    state = transitionEditSession(state, {
      type: 'SETTLED',
      result: {
        status: 'failed',
        outcomes: [{ write: undoAccount, status: 'failed', message: 'no' }],
      },
    });
    expect(state).toMatchObject({ status: 'failed', operation: 'rollback' });
    // A rollback cannot be rolled back.
    const partlyUndone = { ...state, status: 'partial-failure' } as EditSession;
    expect(() => transitionEditSession(partlyUndone, { type: 'ROLLBACK' })).toThrow(
      InvalidTransitionError
    );
    state = transitionEditSession(state, { type: 'RETRY' });
    state = transitionEditSession(state, {
      type: 'SETTLED',
      result: { status: 'saved', outcomes: [{ write: undoAccount, status: 'ok' }] },
    });
    expect(state.status).toBe('rolled-back');
  });

  test('a stale check during a retry keeps what earlier writes did', () => {
    let state = transitionEditSession(partlyApplied(), { type: 'RETRY' });
    const stale = [{ target: plan.writes[1].target, expected: null, actual: ['x'] }];
    state = transitionEditSession(state, {
      type: 'SETTLED',
      result: { status: 'stale', stale, outcomes: [{ write: plan.writes[1], status: 'skipped' }] },
    });
    expect(state).toMatchObject({ status: 'stale', operation: 'apply', stale });
    expect(state).toMatchObject({ outcomes: [ok(0), { status: 'skipped' }] });
  });

  test('a stale rollback keeps knowing it is a rollback and cannot replan the forward intent', () => {
    let state = transitionEditSession(partlyApplied(), { type: 'ROLLBACK' });
    state = transitionEditSession(state, {
      type: 'SETTLED',
      result: {
        status: 'stale',
        stale: [{ target: undoAccount.target, expected: ['m'], actual: ['m', 'y'] }],
        outcomes: [{ write: undoAccount, status: 'skipped' }],
      },
    });
    expect(state).toMatchObject({
      status: 'stale',
      operation: 'rollback',
      outcomes: [ok(0), bad(1)],
    });
    expect(() => transitionEditSession(state, { type: 'REPLAN', plan })).toThrow(
      InvalidTransitionError
    );
  });

  test('a read that throws after earlier writes landed is a partial failure, not "nothing written"', () => {
    let state = transitionEditSession(partlyApplied(), { type: 'RETRY' });
    state = transitionEditSession(state, { type: 'ERROR', message: 'read refused' });
    expect(state).toMatchObject({
      status: 'partial-failure',
      operation: 'apply',
      message: 'read refused',
      outcomes: [ok(0), bad(1)],
    });
  });

  test('a failed re-read of the table after a write keeps the write saved', () => {
    let state = transitionEditSession(STATES.saving, {
      type: 'SETTLED',
      result: { status: 'saved', outcomes: [ok(0), ok(1)] },
    });
    expect(state).toMatchObject({ status: 'saved', refresh: 'running' });
    state = transitionEditSession(state, { type: 'REFRESHED', ok: false });
    expect(state).toMatchObject({ status: 'saved', refresh: 'failed', outcomes: [ok(0), ok(1)] });
    state = transitionEditSession(state, { type: 'REFRESH' });
    expect(state).toMatchObject({ status: 'saved', refresh: 'running' });
  });

  // Exhaustive: every (state, event) pair is either in the table or throws a named error.
  for (const [status, state] of Object.entries(STATES) as Array<[EditSessionStatus, EditSession]>) {
    for (const event of EVENTS) {
      const allowed = EDIT_SESSION_TRANSITIONS[status][event.type];
      test(`${status} + ${event.type} ${allowed ? `-> ${allowed.join('|')}` : 'throws'}`, () => {
        if (allowed) {
          const result = transitionEditSession(state, event).status;
          expect(allowed).toContain(result === status ? 'self' : result);
          return;
        }
        let error: unknown;
        try {
          transitionEditSession(state, event);
        } catch (caught) {
          error = caught;
        }
        expect(error).toBeInstanceOf(InvalidTransitionError);
        expect(error).toMatchObject({
          machine: 'model-edit-session',
          from: status,
          event: event.type,
        });
        expect(String((error as Error).message)).toContain(`in state ${status}`);
      });
    }
  }
});

describe('model access load (every store slice)', () => {
  type Load = LoadState<string[]>;
  const data = ['a'];
  test('load, loaded, refresh keeps the data, failure keeps it too', () => {
    let state: Load = transitionLoad<string[]>(IDLE_LOAD, { type: 'LOAD', generation: 1 });
    expect(state.status).toBe('loading');
    state = transitionLoad(state, { type: 'LOADED', generation: 1, data });
    expect(state.status).toBe('ready');
    state = transitionLoad(state, { type: 'LOAD', generation: 2 });
    expect(state).toMatchObject({ status: 'refreshing', data });
    state = transitionLoad(state, { type: 'FAILED', generation: 2, message: 'boom' });
    expect(state).toMatchObject({ status: 'error', message: 'boom', unsupported: false, data });
    expect(transitionLoad(state, { type: 'LOAD', generation: 3 }).status).toBe('refreshing');
  });

  test('a response from a superseded request is dropped', () => {
    let state: Load = transitionLoad<string[]>(IDLE_LOAD, { type: 'LOAD', generation: 1 });
    state = transitionLoad(state, { type: 'LOAD', generation: 2 });
    expect(transitionLoad(state, { type: 'LOADED', generation: 1, data })).toBe(state);
    expect(transitionLoad(state, { type: 'FAILED', generation: 1, message: 'old' })).toBe(state);
  });

  test('a first load that fails has no data; a missing route is marked unsupported', () => {
    let state: Load = transitionLoad<string[]>(IDLE_LOAD, { type: 'LOAD', generation: 1 });
    state = transitionLoad(state, {
      type: 'FAILED',
      generation: 1,
      message: 'not found',
      unsupported: true,
    });
    expect(state).toEqual({
      status: 'error',
      generation: 1,
      message: 'not found',
      unsupported: true,
      data: null,
    });
    expect(transitionLoad(state, { type: 'LOAD', generation: 2 }).status).toBe('loading');
  });

  test('LOADED in a settled state is an invalid transition that names machine, state and event', () => {
    const ready: Load = { status: 'ready', generation: 4, data };
    expect(LOAD_TRANSITIONS.ready.LOADED).toBeUndefined();
    expect(() => transitionLoad(ready, { type: 'LOADED', generation: 4, data })).toThrow(
      'model-access-load: event LOADED is not allowed in state ready'
    );
  });
});
