// Private local naming configuration, never an API-key inventory or a database projection.
import { closeSync, fstatSync, openSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export const DEFAULT_CLIENT_ALIASES_PATH = join(
  homedir(),
  '.config/prox-usage/client-aliases.json'
);

export function parseClientAliases(input: unknown): ReadonlyMap<string, string> {
  if (
    !input ||
    typeof input !== 'object' ||
    Array.isArray(input) ||
    Object.keys(input).join() !== 'client_alias' ||
    !Array.isArray((input as { client_alias: unknown }).client_alias)
  ) {
    throw new Error('Invalid client aliases');
  }
  const result = new Map<string, string>();
  for (const row of (input as { client_alias: unknown[] }).client_alias) {
    if (!row || typeof row !== 'object' || Array.isArray(row)) throw new Error('Invalid alias');
    const value = row as Record<string, unknown>;
    if (
      Object.keys(value).some((key) => !['api_key_hash', 'alias'].includes(key)) ||
      typeof value.api_key_hash !== 'string' ||
      !/^[a-f0-9]{64}$/.test(value.api_key_hash) ||
      typeof value.alias !== 'string' ||
      !value.alias.trim() ||
      result.has(value.api_key_hash)
    ) {
      throw new Error('Invalid alias');
    }
    result.set(value.api_key_hash, value.alias);
  }
  return result;
}

export function createClientAliasLoader(path: string) {
  let aliases: ReadonlyMap<string, string> = new Map();
  let modified: number | null = null;
  return {
    load(): { aliases: ReadonlyMap<string, string>; error: boolean } {
      let descriptor: number | undefined;
      try {
        const stat = statSync(path);
        if (!stat.isFile() || (stat.mode & 0o777) !== 0o600)
          throw new Error('Private file required');
        if (stat.mtimeMs !== modified) {
          descriptor = openSync(path, 'r');
          const opened = fstatSync(descriptor);
          if (!opened.isFile() || (opened.mode & 0o777) !== 0o600 || opened.size > 1_048_576) {
            throw new Error('Invalid private file');
          }
          aliases = parseClientAliases(JSON.parse(readFileSync(descriptor, 'utf8')));
          modified = opened.mtimeMs;
        }
        return { aliases, error: false };
      } catch {
        // Retain the last good names on an interrupted edit; expose failure without file contents.
        modified = null;
        return { aliases, error: true };
      } finally {
        if (descriptor !== undefined) closeSync(descriptor);
      }
    },
  };
}
