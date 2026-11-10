import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useLocation, useNavigate, useSearchParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { Card } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { EmptyState } from '@/components/ui/EmptyState';
import { Skeleton } from '@/components/ui/Skeleton';
import { IconInfo, IconPlus } from '@/components/ui/icons';
import { OAuthEditorProviderCard } from '@/features/authFiles/components/OAuthEditorProviderCard';
import { OAuthAliasMappingRow } from '@/features/authFiles/components/OAuthAliasMappingRow';
import { useEdgeSwipeBack } from '@/hooks/useEdgeSwipeBack';
import { useUnsavedChangesGuard } from '@/hooks/useUnsavedChangesGuard';
import { useAuthStore } from '@/stores';
import {
  useAuthFilesSource,
  useAuthFilesNotifications,
} from '@/features/authFiles/AuthFilesSourceContext';
import { getTypeLabel, normalizeProviderKey } from '@/features/authFiles/constants';
import { isNamedProvider } from '@/features/authFiles/credentialFacts';
import { oauthProviderKeys } from '@/features/authFiles/hooks/useAuthFilesOauth';
import {
  getModelAliasDraftSignature,
  isOAuthEditorDirty,
} from '@/features/authFiles/oauthEditorState';
import type { AuthFileItem, OAuthModelAliasEntry } from '@/types';
import { useCredentialInventoryStore, useSourceFiles } from '@/stores/useCredentialInventoryStore';
import { generateId, getErrorMessage } from '@/utils/helpers';
import type { AuthFileModelItem } from '@/features/authFiles/constants';
import { IDLE_LOAD, isLoadBusy, loadData, type LoadState } from '@/features/authFiles/modelAccess';
import { modelAccess } from '@/features/authFiles/modelAccessRuntime';
import {
  selectSourceModelAccess,
  useModelAccessStore,
  useSourceModelAccess,
} from '@/stores/useModelAccessStore';
import styles from '@/features/authFiles/components/OAuthEditor.module.scss';
import pageStyles from './AuthFilesOAuthModelAliasEditPage.module.scss';

const NO_FILES: AuthFileItem[] = [];
const NO_MODELS: AuthFileModelItem[] = [];
const NO_LISTS: Record<string, string[]> = {};
const IDLE_CATALOG: LoadState<AuthFileModelItem[]> = IDLE_LOAD;

type LocationState = { fromAuthFiles?: boolean } | null;

type OAuthModelMappingFormEntry = OAuthModelAliasEntry & { id: string };

const buildEmptyMappingEntry = (): OAuthModelMappingFormEntry => ({
  id: generateId(),
  name: '',
  alias: '',
  fork: true,
});

const normalizeMappingEntries = (
  entries?: OAuthModelAliasEntry[]
): OAuthModelMappingFormEntry[] => {
  if (!Array.isArray(entries) || entries.length === 0) {
    return [buildEmptyMappingEntry()];
  }
  return entries.map((entry) => ({
    id: generateId(),
    name: entry.name ?? '',
    alias: entry.alias ?? '',
    fork: Boolean(entry.fork),
    forceMapping: entry.forceMapping,
  }));
};

