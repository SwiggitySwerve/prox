import { useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/Button';
import { Modal } from '@/components/ui/Modal';
import type {
  EditSession,
  ListTarget,
  ListWrite,
  ModelAccessInventory,
  PlanNotice,
  WriteOutcome,
  WritePlan,
} from '@/features/authFiles/modelAccess';
import type { LockedCellInfo } from './ModelAccessMatrix';
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
  const labelOf = (name: string) =>
    inventory?.accounts.find((account) => account.name === name)?.label ?? name;
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
      case 'still-served-by':
        return t('model_access.notice_still_served_by', {
          model: notice.model,
          accounts: names(notice.accounts),
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
          <li key={targetLabel(write.target)}>
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
              <li key={targetLabel(item.target)}>
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

  const renderOutcomes = (outcomes: WriteOutcome[]) => (
    <ul className={styles.writeList}>
      {outcomes.map((outcome) => (
        <li key={targetLabel(outcome.write.target)} data-outcome={outcome.status}>
          <strong>{targetLabel(outcome.write.target)}</strong>
          <span className={outcome.status === 'ok' ? styles.diffAdded : styles.diffRemoved}>
            {outcome.status === 'ok'
              ? t('model_access.outcome_ok')
              : t('model_access.outcome_failed', { message: outcome.message })}
          </span>
        </li>
      ))}
    </ul>
  );

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
        </div>
      );
      footer = close;
      break;
    case 'partial-failure':
      title = view.rollback
        ? t('model_access.rollback_partial_title')
        : t('model_access.partial_title');
      body = (
        <div className={styles.planBody}>
          <p role="alert">{t('model_access.partial_body')}</p>
          {renderOutcomes(view.outcomes)}
        </div>
      );
      footer = (
        <>
          {close}
          {!view.rollback && (
            <Button
              variant="secondary"
              onClick={props.onRollback}
              data-testid="write-plan-rollback"
            >
              {t('model_access.rollback')}
            </Button>
          )}
          <Button onClick={props.onRetry} data-testid="write-plan-retry">
            {t('model_access.retry')}
          </Button>
        </>
      );
      break;
    case 'failed':
      title = t('model_access.failed_title');
      body = (
        <div className={styles.planBody}>
          <p role="alert">
            {view.message
              ? t('model_access.failed_read', { message: view.message })
              : t('model_access.failed_body')}
          </p>
          {view.outcomes.length > 0 && renderOutcomes(view.outcomes)}
        </div>
      );
      footer = (
        <>
          {close}
          <Button onClick={props.onRetry} data-testid="write-plan-retry">
            {t('model_access.retry')}
          </Button>
        </>
      );
      break;
    case 'stale':
      title = t('model_access.stale_title');
      body = (
        <div className={styles.planBody}>
          <p role="alert">{t('model_access.stale_body')}</p>
          <ul className={styles.writeList}>
            {view.stale.map((item) => (
              <li key={targetLabel(item.target)}>
                {t('model_access.stale_item', {
                  target: targetLabel(item.target),
                  rules: (item.actual ?? []).join(', ') || t('model_access.none'),
                })}
              </li>
            ))}
          </ul>
        </div>
      );
      footer = (
        <>
          <Button variant="secondary" onClick={props.onClose}>
            {t('common.cancel')}
          </Button>
          <Button onClick={props.onReplan} data-testid="write-plan-replan">
            {t('model_access.replan')}
          </Button>
        </>
      );
      break;
    case 'rolled-back':
      title = t('model_access.rolled_back_title');
      body = (
        <div className={styles.planBody}>
          <p>{t('model_access.rolled_back_body')}</p>
          {renderOutcomes(view.outcomes)}
        </div>
      );
      footer = close;
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

export function LockedCellDialog(props: {
  info: LockedCellInfo | null;
  onClose: () => void;
  onEditRule: (info: LockedCellInfo) => void;
}) {
  const { t } = useTranslation();
  const [shown, setShown] = useState<LockedCellInfo | null>(props.info);
  if (props.info && props.info !== shown) setShown(props.info);
  const info = props.info ?? shown;
  if (!info) return null;
  return (
    <Modal
      open={props.info !== null}
      title={t('model_access.locked_title')}
      onClose={props.onClose}
      footer={
        <>
          <Button variant="secondary" onClick={props.onClose}>
            {t('common.close')}
          </Button>
          <Button onClick={() => props.onEditRule(info)} data-testid="locked-edit-rule">
            {t('model_access.edit_rule')}
          </Button>
        </>
      }
    >
      <p data-machine="locked-cell" data-state={props.info ? 'open' : 'closed'}>
        {t('model_access.locked_body', {
          model: info.model,
          account: info.account,
          rule: info.rule,
          list: t(
            info.list === 'provider' ? 'model_access.list_provider' : 'model_access.list_account'
          ),
        })}
      </p>
    </Modal>
  );
}
