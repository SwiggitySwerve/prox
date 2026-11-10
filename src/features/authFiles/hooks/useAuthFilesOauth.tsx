import { useAuthFilesSource, useAuthFilesNotifications } from '../AuthFilesSourceContext';
import { useCallback, useEffect, useMemo, useRef } from 'react';
import { Trans, useTranslation } from 'react-i18next';

import type { AuthFileItem, OAuthModelAliasEntry } from '@/types';
import type { AuthFileModelItem, OAuthConfigLoadError } from '@/features/authFiles/constants';
import { normalizeProviderKey } from '@/features/authFiles/constants';
import { configLoadError, IDLE_LOAD, loadData } from '@/features/authFiles/modelAccess';
import { modelAccess } from '@/features/authFiles/modelAccessRuntime';
import { useSourceModelAccess } from '@/stores/useModelAccessStore';
type ViewMode = 'diagram' | 'list';
const NO_LISTS: Record<string, string[]> = {};
const NO_ALIASES: Record<string, OAuthModelAliasEntry[]> = {};

export type UseAuthFilesOauthResult = {
  excluded: Record<string, string[]>;
  excludedError: OAuthConfigLoadError;
  modelAlias: Record<string, OAuthModelAliasEntry[]>;
  modelAliasError: OAuthConfigLoadError;
  allProviderModels: Record<string, AuthFileModelItem[]>;
  providerList: string[];
  loadExcluded: () => Promise<void>;
  loadModelAlias: () => Promise<void>;
  deleteModelAlias: (provider: string) => void;
  handleMappingUpdate: (provider: string, sourceModel: string, newAlias: string) => Promise<void>;
  handleDeleteLink: (provider: string, sourceModel: string, alias: string) => void;
  handleToggleFork: (
    provider: string,
    sourceModel: string,
    alias: string,
    fork: boolean
  ) => Promise<void>;
  handleRenameAlias: (oldAlias: string, newAlias: string) => Promise<void>;
  handleDeleteAlias: (aliasName: string) => void;
};

export type UseAuthFilesOauthOptions = {
  viewMode: ViewMode;
  files: AuthFileItem[];
};