export function AuthFilesOAuthModelAliasEditPage() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const location = useLocation();
  const { showConfirmation, showNotification } = useAuthFilesNotifications();
  const { api: authFilesApi, session, source } = useAuthFilesSource();
  const connectionStatus = useAuthStore((state) => state.connectionStatus);
  const disableControls = connectionStatus !== 'connected';

  const [searchParams, setSearchParams] = useSearchParams();
  const providerFromParams = searchParams.get('provider') ?? '';
  const [initialProviderKey] = useState(() => normalizeProviderKey(providerFromParams));
  // A provider in the link is the one being edited; the picker is only for a link without one.
  const providerLocked = initialProviderKey !== '';

  const [provider, setProvider] = useState(providerFromParams);
  // Credential files come from the one inventory store, not a list of this page's own.
  const files: AuthFileItem[] = useSourceFiles(session.owner) ?? NO_FILES;
  const [modelAlias, setModelAlias] = useState<Record<string, OAuthModelAliasEntry[]>>({});
  const [initialLoading, setInitialLoading] = useState(true);
  const [initialLoadError, setInitialLoadError] = useState<string | null>(null);
  const [baselineReady, setBaselineReady] = useState(false);
  const [modelAliasUnsupported, setModelAliasUnsupported] = useState(false);
  const loadRequestRef = useRef(0);

  const [mappings, setMappings] = useState<OAuthModelMappingFormEntry[]>([
    buildEmptyMappingEntry(),
  ]);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    setProvider(providerFromParams);
  }, [providerFromParams]);

  // Providers this hub has credentials, aliases or an exclusion list for; the lists are read
  // from the shared model-access store rather than copied.
  const modelAccessSlices = useSourceModelAccess(session.owner);
  const excluded = (modelAccessSlices && loadData(modelAccessSlices.providerLists)) ?? NO_LISTS;
  const providerOptions = useMemo(
    () =>
      oauthProviderKeys([...Object.keys(excluded), ...Object.keys(modelAlias)], files)
        .filter(isNamedProvider)
        .sort(),
    [excluded, files, modelAlias]
  );

  const resolvedProviderKey = useMemo(() => normalizeProviderKey(provider), [provider]);
  // The catalog is read live from the shared model-access store. The alias baseline above is a
  // snapshot taken from the same store at load time: a later refresh by another screen must not
  // replace a draft that is being edited.
  const catalog = modelAccessSlices?.catalogs[resolvedProviderKey] ?? IDLE_CATALOG;
  const catalogWanted = Boolean(resolvedProviderKey) && !modelAliasUnsupported;
  const modelsList = useMemo(
    () => (catalogWanted ? (loadData(catalog) ?? NO_MODELS) : NO_MODELS),
    [catalog, catalogWanted]
  );
  const modelsLoading = catalogWanted && (catalog.status === 'idle' || isLoadBusy(catalog));
  const modelsError: 'unsupported' | null =
    catalogWanted && catalog.status === 'error' && catalog.unsupported ? 'unsupported' : null;
  const catalogFailure =
    catalogWanted && catalog.status === 'error' && !catalog.unsupported ? catalog.message : null;
  const isEditing = useMemo(() => {
    if (!resolvedProviderKey) return false;
    return Object.prototype.hasOwnProperty.call(modelAlias, resolvedProviderKey);
  }, [modelAlias, resolvedProviderKey]);
  const baselineMappingsSignature = useMemo(
    () => getModelAliasDraftSignature(modelAlias[resolvedProviderKey] ?? []),
    [modelAlias, resolvedProviderKey]
  );
  const mappingsSignature = useMemo(() => getModelAliasDraftSignature(mappings), [mappings]);
  const contentDirty = baselineMappingsSignature !== mappingsSignature;
  const isDirty = isOAuthEditorDirty(
    initialProviderKey,
    provider,
    baselineMappingsSignature,
    mappingsSignature
  );
  const unsavedChangesDialog = useMemo(
    () => ({
      title: t('common.unsaved_changes_title'),
      message: t('common.unsaved_changes_message'),
      confirmText: t('common.leave'),
      cancelText: t('common.stay'),
    }),
    [t]
  );
  const { allowNextNavigation, allowNavigationTo } = useUnsavedChangesGuard({
    shouldBlock: isDirty,
    dialog: unsavedChangesDialog,
  });
  const title = isEditing
    ? t('oauth_model_alias.edit_title', { provider: provider.trim() || resolvedProviderKey })
    : t('oauth_model_alias.add_title');
  const headerHint = useMemo(() => {
    if (!provider.trim()) {
      return t('oauth_model_alias.provider_hint');
    }
    if (modelsLoading) {
      return t('oauth_model_alias.model_source_loading');
    }
    if (modelsError === 'unsupported') {
      return t('oauth_model_alias.model_source_unsupported');
    }
    return t('oauth_model_alias.model_source_loaded', { count: modelsList.length });
  }, [modelsError, modelsList.length, modelsLoading, provider, t]);

  const modelsHref = useMemo(() => {
    const params = new URLSearchParams({ source: source.instanceId });
    if (resolvedProviderKey) params.set('provider', resolvedProviderKey);
    params.set('tab', 'aliases');
    return `/auth-files/models?${params.toString()}`;
  }, [resolvedProviderKey, source.instanceId]);

  const handleBack = useCallback(() => {
    const state = location.state as LocationState;
    if (state?.fromAuthFiles) {
      navigate(-1);
      return;
    }
    navigate(modelsHref, { replace: true });
  }, [location.state, modelsHref, navigate]);

  const swipeRef = useEdgeSwipeBack({ onBack: handleBack });

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        handleBack();
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [handleBack]);

  const loadInitialData = useCallback(async () => {
    const requestId = ++loadRequestRef.current;
    setInitialLoading(true);
    setInitialLoadError(null);
    setBaselineReady(false);
    setModelAliasUnsupported(false);

    try {
      await Promise.allSettled([
        useCredentialInventoryStore.getState().ensureLoaded(session.owner),
        modelAccess().ensureConfig(session.owner, { force: true }),
      ]);

      if (requestId !== loadRequestRef.current) return;

      const access = selectSourceModelAccess(useModelAccessStore.getState(), session.owner);
      const aliases = access?.aliases;
      if (aliases?.status === 'ready') {
        setModelAlias(aliases.data);
        setBaselineReady(true);
        return;
      }
      if (aliases?.status === 'error' && aliases.unsupported) {
        setModelAliasUnsupported(true);
        return;
      }
      setInitialLoadError(aliases?.status === 'error' ? aliases.message : '');
    } catch (err: unknown) {
      if (requestId === loadRequestRef.current) {
        setInitialLoadError(getErrorMessage(err));
      }
    } finally {
      if (requestId === loadRequestRef.current) {
        setInitialLoading(false);
      }
    }
  }, [session.owner]);

  useEffect(() => {
    void loadInitialData();
    return () => {
      loadRequestRef.current += 1;
    };
  }, [loadInitialData]);

  useEffect(() => {
    if (!resolvedProviderKey) {
      setMappings([buildEmptyMappingEntry()]);
      return;
    }
    const existing = modelAlias[resolvedProviderKey] ?? [];
    setMappings(normalizeMappingEntries(existing));
  }, [modelAlias, resolvedProviderKey]);

  useEffect(() => {
    if (catalogWanted) void modelAccess().ensureCatalog(session.owner, resolvedProviderKey);
  }, [catalogWanted, resolvedProviderKey, session.owner]);

  useEffect(() => {
    if (catalogFailure !== null) {
      showNotification(`${t('notification.load_failed')}: ${catalogFailure}`, 'error');
    }
  }, [catalogFailure, showNotification, t]);

  const applyProviderChange = useCallback(
    (value: string) => {
      setProvider(value);
      const next = new URLSearchParams(searchParams);
      const trimmed = value.trim();
      if (trimmed) {
        next.set('provider', trimmed);
      } else {
        next.delete('provider');
      }
      const nextSearch = next.toString();
      allowNavigationTo(
        `${location.pathname}${nextSearch ? `?${nextSearch}` : ''}${location.hash}`
      );
      setSearchParams(next, { replace: true });
    },
    [allowNavigationTo, location.hash, location.pathname, searchParams, setSearchParams]
  );

  const updateProvider = useCallback(
    (value: string) => {
      if (!contentDirty || normalizeProviderKey(value) === resolvedProviderKey) {
        applyProviderChange(value);
        return;
      }
      showConfirmation({
        ...unsavedChangesDialog,
        variant: 'danger',
        onConfirm: () => applyProviderChange(value),
      });
    },
    [applyProviderChange, contentDirty, resolvedProviderKey, showConfirmation, unsavedChangesDialog]
  );

  const updateMappingEntry = useCallback(
    (index: number, field: keyof OAuthModelAliasEntry, value: string | boolean) => {
      setMappings((prev) =>
        prev.map((entry, idx) => (idx === index ? { ...entry, [field]: value } : entry))
      );
    },
    []
  );

  const addMappingEntry = useCallback(() => {
    setMappings((prev) => [...prev, buildEmptyMappingEntry()]);
  }, []);

  const removeMappingEntry = useCallback((index: number) => {
    setMappings((prev) => {
      const next = prev.filter((_, idx) => idx !== index);
      return next.length ? next : [buildEmptyMappingEntry()];
    });
  }, []);

  const handleSave = useCallback(async () => {
    const channel = normalizeProviderKey(provider);
    if (!channel) {
      showNotification(t('oauth_model_alias.provider_required'), 'error');
      return;
    }

    const seenAlias = new Set<string>();
    let hasDuplicateAlias = false;
    const normalized = mappings
      .map((entry) => {
        const name = String(entry.name ?? '').trim();
        const alias = String(entry.alias ?? '').trim();
        if (!name || !alias) return null;
        const aliasKey = alias.toLowerCase();
        if (seenAlias.has(aliasKey)) {
          hasDuplicateAlias = true;
          return null;
        }
        seenAlias.add(aliasKey);
        const normalizedEntry: OAuthModelAliasEntry = { name, alias };
        if (entry.fork) normalizedEntry.fork = true;
        if (typeof entry.forceMapping === 'boolean') {
          normalizedEntry.forceMapping = entry.forceMapping;
        }
        return normalizedEntry;
      })
      .filter(Boolean) as OAuthModelAliasEntry[];

    if (hasDuplicateAlias) {
      showNotification(t('oauth_model_alias.duplicate_alias'), 'error');
      return;
    }

    setSaving(true);
    try {
      if (normalized.length) {
        await authFilesApi.saveOauthModelAlias(channel, normalized);
      } else if (isEditing) {
        await authFilesApi.deleteOauthModelAlias(channel);
      }
      showNotification(t('oauth_model_alias.save_success'), 'success');
      // The screen this returns to reads the same store: re-read it before leaving.
      await modelAccess().ensureConfig(session.owner, { force: true });
      allowNextNavigation();
      handleBack();
    } catch (err: unknown) {
      const errorMessage = err instanceof Error ? err.message : '';
      showNotification(`${t('oauth_model_alias.save_failed')}: ${errorMessage}`, 'error');
    } finally {
      setSaving(false);
    }
  }, [
    authFilesApi,
    allowNextNavigation,
    handleBack,
    isEditing,
    mappings,
    provider,
    session.owner,
    showNotification,
    t,
  ]);

  const canSave =
    !disableControls &&
    !saving &&
    baselineReady &&
    !modelAliasUnsupported &&
    initialLoadError === null;

  const header = (
    <header className={pageStyles.header}>
      <div className={pageStyles.titleBlock}>
        <p className={pageStyles.eyebrow}>
          <Link to="/auth-files">{t('nav.auth_files')}</Link>
          <span aria-hidden="true"> / </span>
          {source.label}
          <span aria-hidden="true"> / </span>
          <Link to={modelsHref}>{t('model_access.title')}</Link>
          <span aria-hidden="true"> / </span>
          <span aria-current="page">{t('model_access.tab_aliases')}</span>
        </p>
        <h1>{title}</h1>
        <p className={pageStyles.subtitle}>{t('oauth_model_alias.editor_description')}</p>
      </div>
      <div className={pageStyles.headerActions}>
        <Button size="sm" onClick={handleSave} loading={saving} disabled={!canSave}>
          {t('common.save')}
        </Button>
      </div>
    </header>
  );

  const loadingState = (
    <div className={pageStyles.skeletons} role="status" aria-label={t('common.loading')}>
      {Array.from({ length: 4 }, (_, index) => (
        <Skeleton key={index} height={40} rounded={8} />
      ))}
    </div>
  );

  return (
    <div className={pageStyles.page} ref={swipeRef}>
      {header}
      {initialLoading ? (
        loadingState
      ) : modelAliasUnsupported ? (
        <Card>
          <EmptyState
            title={t('oauth_model_alias.upgrade_required_title')}
            description={t('oauth_model_alias.upgrade_required_desc')}
          />
        </Card>
      ) : initialLoadError !== null ? (
        <Card>
          <EmptyState
            title={t('notification.refresh_failed')}
            description={initialLoadError || t('notification.refresh_failed')}
            action={
              <Button variant="secondary" size="sm" onClick={() => void loadInitialData()}>
                {t('common.refresh')}
              </Button>
            }
          />
        </Card>
      ) : (
        <>
          {providerLocked ? (
            <div className={pageStyles.provider}>
              <span id="alias-provider-label">{t('oauth_model_alias.provider_label')}</span>
              <span className={pageStyles.providerChip}>
                {getTypeLabel(t, resolvedProviderKey)}
              </span>
            </div>
          ) : (
            <OAuthEditorProviderCard
              provider={provider}
              options={providerOptions}
              onChange={updateProvider}
              disabled={disableControls || saving}
              translationPrefix="oauth_model_alias"
            />
          )}

          <Card className={styles.settingsCard}>
            <div className={styles.editorHeader}>
              <div className={styles.sectionHeading}>
                <span className={styles.stepNumber} aria-hidden="true">
                  {providerLocked ? '01' : '02'}
                </span>
                <div className={styles.headingCopy}>
                  <h2 className={styles.sectionTitle}>{t('oauth_model_alias.alias_label')}</h2>
                  <p className={styles.description}>{t('oauth_model_alias.mapping_hint')}</p>
                </div>
              </div>
              <Button
                variant="secondary"
                size="sm"
                onClick={addMappingEntry}
                disabled={disableControls || saving || modelAliasUnsupported}
              >
                <IconPlus size={14} aria-hidden="true" />
                {t('oauth_model_alias.add_alias')}
              </Button>
            </div>

            <div className={styles.catalogHint}>
              <IconInfo size={15} aria-hidden="true" />
              <p className={styles.description}>{headerHint}</p>
            </div>

            <div className={styles.mappingsBody}>
              {mappings.map((entry, index) => (
                <OAuthAliasMappingRow
                  key={entry.id}
                  entry={entry}
                  index={index}
                  options={modelsList.map((model) => ({
                    value: model.id,
                    label:
                      model.display_name && model.display_name !== model.id
                        ? model.display_name
                        : undefined,
                  }))}
                  disabled={disableControls || saving}
                  canRemove={mappings.length > 1}
                  onChange={(field, value) => updateMappingEntry(index, field, value)}
                  onRemove={() => removeMappingEntry(index)}
                />
              ))}
            </div>
          </Card>
        </>
      )}
    </div>
  );
}
