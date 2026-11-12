// Shared management bearer authentication; missing or empty key files fail closed.
import { createHash, timingSafeEqual } from 'node:crypto';
import { readFileSync } from 'node:fs';

/** A rotated key file takes effect within this long; the disk is not read per request. */
const KEY_CACHE_MS = 2000;
const keyCache = new Map<string, { key: string; readAtMs: number }>();

function managementKey(keyFile: string): string {
  const nowMs = Date.now();
  const cached = keyCache.get(keyFile);
  if (cached && nowMs - cached.readAtMs < KEY_CACHE_MS) return cached.key;
  keyCache.delete(keyFile);
  // A missing or empty file throws or is rejected here and is never cached, so it fails closed.
  const key = readFileSync(keyFile, 'utf8').trim();
  if (!key) throw new Error('Management key unavailable');
  keyCache.set(keyFile, { key, readAtMs: nowMs });
  return key;
}

export function authorized(request: Request, keyFile: string): boolean {
  const header = request.headers.get('authorization') ?? '';
  if (!header.startsWith('Bearer ') || header.length > 4096) return false;
  const key = managementKey(keyFile);
  const digest = (value: string) => createHash('sha256').update(value).digest();
  return timingSafeEqual(digest(key), digest(header.slice(7)));
}

