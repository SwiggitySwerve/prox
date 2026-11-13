// Range-wide provenance includes supplementary records and ignores display filters.
import type { Database } from 'bun:sqlite';
import { INGEST } from './types';

export interface CoverageRow {
  provider_id: number;
  imported: number;
}
export function readCoverage(db: Database, from: number, to: number): CoverageRow[] {
  return db
    .query<CoverageRow, [number, number]>(
      `
    SELECT provider_id, max(ingest = ${INGEST.imported}) AS imported FROM events
    WHERE ts_ms >= ? AND ts_ms < ? GROUP BY provider_id
  `
    )
    .all(from, to);
}
