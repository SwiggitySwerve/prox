import { describe, expect, test } from 'bun:test';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const root = join(import.meta.dir, '..');
const read = (path: string) => readFileSync(join(root, path), 'utf8');
function sources(directory: string): string[] {
  return readdirSync(join(root, directory)).flatMap((name) => {
    const path = join(directory, name);
    if (statSync(join(root, path)).isDirectory()) return sources(path);
    return /\.(ts|tsx)$/.test(name) ? [path] : [];
  });
}

/** Every screen that shows credential metadata, and the store API it must read through. */
const SCREENS: Record<string, string[]> = {
  'src/features/authFiles/hooks/useAuthFilesData.ts': ['selectSourceFiles', 'refresh()'],
  'src/features/quota/QuotaPage.tsx': ['selectSourceFiles', 'refresh()'],
  'src/features/quotaPool/PoolAccountResets.tsx': ['useSourceFiles', 'ensureLoaded'],
  'src/features/dashboard/hooks/useDashboardOverview.ts': ['useSourceFiles', 'ensureLoaded'],
  'src/components/layout/MainLayout.tsx': ['selectSourceFiles', 'startCredentialInventory'],
  'src/pages/AuthFilesOAuthExcludedEditPage.tsx': ['useSourceFiles', 'ensureLoaded'],
  'src/pages/AuthFilesOAuthModelAliasEditPage.tsx': ['useSourceFiles', 'ensureLoaded'],
};

describe('metadata screens read the one credential inventory store', () => {
  for (const [path, uses] of Object.entries(SCREENS)) {
    test(`${path} reads the store and lists no credentials itself`, () => {
      const text = read(path);
      expect(text).toContain('useCredentialInventoryStore');
      for (const needle of uses) expect(text).toContain(needle);
      expect(text).not.toMatch(/\bauthFilesApi\s*\.\s*list\s*\(/);
      expect(text).not.toMatch(/createAuthFilesApi\([^)]*\)\s*\.\s*list\s*\(/);
      expect(text).not.toContain('AUTH_FILES_CHANGED_EVENT');
    });
  }

  test('only the store runtime lists credential files from a source', () => {
    const callers = sources('src')
      .filter((path) =>
        /createAuthFilesApi\([^)]*\)\s*\.list\(|authFilesApi\s*\.list\(/.test(read(path))
      )
      .map((path) => relative(root, join(root, path)));
    // SiwcBindDialog lists once when its modal opens, to offer binding targets: a transient
    // dialog, not a metadata screen.
    expect(callers.sort()).toEqual([
      'src/features/authFiles/credentialInventoryRuntime.ts',
      'src/features/oauth/components/SiwcBindDialog.tsx',
    ]);
  });

  test('there is exactly one poller, hosted by the app shell', () => {
    const starters = sources('src').filter((path) =>
      /startCredentialInventory\(\)/.test(read(path))
    );
    expect(starters.sort()).toEqual([
      'src/components/layout/MainLayout.tsx',
      'src/features/authFiles/credentialInventoryRuntime.ts',
    ]);
    const polling = sources('src').filter((path) => /\.startPolling\(\)/.test(read(path)));
    expect(polling).toEqual(['src/features/authFiles/credentialInventoryRuntime.ts']);
  });
});

describe('every add and remove path announces itself', () => {
  const callers: Record<string, number> = {
    'src/features/oauth/hooks/useOAuthFlows.ts': 1,
    'src/features/oauth/components/SiwcBindDialog.tsx': 1,
    'src/features/oauth/hooks/useVertexImport.ts': 1,
    'src/features/authFiles/hooks/useAuthFilesPrefixProxyEditor.ts': 1,
    // upload, single delete, filtered delete, manual refresh, refresh-all, batch delete
    'src/features/authFiles/hooks/useAuthFilesData.ts': 6,
  };
  for (const [path, count] of Object.entries(callers)) {
    test(`${path} calls notifyAuthFilesChanged ${count}x`, () => {
      expect(read(path).match(/notifyAuthFilesChanged\(/g)).toHaveLength(count);
    });
  }

  test('deletes name what they deleted, so the server can purge it at once', () => {
    const text = read('src/features/authFiles/hooks/useAuthFilesData.ts');
    expect(text.match(/reason: 'delete'/g)).toHaveLength(3);
    expect(text.match(/deletedNames/g)!.length).toBeGreaterThanOrEqual(6);
  });

  test('delete-all is wired in through the source API', () => {
    const text = read('src/services/api/authFiles.ts');
    expect(text).toMatch(
      /deleteAll: async \(\) => \{[\s\S]*?notifyAuthFilesChanged\(session\.owner/
    );
  });
});

describe('AI Providers does not depend on credential files', () => {
  test('no provider screen imports the inventory store, its events or the credential endpoints', () => {
    const offenders = [
      ...sources('src/features/providers'),
      ...sources('src/components/providers'),
    ].filter((path) =>
      /useCredentialInventoryStore|authFilesEvents|notifyAuthFilesChanged|['"`]\/credentials/.test(
        read(path)
      )
    );
    expect(offenders).toEqual([]);
  });
});
