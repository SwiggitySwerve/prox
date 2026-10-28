import { createApiCallApi } from '@/services/api/apiCall';
import { apiClient } from '@/services/api/client';
import {
  claimClaudeResetGrant,
  readClaudeOrganization,
  readClaudeResetGrants,
} from '@/services/api/claudeResetGrants';
import type { SourceOwner, SourceSession } from '@/services/api/sourceSession';
import {
  createResetGrantJournal,
  createResetGrantOperations,
  resetGrantOperations,
  type ResetGrantJournal,
} from './resetGrantOperations';
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

const journals = new WeakMap<SourceOwner, ResetGrantJournal>();
const scopes = new WeakMap<SourceSession, ResetGrantScope>();
/** Share ambiguous-operation journals across cards/pages, only within their owner.
 * The journal belongs to the authenticated owner so leaving a page keeps it; currentness
 * and requests stay bound to each page's own lease. */
export function createSourceResetGrants(session: SourceSession): ResetGrantScope {
  const existing = scopes.get(session);
  if (existing) return existing;
  let journal = journals.get(session.owner);
  if (!journal) {
    journal = createResetGrantJournal();
    journals.set(session.owner, journal);
  }
  const api = createApiCallApi(session);
  const current = () => {
    try {
      session.assertCurrent();
      return true;
    } catch {
      return false;
    }
  };
  // Constant per owner so a claim interrupted by closing its page still releases its key.
  const revision = () => session.owner.sourceGeneration;
  const read = (authIndex: string) => readClaudeResetGrants(authIndex, api);
  const scope: ResetGrantScope = {
    current,
    revision,
    read: createResetGrantReader({ revision, read }),
    operations: createResetGrantOperations(
      {
        revision,
        readStatus: read,
        readOrganization: (authIndex) => readClaudeOrganization(authIndex, api),
        claim: (authIndex, organization, grantId, requestId) =>
          claimClaudeResetGrant(authIndex, organization, grantId, requestId, api),
        now: () => Date.now(),
        requestId: () => crypto.randomUUID(),
      },
      journal
    ),
  };
  scopes.set(session, scope);
  return scope;
}
