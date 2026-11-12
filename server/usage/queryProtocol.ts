// Value-only RPC shared by the socket thread and the read workers.
import type { RateBookState } from './rates';
import type { UsageAnalyticsQuery } from './validate';
export interface QueryRequest {
  id: number;
  kind: 'analytics';
  body: { dbPath: string; query: UsageAnalyticsQuery; deadline: number; rates: RateBookState };
}
export type QueryReply =
  | { id: number; ok: true; body: string }
  | { id: number; ok: false; body: { error: string; status: number } };
