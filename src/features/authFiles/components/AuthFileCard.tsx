import { useState, type CSSProperties } from 'react';
import { getAuthFileRefreshKey } from '@/features/authFiles/manualRefresh';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/Button';
import { Skeleton } from '@/components/ui/Skeleton';
import { LoadingSpinner } from '@/components/ui/LoadingSpinner';
import { SelectionCheckbox } from '@/components/ui/SelectionCheckbox';
import { ToggleSwitch } from '@/components/ui/ToggleSwitch';
import {
  IconDownload,
  IconInfo,
  IconModelCluster,
  IconRefreshCw,
  IconSettings,
  IconTrash2,
} from '@/components/ui/icons';
import { ProviderStatusBar } from '@/components/providers/ProviderStatusBar';
import type { AuthFileItem } from '@/types';
import { useNow } from '@/hooks/useNow';
import { statusBarDataFromRecentRequests } from '@/utils/recentRequests';
import { formatDateTimeValue, formatFileSize } from '@/utils/format';
import {
  authFileStatusWarning,
  formatModified,
  getAuthFileStatusMessage,
  getTypeColor,
  getTypeLabel,
  isRuntimeOnlyAuthFile,
  normalizeProviderKey,
  supportsAuthFileManualRefresh,
  type AuthFileQuotaFilter,
  type AuthFileStatusSummary,
  type ResolvedTheme,
} from '@/features/authFiles/constants';
import { deriveAuthFileIdentity } from '@/features/authFiles/identity';
import { resolveAuthFileQuotaType } from '@/features/authFiles/logic';
import type { AuthFileStatusBarData } from '@/features/authFiles/hooks/useAuthFilesStatusBarCache';
import {
  AuthFileQuotaSection,
  AuthFileQuotaSkeleton,
  AuthFileQuotaUnavailable,
} from '@/features/authFiles/components/AuthFileQuotaSection';
import { quotaUnavailableReason } from '@/features/authFiles/quotaSlot';
import { AuthFileCooldownSection } from './AuthFileCooldownSection';
import { getSiwcBindingStatus, supportsSiwcBinding } from '@/features/oauth/siwcBinding';
import { SiwcStatusBadge } from '@/features/oauth/components/SiwcStatusBadge';
import styles from './AuthFileCard.module.scss';

export type AuthFileCardProps = {
  file: AuthFileItem;
  compact: boolean;
  selected: boolean;
  resolvedTheme: ResolvedTheme;
  disableControls: boolean;
  deleting: string | null;
  statusUpdating: Record<string, boolean>;
  manualRefreshing: Record<string, boolean>;
  cooldownResetting: Record<string, boolean>;
  quotaFilterType: AuthFileQuotaFilter;
  statusBarCache: Map<string, AuthFileStatusBarData>;
  /** One-time entrance delay; null/undefined disables entrance motion. */
  entranceDelayMs?: number | null;
  onShowModels: (file: AuthFileItem) => void;
  onDownload: (name: string) => void;
  onManualRefresh: (file: AuthFileItem) => void;
  onCooldownReset: (file: AuthFileItem) => void;
  onOpenPrefixProxyEditor: (file: AuthFileItem) => void;
  onDelete: (name: string) => void;
  onToggleStatus: (file: AuthFileItem, enabled: boolean) => void;
  onToggleSelect: (name: string) => void;
};

