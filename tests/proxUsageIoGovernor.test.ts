import { describe, expect, test } from 'bun:test';
import { fullIoPressure, IoGovernor, readIoBytes } from '../server/usage/ioGovernor';
import { fakeIo } from './helpers/usageIo';

describe('usage bulk IO governor', () => {
  test('reads full avg10 as percent and fails closed on unavailable or invalid PSI', async () => {
    expect(fullIoPressure('some avg10=99.00 avg60=0\nfull avg10=4.99 avg60=0')).toBe(4.99);
    for (const psi of ['', 'some avg10=0.00 avg60=0', 'full avg10=101.00 avg60=0']) {
      expect(() => fullIoPressure(psi)).toThrow();
    }
    await expect(
      fakeIo({
        readPsi: () => {
          throw new Error('unavailable');
        },
      }).governor.waitForQuietIo()
    ).rejects.toThrow('unavailable');
    expect(readIoBytes().read).toBeGreaterThan(0);
  });

  test('no chunk starts at or above 5%, and 15% requires 30s continuously below 5%', async () => {
    let pressure = 5;
    let samples = 0;
    const io = fakeIo({
      readPsi: () => {
        samples += 1;
        // Moderate pressure blocks the start. Crossing 15 latches the recovery period.
        pressure = samples === 1 ? 5 : samples === 2 ? 15 : samples === 20 ? 5 : 4.99;
        return `full avg10=${pressure.toFixed(2)} avg60=0`;
      },
    });
    await io.governor.waitForQuietIo();
    expect(pressure).toBeLessThan(5);
    // The interrupted quiet period starts again at t=20s, and ends at t=50s.
    expect(io.clock.now()).toBe(50_000);
    expect(io.governor.counters.pauseSeconds).toBe(50);
    await io.governor.reportBytes({ read: 0, written: 0 });
    await io.governor.waitForQuietIo();
    expect(io.clock.now()).toBe(50_000);
  });

  test('paces reads plus writes, subtracts work time, and earns no idle burst credit', async () => {
    const io = fakeIo();
    for (let i = 0; i < 3; i += 1) {
      io.advance(90_000); // unrelated idle time cannot subsidize the next chunk
      const before = io.clock.now();
      await io.governor.waitForQuietIo();
      io.advance(100);
      await io.governor.reportBytes({ read: 3_000_000, written: 1_000_000 });
      expect(io.clock.now() - before).toBe(1000);
    }
    expect(io.governor.counters).toMatchObject({ bytesRead: 9_000_000, bytesWritten: 3_000_000 });
    const slow = fakeIo({ bytesPerSecond: 100 });
    await slow.governor.waitForQuietIo();
    await slow.governor.reportBytes({ read: 100, written: 100 });
    expect(slow.clock.now()).toBe(2000);
    expect(() => new IoGovernor({ bytesPerSecond: 0 })).toThrow();
    await expect(slow.governor.reportBytes({ read: -1, written: 0 })).rejects.toThrow();
  });

  test('cancelling a severe wait preserves its recovery latch and quiet interval on reuse', async () => {
    let time = 0;
    let pressure = 15;
    let cancelAt = 1000;
    let controller = new AbortController();
    const governor = new IoGovernor({
      readPsi: () => `full avg10=${pressure.toFixed(2)} avg60=0`,
      clock: {
        now: () => time,
        sleep: async (ms) => {
          time += ms;
          if (time >= cancelAt) controller.abort();
        },
      },
    });
    await expect(governor.waitForQuietIo(controller.signal)).rejects.toThrow();
    pressure = 0;
    controller = new AbortController();
    cancelAt = 11_000;
    await expect(governor.waitForQuietIo(controller.signal)).rejects.toThrow();
    expect(time).toBe(11_000); // cancellation during the quiet recovery period
    cancelAt = Infinity;
    await governor.waitForQuietIo();
    expect(time).toBe(31_000); // retain the quiet interval begun at t=1s
    expect(governor.counters.pauseSeconds).toBe(31);
    await governor.reportBytes({ read: 0, written: 0 });
    await governor.waitForQuietIo();
    expect(time).toBe(31_000);
  });

  test('cancelling byte pacing preserves the outstanding debt before the next admission', async () => {
    let time = 0;
    const controller = new AbortController();
    const governor = new IoGovernor({
      bytesPerSecond: 100,
      readPsi: () => 'full avg10=0.00 avg60=0',
      clock: {
        now: () => time,
        sleep: async (ms) => {
          time += ms;
          if (time === 1000) controller.abort();
        },
      },
    });
    await governor.waitForQuietIo();
    await expect(
      governor.reportBytes({ read: 150, written: 150 }, controller.signal)
    ).rejects.toThrow();
    expect(time).toBe(1000);
    await expect(governor.waitForQuietIo(AbortSignal.abort())).rejects.toThrow();
    expect(time).toBe(1000);
    await governor.waitForQuietIo();
    expect(time).toBe(3000);
    expect(governor.counters).toMatchObject({ bytesRead: 150, bytesWritten: 150 });
    await governor.reportBytes({ read: 50, written: 50 });
    expect(time).toBe(4000);
  });

  test('reports a pause longer than 6h once and never forces the job through', async () => {
    let time = 0;
    const reports: number[] = [];
    let samples = 0;
    const controller = new AbortController();
    const governor = new IoGovernor({
      readPsi: () => {
        samples += 1;
        return 'full avg10=65.00 avg60=60.00';
      },
      clock: {
        now: () => time,
        sleep: async () => {
          time += 60 * 60 * 1000;
          if (time === 10 * 60 * 60 * 1000) controller.abort();
        },
      },
      reportLongPause: (seconds) => {
        reports.push(seconds);
      },
    });
    await expect(governor.waitForQuietIo(controller.signal)).rejects.toThrow();
    expect(samples).toBe(10);
    expect(reports).toEqual([7 * 60 * 60]);
    expect(governor.counters).toMatchObject({
      pauseSeconds: 10 * 60 * 60,
      longPauses: 1,
      bytesRead: 0,
    });
  });
});
