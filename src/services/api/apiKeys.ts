/** Client access keys are a direct config list, not upstream provider groups. */
import { apiClient } from './client';
import { createConfigValueApi, guardConfigConnection } from './configValue';

import type { ManagementTransport, SourceSession } from './sourceSession';

const PATH = '/config/access/api-keys';

const assertIndex = (keys: string[], index: number): void => {
  if (!Number.isInteger(index) || index < 0 || index >= keys.length) {
    throw new RangeError('API key index out of range');
  }
};

export function createApiKeysApi(session: SourceSession) {
  return buildApiKeysApi(
    session.management,
    () => {
      const signal = session.signal;
      return () => {
        session.assertCurrent();
        signal.throwIfAborted();
      };
    },
    true
  );
}

function buildApiKeysApi(
  transport: ManagementTransport,
  captureGuard: () => () => void,
  strict = false
) {
  const { getConfigValue } = createConfigValueApi(transport, captureGuard);
  const api = {
    async list(): Promise<string[]> {
      const assertCurrent = captureGuard();
      assertCurrent();
      const data = await getConfigValue<unknown>(PATH, []);
      assertCurrent();
      if (strict && (!Array.isArray(data) || !data.every((key) => typeof key === 'string'))) {
        throw new Error('Invalid client API key inventory');
      }
      return Array.isArray(data) ? data.map((key) => String(key)) : [];
    },

    replace: async (keys: string[]) => {
      const assertCurrent = captureGuard();
      assertCurrent();
      const result = await transport.put(PATH, keys);
      assertCurrent();
      return result;
    },

    async update(index: number, value: string) {
      const assertConnection = captureGuard();
      const keys = await api.list();
      assertConnection();
      assertIndex(keys, index);
      keys[index] = value;
      return api.replace(keys);
    },

    async delete(index: number) {
      const assertConnection = captureGuard();
      const keys = await api.list();
      assertConnection();
      assertIndex(keys, index);
      keys.splice(index, 1);
      return api.replace(keys);
    },
  };

  return api;
}

export const apiKeysApi = buildApiKeysApi(apiClient, guardConfigConnection);
