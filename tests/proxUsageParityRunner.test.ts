import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { runParity } from '../scripts/usage-parity/run';
import { parseArgs } from '../scripts/usage-parity';
import { quietGate } from './helpers/usageParity';
import { parityServers } from './helpers/usageParityServers';

test('real fake-server HTTP uses independent second-page cursors and never overlaps requests', async () => {
  const f = parityServers({ delayMs: 2 });
  try {
    const signal = new AbortController().signal;
    const report = await runParity(f.options, signal, { gate: quietGate(signal), nowMs: f.nowMs });
    expect(report.status).toBe('passed');
    expect(report.matrix).toMatchObject({
      pairs_completed: 2,
      http_responses: 4,
      paging_mismatches: 0,
    });
    expect(report.response_counts).toMatchObject({ compared: 2, equal: 2, unexplained: 0 });
    expect(f.maximumActive).toBe(1);
    expect(f.seen).toHaveLength(4);
    expect(f.seen[2].query.before_id! - f.seen[3].query.before_id!).toBe(1000);
    const json = readFileSync(`${f.options.output}.json`, 'utf8');
    expect(JSON.parse(json).status).toBe('passed');
    expect(json).not.toContain(f.keys.cpamp);
    expect(json).not.toContain(f.keys.prox);
    const markdown = readFileSync(`${f.options.output}.md`, 'utf8');
    expect(markdown).toContain('22,464');
    expect(markdown).toContain('240 + 432 = 672');
  } finally {
    f.close();
  }
});
test('a second page on only one backend is an unexplained paging difference', async () => {
  const f = parityServers({
    mutate: (r, backend) => {
      if (backend === 'cpamp') {
        r.requests.has_more = false;
        r.requests.next_before_id = null;
        r.requests.next_before_ms = null;
      }
    },
  });
  try {
    const signal = new AbortController().signal;
    const report = await runParity(f.options, signal, { gate: quietGate(signal), nowMs: f.nowMs });
    expect(report.status).toBe('failed');
    expect(report.matrix.paging_mismatches).toBe(1);
    expect(report.matrix.second_pages_absent_on_both).toBe(0);
    expect(report.responses[0].differences).toContainEqual({
      class: 'unexplained',
      path: '$.requests.second_page',
      cpamp: { available: false },
      prox: { available: true },
    });
    expect(report.response_counts.unexplained).toBe(1);
  } finally {
    f.close();
  }
});
test('limits count response pairs, including second pages; reports known rules per pair', async () => {
  const f = parityServers({
    mutate: (r, backend) => {
      if (backend === 'cpamp')
        r.requests.items.forEach((item) => {
          item.provider = 'credential-snapshot-provider';
          item.trace_id = 'header-trace';
        });
    },
  });
  try {
    const signal = new AbortController().signal;
    const report = await runParity({ ...f.options, limit: 1 }, signal, {
      gate: quietGate(signal),
      nowMs: f.nowMs,
    });
    expect(report.status).toBe('passed');
    expect(f.seen).toHaveLength(2);
    expect(report.response_counts).toMatchObject({
      compared: 1,
      equal: 0,
      unexplained: 0,
      known_by_rule: { 'detail-provider': 1, 'detail-trace': 1, 'd5-pricing': 0 },
    });
    expect(report.counts['detail-provider']).toBe(3);
    expect(report.counts['detail-trace']).toBe(3);
    expect(report.matrix.second_pages_limited).toBe(1);
  } finally {
    f.close();
  }
});
test('HTTP failures produce failed evidence without server error text or credentials', async () => {
  const f = parityServers({ status: 503 });
  try {
    const signal = new AbortController().signal;
    const report = await runParity(f.options, signal, { gate: quietGate(signal), nowMs: f.nowMs });
    expect(report.status).toBe('failed');
    expect(report.error).toBe('Analytics HTTP 503');
    const json = readFileSync(`${f.options.output}.json`, 'utf8');
    expect(json).not.toContain(f.keys.cpamp);
    expect(json).not.toContain(f.keys.prox);
    expect(report.matrix.pairs_completed).toBe(0);
  } finally {
    f.close();
  }
});
test('abort writes partial evidence and ends before another pair can start', async () => {
  const controller = new AbortController();
  const f = parityServers({
    mutate: (_r, backend) => {
      if (backend === 'prox') controller.abort();
    },
  });
  try {
    const report = await runParity(f.options, controller.signal, {
      gate: quietGate(controller.signal),
      nowMs: f.nowMs,
    });
    expect(report.status).toBe('aborted');
    expect(f.seen.length).toBeLessThanOrEqual(2);
    expect(JSON.parse(readFileSync(`${f.options.output}.json`, 'utf8')).status).toBe('aborted');
  } finally {
    f.close();
  }
});
test('rejects moving/recent windows and non-loopback endpoints before sending any query', async () => {
  const f = parityServers();
  try {
    const signal = new AbortController().signal;
    const recent = await runParity({ ...f.options, toMs: f.nowMs }, signal, {
      gate: quietGate(signal),
      nowMs: f.nowMs,
    });
    expect(recent.status).toBe('failed');
    expect(f.seen).toHaveLength(0);
    const remote = await runParity(
      { ...f.options, proxUrl: 'http://example.com/v1/analytics' },
      signal,
      { gate: quietGate(signal), nowMs: f.nowMs }
    );
    expect(remote.status).toBe('failed');
    expect(f.seen).toHaveLength(0);
  } finally {
    f.close();
  }
});
test('CLI uses fixed UTC windows, validates controls, and preserves nightly settings', () => {
  const now = Date.UTC(2026, 10, 13, 4, 30);
  const opts = parseArgs(['--previous-utc-day'], now);
  expect(opts.gapMs).toBe(2000);
  expect(opts.mode).toBe('quick');
  expect(opts.level).toBe('both');
  expect(opts.toMs).toBe(Date.UTC(2026, 10, 13));
  expect(() => parseArgs(['--previous-utc-day', '--limit', '0'], now)).toThrow();
  expect(() => parseArgs(['--previous-utc-day', '--sample', '1.5'], now)).toThrow();
  expect(() => parseArgs(['--previous-utc-day', '--from', '2026-11-12T00:00:00Z'], now)).toThrow();
  expect(() => parseArgs(['--from', '2026-11-12', '--to', '2026-11-13'], now)).toThrow();
  const service = readFileSync('deploy/prox-usage-parity.service', 'utf8');
  const timer = readFileSync('deploy/prox-usage-parity.timer', 'utf8');
  expect(service).toContain('/usr/bin/ionice -c3 /usr/bin/nice -n10');
  expect(service).toContain('--previous-utc-day --matrix quick --level both');
  expect(timer).toContain('OnCalendar=*-*-* 04:30:00 UTC');
  expect(timer).toContain('Persistent=false');
});

