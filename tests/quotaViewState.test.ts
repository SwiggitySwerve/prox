import { describe, expect, test } from 'bun:test';
import {
  DEFAULT_VIEW_STATE,
  readViewState,
  writeViewState,
} from '../src/features/quotaPool/model/viewState';

describe('quota view state in the address', () => {
  test('an empty address is the default view', () => {
    expect(readViewState(new URLSearchParams())).toEqual(DEFAULT_VIEW_STATE);
  });
  test('reads every allowed value and ignores anything else', () => {
    expect(
      readViewState(
        new URLSearchParams('provider=codex&window=five-hour&mode=burn&lookback=6&future=0.5')
      )
    ).toEqual({ provider: 'codex', window: 'five-hour', mode: 'burn', lookback: 6, future: 0.5 });
    // Unknown or malformed values fall back to the default instead of reaching the server.
    expect(
      readViewState(
        new URLSearchParams('provider=gemini&window=daily&mode=x&lookback=24&future=9&offset=3')
      )
    ).toEqual(DEFAULT_VIEW_STATE);
    expect(readViewState(new URLSearchParams('future=0')).future).toBe(0);
  });
  test('writes only non-default values and keeps unrelated parameters', () => {
    const next = writeViewState(new URLSearchParams('source=remote-1&mode=drain'), {
      ...DEFAULT_VIEW_STATE,
      window: 'five-hour',
      future: 2,
    });
    expect(next.get('source')).toBe('remote-1');
    expect(next.get('window')).toBe('five-hour');
    expect(next.get('future')).toBe('2');
    // Back at its default, a key leaves the address, so the plain URL stays canonical.
    expect(next.has('mode')).toBe(false);
    expect(next.has('provider')).toBe(false);
    expect(writeViewState(new URLSearchParams(), DEFAULT_VIEW_STATE).toString()).toBe('');
  });
  test('round-trips every view', () => {
    const view = {
      provider: 'claude',
      window: 'weekly',
      mode: 'drain',
      lookback: 1,
      future: 0,
    } as const;
    expect(readViewState(writeViewState(new URLSearchParams(), view))).toEqual(view);
  });
});
