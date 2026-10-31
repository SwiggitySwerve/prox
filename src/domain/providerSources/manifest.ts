import { containsControlCharacters } from '@/utils/helpers';
import type { DeploymentSource, PublicSource, SourceDiscovery, SourceManifest } from './types';

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('Invalid source descriptor');
  return value as Record<string, unknown>;
}

function keys(value: Record<string, unknown>, allowed: readonly string[]): void {
  if (Object.keys(value).some((key) => !allowed.includes(key)))
    throw new Error('Unexpected source descriptor field');
}

function text(value: unknown, maximum = 128): string {
  if (
    typeof value !== 'string' ||
    !value.trim() ||
    value.length > maximum ||
    containsControlCharacters(value)
  )
    throw new Error('Invalid source descriptor text');
  return value;
}

function id(value: unknown): string {
  const result = text(value, 64);
  if (!/^[a-z][a-z0-9-]*$/.test(result)) throw new Error('Invalid source identifier');
  return result;
}

function basePath(value: unknown): string {
  if (value === '') return '';
  const result = text(value, 256);
  if (!/^\/[a-zA-Z0-9_-]+(?:\/[a-zA-Z0-9_-]+)*$/.test(result))
    throw new Error('Invalid source base path');
  return result;
}

function origin(value: unknown): string {
  const result = text(value, 512);
  let url: URL;
  try {
    url = new URL(result);
  } catch {
    throw new Error('Invalid source origin');
  }
  if (
    !['http:', 'https:'].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.origin !== result ||
    !/^(?:[a-z0-9.-]+|\[[a-f0-9:]+\])$/i.test(url.hostname)
  )
    throw new Error('Source upstream must be an HTTP origin');
  return result;
}

function keyFile(value: unknown): string {
  const result = text(value, 1024);
  if (!result.startsWith('/') || result.includes('..'))
    throw new Error('Source credential reference must be an absolute file path');
  return result;
}

function providers(value: unknown): readonly string[] {
  if (!Array.isArray(value) || !value.length) throw new Error('Invalid source providers');
  return Object.freeze(
    value.map((entry) => {
      const result = id(entry);
      if (result === 'anthropic') throw new Error('Source providers use the credential type');
      return result;
    })
  );
}

const publicKeys = [
  'instanceId',
  'label',
  'publicBasePath',
  'aliases',
  'authScope',
  'providers',
] as const;
function publicSource(value: Record<string, unknown>): PublicSource {
  if (!Array.isArray(value.aliases)) throw new Error('Invalid source aliases');
  return Object.freeze({
    instanceId: id(value.instanceId),
    label: text(value.label, 80),
    publicBasePath: basePath(value.publicBasePath),
    aliases: Object.freeze(value.aliases.map(basePath)),
    authScope: id(value.authScope),
    ...(value.providers === undefined ? {} : { providers: providers(value.providers) }),
  });
}

function validateInventory(sources: readonly PublicSource[], defaultInstanceId: string): void {
  const ids = new Set<string>();
  const paths = new Set<string>();
  const owned = new Set<string>();
  for (const source of sources) {
    if (ids.has(source.instanceId)) throw new Error('Duplicate source identifier');
    ids.add(source.instanceId);
    for (const path of [source.publicBasePath, ...source.aliases]) {
      if (paths.has(path)) throw new Error('Duplicate source route');
      paths.add(path);
    }
    for (const provider of source.providers ?? []) {
      if (owned.has(provider)) throw new Error('Provider declared by more than one source');
      owned.add(provider);
    }
  }
  if (!ids.has(defaultInstanceId)) throw new Error('Default source is not configured');
}

function sourceList(value: unknown): unknown[] {
  if (!Array.isArray(value) || !value.length || value.length > 128)
    throw new Error('Invalid source inventory');
  return value;
}

export function validateSourceManifest(input: unknown): SourceManifest {
  const value = record(input);
  keys(value, ['schemaVersion', 'defaultInstanceId', 'history', 'sources', 'analytics']);
  if (value.schemaVersion !== 1) throw new Error('Unsupported source manifest version');
  const sources = sourceList(value.sources).map((entry): DeploymentSource => {
    const source = record(entry);
    keys(source, [...publicKeys, 'upstreamOrigin', 'managementKeyFile']);
    return Object.freeze({
      ...publicSource(source),
      upstreamOrigin: origin(source.upstreamOrigin),
      managementKeyFile: keyFile(source.managementKeyFile),
    });
  });
  const defaultInstanceId = id(value.defaultInstanceId);
  validateInventory(sources, defaultInstanceId);
  const history = record(value.history);
  keys(history, ['upstreamOrigin', 'managementKeyFile']);
  let analytics: SourceManifest['analytics'];
  if (value.analytics !== undefined) {
    const config = record(value.analytics);
    keys(config, ['upstreamOrigin', 'adminKeyFile', 'dataset']);
    if (config.dataset !== 'homelab') throw new Error('Unknown analytics dataset grant');
    analytics = Object.freeze({
      upstreamOrigin: origin(config.upstreamOrigin),
      adminKeyFile: keyFile(config.adminKeyFile),
      dataset: 'homelab',
    });
  }
  return Object.freeze({
    schemaVersion: 1,
    defaultInstanceId,
    sources: Object.freeze(sources),
    ...(analytics ? { analytics } : {}),
    history: Object.freeze({
      upstreamOrigin: origin(history.upstreamOrigin),
      managementKeyFile: keyFile(history.managementKeyFile),
    }),
  });
}

/** Allowlist deployment metadata; never accept upstream inventories here. */
export function publicSourceDiscovery(manifest: SourceManifest, revision: string): SourceDiscovery {
  return validateSourceDiscovery({
    schemaVersion: 1,
    revision,
    defaultInstanceId: manifest.defaultInstanceId,
    sources: manifest.sources.map(
      ({ instanceId, label, publicBasePath, aliases, authScope, providers: owned }) => ({
        instanceId,
        label,
        publicBasePath,
        aliases,
        authScope,
        ...(owned ? { providers: owned } : {}),
      })
    ),
  });
}

export function validateSourceDiscovery(input: unknown): SourceDiscovery {
  const value = record(input);
  keys(value, ['schemaVersion', 'revision', 'defaultInstanceId', 'sources']);
  if (
    value.schemaVersion !== 1 ||
    typeof value.revision !== 'string' ||
    !/^[a-f0-9]{64}$/.test(value.revision)
  )
    throw new Error('Invalid source discovery version');
  const sources = sourceList(value.sources).map((entry) => {
    const source = record(entry);
    keys(source, publicKeys);
    return publicSource(source);
  });
  const defaultInstanceId = id(value.defaultInstanceId);
  validateInventory(sources, defaultInstanceId);
  return Object.freeze({
    schemaVersion: 1,
    revision: value.revision,
    defaultInstanceId,
    sources: Object.freeze(sources),
  });
}
