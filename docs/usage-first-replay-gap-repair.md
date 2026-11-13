# Repair the two first-run replay gaps

No automatic startup deletion is safe. `ingest_gaps` stores only `id`, `instance`,
`from_ms`, `to_ms`, `reason`, and `missed`. It has no creation time, prior cursor,
boot ID, or replay provenance. `meta` stores only current cursor progress. A genuine
retention gap can have the same reason, interval, and missed count as a false
first-run gap. The event/raw stores do not retain queue sequence metadata.

The coordinator reported two false rows from the 2026-11-13 deployment: approximately
00:36:14–00:36:21 UTC, reason `subscription-dropped`, missed 943 for Claude and
1318 for Codex. These details narrow inspection; they do not prove a row's origin.
The coordinator must identify and approve the exact row IDs using the deployment
record. This PR does not perform the cleanup or change the live database.

## Operator procedure

1. Stop `prox-usage` and take an offline backup using the normal operator procedure.
   No other writer may open the event database during this repair. Set `usage_db`
   to the actual `usage.sqlite` path, then open it with
   `ionice -c3 nice -n10 sqlite3 "$usage_db"`.
2. Inspect candidates and confirm both IDs and every stored value against the
   deployment evidence. Do not delete rows using this filter alone:

   ```sql
   SELECT id, instance, from_ms, to_ms, reason, missed,
          datetime(from_ms / 1000.0, 'unixepoch') AS from_utc,
          datetime(to_ms / 1000.0, 'unixepoch') AS to_utc
   FROM ingest_gaps
   WHERE reason = 'subscription-dropped' AND missed IN (943, 1318)
   ORDER BY id;
   ```

3. Substitute the approved IDs, exact instance strings and millisecond endpoints
   below. The placeholders are intentional; no IDs are inferred from counters.

   ```sql
   CREATE TEMP TABLE approved_gap (
     id INTEGER PRIMARY KEY, instance TEXT NOT NULL,
     from_ms INTEGER NOT NULL, to_ms INTEGER NOT NULL,
     reason TEXT NOT NULL, missed INTEGER NOT NULL
   );
   INSERT INTO approved_gap VALUES
     (<claude_id>, '<claude_instance>', <claude_from_ms>, <claude_to_ms>,
      'subscription-dropped', 943),
     (<codex_id>, '<codex_instance>', <codex_from_ms>, <codex_to_ms>,
      'subscription-dropped', 1318);

   BEGIN IMMEDIATE;
   DELETE FROM ingest_gaps
   WHERE EXISTS (
     SELECT 1 FROM approved_gap a
     WHERE a.id = ingest_gaps.id AND a.instance = ingest_gaps.instance
       AND a.from_ms = ingest_gaps.from_ms AND a.to_ms = ingest_gaps.to_ms
       AND a.reason = ingest_gaps.reason AND a.missed = ingest_gaps.missed
   ) AND NOT EXISTS (
     SELECT 1 FROM meta m
     WHERE m.key = 'recovery-gap:' || ingest_gaps.instance
       AND m.value = CAST(ingest_gaps.id AS TEXT)
   );
   SELECT changes() AS deleted_rows;
   ```

4. Expect two deletions on the first run and zero on a repeat. Inspect remaining
   rows inside the transaction. Use `COMMIT;` only for the approved result;
   otherwise use `ROLLBACK;` and investigate. Retain the approved values and the
   backup in the operator record, then restart `prox-usage` and check source health.

The delete is idempotent for the approved rows and cannot match a row whose ID or
any expected value differs. It also excludes active provisional recovery rows.
It does not alter event history, cursors, other gaps, or the raw buffer.
