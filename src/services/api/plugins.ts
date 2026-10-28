import { apiClient } from './client';
import type { ManagementTransport, SourceSession } from './sourceSession';
import { createConfigValueApi, guardConfigConnection } from './configValue';
import { isRecord } from '@/utils/helpers';
import {
  isManagementOAuthProviderKey,
  normalizeManagementOAuthProviderKey,
} from '@/utils/providerKeys';
import type {
  PluginConfigField,
  PluginConfigObject,
  PluginDeleteResult,
  PluginListEntry,
  PluginListResponse,
  PluginMetadata,
  PluginMenu,
  PluginStoreEntry,
  PluginStoreInstallResult,
  PluginStorePlatform,
  PluginStoreResponse,
  PluginStoreSourceError,
} from '@/types';

const asString = (value: unknown): string => {
  if (value === undefined || value === null) return '';
  return String(value);
};

const asBoolean = (value: unknown): boolean => value === true;

const normalizePluginOAuthProvider = (value: unknown): string | undefined => {
  const provider = normalizeManagementOAuthProviderKey(asString(value));
  return isManagementOAuthProviderKey(provider) ? provider : undefined;
};

const normalizeConfigField = (value: unknown): PluginConfigField | null => {
  if (!isRecord(value)) return null;
  const name = asString(value.name).trim();
  if (!name) return null;
  const enumValues = Array.isArray(value.enum_values)
    ? value.enum_values.map((item) => asString(item)).filter(Boolean)
    : [];
  return {
    name,
    type: asString(value.type).trim() || 'string',
    enumValues,
    description: asString(value.description).trim(),
  };
};

const normalizeConfigFields = (value: unknown): PluginConfigField[] =>
  Array.isArray(value)
    ? (value.map((item) => normalizeConfigField(item)).filter(Boolean) as PluginConfigField[])
    : [];

const normalizeMetadata = (value: unknown): PluginMetadata | null => {
  if (!isRecord(value)) return null;
  const name = asString(value.name).trim();
  const version = asString(value.version).trim();
  const author = asString(value.author).trim();
  const githubRepository = asString(value.github_repository).trim();
  const logo = asString(value.logo).trim();
  const configFields = normalizeConfigFields(value.config_fields);

  if (!name && !version && !author && !githubRepository && !logo && configFields.length === 0) {
    return null;
  }

  return {
    name,
    version,
    author,
    githubRepository,
    logo,
    configFields,
  };
};

const normalizeMenu = (value: unknown): PluginMenu | null => {
  if (!isRecord(value)) return null;
  const path = asString(value.path).trim();
  const menu = asString(value.menu).trim();
  if (!path && !menu) return null;
  return {
    path,
    menu,
    description: asString(value.description).trim(),
  };
};

const normalizeMenus = (value: unknown): PluginMenu[] =>
  Array.isArray(value)
    ? (value.map((item) => normalizeMenu(item)).filter(Boolean) as PluginMenu[])
    : [];

const normalizePluginEntry = (value: unknown): PluginListEntry | null => {
  if (!isRecord(value)) return null;
  const id = asString(value.id).trim();
  if (!id) return null;

  const metadata = normalizeMetadata(value.metadata);
  const configFields = normalizeConfigFields(value.config_fields);
  const supportsOAuth = asBoolean(value.supports_oauth);
  const oauthProvider = normalizePluginOAuthProvider(value.oauth_provider);
  const quotaProvider = asString(value.quota_provider).trim().toLowerCase();

  return {
    id,
    path: asString(value.path).trim(),
    configured: asBoolean(value.configured),
    registered: asBoolean(value.registered),
    enabled: value.enabled !== false,
    effectiveEnabled: asBoolean(value.effective_enabled),
    supportsOAuth,
    oauthProvider,
    supportsQuota: asBoolean(value.supports_quota),
    ...(quotaProvider ? { quotaProvider } : {}),
    logo: asString(value.logo || metadata?.logo).trim(),
    configFields: configFields.length > 0 ? configFields : (metadata?.configFields ?? []),
    menus: normalizeMenus(value.menus),
    metadata,
  };
};

export class PluginInventoryError extends Error {
  constructor() {
    super('Invalid plugin inventory');
    this.name = 'PluginInventoryError';
  }
}

// Never report a malformed or truncated inventory as complete-empty.
function validatePluginInventory(value: unknown): Record<string, unknown> & { plugins: unknown[] } {
  if (
    !isRecord(value) ||
    !Array.isArray(value.plugins) ||
    value.plugins.some((item) => !isRecord(item) || typeof item.id !== 'string' || !item.id.trim())
  ) {
    throw new PluginInventoryError();
  }
  return { ...value, plugins: value.plugins };
}

