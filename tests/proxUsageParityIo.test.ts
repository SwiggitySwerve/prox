import { expect, test } from 'bun:test';
import { QueryGate } from '../scripts/usage-parity/io';

import { quietGate } from './helpers/usageParity';

test('checks full PSI before every operation, waits at 5%, and spaces completion to next start', async () => {
  const controller = new AbortController();
  let now = 0,
    checks = 0;
  const starts: number[] = [];
  const readings = [5, 7, 4.9, 5, 0];
  const gate = new QueryGate(
    controller.signal,
    2000,
    {
      now: () => now,
      sleep: async (ms) => {
        now += ms;
      },
    },
    () => `full avg10=${readings[checks++]} avg60=0.00`
  );
  await gate.run(() => {
    starts.push(now);
    now += 123;
  });
  await gate.run(() => {
    starts.push(now);
  });
  expect(checks).toBe(5);
  expect(starts).toEqual([2000, 5123]);
});
test('fails closed on invalid/missing PSI and forbids simultaneous queries', async () => {
  const controller = new AbortController();
  const gate = new QueryGate(controller.signal, 0, undefined, () => 'some avg10=0.00');
  let ran = false;
  await expect(
    gate.run(() => {
      ran = true;
    })
  ).rejects.toThrow('Invalid IO PSI');
  expect(ran).toBe(false);
  let release!: () => void;
  const serial = quietGate();
  const pending = serial.run(
    () =>
      new Promise<void>((resolve) => {
        release = resolve;
      })
  );
  await Bun.sleep(0);
  await expect(serial.run(() => {})).rejects.toThrow('Concurrent parity');
  release();
  await pending;
});
test('SIGINT-style cancellation stops pressure waits without admitting a query', async () => {
  const controller = new AbortController();
  let ran = false;
  const gate = new QueryGate(
    controller.signal,
    0,
    {
      now: () => 0,
      sleep: async () => {
        controller.abort();
      },
    },
    () => 'full avg10=6.00 avg60=0.00'
  );
  await expect(
    gate.run(() => {
      ran = true;
    })
  ).rejects.toThrow();
  expect(ran).toBe(false);
});
