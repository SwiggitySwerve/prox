/**
 * The header's refresh button: one click re-reads every shared store and the open page.
 *
 * - Every hub's key gate is armed first, so each hub answers one request before the rest go out
 *   and a wrong key costs one failed request per hub (services/api/authGate.ts).
 * - The credential lists are read once; the page's handler receives that read in the round
 *   instead of listing every hub again.
 * - Config goes through the main connection, so it waits for the credential read and is skipped
 *   when the main hub refused the key.
 * - Resolves when everything has settled, with what failed, for one summary notice.
 * React-free; tests/headerRefreshRound.test.ts consumes it directly.
 */
import type { HeaderRefreshRound } from '@/hooks/useHeaderRefresh';
import type { RefreshOutcome } from '@/stores/useCredentialInventoryStore';

export type RefreshSource = 'config' | 'plugins' | 'credentials' | 'models' | 'quota' | 'page';

export interface HeaderRefreshDeps {
  armAuthProbes(): void;
  /** Instance ids of hubs that refused the management key. */
  deniedHubs(): string[];
  /** The hub behind the main connection (config), if known. */
  selectedHub(): string | null;
  clearConfigCache(): void;
  refreshConfig(): Promise<unknown>;
  /** Resolves to the hubs whose plugin list could not be read. */
  refreshPlugins(): Promise<string[]>;
  refreshInventory(): Promise<RefreshOutcome>;
  /** Resolves to the hubs where a model-access re-read failed. */
  refreshModelAccess(): Promise<string[]>;
  refreshPage(round: HeaderRefreshRound): Promise<void>;
}

export interface HeaderRefreshSummary {
  /** count: cards whose quota read failed (source 'quota'). */
  failed: Array<{ source: RefreshSource; hub?: string; count?: number }>;
  deniedHubs: string[];
}

export async function runHeaderRefresh(deps: HeaderRefreshDeps): Promise<HeaderRefreshSummary> {
  deps.armAuthProbes();
  const inventory = deps.refreshInventory();
  const quotaFailures = new Map<string, number>();
  const round: HeaderRefreshRound = {
    inventory,
    quotaFailed: (hub, count) => quotaFailures.set(hub, (quotaFailures.get(hub) ?? 0) + count),
  };
  const [inventoryResult, models, page, config, plugins] = await Promise.allSettled([
    inventory,
    deps.refreshModelAccess(),
    deps.refreshPage(round),
    inventory
      .catch(() => undefined)
      .then(() => {
        const main = deps.selectedHub();
        if (main && deps.deniedHubs().includes(main)) return;
        deps.clearConfigCache();
        return deps.refreshConfig();
      }),
    deps.refreshPlugins(),
  ]);

  const deniedHubs = deps.deniedHubs();
  const failed: HeaderRefreshSummary['failed'] = [];
  if (config.status === 'rejected') failed.push({ source: 'config' });
  if (plugins.status === 'rejected') failed.push({ source: 'plugins' });
  else {
    for (const hub of plugins.value) {
      if (!deniedHubs.includes(hub)) failed.push({ source: 'plugins', hub });
    }
  }
  if (inventoryResult.status === 'rejected') failed.push({ source: 'credentials' });
  else {
    for (const [hub, error] of Object.entries(inventoryResult.value)) {
      if (error && !deniedHubs.includes(hub)) failed.push({ source: 'credentials', hub });
    }
  }
  if (models.status === 'rejected') failed.push({ source: 'models' });
  else {
    for (const hub of models.value) {
      if (!deniedHubs.includes(hub)) failed.push({ source: 'models', hub });
    }
  }
  for (const [hub, count] of quotaFailures) {
    if (count > 0 && !deniedHubs.includes(hub)) failed.push({ source: 'quota', hub, count });
  }
  if (page.status === 'rejected') failed.push({ source: 'page' });
  return { failed, deniedHubs };
}
