export type Query = Record<string, unknown>;
export type Outcome = { ok: true; body: unknown } | { ok: false; status: 400 | 503 };

const MINUTE = 60_000;
const DAY = 86_400_000;
// A window ending this close to now is "live": its caller clock is not part of its identity.
const LIVE_SLACK = 2 * MINUTE;
const MIN_REFRESH = 30_000;
const MAX_REFRESH = 5 * MINUTE;
// Past this age a snapshot of a view nobody keeps warm is too old to serve while refreshing.
const MAX_STALE = 15 * MINUTE;
const FIXED_TTL = MINUTE;
const SEED_TTL = 10 * MINUTE;
// The warmer keeps a live view fresh this long after anyone last asked for it, and keeps
// the default views on their active cadence for as long after any view was last asked for.
const HOT_FOR = 15 * MINUTE;
// While nobody has asked for anything, the default views refresh only this often (about 1%
// of CPA's time, against about 25% when active), so a first visit finds a recent snapshot.
const IDLE_REFRESH = 30 * MINUTE;
// A healthy default view is never much older than IDLE_REFRESH. Older means its refreshes are
// failing, and the dashboard (which never shows snapshot age) would draw old data as current.
const MAX_PINNED_STALE = 3 * IDLE_REFRESH;
const MAX_ENTRIES = 64;

interface Entry {
  query: Query;
  live: boolean;
  pinned: boolean;
  body?: unknown;
  at: number;
  took: number;
  tried: number;
  touched: number;
  inflight?: Promise<Outcome>;
  // The inflight recompute was started by a Refresh, so another Refresh may share it.
  inflightFresh?: boolean;
  // Sequence number of the recompute whose result is in body; an older one never replaces it.
  applied: number;
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
    const work = compute(query).then((outcome) => {
      if (outcome.ok && mine > entry.applied) {
        entry.applied = mine;
        entry.body = outcome.body;
        entry.query = query;
        entry.at = clock();
        entry.took = entry.at - started;
      } else if (
        entry.body === undefined &&
        !entry.pinned &&
        // A superseded recompute must not drop the entry a newer one will store into.
        entry.inflight === work &&
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
        at: 0,
        took: 0,
        tried: -Infinity,
        touched: now,
        applied: 0,
      };
    entries.set(key, entry);
    for (const [other, candidate] of entries) {
      if (entries.size <= MAX_ENTRIES) break;
      if (!candidate.pinned && !candidate.inflight && other !== key) entries.delete(other);
    }
    return entry;
  }

  return {
    async get(query: Query, fresh = false): Promise<Outcome> {
      const now = clock();
      const { key, live } = shape(query, now);
      const entry = entryFor(key, query, live, now);
      entry.touched = now;
      lastUsed = now;
      if (!fresh && entry.body !== undefined) {
        const age = now - entry.at;
        if (age < refreshAfter(entry)) return { ok: true, body: entry.body };
        // A default view is answered from its last snapshot up to the idle cap: its own
        // generated_at_ms tells the page how old that is, and the refresh never blocks the visit.
        if (age < (entry.pinned ? MAX_PINNED_STALE : live ? MAX_STALE : 0)) {
          void refresh(key, entry, query);
          return { ok: true, body: entry.body };
        }
      }
      return refresh(key, entry, query, fresh);
    },
    /** Refresh the default views, and any live view someone opened recently, one at a time. */
    async warm(): Promise<void> {
      if (warming) return;
      warming = true;
      try {
        for (const entry of entries.values()) entry.pinned = false;
        const start = clock();
        const idle = start - lastUsed > HOT_FOR;
        for (const query of seeds(start)) {
          const { key, live } = shape(query, start);
          entryFor(key, query, live, start).pinned = true;
        }
        for (const [key, entry] of [...entries]) {
          const now = clock();
          const wanted = entry.pinned || (entry.live && now - entry.touched <= HOT_FOR);
          const every = idle ? Math.max(IDLE_REFRESH, refreshAfter(entry)) : refreshAfter(entry);
          const fresh = entry.body !== undefined && now - entry.at < every;
          // A failing view is retried on its own cadence (30 s to 5 min), not on every tick.
          const backingOff = now - entry.tried < Math.min(every, MAX_REFRESH);
          if (!wanted || fresh || backingOff) continue;
          await refresh(key, entry, entry.live ? rebase(entry.query, now) : entry.query);
        }
      } finally {
        warming = false;
      }
    },
  };
}
