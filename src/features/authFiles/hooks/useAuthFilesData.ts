import { useAuthFilesSource, useAuthFilesNotifications } from '../AuthFilesSourceContext';
import { useCallback, useEffect, useRef, useState, type ChangeEvent, type RefObject } from 'react';
import { useTranslation } from 'react-i18next';

import type { AuthFileRefreshResult } from '@/services/api/authFiles';
import { getAuthFileRefreshKey } from '@/features/authFiles/manualRefresh';
import { notifyAuthFilesChanged } from '@/features/authFiles/authFilesEvents';
import { misplacedCredentialOwner } from '@/domain/providerSources/ownership';
import { providerSources } from '@/stores/useProviderSources';
import {
  selectSourceFiles,
  useCredentialInventoryStore,
} from '@/stores/useCredentialInventoryStore';

import type { AuthFileItem } from '@/types';
import { formatFileSize } from '@/utils/format';
import { MAX_AUTH_FILE_SIZE } from '@/utils/constants';
import { downloadBlob } from '@/utils/download';
import {
  isRuntimeOnlyAuthFile,
  supportsAuthFileManualRefresh,
} from '@/features/authFiles/constants';

export type LoadFilesOptions = {
  /** 后台刷新：不置 loading（网格保持内容），改用 refreshing 标志。 */
  background?: boolean;
};

export type UseAuthFilesDataOptions = {
  /** 文件集发生变更（上传/删除/手动刷新）后触发，供缓存失效等联动。 */
  onFilesMutated?: (names?: string[]) => void;
};

export type UseAuthFilesDataResult = {
  files: AuthFileItem[];
  selectedFiles: Set<string>;
  selectionCount: number;
  loading: boolean;
  refreshing: boolean;
  error: string;
  uploading: boolean;
  deleting: string | null;
  deletingAll: boolean;
  statusUpdating: Record<string, boolean>;
  manualRefreshing: Record<string, boolean>;
  refreshingAllCredentials: boolean;
  refreshResults: AuthFileRefreshResult[] | null;
  closeRefreshResults: () => void;
  handleRefreshAllCredentials: () => void;
  cooldownResetting: Record<string, boolean>;
  batchStatusUpdating: boolean;
  fileInputRef: RefObject<HTMLInputElement | null>;
  /** Resolves to the re-read list, or null when the read failed or a newer one superseded it. */
  loadFiles: (options?: LoadFilesOptions) => Promise<AuthFileItem[] | null>;
  handleUploadClick: () => void;
  handleFileChange: (event: ChangeEvent<HTMLInputElement>) => Promise<void>;
  handleDelete: (name: string) => void;
  /** Deletes exactly these credentials (the ones the group shows), after a confirmation. */
  handleDeleteAll: (targets: AuthFileItem[]) => void;
  handleDownload: (name: string) => Promise<void>;
  handleManualRefresh: (item: AuthFileItem) => Promise<void>;
  handleCooldownReset: (item: AuthFileItem) => void;
  handleStatusToggle: (item: AuthFileItem, enabled: boolean) => Promise<void>;
  toggleSelect: (name: string) => void;
  selectAllVisible: (visibleFiles: AuthFileItem[]) => void;
  invertVisibleSelection: (visibleFiles: AuthFileItem[]) => void;
  deselectAll: () => void;
  batchDownload: (names: string[]) => Promise<void>;
  batchSetStatus: (names: string[], enabled: boolean) => Promise<void>;
  batchDelete: (names: string[]) => void;
};

