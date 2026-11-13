import { expect, test } from 'bun:test';
import { ExecutionWindow, IncompleteRun, parseDeadline } from '../scripts/usage-parity/window';
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

// Fake wall time and IO time advance together; no real sleeps or live pressure queries.

function scheduledGate(start: number, deadline?: number, pressure = 6, gapMs = 2000) {
  let at = start,
    elapsed = 0;
  const signal = new AbortController().signal;
  const window = new ExecutionWindow(signal, deadline, () => at);
  const gate = new QueryGate(
    signal,
    gapMs,
    {
      now: () => elapsed,
      sleep: async (ms) => {
        elapsed += ms;
        at += ms;
      },
    },
    () => `full avg10=${pressure} avg60=0`
  );
  gate.setWindow(window);
  return {
    gate,
    window,
    get at() {
      return at;
    },
    jump: (ms: number) => {
      at += ms;
    },
  };
}
test('delayed starts cannot roll a same-day noon deadline into tomorrow', async () => {
  const late = Date.UTC(2026, 10, 14, 12, 5);
  const cutoff = parseDeadline('12:00Z', late);
  expect(cutoff).toBe(Date.UTC(2026, 10, 14, 12));
  const f = scheduledGate(late, cutoff, 0);
  try {
    await expect(
      f.gate.run(() => {
        throw new Error('must not run');
      })
    ).rejects.toBeInstanceOf(IncompleteRun);
    expect(f.gate.queries).toBe(0);
    expect(f.window.signal.reason.kind).toBe('deadline');
  } finally {
    f.window.close();
  }
});
test('long PSI waits stop exactly at the cutoff without admitting a query', async () => {
  const start = Date.UTC(2026, 10, 14, 11, 59, 57, 500);
  const cutoff = Date.UTC(2026, 10, 14, 12);
  const f = scheduledGate(start, cutoff);
  try {
    await expect(f.gate.run(() => {})).rejects.toBeInstanceOf(IncompleteRun);
    expect(f.gate.queries).toBe(0);
    expect(f.at).toBe(cutoff);
    expect(f.window.signal.reason.kind).toBe('deadline');
  } finally {
    f.window.close();
  }
});
test('forbidden windows reject delayed starts and pressure waits at both UTC boundaries', async () => {
  for (const [hour, minute] of [
    [2, 30],
    [12, 30],
  ]) {
    const f = scheduledGate(Date.UTC(2026, 10, 14, hour, minute), undefined, 0);
    try {
      await expect(f.gate.run(() => {})).rejects.toBeInstanceOf(IncompleteRun);
      expect(f.gate.queries).toBe(0);
      expect(f.window.signal.reason.kind).toBe('forbidden-hours');
    } finally {
      f.window.close();
    }
  }
  for (const [hour, minute] of [
    [1, 0],
    [12, 20],
  ]) {
    const boundary = Date.UTC(2026, 10, 14, hour, minute);
    const f = scheduledGate(boundary - 2500);
    try {
      await expect(f.gate.run(() => {})).rejects.toBeInstanceOf(IncompleteRun);
      expect(f.at).toBe(boundary);
      expect(f.gate.queries).toBe(0);
    } finally {
      f.window.close();
    }
  }
});
test('query-gap waits and large clock jumps cannot bypass the recorded stop boundary', async () => {
  const start = Date.UTC(2026, 10, 14, 4, 30);
  const f = scheduledGate(start, start + 1500, 0);
  try {
    await f.gate.run(() => {});
    await expect(f.gate.run(() => {})).rejects.toBeInstanceOf(IncompleteRun);
    expect(f.gate.queries).toBe(1);
    expect(f.at).toBe(start + 1500);
  } finally {
    f.window.close();
  }
  const g = scheduledGate(Date.UTC(2026, 10, 14, 0, 59), undefined, 0);
  try {
    g.jump(4 * 3600000);
    await expect(g.gate.run(() => {})).rejects.toBeInstanceOf(IncompleteRun);
    expect(g.gate.queries).toBe(0);
  } finally {
    g.window.close();
  }
});

test('UTC admission includes the exact end of each forbidden window', async () => {
  for (const [hour, minute] of [
    [0, 0],
    [4, 0],
    [12, 50],
    [23, 59],
  ]) {
    const f = scheduledGate(Date.UTC(2026, 10, 14, hour, minute), undefined, 0);
    try {
      await f.gate.run(() => {});
      expect(f.gate.queries).toBe(1);
    } finally {
      f.window.close();
    }
  }
});

test('a deadline crossing while arming the stop timer aborts rather than throwing outside the runner', () => {
  const cutoff = Date.UTC(2026, 10, 14, 12);
  let calls = 0;
  const window = new ExecutionWindow(new AbortController().signal, cutoff, () =>
    calls++ === 0 ? cutoff - 1 : cutoff
  );
  try {
    expect(window.signal.aborted).toBe(true);
    expect(window.signal.reason.kind).toBe('deadline');
  } finally {
    window.close();
  }
});