test('keeps both compared values when an unavailable D5 witness aborts the run', async () => {
  const f = parityServers({
    mutate: (r, backend) => {
      if (backend === 'prox') r.summary.cost.usd! += 1;
    },
  });
  try {
    const signal = new AbortController().signal;
    const report = await runParity(f.options, signal, { gate: quietGate(signal), nowMs: f.nowMs });
    expect(report.status).toBe('failed');
    expect(report.response_counts.unexplained).toBe(1);
    const d = report.responses[0].differences.find((d) => d.path === '$.summary.cost.usd')!;
    expect(typeof d.cpamp).toBe('number');
    expect(typeof d.prox).toBe('number');
    expect(d.cpamp).not.toBe(d.prox);
  } finally {
    f.close();
  }
});

test('runner proves D5 costs/rates against both read-only rate-book replays', async () => {
  const f = parityServers({ d5: true });
  try {
    const signal = new AbortController().signal;
    const report = await runParity(f.options, signal, { gate: quietGate(signal), nowMs: f.nowMs });
    expect(report.status).toBe('passed');
    expect(report.matrix.d5_replays).toBe(4);
    expect(report.response_counts.known_by_rule['d5-pricing']).toBe(2);
    expect(report.counts['d5-pricing']).toBeGreaterThan(20);
    expect(report.counts.unexplained).toBe(0);
  } finally {
    f.close();
  }
});
