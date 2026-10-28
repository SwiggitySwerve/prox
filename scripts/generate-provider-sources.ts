import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { loadSourceManifest } from '../server/providerSources/config';
import { generateSourceRoutes } from '../server/providerSources/routing';

const path = (name: string) => fileURLToPath(new URL(`../deploy/${name}`, import.meta.url));
const { manifest, revision, discovery } = loadSourceManifest(path('provider-sources.json'));
const outputs = {
  'provider-routes.conf': generateSourceRoutes(manifest, revision),
  'provider-discovery.json': `${JSON.stringify(discovery, null, 2)}\n`,
};
for (const [name, content] of Object.entries(outputs)) {
  if (process.argv.includes('--check')) {
    if (readFileSync(path(name), 'utf8') !== content)
      throw new Error(
        `Generated ${name} differs from the source manifest; run bun run sources:generate`
      );
  } else writeFileSync(path(name), content);
}
