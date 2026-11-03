import { useEffect, useId, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { PoolAccount, PoolProviderId } from '@/domain/quotaPool/types';
import type { AuthFileItem } from '@/types';
import { createAuthFilesApi } from '@/services/api/authFiles';
import { sourceOwnerKey, type SourceSession } from '@/services/api/sourceSession';
import { useProviderSources } from '@/stores/useProviderSources';
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
  onRefresh: () => void;
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
  provider,
  spent,
  reason,
  live = false,
  disabled = true,
  onClick,
}: FactProps) {
  const { t, i18n } = useTranslation();
  const asideId = useId();
  const resets = account.resets;
  const status = poolResetStatus(resets, provider, spent);
  if (!resets || !status) return null;
  const aside = [
    !live && status.statusKey && t(status.statusKey, { usable: resets.usable }),
    !spent && reason,
    !spent &&
      resets.available > 0 &&
      resets.nextExpiryAtMs !== null &&
      t('quota_pool.reset_expiry', { date: formatPoolDate(resets.nextExpiryAtMs, i18n.language) }),
  ]
    .filter(Boolean)
    .join(' · ');
  return (
    <div className={styles.accountResets}>
      <dt>{t('quota_pool.resets')}</dt>
      <dd>
        <span>{t(status.valueKey, { count: resets.available })}</span>
        {aside && (
          <span id={asideId} role="status" className={styles.resetAside}>
            {aside}
          </span>
        )}
        {(resets.available > 0 || spent) && (
          <button
            className={styles.resetAction}
            type="button"
            disabled={disabled}
            aria-describedby={asideId}
            onClick={onClick}
          >
            {t('quota_pool.use_reset')}
          </button>
        )}
      </dd>
    </div>
  );
}

/** Pool readings stay server-owned; credentials load only on disclosure. */
export function PoolAccountResets(props: Props) {
  const { t } = useTranslation();
  const registry = useProviderSources();
  const resets = props.account.resets;
  if (!resets) return null;
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
  const [file, setFile] = useState<AuthFileItem | null>(null);
  const [error, setError] = useState(false);
  useEffect(() => {
    let active = true;
    setFile(null);
    setError(false);
    void createAuthFilesApi(session)
      .list()
      .then((result) => {
        session.assertCurrent();
        if (!active) return;
        const match = findPoolResetFile(
          result.files,
          session.owner.instanceId,
          provider,
          account.sourceAccountId
        );
        if (!match || match.disabled) setError(true);
        else setFile(match);
      })
      .catch(() => {
        if (active) setError(true);
      });
    return () => {
      active = false;
    };
  }, [session, provider, account.sourceAccountId]);
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
  onRefresh: () => void;
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
  const reset = useClaudeResetGrants(file, true, false, null, onRefresh, scope);
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
            : reset.blocked
              ? // A finished read with nothing usable is not still loading.
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
          if (!session.signal.aborted) onRefresh();
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
