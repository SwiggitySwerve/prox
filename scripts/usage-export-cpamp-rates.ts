/** One-time read-only export. Usage:
 * bun scripts/usage-export-cpamp-rates.ts <book.json> [cpamp-usage.sqlite]
 * Writes <book.json> and <book.json>.client-aliases.json. The latter is
 * {"client_alias":[{"api_key_hash":"<sha256>","alias":"<label>"}]}, for a later
 * writer-worker import into client_alias; this command never opens the Prox DB.
 */
import { constants, Database } from 'bun:sqlite';
import { homedir } from 'node:os';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { existsSync, writeFileSync } from 'node:fs';
import { parseRateBook, type RateValues } from '../server/usage/rates';

type PriceRow = {
  model: string;
  prompt_per_1m: number;
  completion_per_1m: number;
  cache_read_per_1m: number;
  cache_creation_per_1m: number;
  prompt_configured: number;
  completion_configured: number;
  cache_read_configured: number;
  cache_creation_configured: number;
};
const COLUMNS = `model, prompt_per_1m, completion_per_1m, cache_read_per_1m,
  cache_creation_per_1m, prompt_configured, completion_configured,
  cache_read_configured, cache_creation_configured`;
function rates(row: PriceRow): RateValues {
  return {
    input: row.prompt_configured ? row.prompt_per_1m : null,
    output: row.completion_configured ? row.completion_per_1m : null,
    cache_read: row.cache_read_configured ? row.cache_read_per_1m : null,
    cache_write: row.cache_creation_configured ? row.cache_creation_per_1m : null,
  };
}

/** Only the four named source tables are read, in one snapshot. No schema writes. */
export function exportCpampRates(databasePath: string) {
  const uri = pathToFileURL(resolve(databasePath));
  uri.searchParams.set('mode', 'ro');
  const db = new Database(uri.href, constants.SQLITE_OPEN_READONLY | constants.SQLITE_OPEN_URI);
  try {
    db.exec('PRAGMA query_only=1');
    db.exec('BEGIN');
    const models = Object.fromEntries(
      db
        .query<PriceRow & { source: string | null; updated_at_ms: number }, []>(
          `SELECT ${COLUMNS}, source, updated_at_ms FROM model_prices ORDER BY model`
        )
        .all()
        .map((row) => [
          row.model,
          {
            ...rates(row),
            source: row.source ?? '',
            updated_at_ms: row.updated_at_ms,
            context_tiers: [] as Array<RateValues & { above_input_tokens: number }>,
            service_tiers: [] as Array<RateValues & { names: string[] }>,
          },
        ])
    );
    for (const row of db
      .query<PriceRow & { threshold_tokens: number }, []>(
        `SELECT ${COLUMNS}, threshold_tokens FROM model_price_context_tiers ORDER BY model, threshold_tokens`
      )
      .all()) {
      if (!Object.prototype.hasOwnProperty.call(models, row.model))
        throw new Error(`Context tier has no model: ${row.model}`);
      models[row.model].context_tiers.push({
        ...rates(row),
        above_input_tokens: row.threshold_tokens,
      });
    }
    for (const row of db
      .query<PriceRow & { mode: string; service_tier: string }, []>(
        `SELECT ${COLUMNS}, mode, service_tier FROM model_price_service_tiers ORDER BY model, mode, service_tier`
      )
      .all()) {
      if (!Object.prototype.hasOwnProperty.call(models, row.model))
        throw new Error(`Service tier has no model: ${row.model}`);
      models[row.model].service_tiers.push({
        ...rates(row),
        names: [...new Set([row.mode, row.service_tier])],
      });
    }
    // D5 is a deployment decision: preserve existing prices, otherwise expose the gap.
    for (const name of ['claude-fable-5-2', 'gpt-6.1-terra']) {
      if (!Object.prototype.hasOwnProperty.call(models, name))
        models[name] = {
          input: null,
          output: null,
          cache_read: null,
          cache_write: null,
          source: 'pending D5',
          updated_at_ms: 0,
          context_tiers: [],
          service_tiers: [],
        };
    }
    const aliases = db
      .query<{ api_key_hash: string; alias: string }, []>(
        'SELECT api_key_hash, alias FROM api_key_aliases ORDER BY api_key_hash'
      )
      .all();
    const book = parseRateBook({ version: 1, models });
    return { book, client_alias: aliases };
  } finally {
    db.close();
  }
}

if (import.meta.main) {
  const [
    output,
    databasePath = `${homedir()}/.local/share/cpa-manager-plus/usage.sqlite`,
    ...extra
  ] = Bun.argv.slice(2);
  if (!output || extra.length)
    throw new Error(
      'Usage: bun scripts/usage-export-cpamp-rates.ts <book.json> [cpamp-usage.sqlite]'
    );
  const aliasesPath = `${output}.client-aliases.json`;
  if (existsSync(output) || existsSync(aliasesPath))
    throw new Error('Output already exists; choose new paths');
  const result = exportCpampRates(databasePath);
  writeFileSync(output, `${JSON.stringify(result.book, null, 2)}\n`, { flag: 'wx' });
  writeFileSync(
    aliasesPath,
    `${JSON.stringify({ client_alias: result.client_alias }, null, 2)}\n`,
    { flag: 'wx', mode: 0o600 }
  );
  console.log(
    `Exported ${Object.keys(result.book.models).length} models to ${output}; ${result.client_alias.length} client_alias rows to ${aliasesPath}`
  );
}