export function AuthFileCard(props: AuthFileCardProps) {
  const { t, i18n } = useTranslation();
  const {
    file,
    compact,
    selected,
    resolvedTheme,
    disableControls,
    deleting,
    statusUpdating,
    manualRefreshing,
    cooldownResetting,
    quotaFilterType,
    statusBarCache,
    entranceDelayMs,
    onShowModels,
    onDownload,
    onManualRefresh,
    onCooldownReset,
    onOpenPrefixProxyEditor,
    onDelete,
    onToggleStatus,
    onToggleSelect,
  } = props;

  const isRuntimeOnly = isRuntimeOnlyAuthFile(file);
  const providerKey = normalizeProviderKey(String(file.type ?? file.provider ?? 'unknown'));
  const isAistudio = providerKey === 'aistudio';
  const showModelsButton = !isRuntimeOnly || isAistudio;
  const showManualRefreshButton = !isRuntimeOnly && supportsAuthFileManualRefresh(providerKey);
  const isManualRefreshing = manualRefreshing[getAuthFileRefreshKey(file)] === true;
  const typeLabel = getTypeLabel(t, providerKey);
  const typeColor = getTypeColor(providerKey, resolvedTheme);

  const quotaType = resolveAuthFileQuotaType(file, quotaFilterType);
  const quotaReason = quotaUnavailableReason(file, quotaFilterType);

  const successCount = file.successCount ?? 0;
  const failureCount = file.failureCount ?? 0;
  const authIndexKey = typeof file.authIndex === 'string' ? file.authIndex : null;
  const isCooldownResetting = Boolean(authIndexKey && cooldownResetting[authIndexKey]);
  const statusData =
    (authIndexKey && statusBarCache.get(authIndexKey)) ||
    statusBarDataFromRecentRequests(file.recentRequests ?? []);

  const rawStatusMessage = getAuthFileStatusMessage(file);
  const describeStatus = (summary: AuthFileStatusSummary): string => {
    if (summary.kind === 'message') return summary.text;
    if (summary.kind === 'rate_limit') {
      return summary.resetsAt
        ? t('auth_files.status_rate_limited_until', {
            time: formatDateTimeValue(summary.resetsAt, i18n.language),
          })
        : t('auth_files.status_rate_limited');
    }
    const limit = t(
      summary.window === 'weekly'
        ? 'auth_files.status_weekly_limit'
        : summary.window === 'five_hour'
          ? 'auth_files.status_five_hour_limit'
          : 'auth_files.status_usage_limit'
    );
    return summary.resetsAt
      ? t('auth_files.status_limit_resets', {
          limit,
          time: formatDateTimeValue(summary.resetsAt, i18n.language),
        })
      : limit;
  };
  // Re-read each minute while a retry time is shown, so a passed one drops off.
  const now = useNow(Boolean(file.nextRetryAfter));
  const statusWarning = authFileStatusWarning(file, now);

  const priorityValue = Number.isSafeInteger(file.priority) ? file.priority : undefined;
  const weightValue = Number.isSafeInteger(file.weight) ? file.weight : undefined;
  const noteValue = typeof file.note === 'string' ? file.note.trim() : '';
  // Config API keys and runtime credentials have no file size or modified time.
  const modifiedText = formatModified(file);
  const hasFileMeta = Boolean(file.size) || modifiedText !== '-';
  const cooldownRecords = file.cooldownSnapshot?.records;
  const hasCooldownContent = cooldownRecords === null || (cooldownRecords?.length ?? 0) > 0;
  // Lead with account identity and use the file name as secondary text.
  const identity = deriveAuthFileIdentity(file);
  const siwcExpires = file.siwcExpiresAt
    ? formatDateTimeValue(file.siwcExpiresAt, i18n.language)
    : '';

  // Capture the entrance delay once so subsequent updates do not interrupt it.
  const [mountEntranceDelayMs] = useState<number | null>(entranceDelayMs ?? null);
  const cardClasses = [
    styles.card,
    compact ? styles.cardCompact : '',
    selected ? styles.cardSelected : '',
    file.disabled === true ? styles.cardDisabled : '',
    mountEntranceDelayMs != null ? styles.cardEnter : '',
  ]
    .filter(Boolean)
    .join(' ');
  const cardStyle =
    mountEntranceDelayMs != null
      ? ({ '--card-delay': `${mountEntranceDelayMs}ms` } as CSSProperties)
      : undefined;

  const statusBusy = statusUpdating[getAuthFileRefreshKey(file)] === true;
  // Every card has the same buttons in the same order; one that does not apply says why.
  const runtimeReason = t('auth_files.action_unavailable_runtime');
  const manualRefreshReason = isRuntimeOnly
    ? runtimeReason
    : !supportsAuthFileManualRefresh(providerKey)
      ? t('auth_files.action_refresh_unsupported')
      : file.disabled
        ? t('auth_files.action_refresh_disabled')
        : t('auth_files.manual_refresh_button');

  return (
    <article className={cardClasses} style={cardStyle}>
      <header className={styles.head}>
        <SelectionCheckbox
          checked={selected && !isRuntimeOnly}
          onChange={() => onToggleSelect(file.name)}
          className={styles.selection}
          disabled={isRuntimeOnly}
          ariaLabel={t('auth_files.card_select', { name: file.name })}
          title={
            isRuntimeOnly
              ? t('auth_files.select_unavailable_runtime')
              : t('auth_files.card_select', { name: file.name })
          }
        />
        <h3 className={styles.identity}>
          <span
            className={styles.providerBadge}
            style={{
              backgroundColor: typeColor.bg,
              color: typeColor.text,
              ...(typeColor.border ? { border: typeColor.border } : {}),
            }}
          >
            {typeLabel}
          </span>
          <span
            className={`${styles.account} ${identity.kind === 'fileName' ? styles.accountMono : ''}`}
            title={identity.primary}
          >
            {identity.primary}
          </span>
        </h3>
      </header>

      {/* Slot b: the file name, or "Runtime only" for a credential held in memory. */}
      <div className={styles.identityLine}>
        {isRuntimeOnly ? (
          <span className={styles.runtimeLabel}>{t('auth_files.type_virtual')}</span>
        ) : (
          <span className={styles.fileName} title={identity.fullName}>
            {identity.secondary ?? identity.fullName}
          </span>
        )}
      </div>

      {/* Slot c: requests; with no traffic the bar is the empty track. */}
      <div className={styles.health}>
        <div className={styles.healthHead}>
          <span className={styles.healthLabel}>{t('auth_files.card_requests')}</span>
          <span className={styles.healthCounts}>
            <span
              className={`${styles.countOk} ${successCount > 0 ? styles.countLive : ''}`}
              title={t('stats.success')}
            >
              {t('stats.success')} {successCount}
            </span>
            <span
              className={`${styles.countFail} ${failureCount > 0 ? styles.countLive : ''}`}
              title={t('stats.failure')}
            >
              {t('stats.failure')} {failureCount}
            </span>
          </span>
        </div>
        <ProviderStatusBar statusData={statusData} styles={styles} />
      </div>

      {/* Slot d: size · modified, or a muted default; never left out. */}
      <div className={styles.metaRow}>
        {hasFileMeta ? (
          <>
            <span title={t('auth_files.file_size')}>
              {file.size ? formatFileSize(file.size) : '–'}
            </span>
            <span className={styles.metaDivider} aria-hidden="true">
              ·
            </span>
            <span title={t('auth_files.file_modified')}>
              {modifiedText === '-' ? '–' : modifiedText}
            </span>
          </>
        ) : (
          <span className={styles.metaMuted}>
            {isRuntimeOnly ? t('auth_files.meta_no_file') : '– · –'}
          </span>
        )}
        {priorityValue !== undefined && (
          <>
            <span className={styles.metaDivider} aria-hidden="true">
              ·
            </span>
            <span className={styles.metaPriority} title={t('auth_files.priority_hint')}>
              <span className={styles.metaMetricLabel}>{t('auth_files.priority_display')}</span>
              <span>{priorityValue}</span>
            </span>
          </>
        )}
        {weightValue !== undefined && (
          <>
            <span className={styles.metaDivider} aria-hidden="true">
              ·
            </span>
            <span className={styles.metaWeight} title={t('auth_files.weight_tooltip')}>
              <span className={styles.metaMetricLabel}>{t('auth_files.weight_display')}</span>
              <span>{weightValue}</span>
            </span>
          </>
        )}
      </div>

      {/* Slot e: quota, one fixed-size block in every state (compact cards leave it out). */}
      {!compact &&
        (quotaReason || !quotaType ? (
          <AuthFileQuotaUnavailable reason={quotaReason ?? 'unsupported'} />
        ) : (
          <AuthFileQuotaSection
            file={file}
            quotaType={quotaType}
            disableControls={disableControls}
          />
        ))}

      {/* Slots f and g share one grid track: the notices on top, the actions at the bottom. */}
      <div className={styles.foot}>
        {/* Notes and warnings sit under the quota slot so the slots above never move. */}
        {(Boolean(!compact && noteValue) ||
          statusWarning !== null ||
          hasCooldownContent ||
          supportsSiwcBinding(file)) && (
          <div className={styles.notices}>
            {!compact && noteValue && (
              <p className={styles.note} title={noteValue}>
                {noteValue}
              </p>
            )}

            {statusWarning && (
              <div className={styles.warning} title={rawStatusMessage}>
                <IconInfo className={styles.warningIcon} size={14} />
                <span>{describeStatus(statusWarning)}</span>
              </div>
            )}

            <AuthFileCooldownSection
              snapshot={file.cooldownSnapshot}
              resetting={isCooldownResetting}
              resetDisabled={disableControls || statusBusy || isManualRefreshing}
              onReset={authIndexKey ? () => onCooldownReset(file) : undefined}
            />

            {supportsSiwcBinding(file) && (
              <div className={styles.siwcRow}>
                <SiwcStatusBadge status={getSiwcBindingStatus(file)} />
                {siwcExpires && (
                  <span className={styles.siwcExpires} title={file.siwcExpiresAt}>
                    {t('siwc.expires', { date: siwcExpires })}
                  </span>
                )}
              </div>
            )}
          </div>
        )}

        {/* The same actions in the same order, then the Enabled switch. */}
        <footer className={styles.actions}>
          <div className={styles.actionsMain}>
            <Button
              variant="secondary"
              size="sm"
              onClick={() => onShowModels(file)}
              data-card-models={file.name}
              title={showModelsButton ? t('auth_files.models_button') : runtimeReason}
              disabled={disableControls || !showModelsButton}
            >
              <IconModelCluster size={14} />
              {t('auth_files.models_button')}
            </Button>
            <div className={styles.utilityActions}>
              <Button
                variant="secondary"
                size="sm"
                onClick={() => onManualRefresh(file)}
                className={styles.iconButton}
                title={manualRefreshReason}
                aria-label={t('auth_files.manual_refresh_button')}
                disabled={
                  disableControls ||
                  !showManualRefreshButton ||
                  file.disabled ||
                  statusBusy ||
                  isManualRefreshing
                }
              >
                {isManualRefreshing ? <LoadingSpinner size={14} /> : <IconRefreshCw size={15} />}
              </Button>
              <Button
                variant="secondary"
                size="sm"
                onClick={() => onDownload(file.name)}
                className={styles.iconButton}
                title={isRuntimeOnly ? runtimeReason : t('auth_files.download_button')}
                aria-label={t('auth_files.download_button')}
                disabled={disableControls || isRuntimeOnly}
              >
                <IconDownload size={15} />
              </Button>
              <Button
                variant="secondary"
                size="sm"
                onClick={() => onOpenPrefixProxyEditor(file)}
                data-card-settings={file.name}
                className={styles.iconButton}
                title={isRuntimeOnly ? runtimeReason : t('auth_files.prefix_proxy_button')}
                aria-label={t('auth_files.prefix_proxy_button')}
                disabled={disableControls || isRuntimeOnly || isManualRefreshing}
              >
                <IconSettings size={15} />
              </Button>
              <Button
                variant="danger"
                size="sm"
                onClick={() => onDelete(file.name)}
                className={styles.iconButton}
                title={isRuntimeOnly ? runtimeReason : t('auth_files.delete_button')}
                aria-label={t('auth_files.delete_button')}
                disabled={
                  disableControls || isRuntimeOnly || deleting === file.name || isManualRefreshing
                }
              >
                {deleting === file.name ? <LoadingSpinner size={14} /> : <IconTrash2 size={15} />}
              </Button>
            </div>
          </div>
          <div
            className={styles.toggleWrap}
            title={isRuntimeOnly ? t('auth_files.toggle_unavailable_runtime') : undefined}
          >
            <span className={styles.toggleLabel}>{t('auth_files.status_toggle_label')}</span>
            <ToggleSwitch
              ariaLabel={t('auth_files.card_toggle', { name: file.name })}
              checked={!file.disabled}
              disabled={disableControls || isRuntimeOnly || statusBusy || isManualRefreshing}
              onChange={(value) => onToggleStatus(file, value)}
            />
          </div>
        </footer>
      </div>
    </article>
  );
}

