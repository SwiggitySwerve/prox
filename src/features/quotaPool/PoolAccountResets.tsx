import { Fact, FactSection } from '@/components/ui/FactPanel';
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
import { findPoolResetFile, poolResetStatus, markSpent, wasSpent } from './resetAccounts';
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
};

function ResetFact({
  account,
  name,
  provider,
  spent,
  reason,
  live = false,
  disabled = true,
  onClick,
}: FactProps) {
  const { t, i18n } = useTranslation();
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
      {/* Its own fact, so the date reads as a value instead of wrapping inside the status. */}
      {!spent && resets.available > 0 && resets.nextExpiryAtMs !== null && (
        <Fact
          label={t('quota_pool.reset_expiry_label')}
          state="known"
          value={formatPoolDate(resets.nextExpiryAtMs, i18n.language)}
        />
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
  const { t } = useTranslation();
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
  return (
    <ResetFact
      {...fact}
      name={name}
      onRefresh={onRefresh}
      spent={spent}
      disabled={actions.resettingQuotaName !== null || spent}
      onClick={() =>
        actions.resetQuota(file, adapter, {
          name,
          title: t(early ? 'quota_pool.reset_early_title' : 'quota_pool.reset_confirm_title'),
          confirmText: t('quota_pool.use_reset'),
          variant: early ? 'danger' : 'primary',
          message: early ? (
            <div className={styles.resetDialog}>
              <p>{t('quota_pool.reset_early_intro', { name })}</p>
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
            t('quota_pool.reset_confirm_body', { name })
          ),
        })
      }
    />
  );
}
