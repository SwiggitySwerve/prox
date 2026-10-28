import { expect, test } from 'bun:test';
import {
  createQuotaStore,
  captureQuotaCacheGeneration,
  commitIfQuotaCacheCurrent,
} from '../src/stores/useQuotaStore';
test('identical filenames have independent quota cache generations', () => {
  const a = createQuotaStore();
  const b = createQuotaStore();
  const pendingA = captureQuotaCacheGeneration('same.json', a);
  const pendingB = captureQuotaCacheGeneration('same.json', b);
  a.getState().clearQuotaCache(['same.json']);
  expect(commitIfQuotaCacheCurrent(pendingA, () => {})).toBe(false);
  expect(commitIfQuotaCacheCurrent(pendingB, () => {})).toBe(true);
  b.getState().clearQuotaCache();
  expect(commitIfQuotaCacheCurrent(pendingB, () => {})).toBe(false);
});
