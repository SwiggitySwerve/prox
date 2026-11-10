import { AccountDetails } from '@/features/quota/components/AccountDetails';
import { useClaudeResetGrants } from '@/features/quota/providers/claude/ClaudeResetGrants';
import { useCallback, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { captureQuotaCacheGeneration, commitIfQuotaCacheCurrent } from '@/stores';
import type { AuthFileItem, ClaudeQuotaState } from '@/types';
import { getStatusFromError, resolveQuotaErrorMessage } from '@/utils/quota';
import { getQuotaCacheKey } from '@/utils/quota/identity';
import { isRuntimeOnlyAuthFile, type QuotaProviderType } from '@/features/authFiles/constants';
import { Button } from '@/components/ui/Button';
import { IconRefreshCw } from '@/components/ui/icons';
import { bindQuotaClasses } from '@/features/quota/types';
import type { QuotaCardState } from '@/features/quota/providers';
import { useAuthFilesSource, useAuthFilesNotifications } from '../AuthFilesSourceContext';
import { hasClaudeUsageData } from '@/features/quota/providers/claude/data';
import {
  selectQuotaSlotState,
  type QuotaSlotState,
  type QuotaUnavailableReason,
} from '@/features/authFiles/quotaSlot';
import styles from './AuthFileQuota.module.scss';

/** Bind the auth-file host's compact styles to the quota rendering contract. */
const compactQuotaClasses = bindQuotaClasses(styles, 'AuthFileQuota.module.scss');

const assertNever = (value: never): never => {
  throw new Error(`Unsupported quota type: ${value}`);
};

type QuotaMapUpdater = (
  updater: (prev: Record<string, QuotaCardState>) => Record<string, QuotaCardState>
) => void;

export type AuthFileQuotaSectionProps = {
  file: AuthFileItem;
  quotaType: QuotaProviderType;
  disableControls: boolean;
};

export function AuthFileQuotaSection(props: AuthFileQuotaSectionProps) {
  const { file, quotaType, disableControls } = props;
  const { t } = useTranslation();
  const sourceScope = useAuthFilesSource();
  const useQuotaStore = sourceScope.quotaStore;
  const { showNotification, showConfirmation } = useAuthFilesNotifications();
  const [resettingQuota, setResettingQuota] = useState(false);
  const adapter = sourceScope.quotaAdapters[quotaType];
  const cacheKey = getQuotaCacheKey(file);

  const quota = useQuotaStore((state) => {
    if (quotaType === 'antigravity')
      return state.antigravityQuota[cacheKey] as QuotaCardState | undefined;
    if (quotaType === 'claude') return state.claudeQuota[cacheKey] as QuotaCardState | undefined;
    if (quotaType === 'codex') return state.codexQuota[cacheKey] as QuotaCardState | undefined;
    if (quotaType === 'devin') return state.devinQuota[cacheKey] as QuotaCardState | undefined;
    if (quotaType === 'kimi') return state.kimiQuota[cacheKey] as QuotaCardState | undefined;
    if (quotaType === 'meta') return state.metaQuota[cacheKey] as QuotaCardState | undefined;
    if (quotaType === 'plugin') return state.pluginQuota[cacheKey] as QuotaCardState | undefined;
    if (quotaType === 'xai') return state.xaiQuota[cacheKey] as QuotaCardState | undefined;
    return assertNever(quotaType);
  });
  const retainedClaudeUsage =
    quotaType === 'claude' && hasClaudeUsageData(quota as ClaudeQuotaState | undefined);

  const updateQuotaState = useQuotaStore(
    (state) => state[adapter.storeSetter] as unknown as QuotaMapUpdater
  );

  const refreshQuotaForFile = useCallback(async () => {
    if (disableControls || !sourceScope.isCurrent()) return;
    if (isRuntimeOnlyAuthFile(file)) return;
    if (file.disabled) return;
    if (quota?.status === 'loading' || resettingQuota) return;

    const cacheGeneration = captureQuotaCacheGeneration(file.name, sourceScope.quotaStore);

    updateQuotaState((prev) => ({
      ...prev,
      [cacheKey]: adapter.buildLoadingState(),
    }));

    try {
      const data = await adapter.fetchQuota(file, t);
      sourceScope.assertCurrent();
      commitIfQuotaCacheCurrent(cacheGeneration, () => {
        updateQuotaState((prev) => ({
          ...prev,
          [cacheKey]: adapter.buildSuccessState(data),
        }));
        showNotification(t('auth_files.quota_refresh_success', { name: file.name }), 'success');
      });
    } catch (err: unknown) {
      if (!sourceScope.isCurrent()) return;
      const message = err instanceof Error ? err.message : t('common.unknown_error');
      const status = getStatusFromError(err);
      commitIfQuotaCacheCurrent(cacheGeneration, () => {
        updateQuotaState((prev) => ({
          ...prev,
          [cacheKey]: adapter.buildErrorState(message, status),
        }));
        showNotification(
          t('auth_files.quota_refresh_failed', { name: file.name, message }),
          'error'
        );
      });
    }
  }, [
    adapter,
    cacheKey,
    disableControls,
    file,
    quota?.status,
    resettingQuota,
    showNotification,
    sourceScope,
    t,
    updateQuotaState,
  ]);

  const resetQuotaForFile = useCallback(() => {
    if (disableControls || !sourceScope.isCurrent()) return;
    if (isRuntimeOnlyAuthFile(file)) return;
    if (file.disabled) return;
    if (quota?.status === 'loading') return;
    if (resettingQuota) return;

    const resetQuota = adapter.resetQuota;
    if (!resetQuota) return;

    showConfirmation({
      title: t('codex_quota.reset_confirm_title'),
      message: t('codex_quota.reset_confirm_message', { name: file.name }),
      confirmText: t('codex_quota.reset_confirm_button'),
      variant: 'primary',
      onConfirm: async () => {
        const cacheGeneration = captureQuotaCacheGeneration(file.name, sourceScope.quotaStore);
        setResettingQuota(true);
        try {
          const data = await resetQuota(file, t);
          sourceScope.assertCurrent();
          commitIfQuotaCacheCurrent(cacheGeneration, () => {
            updateQuotaState((prev) => ({
              ...prev,
              [cacheKey]: adapter.buildSuccessState(data),
            }));
            showNotification(t('codex_quota.reset_success', { name: file.name }), 'success');
          });
        } catch (err: unknown) {
          if (!sourceScope.isCurrent()) return;
          const message = err instanceof Error ? err.message : t('common.unknown_error');
          commitIfQuotaCacheCurrent(cacheGeneration, () => {
            showNotification(t('codex_quota.reset_failed', { name: file.name, message }), 'error');
          });
        } finally {
          setResettingQuota(false);
        }
      },
    });
  }, [
    adapter,
    cacheKey,
    disableControls,
    file,
    quota?.status,
    resettingQuota,
    showConfirmation,
    showNotification,
    sourceScope,
    t,
    updateQuotaState,
  ]);

  const quotaStatus = quota?.status ?? 'idle';
  const canRefreshQuota = !disableControls && !file.disabled && !resettingQuota;
  const claudeReset = useClaudeResetGrants(
    file,
    quotaType === 'claude' && quotaStatus !== 'idle',
    !canRefreshQuota || quotaStatus === 'loading',
    quota,
    refreshQuotaForFile,
    adapter.resetGrants
  );
  // A plain boolean: handing the store-derived value on directly costs the compiler's memoization.
  const hasQuotaData = quotaStatus === 'success' || retainedClaudeUsage === true;
  const slot = selectQuotaSlotState({ reason: null, status: quotaStatus, hasData: hasQuotaData });
  const quotaErrorMessage = resolveQuotaErrorMessage(
    t,
    quota?.errorStatus,
    quota?.error || t('common.unknown_error')
  );
  const failureText = t(`${adapter.i18nPrefix}.load_failed`, { message: quotaErrorMessage });
  // A refresh mid-claim would drop the claim's result and its follow-up refresh.
  const refreshDisabled = !canRefreshQuota || quotaStatus === 'loading' || claudeReset.busy;
  const refresh = () => {
    if (!claudeReset.busy) void refreshQuotaForFile();
  };
  // Account details belong to read quota; Claude's reset grants are read even after a failure.
  const showDetails = slot.kind === 'loaded' || (slot.kind === 'failed' && quotaType === 'claude');

  return (
    <QuotaSlotFrame
      state={slot.kind}
      stateText={
        slot.kind === 'idle'
          ? t('auth_files.quota_not_loaded')
          : slot.kind === 'loading' || (slot.kind === 'loaded' && slot.refreshing)
            ? t('common.loading')
            : slot.kind === 'failed' || (slot.kind === 'loaded' && slot.stale)
              ? t('auth_files.quota_failed')
              : ''
      }
      stateTitle={slot.kind === 'failed' || slot.kind === 'loaded' ? failureText : undefined}
      danger={slot.kind === 'failed' || (slot.kind === 'loaded' && slot.stale)}
      refresh={{
        disabled: refreshDisabled,
        spinning: quotaStatus === 'loading',
        title: t('auth_files.quota_refresh_hint'),
        onClick: refresh,
      }}
    >
      {slot.kind === 'idle' && <QuotaPlaceholderRows />}
      {slot.kind === 'loading' && <QuotaPlaceholderRows loading />}
      {slot.kind === 'failed' && (
        <div className={styles.quotaFailure} role="alert">
          <p className={styles.quotaError} title={failureText}>
            {failureText}
          </p>
          <Button
            type="button"
            variant="secondary"
            size="sm"
            onClick={refresh}
            disabled={refreshDisabled}
          >
            {t('auth_files.retry')}
          </Button>
        </div>
      )}
      {slot.kind === 'loaded' && quota && (
        <div className={styles.quotaBody}>
          <adapter.Body quota={quota} classes={compactQuotaClasses} factsInPanel />
        </div>
      )}
      {showDetails && (
        <AccountDetails
          provider={quotaType}
          quota={slot.kind === 'loaded' ? quota : undefined}
          name={file.name}
          claudeReset={quotaType === 'claude' ? claudeReset : undefined}
          reset={
            quotaType === 'codex' && adapter.resetQuota
              ? {
                  disabled:
                    !canRefreshQuota ||
                    quotaStatus === 'loading' ||
                    !quota ||
                    !adapter.canResetQuota?.(quota),
                  onClick: resetQuotaForFile,
                }
              : undefined
          }
        />
      )}
    </QuotaSlotFrame>
  );
}

/** "No quota for this credential": the same frame and size as every other quota state. */
export function AuthFileQuotaUnavailable({ reason }: { reason: QuotaUnavailableReason }) {
  const { t } = useTranslation();
  const why = t(`auth_files.quota_none_${reason}`);
  return (
    <QuotaSlotFrame
      state="unavailable"
      stateText=""
      refresh={{ disabled: true, spinning: false, title: why, onClick: () => {} }}
    >
      <div className={styles.quotaUnavailable}>
        <p className={styles.quotaUnavailableTitle}>{t('auth_files.quota_none')}</p>
        <p className={styles.quotaUnavailableReason}>{why}</p>
      </div>
    </QuotaSlotFrame>
  );
}

/** The quota slot of a loading card skeleton. */
export function AuthFileQuotaSkeleton() {
  return (
    <QuotaSlotFrame
      state="loading"
      stateText=""
      refresh={{ disabled: true, spinning: false, title: '', onClick: () => {} }}
    >
      <QuotaPlaceholderRows loading />
    </QuotaSlotFrame>
  );
}

/** The fixed header of the quota slot: label, state, and the card's own refresh icon. */
function QuotaSlotFrame({
  state,
  stateText,
  stateTitle,
  danger = false,
  refresh,
  children,
}: {
  state: QuotaSlotState['kind'];
  stateText: string;
  stateTitle?: string;
  danger?: boolean;
  refresh: { disabled: boolean; spinning: boolean; title: string; onClick: () => void };
  children: ReactNode;
}) {
  const { t } = useTranslation();
  return (
    <section
      className={styles.quotaSection}
      data-quota-state={state}
      aria-label={t('auth_files.quota_slot_label')}
      aria-busy={state === 'loading' || undefined}
    >
      <div className={styles.quotaHead}>
        <span className={styles.quotaEyebrow}>{t('auth_files.quota_slot_label')}</span>
        <span
          className={`${styles.quotaState} ${danger ? styles.quotaStateDanger : ''}`}
          title={stateTitle}
        >
          {stateText}
        </span>
        <button
          type="button"
          className={styles.quotaRefreshIcon}
          onClick={refresh.onClick}
          disabled={refresh.disabled}
          title={refresh.title}
          aria-label={t('auth_files.quota_refresh_hint')}
        >
          <IconRefreshCw
            size={13}
            aria-hidden="true"
            className={refresh.spinning ? styles.quotaRefreshSpin : undefined}
          />
        </button>
      </div>
      {children}
    </section>
  );
}

/** Empty tracks (not loaded) or shimmering ones (loading), in the shape of read quota. */
function QuotaPlaceholderRows({ loading = false }: { loading?: boolean }) {
  return (
    <div
      className={`${styles.quotaPlaceholder} ${loading ? styles.quotaPlaceholderLoading : ''}`}
      aria-hidden="true"
    >
      <span className={styles.placeholderChip} />
      {[0, 1, 2].map((row) => (
        <span key={row} className={styles.placeholderRow}>
          <span className={styles.placeholderLabel} />
          <span className={styles.placeholderTrack} />
        </span>
      ))}
    </div>
  );
}
