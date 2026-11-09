import { useCallback, useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuthFilesSource } from '@/features/authFiles/AuthFilesSourceContext';
import { OAuthModelAliasCard } from '@/features/authFiles/components/OAuthModelAliasCard';
import { useAuthFilesOauth } from '@/features/authFiles/hooks/useAuthFilesOauth';
import { useSourceFiles } from '@/stores/useCredentialInventoryStore';
import type { AuthFileItem } from '@/types';

const NO_FILES: AuthFileItem[] = [];

/** The alias overview (list or diagram, with inline edits) for this source; full edits open the editor. */
export function ModelAliasesPanel({ provider, disabled }: { provider: string; disabled: boolean }) {
  const scope = useAuthFilesSource();
  const navigate = useNavigate();
  const files = useSourceFiles(scope.session.owner) ?? NO_FILES;
  const [viewMode, setViewMode] = useState<'list' | 'diagram'>('list');
  const oauth = useAuthFilesOauth({ viewMode, files });
  const { loadExcluded, loadModelAlias } = oauth;

  useEffect(() => {
    // The alias handlers check the excluded list too, so both must be loaded before any edit.
    void loadExcluded();
    void loadModelAlias();
  }, [loadExcluded, loadModelAlias]);

  const openEditor = useCallback(
    (target?: string) => {
      const params = new URLSearchParams({ source: scope.source.instanceId });
      const value = (target || provider).trim();
      if (value) params.set('provider', value);
      navigate(`/auth-files/oauth-model-alias?${params.toString()}`, {
        state: { fromAuthFiles: true, sourceOwner: scope.session.owner },
      });
    },
    [navigate, provider, scope]
  );

  return (
    <div data-machine="oauth-config" data-state={oauth.modelAliasError ?? 'ready'}>
      <OAuthModelAliasCard
        disableControls={disabled || !scope.isCurrent()}
        viewMode={viewMode}
        onViewModeChange={setViewMode}
        onRetry={loadModelAlias}
        onAdd={() => openEditor()}
        onEditProvider={openEditor}
        onDeleteProvider={oauth.deleteModelAlias}
        modelAliasError={oauth.modelAliasError}
        modelAlias={oauth.modelAlias}
        allProviderModels={oauth.allProviderModels}
        onUpdate={oauth.handleMappingUpdate}
        onDeleteLink={oauth.handleDeleteLink}
        onToggleFork={oauth.handleToggleFork}
        onRenameAlias={oauth.handleRenameAlias}
        onDeleteAlias={oauth.handleDeleteAlias}
      />
    </div>
  );
}
