import { Fact, FactSection } from '@/components/ui/FactPanel';
import { IconAlertTriangle } from '@/components/ui/icons';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { PoolAccount, PoolProviderId } from '@/domain/quotaPool/types';
import type { AuthFileItem } from '@/types';
import { sourceOwnerKey, type SourceSession } from '@/services/api/sourceSession';
import { useProviderSources } from '@/stores/useProviderSources';
import { useCredentialInventoryStore, useSourceFiles } from '@/stores/useCredentialInventoryStore';
import { createQuotaStore } from '@/stores/useQuotaStore';
import { useSourceLease } from '@/hooks/useSourceLease';
import { useQuotaActions } from '@/features/quota/hooks/useQuotaActions';
import { createQuotaAdapters } from '@/features/quota/providers';
import { useClaudeResetGrants } from '@/features/quota/providers/claude/ClaudeResetGrants';
import { createSourceResetGrants } from '@/features/quota/providers/claude/resetGrantScope';
import { useNow } from '@/hooks/useNow';
import { formatRelativeInstant } from '@/utils/quota';
import type { AccountResetKind, AccountResets } from '@/domain/quotaPool/types';
import {
  findPoolResetFile,
  heldExpiries,
  heldResets,
  poolResetStatus,
  markSpent,
  wasSpent,
} from './resetAccounts';
import { formatPoolDate } from './presentation';
import styles from './QuotaPoolPage.module.scss';

type Props = {
  account: PoolAccount;
  name: string;
  instanceId?: string;
  provider: PoolProviderId;
  onRefresh: (accountId?: string) => void;
};

type FactProps = Props & {
  spent: boolean;
  reason?: string;
  /** A live provider answer that supersedes the server's status (Claude found none usable). */
  live?: boolean;
  disabled?: boolean;
  onClick?: () => void;
  /** End of the reset a use would spend now, when the provider names it (Claude's live pick). */
  nextAtMs?: number;
  /** Kind of that reset, so the mark lands on it when two kinds end together. */
  nextKind?: AccountResetKind;
};

/**
 * Each held reset's expiry, soonest first, with the time left, so the operator can see how long
 * each one lasts before it lapses. Claude readings also name each reset's kind, so a Fable reset
 * reads apart from a standard one. The one a use would spend is marked when the provider names it:
 * Claude's claim picks the usable grant ending first. Codex's redeem call names no credit.
 */
function ResetExpiries({
  resets,
  nextAtMs,
  nextKind,
}: {
  resets: AccountResets;
  nextAtMs?: number;
  nextKind?: AccountResetKind;
}) {
  const { t, i18n } = useTranslation();
  const now = useNow();
  const expiries = heldResets(resets, now);
  if (!expiries.length) return null;
  const undated = resets.available - expiries.length;
  const marked =
    nextAtMs === undefined
      ? -1
      : expiries.findIndex(
          (reset) => reset.at === nextAtMs && (!nextKind || !reset.kind || reset.kind === nextKind)
        );
  return (
    <Fact
      label={t('quota_pool.reset_expiries_label', { count: expiries.length })}
      state="known"
      value={
        <ol className={styles.resetExpiries}>
          {expiries.map(({ at, kind }, index) => (
            <li key={`${at}-${index}`} data-next={index === marked ? '' : undefined}>
              <span>{formatPoolDate(at, i18n.language)}</span>
              <span className={styles.resetExpiryLeft}>
                {kind && `${t(`claude_reset.kind_${kind}`)} · `}
                {formatRelativeInstant(at, now, i18n.language)}
                {index === marked && ` · ${t('quota_pool.reset_expiry_next')}`}
              </span>
            </li>
          ))}
        </ol>
      }
      aside={undated > 0 ? t('quota_pool.reset_expiry_undated', { count: undated }) : undefined}
    />
  );
}

function ResetFact({
  account,
  name,
  provider,
  spent,
  reason,
  live = false,
  disabled = true,
  onClick,
  nextAtMs,
  nextKind,
}: FactProps) {
  const { t } = useTranslation();
  const resets = account.resets;
  const status = poolResetStatus(resets, provider, spent);
  if (!resets || !status)
    return (
      <FactSection title={t('quota_pool.resets')} tone="accent">
        <Fact
          label={t('quota_pool.reset_held_label')}
          state="notReported"
          reason={t('quota_pool.reset_not_reported_reason')}
        />
      </FactSection>
    );
  const aside = [
    !live && status.statusKey && t(status.statusKey, { usable: resets.usable }),
    !spent && reason,
  ]
    .filter(Boolean)
    .join(' · ');
  return (
    <FactSection
      title={t('quota_pool.resets')}
      tone="accent"
      {...(resets.available > 0 || spent
        ? {
            action: {
              label: t('quota_pool.use_reset'),
              context: t('quota_pool.reset_action_context', { name }),
              disabled,
              onClick: onClick ?? (() => {}),
            },
            note: aside || t('quota_pool.reset_unavailable'),
          }
        : { action: undefined })}
    >
      <Fact
        label={t('quota_pool.reset_held_label')}
        state="known"
        value={t(status.valueKey, { count: resets.available })}
      />
      {/* Its own fact, so the dates read as values instead of wrapping inside the status. */}
      {!spent && resets.available > 0 && (
        <ResetExpiries resets={resets} nextAtMs={nextAtMs} nextKind={nextKind} />
      )}
    </FactSection>
  );
}