export function useAuthFilesData(options?: UseAuthFilesDataOptions): UseAuthFilesDataResult {
  const sourceScope = useAuthFilesSource();
  const authFilesApi = sourceScope.api;
  const { t } = useTranslation();
  const { showNotification, showConfirmation } = useAuthFilesNotifications();
  const onFilesMutated = options?.onFilesMutated;

  const [files, setFiles] = useState<AuthFileItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState('');
  const [uploading, setUploading] = useState(false);
  const [deleting, setDeleting] = useState<string | null>(null);
  const [deletingAll, setDeletingAll] = useState(false);
  const [statusUpdating, setStatusUpdating] = useState<Record<string, boolean>>({});
  const [manualRefreshing, setManualRefreshing] = useState<Record<string, boolean>>({});
  const [refreshingAllCredentials, setRefreshingAllCredentials] = useState(false);
  const [refreshResults, setRefreshResults] = useState<AuthFileRefreshResult[] | null>(null);
  const refreshAllPendingRef = useRef(false);
  const closeRefreshResults = useCallback(() => setRefreshResults(null), []);
  const [cooldownResetting, setCooldownResetting] = useState<Record<string, boolean>>({});
  const [batchStatusUpdating, setBatchStatusUpdating] = useState(false);
  const [selectedFiles, setSelectedFiles] = useState<Set<string>>(new Set());

  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const uploadPendingRef = useRef(false);
  const manualRefreshPendingRef = useRef<Set<string>>(new Set());
  const cooldownResetPendingRef = useRef<Set<string>>(new Set());
  const batchStatusPendingRef = useRef(false);
  const statusPendingRef = useRef({ revision: -1, keys: new Set<string>() });
  /** 列表请求代号：变更操作会使在途响应过期，防止旧轮询复活已删/已改文件。 */
  const loadRequestIdRef = useRef(0);
  /** Logical time of the latest local edit; inventory commits requested before it are ignored. */
  const lastEditRef = useRef(0);
  const invalidateInFlightLoads = useCallback(() => {
    loadRequestIdRef.current += 1;
    lastEditRef.current = useCredentialInventoryStore.getState().tick();
    setLoading(false);
    setRefreshing(false);
  }, []);
  // The credential inventory is read once for every screen. Later commits (the poll, another tab,
  // a sync after an add or remove) arrive here as well, unless a local edit is newer than them.
  const owner = sourceScope.session.owner;
  const inventoryFiles = useCredentialInventoryStore((state) => selectSourceFiles(state, owner));
  const inventoryStartedAt = useCredentialInventoryStore((state) => state.startedAt);
  useEffect(() => {
    if (inventoryFiles && inventoryStartedAt >= lastEditRef.current) setFiles(inventoryFiles);
  }, [inventoryFiles, inventoryStartedAt]);
  const onFilesMutatedRef = useRef(onFilesMutated);
  useEffect(() => {
    onFilesMutatedRef.current = onFilesMutated;
  }, [onFilesMutated]);
  const selectionCount = selectedFiles.size;
  const toggleSelect = useCallback((name: string) => {
    setSelectedFiles((prev) => {
      const next = new Set(prev);
      if (next.has(name)) {
        next.delete(name);
      } else {
        next.add(name);
      }
      return next;
    });
  }, []);

  const selectAllVisible = useCallback((visibleFiles: AuthFileItem[]) => {
    const nextSelected = visibleFiles
      .filter((file) => !isRuntimeOnlyAuthFile(file))
      .map((file) => file.name);
    if (nextSelected.length === 0) return;
    setSelectedFiles((prev) => {
      const next = new Set(prev);
      nextSelected.forEach((name) => next.add(name));
      return next;
    });
  }, []);

  const invertVisibleSelection = useCallback((visibleFiles: AuthFileItem[]) => {
    const visibleNames = visibleFiles
      .filter((file) => !isRuntimeOnlyAuthFile(file))
      .map((file) => file.name);
    if (visibleNames.length === 0) return;

    setSelectedFiles((prev) => {
      const next = new Set(prev);
      visibleNames.forEach((name) => {
        if (next.has(name)) {
          next.delete(name);
        } else {
          next.add(name);
        }
      });
      return next;
    });
  }, []);

  const deselectAll = useCallback(() => {
    setSelectedFiles(new Set());
  }, []);

  const applyDeletedFiles = useCallback(
    (names: string[]) => {
      const deletedNames = Array.from(new Set(names.map((name) => name.trim()).filter(Boolean)));
      if (deletedNames.length === 0) return;

      invalidateInFlightLoads();
      onFilesMutatedRef.current?.(deletedNames);
      const deletedSet = new Set(deletedNames);
      setFiles((prev) => prev.filter((file) => !deletedSet.has(file.name)));
      setSelectedFiles((prev) => {
        if (prev.size === 0) return prev;
        let changed = false;
        const next = new Set<string>();
        prev.forEach((name) => {
          if (deletedSet.has(name)) {
            changed = true;
          } else {
            next.add(name);
          }
        });
        return changed ? next : prev;
      });
    },
    [invalidateInFlightLoads]
  );

  useEffect(() => {
    if (selectedFiles.size === 0) return;
    const existingNames = new Set(files.map((file) => file.name));
    setSelectedFiles((prev) => {
      let changed = false;
      const next = new Set<string>();
      prev.forEach((name) => {
        if (existingNames.has(name)) {
          next.add(name);
        } else {
          changed = true;
        }
      });
      return changed ? next : prev;
    });
  }, [files, selectedFiles.size]);

  const loadFiles = useCallback(
    async (options?: LoadFilesOptions) => {
      const background = options?.background === true;
      const requestId = ++loadRequestIdRef.current;
      const connectionRevision = sourceScope.getRevision();
      const isCurrentRequest = () =>
        requestId === loadRequestIdRef.current && connectionRevision === sourceScope.getRevision();

      if (background) {
        setRefreshing(true);
      } else {
        setLoading(true);
        setError('');
      }

      try {
        const inventory = useCredentialInventoryStore.getState();
        const outcome = await inventory.refresh();
        sourceScope.assertCurrent();
        if (!isCurrentRequest()) return null; // 已被更新的请求/连接/变更取代
        const failure = outcome[owner.instanceId];
        if (failure !== null) throw failure ?? new Error(t('notification.refresh_failed'));
        const list = selectSourceFiles(useCredentialInventoryStore.getState(), owner) ?? [];
        setFiles(list);
        setError('');
        return list;
      } catch (err: unknown) {
        if (!sourceScope.isCurrent()) return null;
        if (!isCurrentRequest()) return null;
        const errorMessage = err instanceof Error ? err.message : t('notification.refresh_failed');
        setError(errorMessage);
        return null;
      } finally {
        if (isCurrentRequest()) {
          setLoading(false);
          setRefreshing(false);
        }
      }
    },
    [owner, sourceScope, t]
  );

  const handleUploadClick = useCallback(() => {
    if (uploadPendingRef.current) return;
    fileInputRef.current?.click();
  }, []);

  const handleFileChange = useCallback(
    async (event: ChangeEvent<HTMLInputElement>) => {
      const fileList = event.target.files;
      if (!fileList || fileList.length === 0) return;

      const filesToUpload = Array.from(fileList);
      const validFiles: File[] = [];
      const invalidFiles: string[] = [];
      const oversizedFiles: string[] = [];

      filesToUpload.forEach((file) => {
        if (!file.name.endsWith('.json')) {
          invalidFiles.push(file.name);
          return;
        }
        if (file.size > MAX_AUTH_FILE_SIZE) {
          oversizedFiles.push(file.name);
          return;
        }
        validFiles.push(file);
      });

      if (invalidFiles.length > 0) {
        showNotification(t('auth_files.upload_error_json'), 'error');
      }
      if (oversizedFiles.length > 0) {
        showNotification(
          t('auth_files.upload_error_size', { maxSize: formatFileSize(MAX_AUTH_FILE_SIZE) }),
          'error'
        );
      }

      if (validFiles.length === 0) {
        event.target.value = '';
        return;
      }
      if (uploadPendingRef.current) {
        event.target.value = '';
        return;
      }

      uploadPendingRef.current = true;
      setUploading(true);
      try {
        const { sources } = providerSources.getSnapshot();
        for (const file of [...validFiles]) {
          const owner = misplacedCredentialOwner(
            sources,
            sourceScope.session.owner.instanceId,
            await file.text()
          );
          if (!owner) continue;
          validFiles.splice(validFiles.indexOf(file), 1);
          showNotification(
            t('auth_files.upload_error_source', { name: file.name, source: owner.source.label }),
            'error'
          );
        }
        sourceScope.assertCurrent();
        if (validFiles.length === 0) return;
        const result = await authFilesApi.uploadFiles(validFiles);
        sourceScope.assertCurrent();
        const successCount = result.uploaded;

        if (successCount > 0) {
          const suffix = validFiles.length > 1 ? ` (${successCount}/${validFiles.length})` : '';
          showNotification(
            `${t('auth_files.upload_success')}${suffix}`,
            result.failed.length ? 'warning' : 'success'
          );
          void notifyAuthFilesChanged(sourceScope.session.owner, { reason: 'add' });
          onFilesMutatedRef.current?.(result.files.length > 0 ? result.files : undefined);
          await loadFiles({ background: true });
          sourceScope.assertCurrent();
        }

        if (result.failed.length > 0) {
          const details = result.failed.map((item) => `${item.name}: ${item.error}`).join('; ');
          showNotification(`${t('notification.upload_failed')}: ${details}`, 'error');
        }
      } catch (err: unknown) {
        if (!sourceScope.isCurrent()) return;
        const errorMessage = err instanceof Error ? err.message : 'Unknown error';
        showNotification(`${t('notification.upload_failed')}: ${errorMessage}`, 'error');
      } finally {
        uploadPendingRef.current = false;
        setUploading(false);
        event.target.value = '';
      }
    },
    [authFilesApi, loadFiles, showNotification, sourceScope, t]
  );

  const handleDelete = useCallback(
    (name: string) => {
      showConfirmation({
        title: t('auth_files.delete_title', { defaultValue: 'Delete File' }),
        message: `${t('auth_files.delete_confirm')} "${name}" ?`,
        variant: 'danger',
        confirmText: t('common.confirm'),
        onConfirm: async () => {
          setDeleting(name);
          try {
            const result = await authFilesApi.deleteFile(name);
            sourceScope.assertCurrent();
            showNotification(t('auth_files.delete_success'), 'success');
            const deletedNames = result.files.length > 0 ? result.files : [name];
            applyDeletedFiles(deletedNames);
            if (result.deleted > 0)
              void notifyAuthFilesChanged(sourceScope.session.owner, {
                reason: 'delete',
                deletedNames,
              });
          } catch (err: unknown) {
            if (!sourceScope.isCurrent()) return;
            const errorMessage = err instanceof Error ? err.message : '';
            showNotification(`${t('notification.delete_failed')}: ${errorMessage}`, 'error');
          } finally {
            setDeleting(null);
          }
        },
      });
    },
    [applyDeletedFiles, authFilesApi, showConfirmation, showNotification, sourceScope, t]
  );

  const handleDeleteAll = useCallback(
    (targets: AuthFileItem[]) => {
      // Exactly the credentials the group shows (see deletableShown); never a wider predicate.
      const names = Array.from(
        new Set(targets.filter((file) => !isRuntimeOnlyAuthFile(file)).map((file) => file.name))
      );
      if (names.length === 0) {
        showNotification(t('auth_files.delete_filtered_result_none'), 'info');
        return;
      }

      showConfirmation({
        title: t('auth_files.delete_shown_title'),
        message: t('auth_files.delete_shown_confirm', {
          count: names.length,
          source: sourceScope.source.label,
        }),
        variant: 'danger',
        confirmText: t('common.delete'),
        onConfirm: async () => {
          setDeletingAll(true);
          try {
            const result = await authFilesApi.deleteFiles(names);
            sourceScope.assertCurrent();
            applyDeletedFiles(result.files);
            if (result.deleted > 0) {
              void notifyAuthFilesChanged(sourceScope.session.owner, {
                reason: 'delete',
                deletedNames: result.files,
              });
            }
            if (result.failed.length === 0) {
              showNotification(
                t('auth_files.delete_shown_success', { count: result.deleted }),
                'success'
              );
            } else {
              showNotification(
                t('auth_files.delete_filtered_result_partial', {
                  success: result.deleted,
                  failed: result.failed.length,
                }),
                'warning'
              );
            }
          } catch (err: unknown) {
            if (!sourceScope.isCurrent()) return;
            const errorMessage = err instanceof Error ? err.message : '';
            showNotification(`${t('notification.delete_failed')}: ${errorMessage}`, 'error');
          } finally {
            setDeletingAll(false);
          }
        },
      });
    },
    [applyDeletedFiles, authFilesApi, showConfirmation, showNotification, sourceScope, t]
  );

  const handleDownload = useCallback(
    async (name: string) => {
      try {
        const blob = await authFilesApi.download(name);
        sourceScope.assertCurrent();
        downloadBlob({ filename: name, blob });
        showNotification(t('auth_files.download_success'), 'success');
      } catch (err: unknown) {
        if (!sourceScope.isCurrent()) return;
        const errorMessage = err instanceof Error ? err.message : '';
        showNotification(`${t('notification.download_failed')}: ${errorMessage}`, 'error');
      }
    },
    [authFilesApi, showNotification, sourceScope, t]
  );

  const handleManualRefresh = useCallback(
    async (item: AuthFileItem) => {
      const name = item.name.trim();
      const provider = item.type ?? item.provider;
      const key = getAuthFileRefreshKey(item);
      const connectionRevision = sourceScope.getRevision();
      if (
        !name ||
        item.disabled === true ||
        isRuntimeOnlyAuthFile(item) ||
        !supportsAuthFileManualRefresh(provider) ||
        refreshAllPendingRef.current ||
        manualRefreshPendingRef.current.has(key)
      ) {
        return;
      }

      manualRefreshPendingRef.current.add(key);
      setManualRefreshing((prev) => ({ ...prev, [key]: true }));

      try {
        await authFilesApi.requestManualRefresh(
          name,
          String(item.authIndex ?? '').trim() || undefined
        );
        sourceScope.assertCurrent();
        if (connectionRevision !== sourceScope.getRevision()) return;
        invalidateInFlightLoads();
        showNotification(t('auth_files.manual_refresh_requested', { name }), 'info');
        void notifyAuthFilesChanged(sourceScope.session.owner);
        onFilesMutatedRef.current?.([name]);
        await loadFiles({ background: true });
        sourceScope.assertCurrent();
      } catch (err: unknown) {
        if (!sourceScope.isCurrent()) return;
        if (connectionRevision !== sourceScope.getRevision()) return;
        const message = err instanceof Error ? err.message : t('notification.update_failed');
        showNotification(t('auth_files.manual_refresh_failed', { name, message }), 'error');
      } finally {
        manualRefreshPendingRef.current.delete(key);
        setManualRefreshing((prev) => {
          if (connectionRevision !== sourceScope.getRevision() || !prev[key]) return prev;
          const next = { ...prev };
          delete next[key];
          return next;
        });
      }
    },
    [authFilesApi, invalidateInFlightLoads, loadFiles, showNotification, sourceScope, t]
  );

  const handleRefreshAllCredentials = useCallback(() => {
    if (refreshAllPendingRef.current || manualRefreshPendingRef.current.size > 0) return;
    const connectionRevision = sourceScope.getRevision();
    showConfirmation({
      title: t('auth_files.refresh_all_button'),
      message: t('auth_files.refresh_all_confirm'),
      confirmText: t('auth_files.refresh_all_button'),
      onConfirm: async () => {
        if (
          connectionRevision !== sourceScope.getRevision() ||
          refreshAllPendingRef.current ||
          manualRefreshPendingRef.current.size > 0
        )
          return;
        refreshAllPendingRef.current = true;
        setRefreshingAllCredentials(true);
        setRefreshResults(null);
        try {
          const results = await authFilesApi.requestAllManualRefresh();
          sourceScope.assertCurrent();
          if (connectionRevision !== sourceScope.getRevision()) return;
          setRefreshResults(results);
        } catch (err: unknown) {
          if (!sourceScope.isCurrent()) return;
          if (connectionRevision !== sourceScope.getRevision()) return;
          const message = err instanceof Error ? err.message : t('notification.update_failed');
          showNotification(t('auth_files.refresh_all_failed', { message }), 'error');
        } finally {
          refreshAllPendingRef.current = false;
          if (connectionRevision === sourceScope.getRevision()) {
            setRefreshingAllCredentials(false);
            // Even a timeout can follow partial backend mutations.
            invalidateInFlightLoads();
            onFilesMutatedRef.current?.();
            void notifyAuthFilesChanged(sourceScope.session.owner);
            await loadFiles({ background: true });
            sourceScope.assertCurrent();
          }
        }
      },
    });
  }, [
    authFilesApi,
    invalidateInFlightLoads,
    loadFiles,
    showConfirmation,
    showNotification,
    sourceScope,
    t,
  ]);

  const handleCooldownReset = useCallback(
    (item: AuthFileItem) => {
      const authIndex = String(item.authIndex ?? '').trim();
      if (
        !authIndex ||
        !item.cooldownSnapshot?.records?.length ||
        cooldownResetPendingRef.current.has(authIndex)
      ) {
        return;
      }

      const connectionRevision = sourceScope.getRevision();
      showConfirmation({
        title: t('auth_files.cooldown_reset_title'),
        message: t('auth_files.cooldown_reset_confirm', { name: item.name }),
        confirmText: t('auth_files.cooldown_reset_button'),
        variant: 'primary',
        onConfirm: async () => {
          if (
            connectionRevision !== sourceScope.getRevision() ||
            cooldownResetPendingRef.current.has(authIndex)
          ) {
            return;
          }
          cooldownResetPendingRef.current.add(authIndex);
          setCooldownResetting((prev) => ({ ...prev, [authIndex]: true }));

          try {
            await authFilesApi.resetCooldown(authIndex);
            sourceScope.assertCurrent();
            if (connectionRevision !== sourceScope.getRevision()) return;
            invalidateInFlightLoads();
            setFiles((prev) =>
              prev.map((file) =>
                String(file.authIndex ?? '').trim() === authIndex && file.cooldownSnapshot
                  ? {
                      ...file,
                      cooldownSnapshot: {
                        ...file.cooldownSnapshot,
                        receivedAtMs: Date.now(),
                        records: [],
                      },
                    }
                  : file
              )
            );
            void notifyAuthFilesChanged(sourceScope.session.owner);
            showNotification(
              t('auth_files.cooldown_reset_success', { name: item.name }),
              'success'
            );
            await loadFiles({ background: true });
            sourceScope.assertCurrent();
          } catch (err: unknown) {
            if (!sourceScope.isCurrent()) return;
            if (connectionRevision !== sourceScope.getRevision()) return;
            const message = err instanceof Error ? err.message : t('notification.update_failed');
            showNotification(
              t('auth_files.cooldown_reset_failed', { name: item.name, message }),
              'error'
            );
          } finally {
            cooldownResetPendingRef.current.delete(authIndex);
            setCooldownResetting((prev) => {
              if (!prev[authIndex]) return prev;
              const next = { ...prev };
              delete next[authIndex];
              return next;
            });
          }
        },
      });
    },
    [
      authFilesApi,
      invalidateInFlightLoads,
      loadFiles,
      showConfirmation,
      showNotification,
      sourceScope,
      t,
    ]
  );

  const handleStatusToggle = useCallback(
    async (item: AuthFileItem, enabled: boolean) => {
      const revision = sourceScope.getRevision();
      if (statusPendingRef.current.revision !== revision) {
        statusPendingRef.current = { revision, keys: new Set() };
        batchStatusPendingRef.current = false;
        setBatchStatusUpdating(false);
        setStatusUpdating({});
      }
      const key = getAuthFileRefreshKey(item);
      if (statusPendingRef.current.keys.has(key)) return;
      statusPendingRef.current.keys.add(key);
      const name = item.name;
      const nextDisabled = !enabled;
      const previousDisabled = item.disabled === true;

      setStatusUpdating((prev) => ({ ...prev, [key]: true }));
      invalidateInFlightLoads();
      setFiles((prev) =>
        prev.map((f) => (getAuthFileRefreshKey(f) === key ? { ...f, disabled: nextDisabled } : f))
      );

      try {
        const res = await authFilesApi.setStatus(
          name,
          nextDisabled,
          String(item.authIndex ?? '').trim() || undefined
        );
        sourceScope.assertCurrent();
        if (revision !== sourceScope.getRevision()) return;
        invalidateInFlightLoads();
        setFiles((prev) =>
          revision !== sourceScope.getRevision()
            ? prev
            : prev.map((f) =>
                getAuthFileRefreshKey(f) === key ? { ...f, disabled: res.disabled } : f
              )
        );
        // The header, Models and Dashboard read the shared inventory: publish the change there.
        void notifyAuthFilesChanged(sourceScope.session.owner);
        showNotification(
          enabled
            ? t('auth_files.status_enabled_success', { name })
            : t('auth_files.status_disabled_success', { name }),
          'success'
        );
      } catch (err: unknown) {
        if (!sourceScope.isCurrent()) return;
        if (revision !== sourceScope.getRevision()) return;
        const errorMessage = err instanceof Error ? err.message : '';
        setFiles((prev) =>
          revision !== sourceScope.getRevision()
            ? prev
            : prev.map((f) =>
                getAuthFileRefreshKey(f) === key ? { ...f, disabled: previousDisabled } : f
              )
        );
        showNotification(`${t('notification.update_failed')}: ${errorMessage}`, 'error');
      } finally {
        if (revision === sourceScope.getRevision()) {
          statusPendingRef.current.keys.delete(key);
          setStatusUpdating((prev) => {
            if (revision !== sourceScope.getRevision()) return prev;
            const next = { ...prev };
            delete next[key];
            return next;
          });
        }
      }
    },
    [authFilesApi, invalidateInFlightLoads, showNotification, sourceScope, t]
  );

  const batchSetStatus = useCallback(
    async (names: string[], enabled: boolean) => {
      const revision = sourceScope.getRevision();
      if (statusPendingRef.current.revision !== revision) {
        statusPendingRef.current = { revision, keys: new Set() };
        batchStatusPendingRef.current = false;
        setBatchStatusUpdating(false);
        setStatusUpdating({});
      }
      if (batchStatusPendingRef.current) return;

      const uniqueNames = new Set(names);
      const targets = new Map(
        files
          .filter((file) => uniqueNames.has(file.name))
          .map((file) => [getAuthFileRefreshKey(file), file])
      );
      if ([...targets.keys()].some((key) => statusPendingRef.current.keys.has(key))) return;
      const originalDisabled = new Map(
        [...targets].map(([key, file]) => [key, file.disabled === true])
      );
      const targetNames = new Set(originalDisabled.keys());
      const targetNameList = Array.from(targetNames);
      if (targetNameList.length === 0) return;

      const nextDisabled = !enabled;

      batchStatusPendingRef.current = true;
      targetNameList.forEach((key) => statusPendingRef.current.keys.add(key));
      setBatchStatusUpdating(true);
      invalidateInFlightLoads();
      setStatusUpdating((prev) => {
        const next = { ...prev };
        targetNameList.forEach((name) => {
          next[name] = true;
        });
        return next;
      });
      setFiles((prev) =>
        prev.map((file) =>
          targetNames.has(getAuthFileRefreshKey(file)) ? { ...file, disabled: nextDisabled } : file
        )
      );

      try {
        const results = await Promise.allSettled(
          targetNameList.map((key) => {
            const file = targets.get(key)!;
            return authFilesApi.setStatus(
              file.name,
              nextDisabled,
              String(file.authIndex ?? '').trim() || undefined
            );
          })
        );
        sourceScope.assertCurrent();
        if (revision !== sourceScope.getRevision()) return;
        invalidateInFlightLoads();

        let successCount = 0;
        let failCount = 0;
        const failedNames = new Set<string>();
        const confirmedDisabled = new Map<string, boolean>();

        results.forEach((result, index) => {
          const name = targetNameList[index];
          if (result.status === 'fulfilled') {
            successCount++;
            confirmedDisabled.set(name, result.value.disabled);
          } else {
            failCount++;
            failedNames.add(name);
          }
        });

        setFiles((prev) =>
          revision !== sourceScope.getRevision()
            ? prev
            : prev.map((file) => {
                const key = getAuthFileRefreshKey(file);
                if (failedNames.has(key)) {
                  return { ...file, disabled: originalDisabled.get(key) === true };
                }
                if (confirmedDisabled.has(key)) {
                  return { ...file, disabled: confirmedDisabled.get(key) };
                }
                return file;
              })
        );
        if (successCount > 0) void notifyAuthFilesChanged(sourceScope.session.owner);

        if (failCount === 0) {
          showNotification(
            t('auth_files.batch_status_success', { count: successCount }),
            'success'
          );
        } else {
          showNotification(
            t('auth_files.batch_status_partial', { success: successCount, failed: failCount }),
            'warning'
          );
        }

        deselectAll();
      } catch (err: unknown) {
        if (!sourceScope.isCurrent()) return;
        if (revision !== sourceScope.getRevision()) return;
        // Same recovery as a single toggle: put back what was shown before the attempt.
        setFiles((prev) =>
          prev.map((file) => {
            const key = getAuthFileRefreshKey(file);
            return originalDisabled.has(key)
              ? { ...file, disabled: originalDisabled.get(key) === true }
              : file;
          })
        );
        const errorMessage = err instanceof Error ? err.message : '';
        showNotification(`${t('notification.update_failed')}: ${errorMessage}`, 'error');
      } finally {
        if (revision === sourceScope.getRevision()) {
          batchStatusPendingRef.current = false;
          targetNameList.forEach((key) => statusPendingRef.current.keys.delete(key));
          setBatchStatusUpdating(false);
          setStatusUpdating((prev) => {
            if (revision !== sourceScope.getRevision()) return prev;
            const next = { ...prev };
            targetNameList.forEach((key) => {
              delete next[key];
            });
            return next;
          });
        }
      }
    },
    [authFilesApi, deselectAll, files, invalidateInFlightLoads, showNotification, sourceScope, t]
  );

  const batchDownload = useCallback(
    async (names: string[]) => {
      const uniqueNames = Array.from(new Set(names));
      if (uniqueNames.length === 0) return;

      let successCount = 0;
      let failCount = 0;

      for (const name of uniqueNames) {
        try {
          const blob = await authFilesApi.download(name);
          sourceScope.assertCurrent();
          downloadBlob({ filename: name, blob });
          successCount++;
        } catch {
          if (!sourceScope.isCurrent()) return;
          failCount++;
        }
      }

      if (failCount === 0) {
        showNotification(
          t('auth_files.batch_download_success', { count: successCount }),
          'success'
        );
      } else {
        showNotification(
          t('auth_files.batch_download_partial', { success: successCount, failed: failCount }),
          'warning'
        );
      }

      // 与 batchSetStatus 保持一致：批量动作完成后清空选择
      deselectAll();
    },
    [authFilesApi, deselectAll, showNotification, sourceScope, t]
  );

  const batchDelete = useCallback(
    (names: string[]) => {
      const uniqueNames = Array.from(new Set(names));
      if (uniqueNames.length === 0) return;

      showConfirmation({
        title: t('auth_files.batch_delete_title'),
        message: t('auth_files.batch_delete_confirm', { count: uniqueNames.length }),
        variant: 'danger',
        confirmText: t('common.confirm'),
        onConfirm: async () => {
          try {
            const result = await authFilesApi.deleteFiles(uniqueNames);
            sourceScope.assertCurrent();
            applyDeletedFiles(result.files);
            if (result.deleted > 0) {
              void notifyAuthFilesChanged(sourceScope.session.owner, {
                reason: 'delete',
                deletedNames: result.files,
              });
            }

            if (result.failed.length === 0) {
              showNotification(
                `${t('auth_files.delete_all_success')} (${result.deleted})`,
                'success'
              );
            } else {
              showNotification(
                t('auth_files.delete_filtered_partial', {
                  success: result.deleted,
                  failed: result.failed.length,
                  type: t('auth_files.filter_all'),
                }),
                'warning'
              );
            }
          } catch (err: unknown) {
            if (!sourceScope.isCurrent()) return;
            const errorMessage = err instanceof Error ? err.message : '';
            showNotification(`${t('notification.delete_failed')}: ${errorMessage}`, 'error');
          }
        },
      });
    },
    [applyDeletedFiles, authFilesApi, showConfirmation, showNotification, sourceScope, t]
  );

  return {
    files,
    selectedFiles,
    selectionCount,
    loading,
    refreshing,
    error,
    uploading,
    deleting,
    deletingAll,
    statusUpdating,
    manualRefreshing,
    refreshingAllCredentials,
    refreshResults,
    closeRefreshResults,
    handleRefreshAllCredentials,
    cooldownResetting,
    batchStatusUpdating,
    fileInputRef,
    loadFiles,
    handleUploadClick,
    handleFileChange,
    handleDelete,
    handleDeleteAll,
    handleDownload,
    handleManualRefresh,
    handleCooldownReset,
    handleStatusToggle,
    toggleSelect,
    selectAllVisible,
    invertVisibleSelection,
    deselectAll,
    batchDownload,
    batchSetStatus,
    batchDelete,
  };
}
