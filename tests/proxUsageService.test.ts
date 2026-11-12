import { afterEach, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { createUsageStatusHandler } from '../server/usage/status';

let temp = '';
afterEach(() => {
  if (temp) rmSync(temp, { recursive: true, force: true });
  temp = '';
});

test('status is bearer protected, health is public, missing/empty keys fail closed', async () => {
  temp = mkdtempSync(join(tmpdir(), 'prox-usage-status-'));
  const keyFile = join(temp, 'key');
  const handler = createUsageStatusHandler({
    keyFile,
    sources: () => [],
    healthy: () => true,
    writer: () => ({
      backlog: 3,
      gaps: 2,
      rawBufferFailures: 1,
      inserted: 5,
      duplicates: 0,
      rejected: 0,
    }),
  });
  const request = (path: string, key?: string) =>
    new Request(`http://127.0.0.1${path}`, {
      headers: key ? { Authorization: `Bearer ${key}` } : {},
    });
  expect(handler(request('/healthz')).status).toBe(200);
  expect(handler(request('/v1/status')).status).toBe(401);
  expect(handler(request('/v1/status', 'key')).status).toBe(503);
  writeFileSync(keyFile, '  ');
  expect(handler(request('/v1/status', 'key')).status).toBe(503);
  writeFileSync(keyFile, 'synthetic-key');
  expect(handler(request('/v1/status', 'wrong')).status).toBe(401);
  const response = handler(request('/v1/status', 'synthetic-key'));
  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({
    writer: { backlog: 3, gaps: 2, rawBufferFailures: 1 },
  });
  expect(handler(request('/unknown')).status).toBe(404);
  expect(handler(new Request('http://127.0.0.1/v1/status', { method: 'POST' })).status).toBe(405);
});

test('the main-thread runtime module graph never imports bun:sqlite or a worker entry', () => {
  const transpiler = new Bun.Transpiler({ loader: 'ts', target: 'bun' });
  const visited = new Set<string>();
  const root = resolve(import.meta.dir, '..');
  const visit = (file: string) => {
    if (visited.has(file)) return;
    visited.add(file);
    for (const entry of transpiler.scanImports(readFileSync(file, 'utf8'))) {
      expect(entry.path).not.toBe('bun:sqlite');
      expect(entry.path).not.toContain('.worker');
      if (entry.path.startsWith('.') || entry.path.startsWith('@/')) {
        const base = entry.path.startsWith('@/')
          ? resolve(root, 'src', entry.path.slice(2))
          : resolve(dirname(file), entry.path);
        visit(`${base}.ts`);
      }
    }
  };
  visit(join(root, 'server/usage/main.ts'));
  expect(visited.size).toBeGreaterThan(10);
});

test('deploy uses the history image, hashes both bundles and keeps the API on loopback', () => {
  const root = resolve(import.meta.dir, '..');
  const read = (path: string) => readFileSync(join(root, path), 'utf8');
  const script = read('scripts/deploy-homelab.sh');
  expect(script.match(/podman build /g)).toHaveLength(2);
  expect(script).toContain('sha256sum dist/usage/*.js');
  expect(script).toContain('if [[ "$usage_hash" != "$previous_usage_hash" ]]');
  expect(script.match(/restart prox-usage.service/g)).toHaveLength(1);
  expect(read('deploy/prox-usage.container')).toContain('Image=localhost/prox-history:dev');
  expect(read('deploy/prox-usage.container')).toContain('Exec=bun /app/usage/main.js');
  expect(read('deploy/Dockerfile.history')).toContain('COPY dist/usage /app/usage');
  expect(read('server/usage/main.ts')).toContain("hostname: '127.0.0.1'");
});
