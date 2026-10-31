import { expect, test } from 'bun:test';
import {
  isHeaderRefreshBusy,
  markHeaderRefreshBusy,
  registerHeaderRefresh,
  triggerHeaderRefresh,
} from '../src/hooks/useHeaderRefresh';
test('refresh enumerates a frozen subscription snapshot and cleans up each owner', async () => {
  const calls: string[] = [];
  const removeA = registerHeaderRefresh(() => {
    calls.push('a');
  });
  const removeB = registerHeaderRefresh(() => {
    calls.push('b');
    throw new Error('b failed');
  });
  try {
    await expect(triggerHeaderRefresh()).rejects.toThrow('b failed');
    expect(calls).toEqual(['a', 'b']);
    removeB();
    calls.length = 0;
    await triggerHeaderRefresh();
    expect(calls).toEqual(['a']);
  } finally {
    removeA();
    removeB();
  }
});
test('the header stays busy while any page reports work in flight', () => {
  expect(isHeaderRefreshBusy()).toBe(false);
  const releaseA = markHeaderRefreshBusy();
  const releaseB = markHeaderRefreshBusy();
  expect(isHeaderRefreshBusy()).toBe(true);
  releaseA();
  expect(isHeaderRefreshBusy()).toBe(true);
  releaseB();
  releaseB();
  expect(isHeaderRefreshBusy()).toBe(false);
});