/** Pool readings stay server-owned; credentials load only on disclosure. */
export function PoolAccountResets(props: Props) {
  const { t } = useTranslation();
  const registry = useProviderSources();
  const resets = props.account.resets;
  if (!resets) return <ResetFact {...props} spent={false} />;
  const source = registry.sources.find((view) => view.source.instanceId === props.instanceId);
  const spent = wasSpent(props.account.id, resets.observedAtMs);
  const status = poolResetStatus(resets, props.provider, spent)!;
  if (
    resets.available > 0 &&
    (resets.usable > 0 || spent || status.early) &&
    source?.session &&
    source.status === 'ready'
  ) {
    return (
      <SourceResetAction
        key={sourceOwnerKey(source.session.owner)}
        {...props}
        owner={source.session}
        spent={spent}
        early={status.early}
      />
    );
  }
  return (
    <ResetFact
      {...props}
      spent={spent}
      reason={
        resets.available > 0 && !spent && (resets.usable > 0 || status.early)
          ? t('quota_pool.reset_source_unavailable')
          : undefined
      }
    />
  );
}

function SourceResetAction({
  owner,
  name,
  account,
  provider,
  onRefresh,
  spent,
  early,
}: Props & { owner: SourceSession; spent: boolean; early: boolean }) {
  const { session } = useSourceLease(owner);
  const { t } = useTranslation();
  // The credential files come from the one inventory store, so a removed or disabled credential
  // stops offering its reset in the same step every other screen drops it.
  const files = useSourceFiles(session.owner);
  const status = useCredentialInventoryStore((state) => state.status);
  useEffect(() => {
    void useCredentialInventoryStore.getState().ensureLoaded(session.owner);
  }, [session.owner]);
  const match = useMemo(
    () =>
      files
        ? findPoolResetFile(files, session.owner.instanceId, provider, account.sourceAccountId)
        : undefined,
    [files, session.owner.instanceId, provider, account.sourceAccountId]
  );
  const file: AuthFileItem | null = match && !match.disabled ? match : null;
  const error = files ? !file : status === 'error';
  const fact = { account, name, provider, onRefresh, spent };
  if (!file)
    return (
      <ResetFact
        {...fact}
        reason={t(error ? 'quota_pool.reset_lookup_failed' : 'quota_pool.reset_loading')}
      />
    );
  return provider === 'claude' ? (
    <ClaudeResetAction {...fact} file={file} session={session} accountId={account.id} />
  ) : (
    <CodexResetAction
      {...fact}
      file={file}
      session={session}
      accountId={account.id}
      early={early}
    />
  );
}

