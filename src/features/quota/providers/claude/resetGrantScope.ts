import { createApiCallApi } from '@/services/api/apiCall';
import { apiClient } from '@/services/api/client';
import {
  claimClaudeResetGrant,
  readClaudeOrganization,
  readClaudeResetGrants,
} from '@/services/api/claudeResetGrants';
import type { SourceSession } from '@/services/api/sourceSession';
import { createResetGrantOperations, resetGrantOperations } from './resetGrantOperations';
import { createResetGrantReader, readResetGrantsForCard } from './resetGrantReads';

export interface ResetGrantScope {
  current: () => boolean;
  revision: () => number;
  read: typeof readResetGrantsForCard;
  operations: typeof resetGrantOperations;
}
export const legacyResetGrantScope: ResetGrantScope = {
  current: () => true,
  revision: () => apiClient.getConnectionRevision(),
  read: readResetGrantsForCard,
  operations: resetGrantOperations,
};

const scopes = new WeakMap<SourceSession, ResetGrantScope>();
/** Share ambiguous-operation journals across cards/pages, only within their owner. */
export function createSourceResetGrants(session: SourceSession): ResetGrantScope {
  const existing = scopes.get(session);
  if (existing) return existing;
  const api = createApiCallApi(session);
  const current = () => {
    try {
      session.assertCurrent();
      return true;
    } catch {
      return false;
    }
  };
  const revision = () => (current() ? session.owner.sourceGeneration : -1);
  const read = (authIndex: string) => readClaudeResetGrants(authIndex, api);
  const scope: ResetGrantScope = {
    current,
    revision,
    read: createResetGrantReader({ revision, read }),
    operations: createResetGrantOperations({
      revision,
      readStatus: read,
      readOrganization: (authIndex) => readClaudeOrganization(authIndex, api),
      claim: (authIndex, organization, grantId, requestId) =>
        claimClaudeResetGrant(authIndex, organization, grantId, requestId, api),
      now: () => Date.now(),
      requestId: () => crypto.randomUUID(),
    }),
  };
  scopes.set(session, scope);
  return scope;
}
