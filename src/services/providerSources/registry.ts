import { resolveConnectionSources } from '@/domain/providerSources/resolution';
import type {
  ResolvedSource,
  SourceDiscovery,
  SourceResolution,
} from '@/domain/providerSources/types';
import { validatedManagementBase } from '@/utils/connection';
import {
  SourceSessions,
  type SourceConnection,
  type SourceSession,
  type SourceTransportEvent,
} from '@/services/api/sourceSession';
import { fetchSourceDiscovery } from './discovery';

export interface SourceView {
  readonly source: ResolvedSource;
  readonly session: SourceSession | null;
  readonly status: 'ready' | 'authentication-required' | 'unauthorized';
  readonly version: string | null;
  readonly supportsPlugin: boolean;
}
export interface SourceRegistrySnapshot {
  readonly status: 'disconnected' | 'loading' | 'ready' | 'error';
  readonly resolution: SourceResolution | null;
  readonly sources: readonly SourceView[];
}
const disconnected: SourceRegistrySnapshot = Object.freeze({
  status: 'disconnected',
  resolution: null,
  sources: [],
});
type Discover = (origin: string, signal: AbortSignal) => Promise<SourceDiscovery | null>;

/** Owns authenticated source inventory; selection does not change source identity. */
export class SourceRegistry {
  private snapshot: SourceRegistrySnapshot = disconnected;
  private listeners = new Set<() => void>();
  private controller: AbortController | null = null;
  private readonly sessions = new SourceSessions((event) => this.receive(event));
  private connections: SourceConnection[] = [];

  constructor(private readonly discover: Discover = fetchSourceDiscovery) {}
  getSnapshot = (): SourceRegistrySnapshot => this.snapshot;
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  private publish(snapshot: SourceRegistrySnapshot) {
    this.snapshot = Object.freeze(snapshot);
    for (const listener of this.listeners) listener();
  }
  reset(): void {
    this.controller?.abort();
    this.controller = null;
    this.sessions.reset();
    this.connections = [];
    this.publish(disconnected);
  }
  async connect(apiBase: string, managementKey: string, appOrigin: string): Promise<void> {
    this.reset();
    const controller = new AbortController();
    this.controller = controller;
    this.publish({ status: 'loading', resolution: null, sources: [] });
    try {
      const base = validatedManagementBase(apiBase);
      const discovery =
        new URL(base).origin === appOrigin
          ? await this.discover(appOrigin, controller.signal)
          : null;
      if (controller.signal.aborted) return;
      const resolution = resolveConnectionSources(base, appOrigin, discovery);
      const selected = resolution.sources.find(
        (source) => source.instanceId === resolution.selectedInstanceId
      )!;
      this.connections = resolution.sources
        .filter((source) => source.authScope === selected.authScope)
        .map((source) => ({
          instanceId: source.instanceId,
          apiBase: source.apiBase,
          managementKey,
          configurationRevision: `${resolution.revision}:${source.authScope}`,
        }));
      this.sessions.configure(this.connections);
      this.publish({
        status: 'ready',
        resolution,
        sources: resolution.sources.map((source) => ({
          source,
          session:
            source.authScope === selected.authScope
              ? this.sessions.captureSource(source.instanceId)
              : null,
          status: source.authScope === selected.authScope ? 'ready' : 'authentication-required',
          version: null,
          supportsPlugin: false,
        })),
      });
    } catch {
      if (!controller.signal.aborted) {
        this.sessions.reset();
        this.connections = [];
        this.publish({ status: 'error', resolution: null, sources: [] });
      }
    }
  }
  private receive(event: SourceTransportEvent): void {
    const sources = this.snapshot.sources.map((view): SourceView => {
      if (view.session?.owner !== event.owner) return view;
      if (event.type === 'unauthorized') return { ...view, status: 'unauthorized' };
      if (event.type === 'server-version-update') return { ...view, version: event.detail.version };
      return { ...view, supportsPlugin: event.detail.supportsPlugin };
    });
    this.publish({ ...this.snapshot, sources });
  }
}
