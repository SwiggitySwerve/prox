import { notifySourceConfigChanged } from './sourceConfigChanges';
import { containsControlCharacters } from '@/utils/helpers';
import type { ApiClientConfig } from '@/types';
import { validatedManagementBase } from '@/utils/connection';
import { ApiClient } from './transport';
import type { TransportEvent } from './transportPolicy';

export interface SourceOwner {
  readonly instanceId: string;
  readonly sessionEpoch: number;
  readonly sourceGeneration: number;
}

export type ManagementTransport = Pick<
  ApiClient,
  'get' | 'post' | 'put' | 'patch' | 'delete' | 'getRaw' | 'postForm'
>;

export interface SourceSession {
  readonly owner: SourceOwner;
  readonly signal: AbortSignal;
  readonly management: ManagementTransport;
  assertCurrent(): void;
}

export interface SourceConnection extends ApiClientConfig {
  readonly instanceId: string;
  /** Changes when routing/auth scope changes; labels need not invalidate work. */
  readonly configurationRevision: string;
}

export type SourceTransportEvent = Exclude<TransportEvent, { type: 'source-config-changed' }> & {
  readonly owner: SourceOwner;
};

interface Entry {
  config: SourceConnection;
  controller: AbortController;
  session: SourceSession;
}

/** Cache identity only. Resource APIs still receive the original local identifier. */
export function sourceOwnerKey(owner: SourceOwner): string {
  return JSON.stringify([owner.instanceId, owner.sessionEpoch, owner.sourceGeneration]);
}

export function sourceResourceKey(owner: SourceOwner, localKey: string): string {
  return JSON.stringify([sourceOwnerKey(owner), localKey]);
}

/** Owns authenticated source lifetimes, never the selected UI filter. */
export class SourceSessions {
  private epoch = 0;
  private readonly generations = new Map<string, number>();
  private readonly entries = new Map<string, Entry>();

  constructor(private readonly onEvent: (event: SourceTransportEvent) => void = () => {}) {}

  configure(connections: readonly SourceConnection[]): void {
    const ids = new Set<string>();
    // Validate every input first so a bad list cannot partially replace live sessions.
    const validated = connections.map((config) => {
      if (!/^[a-z][a-z0-9-]{0,63}$/.test(config.instanceId) || ids.has(config.instanceId))
        throw new Error('Invalid source identity');
      ids.add(config.instanceId);
      if (
        !config.managementKey.trim() ||
        containsControlCharacters(config.managementKey) ||
        !config.configurationRevision.trim() ||
        (config.timeout !== undefined && (!Number.isFinite(config.timeout) || config.timeout <= 0))
      )
        throw new Error('Invalid source connection');
      const apiBase = validatedManagementBase(config.apiBase);
      return { ...config, apiBase };
    });
    for (const [id, entry] of this.entries) {
      if (!ids.has(id)) {
        entry.controller.abort();
        this.entries.delete(id);
      }
    }
    for (const config of validated) {
      const old = this.entries.get(config.instanceId);
      if (
        old &&
        old.config.apiBase === config.apiBase &&
        old.config.managementKey === config.managementKey &&
        old.config.configurationRevision === config.configurationRevision &&
        old.config.timeout === config.timeout
      )
        continue;
      old?.controller.abort();
      const generation = (this.generations.get(config.instanceId) ?? 0) + 1;
      this.generations.set(config.instanceId, generation);
      const owner: SourceOwner = Object.freeze({
        instanceId: config.instanceId,
        sessionEpoch: this.epoch,
        sourceGeneration: generation,
      });
      const controller = new AbortController();
      const assertCurrent = () => {
        if (
          controller.signal.aborted ||
          this.entries.get(config.instanceId)?.session.owner !== owner
        )
          throw new Error('Source session changed');
      };
      const transport = new ApiClient(() => !controller.signal.aborted, {
        signal: controller.signal,
        assertCurrent,
        onEvent: (event) => {
          assertCurrent();
          if (event.type === 'source-config-changed') notifySourceConfigChanged(owner);
          else this.onEvent({ ...event, owner });
        },
      });
      transport.setConfig(config);
      // Bind a read-only public contract; no mutable transport or credentials escape.
      const management: ManagementTransport = Object.freeze({
        get: transport.get.bind(transport),
        post: transport.post.bind(transport),
        put: transport.put.bind(transport),
        patch: transport.patch.bind(transport),
        delete: transport.delete.bind(transport),
        getRaw: transport.getRaw.bind(transport),
        postForm: transport.postForm.bind(transport),
      });
      const session = Object.freeze({
        owner,
        signal: controller.signal,
        management,
        assertCurrent,
      });
      this.entries.set(config.instanceId, { config, controller, session });
    }
  }

  captureSource(instanceId: string): SourceSession {
    const session = this.entries.get(instanceId)?.session;
    if (!session) throw new Error('Source is not authenticated');
    session.assertCurrent();
    return session;
  }

  /** Call on logout/reconnect even if credentials remain textually identical. */
  reset(): void {
    for (const entry of this.entries.values()) entry.controller.abort();
    this.entries.clear();
    this.epoch += 1;
  }
}
