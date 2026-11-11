import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// The group header cannot be rendered under Bun (CSS-module classes bind at import), so the
// contract is read from source, the way tests/authFilesCardAndSearch.test.ts does for the card.
const source = readFileSync('src/features/authFiles/AuthFilesSourceContent.tsx', 'utf8');
const actions = source.split('<div className={styles.groupActions}>')[1].split('</header>')[0];
const refreshButton = actions.split('<Button')[1];
const menu = actions.split('<GroupMenu')[1];
const handler = source.split('const handleGroupRefresh = ')[1]?.split('\n  }, [')[0] ?? '';

describe('group Refresh button', () => {
  test('is one click: it runs the group refresh, not the confirmed server-side token refresh', () => {
    expect(refreshButton).toContain('data-testid="auth-files-group-refresh"');
    expect(refreshButton).toContain('onClick={handleGroupRefresh}');
    expect(refreshButton).not.toContain('handleRefreshAllCredentials');
    expect(refreshButton).toContain('loading={refreshingGroup}');
    expect(refreshButton).toContain("t('auth_files.refresh_group_title')");
    expect(refreshButton).toContain("t('auth_files.refresh_all_short')");
  });

  test('re-reads the credential list and loads quota for the quotaTargets, with no dialog or toast', () => {
    expect(handler).toContain('handleHeaderRefresh()');
    expect(handler).toContain('runQuotaRefresh(');
    expect(handler).toContain('setRefreshingGroup(true)');
    expect(handler).toContain('setRefreshingGroup(false)');
    expect(handler).not.toContain('showConfirmation');
    expect(handler).not.toContain('showNotification');
    expect(source).toContain('quotaRefreshTargets(pageItems, activeQuotaFilter)');
  });

  test('the server-side token refresh is only in the overflow menu, behind its confirmation', () => {
    expect(menu).toContain("key: 'refresh-tokens'");
    expect(menu).toContain('run: handleRefreshAllCredentials');
    expect(menu).toContain("t('auth_files.refresh_tokens_menu')");
    const hook = readFileSync('src/features/authFiles/hooks/useAuthFilesData.ts', 'utf8');
    expect(hook.split('const handleRefreshAllCredentials')[1].split('onConfirm')[0]).toContain(
      'showConfirmation({'
    );
  });

  test('the filter-bar button keeps its test id', () => {
    const toolbar = readFileSync(
      join('src/features/authFiles/components/AuthFilesToolbar.tsx'),
      'utf8'
    );
    expect(toolbar).toContain('data-testid="auth-files-refresh-quota"');
  });
});
