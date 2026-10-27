/**
 * Vertex credential import API
 */

import { apiClient } from './client';
import type { SourceSession, ManagementTransport } from './sourceSession';

export interface VertexImportResponse {
  status: 'ok';
  project_id?: string;
  email?: string;
  location?: string;
  'auth-file'?: string;
  auth_file?: string;
}

function buildVertexApi(client: ManagementTransport) {
  return {
    importCredential: (file: File, location?: string) => {
      const formData = new FormData();
      formData.append('file', file);
      if (location) {
        formData.append('location', location);
      }
      return client.postForm<VertexImportResponse>('/oauth/import?provider=vertex', formData);
    },
  };
}

export function createVertexApi(session: SourceSession) {
  return buildVertexApi(session.management);
}

export const vertexApi = buildVertexApi(apiClient);
