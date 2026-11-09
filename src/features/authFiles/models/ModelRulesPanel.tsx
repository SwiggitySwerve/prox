import { useEffect, useId, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/Button';
import { Select } from '@/components/ui/Select';
import { ExcludedModelsPicker } from '@/components/excludedModels';
import {
  modelUnion,
  sameRuleSet,
  type ListTarget,
  type ModelAccessInventory,
} from '@/features/authFiles/modelAccess';
import { accountListKind, targetOfListKey } from './matrixView';
import styles from './ModelsPage.module.scss';

type Props = {
  inventory: ModelAccessInventory;
  /** `provider` or `account:<file name>`. */
  listKey: string;
  onListKeyChange: (key: string) => void;
  disabled: boolean;
  onReview: (target: ListTarget, rules: string[]) => void;
};

/** Edit one exclusion list as text rules (wildcards included); saving goes through the preview. */
export function ModelRulesPanel({
  inventory,
  listKey,
  onListKeyChange,
  disabled,
  onReview,
}: Props) {
  const { t } = useTranslation();
  const labelId = `${useId()}-rules-label`;
  const target = targetOfListKey(listKey);
  const account =
    target.kind === 'account' ? inventory.accounts.find((item) => item.name === target.name) : null;
  const saved = useMemo(
    () =>
      target.kind === 'provider'
        ? inventory.providerList
        : account?.ownList.status === 'known'
          ? (account.ownList.rules ?? [])
          : [],
    [account, inventory.providerList, target.kind]
  );
  const [draft, setDraft] = useState<string[]>(saved);
  useEffect(() => setDraft(saved), [saved]);

  const ownListAccounts = inventory.accounts.filter((item) => accountListKind(item) === 'own');
  const options = [
    {
      value: 'provider',
      label: t('model_access.target_provider', { provider: inventory.provider }),
    },
    ...inventory.accounts.map((item) => ({
      value: `account:${item.name}`,
      label: t(
        accountListKind(item) === 'own'
          ? 'model_access.rules_option_own'
          : 'model_access.rules_option_inherits',
        { account: item.label }
      ),
    })),
  ];
  const candidates = useMemo(() => modelUnion(inventory).map((id) => ({ id })), [inventory]);
  const dirty = !sameRuleSet(draft, saved);
  const unreadable = account && account.ownList.status !== 'known';

  return (
    <section className={styles.rulesPanel} aria-labelledby={labelId}>
      <div className={styles.rulesHeader}>
        <h2 id={labelId}>{t('model_access.rules_title')}</h2>
        <Select
          value={listKey}
          options={options}
          onChange={onListKeyChange}
          ariaLabel={t('model_access.rules_list_label')}
          size="sm"
        />
      </div>
      <p
        className={styles.banner}
        data-tone={target.kind === 'provider' && ownListAccounts.length ? 'warning' : 'info'}
      >
        {target.kind === 'provider'
          ? ownListAccounts.length > 0
            ? t('model_access.rules_banner_ignored', {
                accounts: ownListAccounts.map((item) => item.label).join(', '),
              })
            : t('model_access.rules_banner_all_follow')
          : account && accountListKind(account) === 'own'
            ? t('model_access.rules_banner_own')
            : t('model_access.rules_account_none')}
      </p>
      {unreadable ? (
        <p className={styles.banner} data-tone="danger" role="alert">
          {t('model_access.notice_unreadable', { accounts: account.label })}
        </p>
      ) : (
        <ExcludedModelsPicker
          value={draft}
          onChange={setDraft}
          candidates={candidates}
          catalogState="ready"
          disabled={disabled}
          labelledBy={labelId}
        />
      )}
      <div className={styles.rulesActions}>
        <Button
          variant="secondary"
          size="sm"
          disabled={!dirty || disabled}
          onClick={() => setDraft(saved)}
        >
          {t('model_access.rules_reset')}
        </Button>
        <Button
          size="sm"
          disabled={!dirty || disabled || Boolean(unreadable)}
          onClick={() => onReview(target, draft)}
          data-testid="rules-review"
        >
          {t('model_access.rules_save')}
        </Button>
      </div>
    </section>
  );
}
