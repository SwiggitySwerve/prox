import { expect, test } from 'bun:test';
import { jobNote, confirmWindow, observeReconcile } from '../scripts/usage-parity/reconcile';
import { createEventReport } from '../scripts/usage-parity/events';
import { quietGate } from './helpers/usageParity';
const to = Date.UTC(2026, 10, 12, 23, 40);
const now = to + 3600000;
const completed = () => ({
  job: {
    id: 1,
    kind: 'reconcile',
    state: 'succeeded',
    startedAtMs: to + 600000,
    finishedAtMs: now - 1,
    result: {
      kind: 'cpamp',
      report: { mode: 'reconcile', maxId: 100, lastId: 100, verification: { exact: true } },
    },
  },
});
const events = () => ({
  ...createEventReport(to - 3600000, to),
  complete: true,
  cpamp_max_id: 100,
});
test('reconcile provenance confirms only successful exact jobs covering the observed source IDs', () => {
  const note = confirmWindow(jobNote(completed(), now), events());
  expect(note.status).toBe('confirmed');
  expect(note.completed_for_window).toBe(true);
  expect(
    confirmWindow(jobNote(completed(), now), { ...events(), cpamp_max_id: 101 })
      .completed_for_window
  ).toBeNull();
  expect(
    confirmWindow(jobNote(completed(), now), { ...events(), complete: false }).completed_for_window
  ).toBeNull();
  for (const mutate of [
    (value: ReturnType<typeof completed>) => {
      value.job.state = 'running';
    },
    (value: ReturnType<typeof completed>) => {
      value.job.result.report.verification.exact = false;
    },
    (value: ReturnType<typeof completed>) => {
      value.job.result.report.lastId = 99;
    },
    (value: ReturnType<typeof completed>) => {
      value.job.startedAtMs = to - 1;
    },
  ]) {
    const value = completed();
    mutate(value);
    expect(confirmWindow(jobNote(value, now), events()).completed_for_window).toBeNull();
  }
  expect(jobNote({ job: null }, now).status).toBe('not-confirmed');
  expect(jobNote({ job: { kind: 'backup' } }, now).completed_for_window).toBeNull();
});
test('unavailable job status is only a note and never leaks response bodies or credentials', async () => {
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    fetch: () => new Response('private credential body', { status: 503 }),
  });
  try {
    const note = await observeReconcile(
      `http://127.0.0.1:${server.port}/v1/analytics`,
      () => 'synthetic-key',
      quietGate(),
      () => now
    );
    expect(note.status).toBe('unavailable');
    expect(JSON.stringify(note)).not.toContain('private credential');
  } finally {
    server.stop(true);
  }
});
