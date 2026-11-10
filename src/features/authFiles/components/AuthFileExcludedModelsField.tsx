import { useAuthFilesSource } from '../AuthFilesSourceContext';
import { useEffect, type MouseEvent, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { accountRefOf, IDLE_LOAD, loadData } from '@/features/authFiles/modelAccess';
import { modelAccess } from '@/features/authFiles/modelAccessRuntime';
import { modelsScreenPath } from '@/features/authFiles/unifiedList';
import { useSourceModelAccess } from '@/stores/useModelAccessStore';
import { useSourceFiles } from '@/stores/useCredentialInventoryStore';
import styles from './AuthFileDetailsSheet.module.scss';

/** Up to this many rules are listed by name; more are only counted. */
const LISTED_RULES = 6;

interface AuthFileExcludedModelsFieldProps {
  fileName: string;
  /** Normalized provider key of the credential: selects the provider list. */
  providerKey: string;
  /** Leaves the sheet for the Models screen (the sheet confirms unsaved edits first). */
  onNavigate: (path: string) => void;
}

/**
 * The credential's exclusion list, read-only. It has one editor, the Models screen's Rules tab
 * (preview, stale check, rollback); this summary reads the same model-access store slices.
 */
export function AuthFileExcludedModelsField({
  fileName,
  providerKey,
  onNavigate,
}: AuthFileExcludedModelsFieldProps) {
  const { source, session } = useAuthFilesSource();
  const owner = session.owner;
  const { t } = useTranslation();
  const access = useSourceModelAccess(owner);
  const file = useSourceFiles(owner)?.find((item) => item.name === fileName);

  useEffect(() => {
    const store = modelAccess();
    void store.ensureConfig(owner);
    if (file) void store.ensureAccounts(owner, [accountRefOf(file)]);
  }, [file, owner]);

  const ownList = access?.accountLists[fileName] ?? IDLE_LOAD;
  const rules = loadData(ownList);
  const providerRules = loadData(access?.providerLists ?? IDLE_LOAD)?.[providerKey];
  const path = modelsScreenPath(source.instanceId, providerKey, fileName);
  const handleClick = (event: MouseEvent<HTMLAnchorElement>) => {
    event.preventDefault();
    onNavigate(path);
  };

  let summary: ReactNode;
  if (rules === null && ownList.status !== 'ready') {
    summary = (
      <p className="hint" role={ownList.status === 'error' ? 'alert' : 'status'}>
        {ownList.status === 'error'
          ? t('auth_files.excluded_models_error')
          : t('auth_files.excluded_models_loading')}
      </p>
    );
  } else if (!rules || rules.length === 0) {
    summary = (
      <p className={styles.listSummary} data-list="inherits">
        {providerRules
          ? t('auth_files.excluded_models_follows', { count: providerRules.length })
          : t('auth_files.excluded_models_follows_plain')}
      </p>
    );
  } else {
    summary = (
      <div className={styles.listSummary} data-list="own">
        <p>{t('auth_files.excluded_models_own', { count: rules.length })}</p>
        {rules.length <= LISTED_RULES && (
          <ul className={styles.ruleList}>
            {rules.map((rule) => (
              <li key={rule}>
                <code>{rule}</code>
              </li>
            ))}
          </ul>
        )}
      </div>
    );
  }

  return (
    <div className="form-group">
      <h3 className={styles.fieldLabel}>{t('auth_files.excluded_models_label')}</h3>
      {summary}
      <Link
        className={styles.settingsLink}
        to={path}
        state={{ fromAuthFiles: true, sourceOwner: owner }}
        onClick={handleClick}
      >
        {t('auth_files.edit_in_models')}
      </Link>
    </div>
  );
}