const normalizePluginList = (value: unknown): PluginListResponse => {
  const source = validatePluginInventory(value);
  const plugins = Array.isArray(source.plugins)
    ? (source.plugins
        .map((item) => normalizePluginEntry(item))
        .filter(Boolean) as PluginListEntry[])
    : [];

  return {
    pluginsEnabled: asBoolean(source.plugins_enabled),
    pluginsDir: asString(source.plugins_dir).trim() || 'plugins',
    plugins,
  };
};

const normalizePluginConfig = (value: unknown): PluginConfigObject =>
  isRecord(value) ? { ...value } : {};

const normalizeDeleteResult = (value: unknown): PluginDeleteResult => {
  const source = isRecord(value) ? value : {};
  return {
    status: asString(source.status).trim(),
    id: asString(source.id).trim(),
    path: asString(source.path).trim(),
    fileDeleted: asBoolean(source.file_deleted),
    configuredRemoved: asBoolean(source.configured_removed),
    restartRequired: asBoolean(source.restart_required),
  };
};

const normalizeStoreEntry = (value: unknown): PluginStoreEntry | null => {
  if (!isRecord(value)) return null;
  const id = asString(value.id).trim();
  if (!id) return null;
  const sourceId = asString(value.source_id).trim();
  const storeId = asString(value.store_id).trim() || (sourceId ? `${sourceId}/${id}` : id);

  const tags = Array.isArray(value.tags)
    ? value.tags.map((item) => asString(item).trim()).filter(Boolean)
    : [];
  const platforms = Array.isArray(value.platforms)
    ? (value.platforms
        .map((item): PluginStorePlatform | null => {
          if (!isRecord(item)) return null;
          const goos = asString(item.goos).trim();
          const goarch = asString(item.goarch).trim();
          return goos || goarch ? { goos, goarch } : null;
        })
        .filter(Boolean) as PluginStorePlatform[])
    : [];

  return {
    storeId,
    sourceId,
    sourceName: asString(value.source_name).trim(),
    sourceUrl: asString(value.source_url).trim(),
    id,
    name: asString(value.name).trim(),
    description: asString(value.description).trim(),
    author: asString(value.author).trim(),
    version: asString(value.version).trim(),
    repository: asString(value.repository).trim(),
    installType: asString(value.install_type).trim(),
    authRequired: asBoolean(value.auth_required),
    authConfigured: asBoolean(value.auth_configured),
    platforms,
    logo: asString(value.logo).trim(),
    homepage: asString(value.homepage).trim(),
    license: asString(value.license).trim(),
    tags,
    installed: asBoolean(value.installed),
    installedVersion: asString(value.installed_version).trim(),
    path: asString(value.path).trim(),
    configured: asBoolean(value.configured),
    registered: asBoolean(value.registered),
    enabled: asBoolean(value.enabled),
    effectiveEnabled: asBoolean(value.effective_enabled),
    updateAvailable: asBoolean(value.update_available),
  };
};

const normalizeStoreSourceError = (value: unknown): PluginStoreSourceError | null => {
  if (!isRecord(value)) return null;
  const sourceId = asString(value.source_id).trim();
  const sourceUrl = asString(value.source_url).trim();
  const message = asString(value.message).trim();
  if (!sourceId && !sourceUrl && !message) return null;
  return {
    sourceId,
    sourceName: asString(value.source_name).trim(),
    sourceUrl,
    message,
  };
};

const normalizeStoreList = (value: unknown): PluginStoreResponse => {
  const source = validatePluginInventory(value);
  const plugins = Array.isArray(source.plugins)
    ? (source.plugins
        .map((item) => normalizeStoreEntry(item))
        .filter(Boolean) as PluginStoreEntry[])
    : [];
  const sourceErrors = Array.isArray(source.source_errors)
    ? (source.source_errors
        .map((item) => normalizeStoreSourceError(item))
        .filter(Boolean) as PluginStoreSourceError[])
    : [];

  return {
    pluginsEnabled: asBoolean(source.plugins_enabled),
    pluginsDir: asString(source.plugins_dir).trim() || 'plugins',
    sourceErrors,
    plugins,
  };
};

