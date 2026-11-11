import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/Button';
import type { DraftSave } from '@/features/authFiles/hooks/useAccessDraft';
import type {
  AccessBlock,
  AccessChange,
  AccessPlan,
  AccountAccess,
  ListTarget,
} from '@/features/authFiles/modelAccess';
import { followsProviderList } from '@/features/authFiles/modelAccess';
import { summarizeChanges } from './matrixView';
import styles from './ModelsPage.module.scss';

type Props = {
  accounts: readonly AccountAccess[];
  changes: readonly AccessChange[];
  plan: AccessPlan;
  save: DraftSave;
  onSave: () => void;
  onDiscard: () => void;
};

/** What the bar shows, for `data-state`: the staged switches first, then the last Save. */
function draftState(changes: readonly AccessChange[], plan: AccessPlan, save: DraftSave) {
  if (save.status === 'saving') return 'saving';
  if (save.status !== 'idle') return save.status;
  if (changes.length === 0) return 'idle';
  return plan.status === 'blocked' ? 'blocked' : 'pending';
}

/**
 * Sticky at the bottom of the hub section: the staged switches in plain words, with Save and
 * Discard. No dialog: the result of a Save (or why it cannot be saved) is shown here.
 */
export function AccessSaveBar({ accounts, changes, plan, save, onSave, onDiscard }: Props) {
  const { t } = useTranslation();
  const state = draftState(changes, plan, save);
  const labelOf = (name: string) => accounts.find((item) => item.name === name)?.label ?? name;
  const names = (list: readonly string[]) => list.map(labelOf).join(', ');

  const accountsText = (list: readonly string[]) =>
    list.length === 1
      ? labelOf(list[0])
      : list.length === accounts.length
        ? t('model_access.bar_all_accounts', { count: list.length })
        : t('model_access.bar_accounts', { count: list.length });
  const modelsText = (list: readonly string[]) =>
    list.length === 1 ? list[0] : t('model_access.bar_models', { count: list.length });

  const blockText = (block: AccessBlock) =>
    block.code === 'unreadable'
      ? t('model_access.bar_block_unreadable', { accounts: names(block.accounts) })
      : block.code === 'runtime-differ'
        ? t('model_access.bar_block_runtime_differ', { accounts: names(block.accounts) })
        : t('model_access.bar_block_all_on', {
            account: labelOf(block.account),
            runtime: names(block.runtime),
          });

  /** Who a failed write was for: one account, or every account that follows the provider list. */
  const targetText = (target: ListTarget) => {
    if (target.kind === 'account') return labelOf(target.name);
    const sharing = accounts.filter(
      (item) =>
        item.kind === 'runtime' ||
        (item.ownList.status === 'known' && followsProviderList(item.ownList.rules))
    );
    return t('model_access.bar_shared_target', { count: sharing.length });
  };

  if (state === 'idle') return null;

  const groups = summarizeChanges(changes);
  const expansions = plan.status === 'ready' ? plan.expansions : [];

  return (
    <section
      className={styles.saveBar}
      aria-label={t('model_access.bar_label')}
      data-machine="model-access-draft"
      data-state={state}
      data-testid="access-save-bar"
    >
      <div className={styles.saveBarText}>
        {groups.length > 0 && (
          <ul className={styles.changeLines} data-testid="access-changes">
            {groups.map((group) => (
              <li key={`${group.on}:${group.accounts.join('|')}:${group.models.join('|')}`}>
                <span className={styles.changeDot} data-on={group.on} aria-hidden="true" />
                {t(group.on ? 'model_access.bar_change_on' : 'model_access.bar_change_off', {
                  models: modelsText(group.models),
                  accounts: accountsText(group.accounts),
                })}
              </li>
            ))}
          </ul>
        )}
        {expansions.map((item) => (
          <p
            key={`${item.target.kind}:${item.rule}:${'name' in item.target ? item.target.name : ''}`}
            className={styles.saveNote}
          >
            {item.replacedBy.length > 0
              ? t('model_access.bar_expansion', {
                  rule: item.rule,
                  models: item.replacedBy.join(', '),
                  unblocked: item.unblocked.join(', '),
                })
              : t('model_access.bar_expansion_removed', {
                  rule: item.rule,
                  unblocked: item.unblocked.join(', '),
                })}
          </p>
        ))}
        {state === 'blocked' && plan.status === 'blocked' && (
          <p className={styles.saveNote} data-tone="danger" role="alert">
            {blockText(plan.block)}
          </p>
        )}
        <p className={styles.saveNote} role="status" data-tone={toneOf(state)}>
          {save.status === 'saving'
            ? t('model_access.bar_saving')
            : save.status === 'saved'
              ? t('model_access.bar_saved')
              : save.status === 'stale'
                ? t('model_access.bar_stale')
                : save.status === 'error'
                  ? t('model_access.bar_error', { message: save.message })
                  : save.status === 'failed'
                    ? t('model_access.bar_failed', { count: save.failures.length })
                    : ''}
        </p>
        {save.status === 'failed' && (
          <ul className={styles.failureLines}>
            {save.failures.map((failure) => (
              <li
                key={`${failure.target.kind}:${'name' in failure.target ? failure.target.name : ''}`}
              >
                {t('model_access.bar_failed_item', {
                  target: targetText(failure.target),
                  message: failure.message,
                })}
              </li>
            ))}
          </ul>
        )}
      </div>
      <div className={styles.saveBarActions}>
        {changes.length > 0 ? (
          <>
            <Button
              size="sm"
              variant="secondary"
              onClick={onDiscard}
              disabled={state === 'saving'}
              data-testid="access-discard"
            >
              {t('model_access.bar_discard')}
            </Button>
            <Button
              size="sm"
              onClick={onSave}
              disabled={plan.status !== 'ready' || state === 'saving'}
              loading={state === 'saving'}
              data-testid="access-save"
            >
              {t('model_access.bar_save')}
            </Button>
          </>
        ) : (
          state !== 'saving' && (
            <Button size="sm" variant="secondary" onClick={onDiscard} data-testid="access-dismiss">
              {t('common.close')}
            </Button>
          )
        )}
      </div>
    </section>
  );
}

const toneOf = (state: string) =>
  state === 'saved'
    ? 'success'
    : state === 'failed' || state === 'error' || state === 'stale'
      ? 'danger'
      : undefined;
