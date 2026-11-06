import { expect, test } from 'bun:test';
import { readAccountResets, withCodexCreditDetails } from '../server/quota/resets';

const NOW = Date.UTC(2026, 10, 3);
const grant = {
  id: 'held',
  resets_total: 3,
  resets_left: 3,
  usable_now: true,
  use_requires_limit: true,
};
const claude = (patch = {}, grantPatch = {}) =>
  readAccountResets(
    'claude',
    {
      cedar_ember: {
        eligible: true,
        at_limit: true,
        grants: [{ ...grant, ...grantPatch }],
        ...patch,
      },
    },
    NOW
  );

test('Claude counts all held resets but only started, unexpired, unpaused usable grants', () => {
  expect(claude()?.usable).toBe(3);
  expect(claude({}, { starts_at: new Date(NOW + 1).toISOString() })?.usable).toBe(0);
  expect(claude({}, { ends_at: new Date(NOW).toISOString() })?.usable).toBe(0);
  expect(claude({}, { usable_now: false })?.usable).toBe(0);
  expect(claude({}, { paused: true })).toMatchObject({
    available: 3,
    usable: 0,
    blocker: 'paused',
  });
  expect(claude({ cooldown_until: new Date(NOW + 1).toISOString() })).toMatchObject({
    available: 3,
    usable: 0,
    blocker: 'cooldown',
  });
  expect(claude({ cooldown_until: new Date(NOW).toISOString() })?.usable).toBe(3);
  expect(claude({ at_limit: false }, { use_requires_limit: false })?.usable).toBe(3);
  const expiry = new Date(NOW + 1000).toISOString();
  expect(
    readAccountResets(
      'claude',
      {
        cedar_ember: {
          eligible: true,
          at_limit: true,
          grants: [
            { ...grant, ends_at: new Date(NOW + 2000).toISOString() },
            { ...grant, id: 'second', resets_left: 2, ends_at: expiry },
            { ...grant, id: 'empty', resets_left: 0, ends_at: new Date(NOW).toISOString() },
          ],
        },
      },
      NOW
    )
  ).toEqual({
    available: 5,
    usable: 5,
    blocker: null,
    nextExpiryAtMs: NOW + 1000,
    // One entry per held reset, soonest first: 'second' holds two that end together.
    expiries: [NOW + 1000, NOW + 1000, NOW + 2000, NOW + 2000, NOW + 2000],
    observedAtMs: NOW,
  });
  // Resets with no end date are held but list no expiry.
  expect(claude()?.expiries).toBeUndefined();
});

test('Codex clamps applicability, reads earliest available credit expiry and rejects missing counts', () => {
  const read = (block: unknown) =>
    readAccountResets('codex', { rate_limit_reset_credits: block }, NOW);
  expect(read({ available_count: 2, applicable_available_count: 4 })?.usable).toBe(2);
  expect(read({ available_count: 2, applicable_available_count: -1 })?.usable).toBe(0);
  expect(read({ available_count: 2 })).toBeNull();
  expect(read({})).toBeNull();
  expect(
    read({
      available_count: 2,
      applicable_available_count: 2,
      credits: [
        {
          reset_type: 'codex_rate_limits',
          status: 'available',
          expires_at: new Date(NOW + 2000).toISOString(),
        },
        {
          reset_type: 'codex_rate_limits',
          status: 'available',
          expires_at: new Date(NOW + 1000).toISOString(),
        },
      ],
    })?.nextExpiryAtMs
  ).toBe(NOW + 1000);
});

test('Codex lists every credit expiry soonest first, and adopts detail only when it matches the count', () => {
  const credit = (at: number) => ({
    reset_type: 'codex_rate_limits',
    status: 'available',
    expires_at: new Date(at).toISOString(),
  });
  const listed = readAccountResets(
    'codex',
    {
      rate_limit_reset_credits: {
        available_count: 2,
        applicable_available_count: 2,
        credits: [credit(NOW + 2000), credit(NOW + 1000)],
      },
    },
    NOW
  );
  expect(listed?.expiries).toEqual([NOW + 1000, NOW + 2000]);
  // The usage reply often only counts credits; the details reply fills them in.
  const counted = readAccountResets(
    'codex',
    { rate_limit_reset_credits: { available_count: 2, applicable_available_count: 0 } },
    NOW
  )!;
  expect(counted).toMatchObject({ nextExpiryAtMs: null, blocker: 'not_applicable' });
  expect(counted.expiries).toBeUndefined();
  expect(withCodexCreditDetails(counted, [NOW + 5000, NOW + 9000])).toMatchObject({
    available: 2,
    usable: 0,
    nextExpiryAtMs: NOW + 5000,
    expiries: [NOW + 5000, NOW + 9000],
  });
  // A detail list for a different number of credits is stale and is not shown.
  expect(withCodexCreditDetails(counted, [NOW + 5000])).toBe(counted);
  expect(withCodexCreditDetails(counted, undefined)).toBe(counted);
  expect(withCodexCreditDetails(listed!, [NOW + 7000, NOW + 8000])).toBe(listed!);
});
