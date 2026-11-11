import { useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/Button';
import { Modal } from '@/components/ui/Modal';
import {
  targetKey,
  type EditSession,
  type ListTarget,
  type ListWrite,
  type ModelAccessInventory,
  type PlanNotice,
  type SettledEditSession,
  type StaleTarget,
  type WriteOutcome,
  type WritePlan,
} from '@/features/authFiles/modelAccess';
import { listDiff } from './matrixView';
import styles from './ModelsPage.module.scss';

type Props = {
  session: EditSession;
  inventory: ModelAccessInventory | null;
  onChoose: (mode: 'provider' | 'own') => void;
  onApply: () => void;
  onRetry: () => void;
  onRollback: () => void;
  onReplan: () => void;
  onClose: () => void;
};

export function ModelEditDialog(props: Props) {
  const { t } = useTranslation();
  const { session, inventory } = props;
  // Keep the Modal mounted and drive `open`, so it can move focus in, restore it on close and
  // animate out; the last non-idle state stays on screen while it closes.
  const [shown, setShown] = useState<EditSession>(session);
  if (session.status !== 'idle' && session !== shown) setShown(session);
  const view = session.status === 'idle' ? shown : session;
  // Two credential files can share a label (the same e-mail): then the file name tells them apart.
  const labelOf = (name: string) => {
    const account = inventory?.accounts.find((item) => item.name === name);
    if (!account) return name;
    const shared = inventory?.accounts.some(
      (item) => item.name !== name && item.label === account.label
    );
    return shared && account.label !== name ? `${account.label} · ${name}` : account.label;
  };
  const names = (list: string[]) => list.map(labelOf).join(', ');
  const targetLabel = (target: ListTarget) =>
    target.kind === 'provider'
      ? t('model_access.target_provider', { provider: inventory?.provider ?? '' })
      : t('model_access.target_account', { account: labelOf(target.name) });

  const noticeText = (notice: PlanNotice) => {
    switch (notice.code) {
      case 'provider-affects':
        return t('model_access.notice_provider_affects', {
          accounts: names(notice.accounts) || t('model_access.none'),
        });
      case 'provider-ignored-by':
        return t('model_access.notice_provider_ignored', { accounts: names(notice.accounts) });
      case 'stops-inheriting':
        return t('model_access.notice_stops_inheriting', { account: labelOf(notice.account) });
      case 'starts-inheriting':
        return [
          t('model_access.notice_starts_inheriting', { account: labelOf(notice.account) }),
          notice.stillExcluded.length > 0
            ? t('model_access.notice_still_excluded', { models: notice.stillExcluded.join(', ') })
            : '',
        ]
          .filter(Boolean)
          .join(' ');
      case 'cannot-override-provider':
        return t('model_access.notice_cannot_override', {
          account: labelOf(notice.account),
          model: notice.model,
        });
      case 'unreadable':
        return t('model_access.notice_unreadable', { accounts: names(notice.accounts) });
      case 'no-change':
        return t('model_access.notice_no_change');
      default: {
        const unreachable: never = notice;
        return String(unreachable);
      }
    }
  };

  const renderWrites = (writes: ListWrite[]) => (
    <ul className={styles.writeList}>
      {writes.map((write) => {
        const diff = listDiff(write);
        return (
          <li key={targetKey(write.target)}>
            <strong>{targetLabel(write.target)}</strong>
            {diff.added.length > 0 && (
              <span className={styles.diffAdded}>
                {t('model_access.adds', { rules: diff.added.join(', ') })}
              </span>
            )}
            {diff.removed.length > 0 && (
              <span className={styles.diffRemoved}>
                {t('model_access.removes', { rules: diff.removed.join(', ') })}
              </span>
            )}
            {write.after === null && (
              <span className={styles.metaNote}>
                {write.target.kind === 'provider'
                  ? t('model_access.provider_entry_removed')
                  : t('model_access.account_list_removed')}
              </span>
            )}
          </li>
        );
      })}
    </ul>
  );

  const renderPlan = (plan: WritePlan) => (
    <div className={styles.planBody}>
      {plan.writes.length > 0 && (
        <section aria-labelledby="plan-writes">
          <h3 id="plan-writes">
            {t('model_access.preview_writes', { count: plan.writes.length })}
          </h3>
          {renderWrites(plan.writes)}
        </section>
      )}
      {plan.blocked.length > 0 && (
        <section aria-labelledby="plan-blocked">
          <h3 id="plan-blocked">{t('model_access.preview_blocked')}</h3>
          <ul className={styles.writeList}>
            {plan.blocked.map((item) => (
              <li key={targetKey(item.target)}>
                {t('model_access.blocked_item', {
                  target: targetLabel(item.target),
                  rule: item.rule,
                })}
              </li>
            ))}
          </ul>
        </section>
      )}
      {plan.notices.length > 0 && (
        <ul className={styles.notices}>
          {plan.notices.map((notice, index) => (
            <li key={`${notice.code}-${index}`} data-notice={notice.code}>
              {noticeText(notice)}
            </li>
          ))}
        </ul>
      )}
      {plan.writes.length > 0 && (
        <section aria-labelledby="plan-changes">
          <h3 id="plan-changes">
            {t('model_access.preview_changes', { count: plan.changes.length })}
          </h3>
          {plan.changes.length === 0 ? (
            <p className={styles.metaNote}>{t('model_access.preview_no_changes')}</p>
          ) : (
            <ul className={styles.changeList}>
              {plan.changes.map((change) => (
                <li key={`${change.account}::${change.model}`}>
                  <span className={styles.modelId}>{change.model}</span>
                  <span>{labelOf(change.account)}</span>
                  <span>
                    {t('model_access.change_from_to', {
                      from: t(`model_access.kind_${change.from.replace('-', '_')}`),
                      to: t(`model_access.kind_${change.to.replace('-', '_')}`),
                    })}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </section>
      )}
    </div>
  );

  const outcomeText = (outcome: WriteOutcome) =>
    outcome.status === 'ok'
      ? t('model_access.outcome_ok')
      : outcome.status === 'failed'
        ? t('model_access.outcome_failed', { message: outcome.message })
        : t('model_access.outcome_skipped');

  /** The plan's writes: written, failed, or not attempted. */
  const renderOutcomes = (outcomes: WriteOutcome[]) => (
    <ul className={styles.writeList}>
      {outcomes.map((outcome) => (
        <li key={targetKey(outcome.write.target)} data-outcome={outcome.status}>
          <strong>{targetLabel(outcome.write.target)}</strong>
          <span className={outcome.status === 'ok' ? styles.diffAdded : styles.diffRemoved}>
            {outcomeText(outcome)}
          </span>
        </li>
      ))}
    </ul>
  );

  /** While rolling back: every list this change wrote, and whether it is restored yet. */
  const renderUndo = (view: SettledEditSession) => (
    <ul className={styles.writeList}>
      {view.outcomes
        .filter((outcome) => outcome.status === 'ok')
        .map(({ write }) => {
          const undo = view.undo.find(
            (item) => targetKey(item.write.target) === targetKey(write.target)
          );
          const state = undo?.status === 'ok' ? 'restored' : 'still-written';
          return (
            <li key={targetKey(write.target)} data-outcome={state}>
              <strong>{targetLabel(write.target)}</strong>
              <span className={state === 'restored' ? styles.diffAdded : styles.diffRemoved}>
                {undo?.status === 'ok'
                  ? t('model_access.outcome_restored')
                  : undo?.status === 'failed'
                    ? t('model_access.outcome_not_restored', { message: undo.message })
                    : t('model_access.outcome_still_written')}
              </span>
            </li>
          );
        })}
    </ul>
  );

  const renderStale = (stale: StaleTarget[]) => (
    <ul className={styles.writeList}>
      {stale.map((item) => (
        <li key={targetKey(item.target)} data-guard={item.guard ? 'true' : undefined}>
          {t(item.guard ? 'model_access.stale_guard_item' : 'model_access.stale_item', {
            target: targetLabel(item.target),
            rules: (item.actual ?? []).join(', ') || t('model_access.none'),
          })}
        </li>
      ))}
    </ul>
  );

  /** Whether the table was read again after the run; the write result stands either way. */
  const renderRefresh = (view: SettledEditSession) => (
    <p
      className={styles.metaNote}
      role={view.refresh === 'failed' ? 'alert' : 'status'}
      data-refresh={view.refresh}
    >
      {view.refresh === 'running'
        ? t('model_access.session_refreshing')
        : view.refresh === 'ok'
          ? t('model_access.session_refreshed')
          : t('model_access.session_refresh_failed')}
    </p>
  );

  /** Read the table again; shown when no write is left to retry (retry re-reads after writing). */
  const refreshButton = (view: SettledEditSession) =>
    view.refresh === 'failed' && (
      <Button variant="secondary" onClick={props.onRetry} data-testid="write-plan-refresh">
        {t('model_access.session_refresh_retry')}
      </Button>
    );

  const landed = (outcomes: WriteOutcome[]) => outcomes.some((outcome) => outcome.status === 'ok');

  let title: string;
  let body: ReactNode;
  let footer: ReactNode;
  const close = (
    <Button variant="secondary" onClick={props.onClose}>
      {t('common.close')}
    </Button>
  );

  switch (view.status) {
    case 'idle':
      title = '';
      body = null;
      footer = null;
      break;
    case 'choosing': {
      const intent = view.intent;
      const accountName = intent.type === 'account-model' ? intent.account : '';
      const inheriting =
        inventory?.accounts.filter(
          (account) =>
            account.ownList.status === 'known' &&
            !(account.ownList.rules ?? []).some((rule) => rule.trim())
        ).length ?? 0;
      title = t('model_access.choose_title');
      body = (
        <div className={styles.planBody}>
          <p>{t('model_access.choose_body', { account: labelOf(accountName) })}</p>
          <div className={styles.choiceGrid}>
            <button
              type="button"
              className={styles.choice}
              onClick={() => props.onChoose('provider')}
            >
              <strong>{t('model_access.choose_provider')}</strong>
              <span>{t('model_access.choose_provider_desc', { count: inheriting })}</span>
            </button>
            <button type="button" className={styles.choice} onClick={() => props.onChoose('own')}>
              <strong>{t('model_access.choose_own')}</strong>
              <span>{t('model_access.choose_own_desc')}</span>
            </button>
          </div>
        </div>
      );
      footer = (
        <Button variant="secondary" onClick={props.onClose}>
          {t('common.cancel')}
        </Button>
      );
      break;
    }
    case 'previewing':
      title = t('model_access.preview_title');
      body = renderPlan(view.plan);
      footer = (
        <>
          <Button variant="secondary" onClick={props.onClose}>
            {t('common.cancel')}
          </Button>
          <Button
            onClick={props.onApply}
            disabled={!view.plan.canApply}
            data-testid="write-plan-apply"
          >
            {t('model_access.apply', { count: view.plan.writes.length })}
          </Button>
        </>
      );
      break;
    case 'saving':
    case 'rolling-back':
      title =
        view.status === 'saving'
          ? t('model_access.saving_title')
          : t('model_access.rolling_back_title');
      body = <p role="status">{t('model_access.saving_body')}</p>;
      footer = null;
      break;
    case 'saved':
      title = t('model_access.saved_title');
      body = (
        <div className={styles.planBody}>
          <p>{t('model_access.saved_body')}</p>
          {renderOutcomes(view.outcomes)}
          {renderRefresh(view)}
        </div>
      );
      footer = (
        <>
          {close}
          {refreshButton(view)}
        </>
      );
      break;
    case 'partial-failure':
    case 'failed': {
      const rollingBack = view.operation === 'rollback';
      const retryLabel = rollingBack ? t('model_access.rollback_retry') : t('model_access.retry');
      title = rollingBack
        ? view.status === 'failed'
          ? t('model_access.rollback_failed_title')
          : t('model_access.rollback_partial_title')
        : view.status === 'failed'
          ? t('model_access.failed_title')
          : t('model_access.partial_title');
      // `failed` while applying: nothing of this change is on the hub. Anything else names what is.
      const explanation = rollingBack
        ? view.status === 'failed'
          ? t('model_access.rollback_failed_body')
          : t('model_access.rollback_partial_body')
        : view.status === 'failed'
          ? view.message
            ? null
            : t('model_access.failed_body')
          : t('model_access.partial_body');
      body = (
        <div className={styles.planBody}>
          {view.message && (
            <p role="alert">{t('model_access.failed_read', { message: view.message })}</p>
          )}
          {explanation && <p role={view.message ? undefined : 'alert'}>{explanation}</p>}
          {rollingBack
            ? renderUndo(view)
            : view.outcomes.length > 0 && renderOutcomes(view.outcomes)}
          {renderRefresh(view)}
        </div>
      );
      footer = (
        <>
          {close}
          {!rollingBack && view.status === 'partial-failure' && (
            <Button
              variant="secondary"
              onClick={props.onRollback}
              data-testid="write-plan-rollback"
            >
              {t('model_access.rollback')}
            </Button>
          )}
          <Button onClick={props.onRetry} data-testid="write-plan-retry">
            {retryLabel}
          </Button>
        </>
      );
      break;
    }
    case 'stale': {
      const rollingBack = view.operation === 'rollback';
      const written = !rollingBack && landed(view.outcomes);
      title = t('model_access.stale_title');
      body = (
        <div className={styles.planBody}>
          <p role="alert">
            {rollingBack
              ? t('model_access.stale_rollback_body')
              : written
                ? t('model_access.stale_partial_body')
                : t('model_access.stale_body')}
          </p>
          {renderStale(view.stale)}
          {rollingBack ? renderUndo(view) : written && renderOutcomes(view.outcomes)}
          {renderRefresh(view)}
        </div>
      );
      // A stale rollback is not replanned: its intent is the change the user was undoing.
      footer = rollingBack ? (
        <>
          {close}
          {refreshButton(view)}
        </>
      ) : (
        <>
          {written ? (
            close
          ) : (
            <Button variant="secondary" onClick={props.onClose}>
              {t('common.cancel')}
            </Button>
          )}
          <Button onClick={props.onReplan} data-testid="write-plan-replan">
            {t('model_access.replan')}
          </Button>
        </>
      );
      break;
    }
    case 'rolled-back':
      title = t('model_access.rolled_back_title');
      body = (
        <div className={styles.planBody}>
          <p>{t('model_access.rolled_back_body')}</p>
          {renderUndo(view)}
          {renderRefresh(view)}
        </div>
      );
      footer = (
        <>
          {close}
          {refreshButton(view)}
        </>
      );
      break;
    default: {
      const unreachable: never = view;
      return unreachable;
    }
  }

  const busy = session.status === 'saving' || session.status === 'rolling-back';
  return (
    <Modal
      open={session.status !== 'idle'}
      title={title}
      onClose={props.onClose}
      footer={footer}
      closeDisabled={busy}
      width={640}
    >
      <div data-machine="model-edit-session" data-state={session.status}>
        {body}
      </div>
    </Modal>
  );
}
