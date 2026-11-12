export type Query = Record<string, unknown>;
// A degraded body is good data computed while some source's catalog was unavailable.
export type Outcome =
  { ok: true; body: unknown; degraded?: boolean } | { ok: false; status: 400 | 503 };

const MINUTE = 60_000;
const DAY = 86_400_000;
// A window ending this close to now is "live": its caller clock is not part of its identity.
const LIVE_SLACK = 2 * MINUTE;
const MIN_REFRESH = 30_000;
const MAX_REFRESH = 5 * MINUTE;
const FIXED_TTL = MINUTE;
const SEED_TTL = 10 * MINUTE;
// The warmer keeps every view on its active cadence this long after any view was last asked for.
const HOT_FOR = 15 * MINUTE;
// A live view asked for this recently is kept warm like a default view (on the idle cadence
// once nobody is using the page), so a remembered filter or provider opens warm too.
const KEEP_FOR = 24 * 60 * MINUTE;
// While nobody has asked for anything, the default views refresh only this often (about 1%
// of CPA's time, against about 25% when active), so a first visit finds a recent snapshot.
const IDLE_REFRESH = 30 * MINUTE;
// A healthy kept view is never much older than IDLE_REFRESH. Older means its refreshes are
// failing, and the dashboard (which never shows snapshot age) would draw old data as current.
const MAX_STALE = 3 * IDLE_REFRESH;
// Responses run up to about 400 KB, so this bounds the cache near 25 MB.
const MAX_ENTRIES = 64;
// CPA admits two general queries at once; the warmer never takes more than that.
const WARM_CONCURRENCY = 2;

interface Entry {
  query: Query;
  live: boolean;
  pinned: boolean;
  body?: unknown;
  // body came from a recompute whose catalog had every source ready.
  ready: boolean;
  // The latest recompute had a source's catalog unavailable, whether or not body took it.
  degraded: boolean;
  at: number;
  took: number;
  tried: number;
  touched: number;
  inflight?: Promise<Outcome>;
  // The inflight recompute was started by a Refresh, so another Refresh may share it.
  inflightFresh?: boolean;
  // Sequence number of the recompute whose result is in body; an older one never replaces it.
  applied: number;
  // Recomputes still running, superseded ones included: any of them may yet fill the entry.
  pending: number;
}

/**
 * The page builds every window from its own clock, so exact timestamps never repeat. A live
 * window is keyed by its span (or its fixed UTC midnight start, for "today") plus filters;
 * everything else, including cursor pages, is keyed exactly.
 */
function shape(query: Query, now: number): { key: string; live: boolean } {
  const { from_ms: from, to_ms: to, ...rest } = query;
  const live =
    typeof from === 'number' &&
    typeof to === 'number' &&
    rest.before_ms === undefined &&
    rest.before_id === undefined &&
    to % DAY !== 0 &&
    Math.abs(now - to) <= LIVE_SLACK;
  const window = !live
    ? { from_ms: from, to_ms: to }
    : from % DAY === 0
      ? { from_ms: from }
      : { span: Math.round((to - from) / MINUTE) };
  const entries = Object.entries({ ...rest, ...window })
    .filter(([, value]) => value !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : 1));
  return { key: JSON.stringify(entries), live };
}

/** Move a stored live window to end now, keeping a midnight-anchored start where it is. */
function rebase(query: Query, now: number): Query {
  const from = query.from_ms as number;
  const to = query.to_ms as number;
  return { ...query, from_ms: from % DAY === 0 ? from : from + (now - to), to_ms: now };
}

/**
 * Serves the last good snapshot of each view at once and recomputes behind it. Slow CPA
 * queries (seconds for 30 days) never sit on the page's critical path once a view is warm.
 */