type ActionProps = Props & {
  file: AuthFileItem;
  session: SourceSession;
  onRefresh: (accountId?: string) => void;
  accountId: string;
  /** A spend from this tab is newer than the server's reading. */
  spent: boolean;
};
function ClaudeResetAction({ file, session, onRefresh, accountId, spent, ...fact }: ActionProps) {
  const { t } = useTranslation();
  const scope = useMemo(() => {
    const shared = createSourceResetGrants(session);
    const run = shared.operations.run;
    return {
      ...shared,
      operations: {
        ...shared.operations,
        run: async (...args: Parameters<typeof run>) => {
          const answer = await run(...args);
          if (answer.code === 'reset' && !answer.unresolved) markSpent(accountId);
          return answer;
        },
      },
    };
  }, [session, accountId]);
  // The hook refreshes once when a claim finishes; bind that to this account so a confirm
  // re-reads only it, never the whole fleet as well.
  const refreshAccount = useCallback(() => onRefresh(accountId), [onRefresh, accountId]);
  const reset = useClaudeResetGrants(file, true, false, null, refreshAccount, scope);
  return (
    <ResetFact
      {...fact}
      onRefresh={onRefresh}
      spent={spent}
      disabled={reset.blocked || spent}
      onClick={reset.confirm}
      nextAtMs={spent ? undefined : reset.nextEndsAtMs}
      nextKind={spent ? undefined : reset.nextKind}
      live={!spent && !reset.message && reset.blocked && !reset.busy && reset.count !== null}
      reason={
        spent && !reset.busy
          ? undefined
          : reset.message
            ? t(`claude_reset.${reset.message}`)
            : reset.blocked && !reset.busy
              ? // A finished read with nothing usable is not still loading; a running claim is neither.
                t(
                  reset.count === null
                    ? 'quota_pool.reset_loading'
                    : 'quota_pool.reset_claude_unavailable'
                )
              : undefined
      }
    />
  );
}
function CodexResetAction({
  file,
  session,
  onRefresh,
  accountId,
  spent,
  early,
  name,
  ...fact
}: ActionProps & { early: boolean }) {
  const { t, i18n } = useTranslation();
  const [store] = useState(createQuotaStore);
  const adapter = useMemo(() => {
    const codex = createQuotaAdapters(session, store).codex;
    const reset = codex.resetQuota!;
    return {
      ...codex,
      resetQuota: async (...args: Parameters<typeof reset>) => {
        try {
          return await reset(...args);
        } finally {
          // A confirmed attempt may have consumed the credit even if its cooldown clear or
          // follow-up read failed, so the row waits for the next reading either way.
          markSpent(accountId);
          if (!session.signal.aborted) onRefresh(accountId);
        }
      },
    };
  }, [session, store, onRefresh, accountId]);
  const actions = useQuotaActions(false, store, session);
  // Both confirmations name the soonest expiry the account holds when the dialog opens.
  const soonestFact = () => {
    const soonest = fact.account.resets
      ? heldExpiries(fact.account.resets, Date.now())[0]
      : undefined;
    return (
      soonest !== undefined && (
        <Fact
          label={t('quota_pool.reset_dialog_soonest')}
          state="known"
          value={formatPoolDate(soonest, i18n.language)}
        />
      )
    );
  };
  return (
    <ResetFact
      {...fact}
      name={name}
      onRefresh={onRefresh}
      spent={spent}
      disabled={actions.resettingQuotaName !== null || spent}
      onClick={() => {
        const soonest = soonestFact();
        actions.resetQuota(file, adapter, {
          name,
          title: t(early ? 'quota_pool.reset_early_title' : 'quota_pool.reset_confirm_title'),
          confirmText: t('quota_pool.use_reset'),
          variant: early ? 'danger' : 'primary',
          pill: true,
          message: early ? (
            <div className={styles.resetDialog}>
              <p>{t('quota_pool.reset_early_intro', { name })}</p>
              {soonest && <dl className={styles.resetFacts}>{soonest}</dl>}
              <section>
                <h4>{t('quota_pool.reset_usage_left')}</h4>
                <dl>
                  {fact.account.windows
                    .filter((limit) => limit.remainingPercent !== null)
                    .map((limit) => (
                      <div key={limit.id}>
                        <dt>{t(limit.labelKey, limit.labelParams)}</dt>
                        <dd>{limit.remainingPercent!.toFixed(1)}%</dd>
                      </div>
                    ))}
                </dl>
                {fact.account.windows.every((limit) => limit.remainingPercent === null) && (
                  <p>{t('quota_pool.reset_left_unknown')}</p>
                )}
              </section>
              <p>{t('quota_pool.reset_early_outcome')}</p>
            </div>
          ) : (
            <div>
              <dl className={styles.resetFacts}>
                <Fact label={t('codex_quota.reset_dialog_account')} state="known" value={name} />
                <Fact
                  label={t('codex_quota.reset_dialog_used')}
                  state="known"
                  value={
                    fact.account.resets
                      ? t('codex_quota.reset_dialog_used_of', {
                          held: fact.account.resets.available,
                        })
                      : '1'
                  }
                />
                {soonest}
                {/* The reset lifts Codex's rate limits (credit type codex_rate_limits); the credit
                    doesn't list windows, so the dialog names the limits this account reports. */}
                <Fact
                  label={t('codex_quota.reset_dialog_limits')}
                  state="known"
                  value={
                    fact.account.windows.length > 0
                      ? fact.account.windows
                          .map((limit) => t(limit.labelKey, limit.labelParams))
                          .join(' · ')
                      : t('codex_quota.reset_dialog_limits_unknown')
                  }
                />
              </dl>
              <p className={styles.resetWarning}>
                <IconAlertTriangle size={14} aria-hidden="true" />
                {t('codex_quota.reset_dialog_irreversible')}
              </p>
            </div>
          ),
        });
      }}
    />
  );
}