/** A loading card: the same slots at the same heights as a real one, so nothing jumps. */
export function AuthFileCardSkeleton({ compact }: { compact: boolean }) {
  return (
    <div
      className={[styles.card, compact ? styles.cardCompact : ''].filter(Boolean).join(' ')}
      aria-hidden="true"
    >
      <div className={styles.head}>
        <Skeleton width={18} height={18} rounded={5} />
        <Skeleton width={58} height={22} rounded={12} />
        <Skeleton width="45%" height={14} rounded={6} />
      </div>
      <div className={styles.identityLine}>
        <Skeleton width="32%" height={10} rounded={5} />
      </div>
      <div className={styles.health}>
        <div className={styles.healthHead}>
          <Skeleton width={64} height={10} rounded={5} />
          <Skeleton width={128} height={10} rounded={5} />
        </div>
        <Skeleton height={14} rounded={2} />
      </div>
      <div className={styles.metaRow}>
        <Skeleton width={120} height={10} rounded={5} />
      </div>
      {!compact && <AuthFileQuotaSkeleton />}
      <div className={styles.foot}>
        <div className={styles.actions}>
          <div className={styles.actionsMain}>
            <Skeleton width={128} height={30} rounded={8} />
            <div className={styles.utilityActions}>
              {[0, 1, 2, 3].map((index) => (
                <Skeleton key={index} width={30} height={30} rounded={8} />
              ))}
            </div>
          </div>
          <div className={styles.toggleWrap}>
            <Skeleton width={44} height={10} rounded={5} />
            <Skeleton width={44} height={24} rounded={12} />
          </div>
        </div>
      </div>
    </div>
  );
}
