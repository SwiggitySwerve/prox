import { describe, expect, test } from 'bun:test';
import { createCoalescingRunner, type QuotaRun } from '@/features/authFiles/quotaRunner';

/** A run the test finishes by hand, so overlap is controlled. */
function harness() {
  const runs: Array<{ inputs: Array<string | undefined>; finish: () => void; fail: () => void }> =
    [];
  const request = createCoalescingRunner<string>();
  const execute: QuotaRun<string> = (inputs, onSettled) =>
    new Promise<void>((resolve, reject) => {
      runs.push({
        inputs,
        finish: () => {
          // one target per run, settled just before the run ends
          onSettled(true);
          resolve();
        },
        fail: () => reject(new Error('boom')),
      });
    });
  const runner = (input?: string, onSettled?: (ok: boolean) => void) =>
    request(execute, input, onSettled);
  return { runs, runner };
}
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

describe('coalescing quota runner', () => {
  test('an idle request runs at once, with its input and callbacks', async () => {
    const { runs, runner } = harness();
    const settled: boolean[] = [];
    const done = runner('list', (ok) => settled.push(ok));
    expect(runs).toHaveLength(1);
    expect(runs[0].inputs).toEqual(['list']);
    runs[0].finish();
    await done;
    expect(settled).toEqual([true]);
  });

  test('page-wide during a group run: the page-wide request waits, runs after, and settles', async () => {
    const { runs, runner } = harness();
    const groupSettled: boolean[] = [];
    const pageSettled: boolean[] = [];
    const group = runner('fresh-list', (ok) => groupSettled.push(ok));
    let pageDone = false;
    const page = runner(undefined, (ok) => pageSettled.push(ok)).then(() => (pageDone = true));
    await tick();
    expect(runs).toHaveLength(1);
    expect(pageDone).toBe(false);
    runs[0].finish();
    await group;
    await tick();
    expect(runs).toHaveLength(2); // the follow-up run
    expect(runs[1].inputs).toEqual([undefined]);
    expect(groupSettled).toEqual([true]); // the first run's targets are not the page-wide's
    expect(pageSettled).toEqual([]);
    runs[1].finish();
    await page;
    expect(pageSettled).toEqual([true]);
    expect(pageDone).toBe(true);
  });

  test('group during a page-wide run: the group request is not dropped and gets its own run', async () => {
    const { runs, runner } = harness();
    const pageSettled: boolean[] = [];
    const groupSettled: boolean[] = [];
    const page = runner(undefined, (ok) => pageSettled.push(ok));
    const group = runner('fresh-list', (ok) => groupSettled.push(ok));
    runs[0].finish();
    await page;
    await tick();
    expect(runs).toHaveLength(2);
    expect(runs[1].inputs).toEqual(['fresh-list']);
    runs[1].finish();
    await group;
    expect([pageSettled, groupSettled]).toEqual([[true], [true]]);
  });

  test('several waiting requests coalesce into one follow-up run that settles for each of them', async () => {
    const { runs, runner } = harness();
    const first = runner('one');
    const seen: string[] = [];
    const waiters = ['two', 'three', 'four'].map((input) => runner(input, () => seen.push(input)));
    runs[0].finish();
    await first;
    await tick();
    expect(runs).toHaveLength(2);
    expect(runs[1].inputs).toEqual(['two', 'three', 'four']);
    runs[1].finish();
    await Promise.all(waiters);
    expect(seen).toEqual(['two', 'three', 'four']);
    await tick();
    expect(runs).toHaveLength(2); // nothing is left to run
  });

  test('a request made after the runner went idle starts a fresh run', async () => {
    const { runs, runner } = harness();
    const first = runner('one');
    runs[0].finish();
    await first;
    const second = runner('two');
    expect(runs).toHaveLength(2);
    runs[1].finish();
    await second;
  });

  test('a failed run rejects only its own callers; waiting callers still run and resolve', async () => {
    const { runs, runner } = harness();
    const failed = runner('one');
    const failedResult = failed.then(
      () => 'resolved',
      (error: Error) => error.message
    );
    const later = runner('two');
    runs[0].fail();
    expect(await failedResult).toBe('boom');
    await tick();
    expect(runs).toHaveLength(2);
    runs[1].finish();
    await later; // not left hanging
    const after = runner('three'); // and the runner is usable again
    expect(runs).toHaveLength(3);
    runs[2].finish();
    await after;
  });
});