export function useAuthFilesOauth(options: UseAuthFilesOauthOptions): UseAuthFilesOauthResult {
  const { viewMode, files } = options;
  const sourceScope = useAuthFilesSource();
  const authFilesApi = sourceScope.api;
  const { t } = useTranslation();
  const { showNotification, showConfirmation } = useAuthFilesNotifications();

  // Provider lists, aliases and catalogs come from the shared model-access store: this hook keeps
  // no copy of its own, so the Models screen, this page and the alias editor always agree.
  const owner = sourceScope.session.owner;
  const access = useSourceModelAccess(owner);
  const excluded = useMemo(
    () => loadData(access?.providerLists ?? IDLE_LOAD) ?? NO_LISTS,
    [access?.providerLists]
  );
  const modelAlias = useMemo(
    () => loadData(access?.aliases ?? IDLE_LOAD) ?? NO_ALIASES,
    [access?.aliases]
  );
  const excludedError: OAuthConfigLoadError = configLoadError(access?.providerLists);
  const modelAliasError: OAuthConfigLoadError = configLoadError(access?.aliases);

  // Writes are refused until the aliases have been read: a write builds on what was read.
  const modelAliasReadyRef = useRef(false);
  useEffect(() => {
    modelAliasReadyRef.current = modelAliasError === null;
  }, [modelAliasError]);

  // An old backend without these routes gets one upgrade notice per source view.
  const excludedUnsupportedRef = useRef(false);
  const mappingsUnsupportedRef = useRef(false);
  useEffect(() => {
    if (excludedError !== 'unsupported') excludedUnsupportedRef.current = false;
    else if (!excludedUnsupportedRef.current) {
      excludedUnsupportedRef.current = true;
      showNotification(t('oauth_excluded.upgrade_required'), 'warning');
    }
  }, [excludedError, showNotification, t]);
  useEffect(() => {
    if (modelAliasError !== 'unsupported') mappingsUnsupportedRef.current = false;
    else if (!mappingsUnsupportedRef.current) {
      mappingsUnsupportedRef.current = true;
      showNotification(t('oauth_model_alias.upgrade_required'), 'warning');
    }
  }, [modelAliasError, showNotification, t]);

  const providerList = useMemo(() => {
    const providers = new Set<string>();

    Object.keys(modelAlias).forEach((provider) => {
      const key = provider.trim().toLowerCase();
      if (key) providers.add(key);
    });

    files.forEach((file) => {
      if (typeof file.type === 'string') {
        const key = file.type.trim().toLowerCase();
        if (key) providers.add(key);
      }
      if (typeof file.provider === 'string') {
        const key = file.provider.trim().toLowerCase();
        if (key) providers.add(key);
      }
    });
    return Array.from(providers);
  }, [files, modelAlias]);

  const catalogs = access?.catalogs;
  const allProviderModels = useMemo(() => {
    const result: Record<string, AuthFileModelItem[]> = {};
    for (const provider of providerList) {
      const models = loadData(catalogs?.[provider] ?? IDLE_LOAD);
      if (models && models.length > 0) result[provider] = models;
    }
    return result;
  }, [catalogs, providerList]);

  useEffect(() => {
    if (viewMode !== 'diagram') return;
    providerList.forEach((provider) => void modelAccess().ensureCatalog(owner, provider));
  }, [owner, providerList, viewMode]);

  // Re-read both config maps from the hub; concurrent callers share one read.
  const reloadRef = useRef<Promise<void> | null>(null);
  const reloadConfig = useCallback((): Promise<void> => {
    reloadRef.current ??= modelAccess()
      .ensureConfig(owner, { force: true })
      .finally(() => {
        reloadRef.current = null;
      });
    return reloadRef.current;
  }, [owner]);
  const loadExcluded = reloadConfig;
  const loadModelAlias = reloadConfig;

  const showLoadRequired = useCallback(() => {
    showNotification(t('notification.refresh_failed'), 'error');
  }, [showNotification, t]);

  const deleteModelAlias = useCallback(
    (provider: string) => {
      showConfirmation({
        title: t('oauth_model_alias.delete_title', { defaultValue: 'Delete Mappings' }),
        message: t('oauth_model_alias.delete_confirm', { provider }),
        variant: 'danger',
        confirmText: t('common.confirm'),
        onConfirm: async () => {
          if (!modelAliasReadyRef.current) {
            showLoadRequired();
            return;
          }
          try {
            await authFilesApi.deleteOauthModelAlias(provider);
            sourceScope.assertCurrent();
            await loadModelAlias();
            sourceScope.assertCurrent();
            showNotification(t('oauth_model_alias.delete_success'), 'success');
          } catch (err: unknown) {
            if (!sourceScope.isCurrent()) return;
            const errorMessage = err instanceof Error ? err.message : '';
            showNotification(`${t('oauth_model_alias.delete_failed')}: ${errorMessage}`, 'error');
          }
        },
      });
    },
    [
      authFilesApi,
      loadModelAlias,
      showConfirmation,
      showLoadRequired,
      showNotification,
      sourceScope,
      t,
    ]
  );

  const handleMappingUpdate = useCallback(
    async (provider: string, sourceModel: string, newAlias: string) => {
      if (!modelAliasReadyRef.current) {
        showLoadRequired();
        return;
      }
      if (!provider || !sourceModel || !newAlias) return;
      const normalizedProvider = normalizeProviderKey(provider);
      if (!normalizedProvider) return;

      const providerKey = Object.keys(modelAlias).find(
        (key) => normalizeProviderKey(key) === normalizedProvider
      );
      const currentMappings = (providerKey ? modelAlias[providerKey] : null) ?? [];

      const nameTrim = sourceModel.trim();
      const aliasTrim = newAlias.trim();
      const nameKey = nameTrim.toLowerCase();
      const aliasKey = aliasTrim.toLowerCase();

      if (
        currentMappings.some(
          (m) =>
            (m.name ?? '').trim().toLowerCase() === nameKey &&
            (m.alias ?? '').trim().toLowerCase() === aliasKey
        )
      ) {
        return;
      }

      const nextMappings: OAuthModelAliasEntry[] = [
        ...currentMappings,
        { name: nameTrim, alias: aliasTrim, fork: true },
      ];

      try {
        await authFilesApi.saveOauthModelAlias(normalizedProvider, nextMappings);
        sourceScope.assertCurrent();
        await loadModelAlias();
        sourceScope.assertCurrent();
        showNotification(t('oauth_model_alias.save_success'), 'success');
      } catch (err: unknown) {
        if (!sourceScope.isCurrent()) return;
        const errorMessage = err instanceof Error ? err.message : '';
        showNotification(`${t('oauth_model_alias.save_failed')}: ${errorMessage}`, 'error');
      }
    },
    [authFilesApi, loadModelAlias, modelAlias, showLoadRequired, showNotification, sourceScope, t]
  );

  const handleDeleteLink = useCallback(
    (provider: string, sourceModel: string, alias: string) => {
      const nameTrim = sourceModel.trim();
      const aliasTrim = alias.trim();
      if (!provider || !nameTrim || !aliasTrim) return;

      showConfirmation({
        title: t('oauth_model_alias.delete_link_title', { defaultValue: 'Unlink mapping' }),
        message: (
          <Trans
            i18nKey="oauth_model_alias.delete_link_confirm"
            values={{ provider, sourceModel: nameTrim, alias: aliasTrim }}
            components={{ code: <code /> }}
          />
        ),
        variant: 'danger',
        confirmText: t('common.confirm'),
        onConfirm: async () => {
          if (!modelAliasReadyRef.current) {
            showLoadRequired();
            return;
          }
          const normalizedProvider = normalizeProviderKey(provider);
          const providerKey = Object.keys(modelAlias).find(
            (key) => normalizeProviderKey(key) === normalizedProvider
          );
          const currentMappings = (providerKey ? modelAlias[providerKey] : null) ?? [];
          const nameKey = nameTrim.toLowerCase();
          const aliasKey = aliasTrim.toLowerCase();
          const nextMappings = currentMappings.filter(
            (m) =>
              (m.name ?? '').trim().toLowerCase() !== nameKey ||
              (m.alias ?? '').trim().toLowerCase() !== aliasKey
          );
          if (nextMappings.length === currentMappings.length) return;

          try {
            if (nextMappings.length === 0) {
              await authFilesApi.deleteOauthModelAlias(normalizedProvider);
              sourceScope.assertCurrent();
            } else {
              await authFilesApi.saveOauthModelAlias(normalizedProvider, nextMappings);
              sourceScope.assertCurrent();
            }
            await loadModelAlias();
            sourceScope.assertCurrent();
            showNotification(t('oauth_model_alias.save_success'), 'success');
          } catch (err: unknown) {
            if (!sourceScope.isCurrent()) return;
            const errorMessage = err instanceof Error ? err.message : '';
            showNotification(`${t('oauth_model_alias.save_failed')}: ${errorMessage}`, 'error');
          }
        },
      });
    },
    [
      authFilesApi,
      loadModelAlias,
      modelAlias,
      showConfirmation,
      showLoadRequired,
      showNotification,
      sourceScope,
      t,
    ]
  );

  const handleToggleFork = useCallback(
    async (provider: string, sourceModel: string, alias: string, fork: boolean) => {
      if (!modelAliasReadyRef.current) {
        showLoadRequired();
        return;
      }
      const normalizedProvider = normalizeProviderKey(provider);
      if (!normalizedProvider) return;

      const providerKey = Object.keys(modelAlias).find(
        (key) => normalizeProviderKey(key) === normalizedProvider
      );
      const currentMappings = (providerKey ? modelAlias[providerKey] : null) ?? [];
      const nameKey = sourceModel.trim().toLowerCase();
      const aliasKey = alias.trim().toLowerCase();
      let changed = false;

      const nextMappings = currentMappings.map((m) => {
        const mName = (m.name ?? '').trim().toLowerCase();
        const mAlias = (m.alias ?? '').trim().toLowerCase();
        if (mName === nameKey && mAlias === aliasKey) {
          changed = true;
          return fork ? { ...m, fork: true } : { ...m, fork: undefined };
        }
        return m;
      });

      if (!changed) return;

      try {
        await authFilesApi.saveOauthModelAlias(normalizedProvider, nextMappings);
        sourceScope.assertCurrent();
        await loadModelAlias();
        sourceScope.assertCurrent();
        showNotification(t('oauth_model_alias.save_success'), 'success');
      } catch (err: unknown) {
        if (!sourceScope.isCurrent()) return;
        const errorMessage = err instanceof Error ? err.message : '';
        showNotification(`${t('oauth_model_alias.save_failed')}: ${errorMessage}`, 'error');
      }
    },
    [authFilesApi, loadModelAlias, modelAlias, showLoadRequired, showNotification, sourceScope, t]
  );

  const handleRenameAlias = useCallback(
    async (oldAlias: string, newAlias: string) => {
      if (!modelAliasReadyRef.current) {
        showLoadRequired();
        return;
      }
      const oldTrim = oldAlias.trim();
      const newTrim = newAlias.trim();
      if (!oldTrim || !newTrim || oldTrim === newTrim) return;

      const oldKey = oldTrim.toLowerCase();
      const providersToUpdate = Object.entries(modelAlias).filter(([_, mappings]) =>
        mappings.some((m) => (m.alias ?? '').trim().toLowerCase() === oldKey)
      );

      if (providersToUpdate.length === 0) return;

      let hadFailure = false;
      let failureMessage = '';

      try {
        const results = await Promise.allSettled(
          providersToUpdate.map(([provider, mappings]) => {
            const nextMappings = mappings.map((m) =>
              (m.alias ?? '').trim().toLowerCase() === oldKey ? { ...m, alias: newTrim } : m
            );
            return authFilesApi.saveOauthModelAlias(provider, nextMappings);
          })
        );
        sourceScope.assertCurrent();

        const failures = results.filter(
          (result): result is PromiseRejectedResult => result.status === 'rejected'
        );

        if (failures.length > 0) {
          hadFailure = true;
          const reason = failures[0].reason;
          failureMessage = reason instanceof Error ? reason.message : String(reason ?? '');
        }
      } finally {
        await loadModelAlias();
        sourceScope.assertCurrent();
      }

      if (hadFailure) {
        showNotification(
          failureMessage
            ? `${t('oauth_model_alias.save_failed')}: ${failureMessage}`
            : t('oauth_model_alias.save_failed'),
          'error'
        );
      } else {
        showNotification(t('oauth_model_alias.save_success'), 'success');
      }
    },
    [authFilesApi, loadModelAlias, modelAlias, showLoadRequired, showNotification, sourceScope, t]
  );

  const handleDeleteAlias = useCallback(
    (aliasName: string) => {
      const aliasTrim = aliasName.trim();
      if (!aliasTrim) return;
      const aliasKey = aliasTrim.toLowerCase();
      const providersToUpdate = Object.entries(modelAlias).filter(([_, mappings]) =>
        mappings.some((m) => (m.alias ?? '').trim().toLowerCase() === aliasKey)
      );

      if (providersToUpdate.length === 0) return;

      showConfirmation({
        title: t('oauth_model_alias.delete_alias_title', { defaultValue: 'Delete Alias' }),
        message: (
          <Trans
            i18nKey="oauth_model_alias.delete_alias_confirm"
            values={{ alias: aliasTrim }}
            components={{ code: <code /> }}
          />
        ),
        variant: 'danger',
        confirmText: t('common.confirm'),
        onConfirm: async () => {
          if (!modelAliasReadyRef.current) {
            showLoadRequired();
            return;
          }
          let hadFailure = false;
          let failureMessage = '';

          try {
            const results = await Promise.allSettled(
              providersToUpdate.map(([provider, mappings]) => {
                const nextMappings = mappings.filter(
                  (m) => (m.alias ?? '').trim().toLowerCase() !== aliasKey
                );
                if (nextMappings.length === 0) {
                  return authFilesApi.deleteOauthModelAlias(provider);
                }
                return authFilesApi.saveOauthModelAlias(provider, nextMappings);
              })
            );
            sourceScope.assertCurrent();

            const failures = results.filter(
              (result): result is PromiseRejectedResult => result.status === 'rejected'
            );

            if (failures.length > 0) {
              hadFailure = true;
              const reason = failures[0].reason;
              failureMessage = reason instanceof Error ? reason.message : String(reason ?? '');
            }
          } finally {
            await loadModelAlias();
            sourceScope.assertCurrent();
          }

          if (hadFailure) {
            showNotification(
              failureMessage
                ? `${t('oauth_model_alias.delete_failed')}: ${failureMessage}`
                : t('oauth_model_alias.delete_failed'),
              'error'
            );
          } else {
            showNotification(t('oauth_model_alias.delete_success'), 'success');
          }
        },
      });
    },
    [
      authFilesApi,
      loadModelAlias,
      modelAlias,
      showConfirmation,
      showLoadRequired,
      showNotification,
      sourceScope,
      t,
    ]
  );

  return {
    excluded,
    excludedError,
    modelAlias,
    modelAliasError,
    allProviderModels,
    providerList,
    loadExcluded,
    loadModelAlias,
    deleteModelAlias,
    handleMappingUpdate,
    handleDeleteLink,
    handleToggleFork,
    handleRenameAlias,
    handleDeleteAlias,
  };
}
