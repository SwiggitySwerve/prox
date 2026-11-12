import { describe, expect, test } from 'bun:test';
import { eventLoopStall, startEventLoopLagProbe } from '../server/eventLoopLag';

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
