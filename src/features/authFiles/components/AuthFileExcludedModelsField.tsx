import { useAuthFilesSource } from '../AuthFilesSourceContext';
import { useEffect, useId, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import {
  ExcludedModelsPicker,
  formatExcludedRulesText,
  parseExcludedRulesText,
  type ExcludedModelsCatalogState,
} from '@/components/excludedModels';
import { IDLE_LOAD, loadData } from '@/features/authFiles/modelAccess';
import { modelAccess } from '@/features/authFiles/modelAccessRuntime';
import { useSourceModelAccess } from '@/stores/useModelAccessStore';

interface AuthFileExcludedModelsFieldProps {
  fileName: string;
  /** Normalized provider key of the credential: selects the catalog and the provider list. */
  providerKey: string;
  /** 换行分隔的规则文本——凭证编辑器的 dirty diff 依赖这个形状，不要改成数组。 */
  value: string;
  disabled: boolean;
  onChange: (value: string) => void;
}

/**
 * The credential's own exclusion list. Candidates come from the shared model-access store: the
 * provider's catalog plus what the hub reports for this credential. The reported list alone is
 * already filtered by the exclusions, so it cannot offer the models to re-enable.
 */
export function AuthFileExcludedModelsField({
  fileName,
  providerKey,
  value,
  disabled,
  onChange,
}: AuthFileExcludedModelsFieldProps) {
  const { session } = useAuthFilesSource();
  const owner = session.owner;
  const { t } = useTranslation();
  // 凭证文件名可能含点/斜杠等字符，不适合直接当 HTML id。
  const labelId = `${useId()}-excluded-models-label`;
  const access = useSourceModelAccess(owner);

  useEffect(() => {
    const store = modelAccess();
    void store.ensureConfig(owner);
    void store.ensureCatalog(owner, providerKey);
    void store.ensureAccountModels(owner, fileName);
  }, [fileName, owner, providerKey]);

  const catalog = access?.catalogs[providerKey] ?? IDLE_LOAD;
  const reported = access?.accountModels[fileName] ?? IDLE_LOAD;
  const rules = useMemo(() => parseExcludedRulesText(value), [value]);
  const candidates = useMemo(() => {
    const byId = new Map<string, { id: string; displayName?: string }>();
    [...(loadData(catalog) ?? []), ...(loadData(reported) ?? [])].forEach((item) => {
      const id = item.id?.trim();
      if (id && !byId.has(id.toLowerCase())) {
        byId.set(id.toLowerCase(), { id, displayName: item.display_name });
      }
    });
    // 已配置但目录里没有的精确规则也塞进候选，否则它们会在列表里凭空消失。
    rules.forEach((rule) => {
      if (!rule.includes('*') && !byId.has(rule.toLowerCase())) {
        byId.set(rule.toLowerCase(), { id: rule });
      }
    });
    return [...byId.values()].sort((left, right) =>
      left.id.localeCompare(right.id, undefined, { sensitivity: 'base' })
    );
  }, [catalog, reported, rules]);

  const settled = (status: string) => status === 'ready' || status === 'error';
  const catalogState: ExcludedModelsCatalogState =
    !settled(catalog.status) && !settled(reported.status) && candidates.length === 0
      ? 'loading'
      : catalog.status === 'error' && reported.status === 'error'
        ? 'error'
        : 'ready';
  const providerRules = loadData(access?.providerLists ?? IDLE_LOAD)?.[providerKey]?.length ?? 0;

  return (
    <div className="form-group">
      <label id={labelId}>{t('auth_files.excluded_models_label')}</label>
      <ExcludedModelsPicker
        value={rules}
        onChange={(next) => onChange(formatExcludedRulesText(next))}
        candidates={candidates}
        catalogState={catalogState}
        disabled={disabled}
        labelledBy={labelId}
      />
      <div className="hint" data-list={rules.length > 0 ? 'own' : 'inherits'}>
        {rules.length > 0
          ? t('auth_files.excluded_models_own_hint', { count: providerRules })
          : t('auth_files.excluded_models_inherit_hint', { count: providerRules })}
      </div>
    </div>
  );
}
