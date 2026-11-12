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

  test('re-reads the credential list, then loads quota for the refreshed list, with no dialog or toast', () => {
    expect(handler).toContain('await rereadList()');
    expect(handler).toContain('requestQuota(list ?? undefined)');
    expect(handler.indexOf('await rereadList()')).toBeLessThan(handler.indexOf('requestQuota('));
    expect(handler).toContain('setRefreshingGroup(true)');
    expect(handler).toContain('setRefreshingGroup(false)');
    expect(handler).not.toContain('showConfirmation');
    expect(handler).not.toContain('showNotification');
    // targets come from the returned list, never from state or a ref captured before the re-read
    expect(handler).not.toContain('quotaTargets');
    expect(handler).not.toContain('quotaInputsRef');
    // every card the filters show, on every page (not only the page on screen)
    expect(source).toContain('quotaRefreshTargets(sorted, activeQuotaFilter)');
    expect(source).toContain('quotaTargetsShown(list, inputs.filters, inputs.activeQuotaFilter)');
    // each hub proves the key with one request before the rest (authGate.ts)
    expect(handler).toContain('providerSources.armAuthProbes()');
  });

  test('the header refresh lists from the round’s one read, then refreshes this group’s quota', () => {
    const header = source.split('const handleHeaderRefresh = ')[1]?.split('\n  );')[0] ?? '';
    expect(header).toContain('loadFiles({ background: true, inventory: round.inventory })');
    expect(header).toContain('await requestQuota(list ?? undefined)');
  });

  test('the group Refresh and the page-wide Refresh quota share one runner that never drops a call', () => {
    expect(source).toContain('createCoalescingRunner<AuthFileItem[]>');
    expect(source).toContain('requestQuota(undefined, onSettled)');
    // the batch loader (which drops overlapping calls) is only reached from inside that runner
    expect(source.split('await loadQuota(').length).toBe(2);
    expect(source).not.toContain('Promise.allSettled([handleHeaderRefresh(), runQuotaRefresh');
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
