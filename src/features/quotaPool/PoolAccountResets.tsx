import { useEffect, useMemo, useState } from 'react';
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
import { findPoolResetFile, poolResetReasonKey } from './resetAccounts';
import { formatPoolDate } from './presentation';
import styles from './QuotaPoolPage.module.scss';

type Props = {
  account: PoolAccount;
  instanceId?: string;
  provider: PoolProviderId;
  onRefresh: () => void;
};

/** Spend attempts this tab made, by account: the server's counts lag until its next collection. */
const spentAt = new Map<string, number>();
const markSpent = (accountId: string) => spentAt.set(accountId, Date.now());

/** Pool readings stay server-owned; credentials and provider reads are loaded only on disclosure. */
export function PoolAccountResets(props: Props) {
  const { t, i18n } = useTranslation();
  const registry = useProviderSources();
  const resets = props.account.resets;
  if (!resets) return null;
  const source = registry.sources.find((view) => view.source.instanceId === props.instanceId);
  const spent = (spentAt.get(props.account.id) ?? 0) > resets.observedAtMs;
  return (
    <div className={styles.accountResets}>
      <dt>{t('quota_pool.resets')}</dt>
      <dd>
        <span>
          {t('quota_pool.reset_summary', { count: resets.available, usable: resets.usable })}
        </span>
        {resets.nextExpiryAtMs !== null && (
          <span>
            {t('quota_pool.reset_expiry', {
              date: formatPoolDate(resets.nextExpiryAtMs, i18n.language),
            })}
          </span>
        )}
        {/* Nothing held: the count already says so, and there is nothing to spend. */}
        {/* A running or just-finished spend keeps its action mounted so its result still shows. */}
        {resets.available === 0 ? null : (resets.usable > 0 || spent) &&
          source?.session &&
          source.status === 'ready' ? (
          <SourceResetAction
            key={sourceOwnerKey(source.session.owner)}
            {...props}
            owner={source.session}
            spent={spent}
          />
        ) : (
          <ResetButton
            disabled
            reason={t(
              spent
                ? 'quota_pool.reset_spent'
                : resets.usable === 0
                  ? poolResetReasonKey(resets.blocker)
                  : 'quota_pool.reset_source_unavailable'
            )}
          />
        )}
      </dd>
    </div>
  );
}

function ResetButton({
  disabled,
  reason,
  onClick,
}: {
  disabled: boolean;
  reason?: string;
  onClick?: () => void;
}) {
  const { t } = useTranslation();
  return (
    <span className={styles.resetAction}>
      <button type="button" disabled={disabled} onClick={onClick}>
        {t('quota_pool.use_reset')}
      </button>
      {reason && <span role="status">{reason}</span>}
    </span>
  );
}

function SourceResetAction({
  owner,
  account,
  provider,
  onRefresh,
  spent,
}: Props & { owner: SourceSession; spent: boolean }) {
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
  if (!file)
    return (
      <ResetButton
        disabled
        reason={t(
          `quota_pool.${spent ? 'reset_spent' : error ? 'reset_lookup_failed' : 'reset_loading'}`
        )}
      />
    );
  return provider === 'claude' ? (
    <ClaudeResetAction {...{ file, session, onRefresh, spent }} accountId={account.id} />
  ) : (
    <CodexResetAction {...{ file, session, onRefresh, spent }} accountId={account.id} />
  );
}

type ActionProps = {
  file: AuthFileItem;
  session: SourceSession;
  onRefresh: () => void;
  accountId: string;
  /** A spend from this tab is newer than the server's reading. */
  spent: boolean;
};
function ClaudeResetAction({ file, session, onRefresh, accountId, spent }: ActionProps) {
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
    <ResetButton
      disabled={reset.blocked || spent}
      onClick={reset.confirm}
      reason={
        spent && !reset.busy
          ? t('quota_pool.reset_spent')
          : reset.message
            ? t(`claude_reset.${reset.message}`)
            : reset.blocked && !reset.busy
              ? // A finished read with nothing usable is not still loading.
                t(
                  reset.count === null ? 'quota_pool.reset_loading' : 'quota_pool.reset_unavailable'
                )
              : undefined
      }
    />
  );
}
function CodexResetAction({ file, session, onRefresh, accountId, spent }: ActionProps) {
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
    <ResetButton
      disabled={actions.resettingQuotaName !== null || spent}
      onClick={() => actions.resetQuota(file, adapter)}
      reason={
        spent && actions.resettingQuotaName === null ? t('quota_pool.reset_spent') : undefined
      }
    />
  );
}