const normalizeInstallResult = (value: unknown): PluginStoreInstallResult => {
  const source = isRecord(value) ? value : {};
  return {
    status: asString(source.status).trim(),
    sourceId: asString(source.source_id).trim(),
    sourceName: asString(source.source_name).trim(),
    sourceUrl: asString(source.source_url).trim(),
    id: asString(source.id).trim(),
    version: asString(source.version).trim(),
    installType: asString(source.install_type).trim(),
    path: asString(source.path).trim(),
    pluginsEnabled: asBoolean(source.plugins_enabled),
    restartRequired: asBoolean(source.restart_required),
  };
};

export interface PluginStoreInstallOptions {
  sourceId?: string;
  version?: string;
}

export function createPluginsApi(session: SourceSession) {
  const api = buildPluginsApi(guardPluginTransport(session), () => () => session.assertCurrent());
  return { ...api, list: () => api.list() };
}

function buildPluginsApi(transport: ManagementTransport, captureGuard: () => () => void) {
  const { getConfigValue } = createConfigValueApi(transport, captureGuard);
  const api = {
    async list(listTransport: ManagementTransport = transport): Promise<PluginListResponse> {
      const data = await listTransport.get('/plugins');
      return normalizePluginList(data);
    },

    updateEnabled: (id: string, enabled: boolean) =>
      transport.put(`/config/plugins/configs/${encodeURIComponent(id)}/enabled`, enabled),

    async deletePlugin(id: string): Promise<PluginDeleteResult> {
      const data = await transport.delete(`/plugins/${encodeURIComponent(id)}`);
      return normalizeDeleteResult(data);
    },

    async getConfig(id: string): Promise<PluginConfigObject> {
      const data = await getConfigValue(`/config/plugins/configs/${encodeURIComponent(id)}`, {});
      return normalizePluginConfig(data);
    },

    async patchConfig(id: string, changes: PluginConfigObject) {
      // Form fields are complete values: clearing removes a field and editing an
      // object replaces that object. A v8 PATCH would instead retain nulls and
      // recursively merge objects, so merge touched fields into the latest object
      // and replace only this plugin instance (never the complete config tree).
      const assertConnection = captureGuard();
      const next = { ...(await api.getConfig(id)) };
      assertConnection();
      for (const [key, value] of Object.entries(changes)) {
        if (value === null) delete next[key];
        else next[key] = value;
      }
      return transport.put(`/config/plugins/configs/${encodeURIComponent(id)}`, next);
    },
  };

  return api;
}

export function createPluginStoreApi(session: SourceSession) {
  return buildPluginStoreApi(guardPluginTransport(session));
}

function buildPluginStoreApi(transport: ManagementTransport) {
  return {
    async list(): Promise<PluginStoreResponse> {
      const data = await transport.get('/plugins/store');
      return normalizeStoreList(data);
    },

    async install(
      id: string,
      options: PluginStoreInstallOptions = {}
    ): Promise<PluginStoreInstallResult> {
      const path = `/plugins/store/${encodeURIComponent(id)}/install`;
      const params = new URLSearchParams();
      const sourceId = options.sourceId?.trim();
      const version = options.version?.trim();
      if (sourceId) params.set('source', sourceId);
      if (version) params.set('version', version);
      const query = params.size > 0 ? `?${params.toString()}` : '';
      const data = await transport.post(`${path}${query}`, version ? { version } : undefined);
      return normalizeInstallResult(data);
    },
  };
}

// Compatibility entry points for existing single-backend consumers, including list(transport).
export const pluginsApi = buildPluginsApi(apiClient, guardConfigConnection);
export const pluginStoreApi = buildPluginStoreApi(apiClient);

function guardPluginTransport(session: SourceSession): ManagementTransport {
  const guard = async <T>(request: () => Promise<T>): Promise<T> => {
    session.assertCurrent();
    const result = await request();
    session.assertCurrent();
    return result;
  };
  const transport = session.management;
  return {
    get: <T>(...args: Parameters<ManagementTransport['get']>) =>
      guard(() => transport.get<T>(...args)),
    post: <T>(...args: Parameters<ManagementTransport['post']>) =>
      guard(() => transport.post<T>(...args)),
    put: <T>(...args: Parameters<ManagementTransport['put']>) =>
      guard(() => transport.put<T>(...args)),
    patch: <T>(...args: Parameters<ManagementTransport['patch']>) =>
      guard(() => transport.patch<T>(...args)),
    delete: <T>(...args: Parameters<ManagementTransport['delete']>) =>
      guard(() => transport.delete<T>(...args)),
    getRaw: (...args: Parameters<ManagementTransport['getRaw']>) =>
      guard(() => transport.getRaw(...args)),
    postForm: <T>(...args: Parameters<ManagementTransport['postForm']>) =>
      guard(() => transport.postForm<T>(...args)),
  };
}
