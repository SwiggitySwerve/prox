import { describe, expect, test } from 'bun:test';
import {
  EventLoopLagStats,
  eventLoopLagMs,
  eventLoopStall,
  startEventLoopLagProbe,
} from '../server/eventLoopLag';

describe('event loop lag stats', () => {
  test('lag is how far a tick ran past its schedule, never negative', () => {
    expect(eventLoopLagMs(0, 250)).toBe(0);
    expect(eventLoopLagMs(0, 240)).toBe(0);
    expect(eventLoopLagMs(0, 900)).toBe(650);
  });
  test('starts empty, tracks the max, and counts only stalls over one second', () => {
    const stats = new EventLoopLagStats();
    expect(stats.snapshot()).toEqual({ maxLagMs: 0, stallsOver1s: 0, lastStallAtMs: null });
    stats.record(40, 1000);
    stats.record(1000, 2000); // Exactly 1 s is not over 1 s.
    expect(stats.snapshot()).toEqual({ maxLagMs: 1000, stallsOver1s: 0, lastStallAtMs: null });
    stats.record(1500, 3000);
    stats.record(200, 4000);
    stats.record(1200, 5000);
    expect(stats.snapshot()).toEqual({ maxLagMs: 1500, stallsOver1s: 2, lastStallAtMs: 5000 });
  });
  test('a probe records a real blocked loop in the stats it is given', async () => {
    const stats = new EventLoopLagStats();
    const timer = startEventLoopLagProbe(() => {}, stats);
    try {
      await new Promise((resolve) => setTimeout(resolve, 600));
      expect(stats.snapshot().stallsOver1s).toBe(0);
      const end = performance.now() + 1500;
      while (performance.now() < end);
      await new Promise((resolve) => setTimeout(resolve, 300));
      const snapshot = stats.snapshot();
      expect(snapshot.stallsOver1s).toBe(1);
      expect(snapshot.maxLagMs).toBeGreaterThan(1000);
      expect(snapshot.lastStallAtMs).toBeGreaterThan(0);
    } finally {
      clearInterval(timer);
    }
  });
});

describe('event loop lag probe', () => {
  test('a tick on schedule or slightly late is quiet', () => {
    expect(eventLoopStall(0, 250)).toBeNull();
    expect(eventLoopStall(0, 900)).toBeNull();
    expect(eventLoopStall(0, 1250)).toBeNull();
  });
  test('a tick more than a second late reports the stall', () => {
    expect(eventLoopStall(0, 2250)).toBe(2000);
  });
  test('detects a real blocked loop and keeps quiet otherwise', async () => {
    const warnings: string[] = [];
    const timer = startEventLoopLagProbe((message) => warnings.push(message));
    try {
      await new Promise((resolve) => setTimeout(resolve, 600));
      expect(warnings).toEqual([]);
      const end = performance.now() + 1500;
      while (performance.now() < end);
      await new Promise((resolve) => setTimeout(resolve, 300));
      expect(warnings).toHaveLength(1);
      expect(warnings[0]).toMatch(/^Event loop blocked for \d+ms$/);
    } finally {
      clearInterval(timer);
    }
  });
});
