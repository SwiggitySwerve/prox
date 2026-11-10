import { describe, expect, test } from 'bun:test';
import {
  EDIT_SESSION_TRANSITIONS,
  INITIAL_EDIT_SESSION,
  InvalidTransitionError,
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

const STATES: Record<EditSessionStatus, EditSession> = {
  idle: INITIAL_EDIT_SESSION,
  choosing: { status: 'choosing', intent },
  previewing: { status: 'previewing', plan },
  saving: { status: 'saving', plan, operation: 'apply', outcomes: [] },
  saved: { status: 'saved', plan, outcomes: [ok(0), ok(1)] },
  'partial-failure': {
    status: 'partial-failure',
    plan,
    outcomes: [bad(0), ok(1)],
    rollback: false,
  },
  failed: { status: 'failed', plan, outcomes: [bad(0), bad(1)], message: null },
  stale: { status: 'stale', plan, stale: [] },
  'rolling-back': { status: 'rolling-back', plan, outcomes: [bad(0), ok(1)] },
  'rolled-back': { status: 'rolled-back', plan, outcomes: [ok(1)] },
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
    expect(state).toMatchObject({ status: 'saving', operation: 'retry' });
    state = transitionEditSession(state, {
      type: 'SETTLED',
      result: { status: 'saved', outcomes: [ok(0)] },
    });
    expect(state).toMatchObject({ status: 'saved', outcomes: [ok(0), ok(1)] });
  });

  test('a retry that fails again stays a partial failure', () => {
    const retrying: EditSession = {
      status: 'saving',
      plan,
      operation: 'retry',
      outcomes: [bad(0), ok(1)],
    };
    const state = transitionEditSession(retrying, {
      type: 'SETTLED',
      result: { status: 'failed', outcomes: [bad(0)] },
    });
    expect(state.status).toBe('partial-failure');
  });

  test('rollback: all undone is rolled-back; an undo that fails is a partial failure', () => {
    const undone = transitionEditSession(STATES['rolling-back'], {
      type: 'SETTLED',
      result: { status: 'saved', outcomes: [ok(1)] },
    });
    expect(undone.status).toBe('rolled-back');
    const stuck = transitionEditSession(STATES['rolling-back'], {
      type: 'SETTLED',
      result: { status: 'failed', outcomes: [bad(1)] },
    });
    expect(stuck).toMatchObject({ status: 'partial-failure', rollback: true });
  });

  test('stale aborts to stale; replan returns to preview', () => {
    const state = transitionEditSession(STATES.saving, {
      type: 'SETTLED',
      result: {
        status: 'stale',
        stale: [{ target: { kind: 'provider' }, expected: null, actual: ['x'] }],
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

  // Exhaustive: every (state, event) pair is either in the table or throws a named error.
  for (const [status, state] of Object.entries(STATES) as Array<[EditSessionStatus, EditSession]>) {
    for (const event of EVENTS) {
      const allowed = EDIT_SESSION_TRANSITIONS[status][event.type];
      test(`${status} + ${event.type} ${allowed ? `-> ${allowed.join('|')}` : 'throws'}`, () => {
        if (allowed) {
          expect(allowed).toContain(transitionEditSession(state, event).status);
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
