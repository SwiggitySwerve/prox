import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import {
  publicSourceDiscovery,
  validateSourceManifest,
} from '../../src/domain/providerSources/manifest';

export function loadSourceManifest(path: string) {
  const manifest = validateSourceManifest(JSON.parse(readFileSync(path, 'utf8')));
  const revision = createHash('sha256').update(JSON.stringify(manifest)).digest('hex');
  return { manifest, revision, discovery: publicSourceDiscovery(manifest, revision) };
}
