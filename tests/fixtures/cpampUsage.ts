import { Database } from 'bun:sqlite';
import { usagePayloadNumber } from './usagePayloads';

/** Selected columns of the CPAMP usage_events schema (repository/sqlite/migrate.go). */
export const CPAMP_COLUMNS = {
  id: 'INTEGER PRIMARY KEY',
  timestamp_ms: 'INTEGER',
  provider: 'TEXT',
  model: 'TEXT',
  requested_model: 'TEXT',
  resolved_model: 'TEXT',
  response_model: 'TEXT',
  auth_index: 'TEXT',
  account_snapshot: 'TEXT',
  auth_label_snapshot: 'TEXT',
  api_key_hash: 'TEXT',
  user_agent: 'TEXT',
  client_ip: 'TEXT',
  path: 'TEXT',
  method: 'TEXT',
  reasoning_effort: 'TEXT',
  executor_type: 'TEXT',
  request_id: 'TEXT',
  session_id: 'TEXT',
  parent_session_id: 'TEXT',
  stream: 'INTEGER',
  failed: 'INTEGER',
  fail_status_code: 'INTEGER',
  latency_ms: 'INTEGER',
  ttft_ms: 'INTEGER',
  normalized_total_input_tokens: 'INTEGER',
  normalized_uncached_input_tokens: 'INTEGER',
  normalized_cache_read_tokens: 'INTEGER',
  normalized_cache_creation_tokens: 'INTEGER',
  output_tokens: 'INTEGER',
  reasoning_tokens: 'INTEGER',
  total_tokens: 'INTEGER',
  raw_json: 'TEXT',
} as const;
export const V8_SESSION = '01234567-89ab-8def-8123-456789abcdef';
export const PARENT_SESSION = '01234567-89ab-4def-8123-456789abcdef';

export function cpampRow(index: number, overrides: Record<string, string | number | null> = {}) {
  return {
    id: index,
    timestamp_ms: Date.UTC(2026, 10, 1, index % 3),
    provider: 'claude',
    model: 'client-claude',
    requested_model: 'client-claude',
    resolved_model: 'claude-test-4',
    response_model: 'claude-test-4-20260401',
    auth_index: '3',
    account_snapshot: 'snapshot@example.test',
    auth_label_snapshot: 'Synthetic account',
    api_key_hash: 'a'.repeat(64),
    user_agent: 'test-client/1.0',
    client_ip: '192.0.2.10',
    path: '/v1/messages',
    method: 'POST',
    reasoning_effort: 'medium',
    executor_type: 'ClaudeExecutor',
    request_id: `req-${index}`,
    session_id: V8_SESSION,
    parent_session_id: PARENT_SESSION,
    stream: 1,
    failed: index % 2,
    fail_status_code: index % 2 ? 502 : 200,
    latency_ms: 1500 + index,
    ttft_ms: index % 3 === 0 ? 0 : 420,
    normalized_total_input_tokens: 950,
    normalized_uncached_input_tokens: 100,
    normalized_cache_read_tokens: 800,
    normalized_cache_creation_tokens: 50,
    output_tokens: 200,
    reasoning_tokens: 60,
    total_tokens: 1150,
    raw_json: JSON.stringify(usagePayloadNumber(index)),
    ...overrides,
  };
}

export function createCpamp(path: string, count: number) {
  const db = new Database(path, { create: true, strict: true });
  db.exec('PRAGMA temp_store=MEMORY');
  db.exec(
    `CREATE TABLE usage_events (${Object.entries(CPAMP_COLUMNS)
      .map(([key, type]) => `${key} ${type}`)
      .join(', ')})`
  );
  const columns = Object.keys(CPAMP_COLUMNS);
  const insert = db.query(
    `INSERT INTO usage_events (${columns.join(', ')}) VALUES (${columns.map(() => '?').join(', ')})`
  );
  const add = (row: ReturnType<typeof cpampRow>) =>
    insert.run(...columns.map((key) => row[key as keyof typeof row]));
  db.transaction(() => {
    for (let i = 1; i <= count; i += 1) add(cpampRow(i));
  })();
  return { db, add };
}
