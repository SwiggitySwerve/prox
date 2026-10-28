import type { SourceSession } from '@/services/api/sourceSession';
import type { QuotaStore } from '@/stores/useQuotaStore';
import type { QuotaProviderData } from './types';
import { createQuotaDependencies } from './dependencies';
import { createAntigravityQuotaConfig } from './antigravity/data';
import { createClaudeQuotaConfig } from './claude/data';
import { createCodexQuotaConfig } from './codex/data';
import { createDevinQuotaConfig } from './devin/data';
import { createKimiQuotaConfig } from './kimi/data';
import { createMetaQuotaConfig } from './meta/data';
import { createPluginQuotaConfig } from './plugin/data';
import { createXaiQuotaConfig } from './xai/data';

/** Shared source-local algorithms; no rendering or ambient connection selection. */
export function createQuotaConfigs(session: SourceSession, store?: QuotaStore) {
  const deps = createQuotaDependencies(session, store);
  // Optional metadata providers intentionally catch read errors. Always reject a stale
  // operation at the public boundary even when an optional inner read was swallowed.
  const guard =
    <Args extends unknown[], Result>(read: (...args: Args) => Promise<Result>) =>
    async (...args: Args): Promise<Result> => {
      session.assertCurrent();
      const result = await read(...args);
      session.assertCurrent();
      return result;
    };
  const bind = <State, Data>(config: QuotaProviderData<State, Data>) => ({
    ...config,
    fetchQuota: guard(config.fetchQuota),
    ...(config.resetQuota ? { resetQuota: guard(config.resetQuota) } : {}),
    ...(config.enrichQuota ? { enrichQuota: guard(config.enrichQuota) } : {}),
  });
  return {
    antigravity: bind(createAntigravityQuotaConfig(deps)),
    claude: bind(createClaudeQuotaConfig(deps)),
    codex: bind(createCodexQuotaConfig(deps)),
    devin: bind(createDevinQuotaConfig(deps)),
    kimi: bind(createKimiQuotaConfig(deps)),
    meta: bind(createMetaQuotaConfig(deps)),
    plugin: bind(createPluginQuotaConfig(deps)),
    xai: bind(createXaiQuotaConfig(deps)),
  };
}