export function createSnapshotCache(
  compute: (query: Query) => Promise<Outcome>,
  clock: () => number,
  seeds: (now: number) => Query[]
) {
  const entries = new Map<string, Entry>();
  let warming = false;
  let lastUsed = -Infinity;

  const kept = (entry: Entry, now: number) =>
    entry.pinned || (entry.live && now - entry.touched <= KEEP_FOR);
  const refreshAfter = (entry: Entry) =>
    entry.live
      ? Math.min(MAX_REFRESH, Math.max(MIN_REFRESH, entry.took * 10))
      : entry.pinned
        ? SEED_TTL
        : FIXED_TTL;

  let sequence = 0;
  /**
   * A Refresh (supersede) never joins a recompute that started before it, which may hold the
   * catalog or data it was meant to replace, and never waits for one either: waiting plus its
   * own recompute could outlast the browser's timeout. It starts at once; whichever result is
   * newer wins.
   */
  function refresh(key: string, entry: Entry, query: Query, supersede = false): Promise<Outcome> {
    if (entry.inflight && (!supersede || entry.inflightFresh)) return entry.inflight;
    const started = clock();
    const mine = ++sequence;
    entry.tried = started;
    entry.pending += 1;
    const work = compute(query).then((outcome) => {
      entry.pending -= 1;
      if (outcome.ok && mine > entry.applied) {
        entry.degraded = outcome.degraded === true;
        // A catalog blip never replaces a fully ready snapshot that is still servable: the
        // previous body stays, and the warmer retries on its backoff instead of its full period.
        if (!(entry.degraded && entry.ready && clock() - entry.at < MAX_STALE)) {
          entry.applied = mine;
          entry.body = outcome.body;
          entry.ready = !entry.degraded;
          entry.query = query;
          entry.at = clock();
          entry.took = entry.at - started;
        }
      } else if (
        entry.body === undefined &&
        !entry.pinned &&
        // Never drop an entry another running recompute (older or newer) may still fill.
        entry.pending === 0 &&
        entries.get(key) === entry
      ) {
        entries.delete(key);
      }
      return outcome;
    });
    entry.inflight = work;
    entry.inflightFresh = supersede;
    void work.finally(() => {
      if (entry.inflight === work) entry.inflight = undefined;
    });
    return work;
  }

  function entryFor(key: string, query: Query, live: boolean, now: number): Entry {
    let entry = entries.get(key);
    if (entry) entries.delete(key);
    else
      entry = {
        query,
        live,
        pinned: false,
        ready: false,
        degraded: false,
        at: 0,
        took: 0,
        tried: -Infinity,
        touched: now,
        applied: 0,
        pending: 0,
      };
    entries.set(key, entry);
    for (const [other, candidate] of entries) {
      if (entries.size <= MAX_ENTRIES) break;
      if (!candidate.pinned && candidate.pending === 0 && other !== key) entries.delete(other);
    }
    return entry;
  }

  return {
    async get(query: Query, fresh = false): Promise<Outcome> {
      const now = clock();
      const { key, live } = shape(query, now);
      const entry = entryFor(key, query, live, now);
      const warm = kept(entry, now);
      entry.touched = now;
      lastUsed = now;
      if (!fresh && entry.body !== undefined) {
        const age = now - entry.at;
        if (age < refreshAfter(entry)) return { ok: true, body: entry.body };
        // A kept view is answered from its last snapshot up to the idle cap: its own
        // generated_at_ms tells the page how old that is, and the refresh never blocks the visit.
        if (warm && age < MAX_STALE) {
          void refresh(key, entry, query);
          return { ok: true, body: entry.body };
        }
      }
      return refresh(key, entry, query, fresh);
    },
    /**
     * Refresh the default views (in the order given, most used first), then every live view
     * asked for in the last day, most recent first, at most WARM_CONCURRENCY at a time.
     */
    async warm(): Promise<void> {
      if (warming) return;
      warming = true;
      try {
        for (const entry of entries.values()) entry.pinned = false;
        const start = clock();
        const idle = start - lastUsed > HOT_FOR;
        const queue: [string, Entry][] = [];
        for (const query of seeds(start)) {
          const { key, live } = shape(query, start);
          const entry = entryFor(key, query, live, start);
          entry.pinned = true;
          queue.push([key, entry]);
        }
        queue.push(
          ...[...entries]
            .filter(([, entry]) => !entry.pinned)
            .sort(([, a], [, b]) => b.touched - a.touched)
        );
        const next = async (): Promise<void> => {
          const item = queue.shift();
          if (!item) return;
          const [key, entry] = item;
          const now = clock();
          const every =
            idle || (!entry.pinned && now - entry.touched > HOT_FOR)
              ? Math.max(IDLE_REFRESH, refreshAfter(entry))
              : refreshAfter(entry);
          // After a degraded recompute nothing is fresh, so it is retried on the backoff below.
          const fresh = entry.ready && !entry.degraded && now - entry.at < every;
          // A failing view is retried on its own cadence (30 s to 5 min), not on every tick.
          const backingOff = now - entry.tried < Math.min(every, MAX_REFRESH);
          // A view evicted while it waited in the queue is not worth a CPA query.
          if (entries.get(key) === entry && kept(entry, now) && !fresh && !backingOff)
            await refresh(key, entry, entry.live ? rebase(entry.query, now) : entry.query);
          return next();
        };
        await Promise.all(Array.from({ length: WARM_CONCURRENCY }, next));
      } finally {
        warming = false;
      }
    },
  };
}
