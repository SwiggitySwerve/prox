import { MANAGEMENT_API_PREFIX } from '../../src/utils/constants';
import type { SourceManifest } from '../../src/domain/providerSources/types';

/** Fixed routing only: no browser-controlled upstream or credential injection. */
export function generateSourceRoutes(manifest: SourceManifest, revision: string): string {
  const routes = [`# Generated from provider-sources.json; revision ${revision}. Do not edit.\n`];
  routes.push('location = /prox/sources.json { try_files /prox/sources.json =404; }\n');
  for (const source of manifest.sources) {
    for (const base of [source.publicBasePath, ...source.aliases]) {
      routes.push(
        `location ^~ ${base}${MANAGEMENT_API_PREFIX}/prox/ {\n  proxy_pass ${manifest.history.upstreamOrigin}/v1/;\n}\n`
      );
      routes.push(
        `location ^~ ${base}${MANAGEMENT_API_PREFIX}/ {\n  proxy_pass ${source.upstreamOrigin}${MANAGEMENT_API_PREFIX}/;\n}\n`
      );
      // Catalog authentication is the browser's client key, never a management key.
      routes.push(
        `location = ${base}/v1/models {\n  proxy_pass ${source.upstreamOrigin}/v1/models;\n}\n`
      );
    }
  }
  return routes.join('\n');
}
