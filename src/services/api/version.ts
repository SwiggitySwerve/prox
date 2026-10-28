/**
 * 版本相关 API
 */

import { apiClient } from './client';
import type { ManagementTransport, SourceSession } from './sourceSession';

function versionApiFor(transport: ManagementTransport) {
  return { checkLatest: () => transport.get<Record<string, unknown>>('/server/latest-version') };
}
export const versionApi = versionApiFor(apiClient);
export const createVersionApi = (session: SourceSession) => versionApiFor(session.management);
