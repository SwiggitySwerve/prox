import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import ts from 'typescript';
import { getAuthFileRefreshKey } from '../src/features/authFiles/manualRefresh';
import { quotaRefreshTargets } from '../src/features/authFiles/quotaSlot';
import { QUOTA_PAGE_SIZE } from '../src/features/quota/constants';
import type { AuthFileItem } from '../src/types';

const source = readFileSync('src/features/authFiles/hooks/useAuthFilesData.ts', 'utf8');
const groupSource = readFileSync('src/features/authFiles/AuthFilesSourceContent.tsx', 'utf8');

/** Runs the named callbacks of a source slice with the given fakes for its free variables. */
function compile(block: string, returns: string, env: Record<string, unknown>) {
  const js = ts.transpileModule(`${block}\nreturn ${returns};`, {
    compilerOptions: { target: ts.ScriptTarget.ES2022 },
  }).outputText;
  return new Function(...Object.keys(env), js)(...Object.values(env));
}

function harness() {
  let revision = 1;
  let confirmations = 0;
  let loads = 0;
  let invalidations = 0;
  const notifications: Array<[string, string]> = [];
  const calls: unknown[][] = [];
  let resolve!: (value: unknown) => void;
  let reject!: (error: Error) => void;
  const request = (...args: unknown[]) => {
    calls.push(args);
    return new Promise((res, rej) => {
      resolve = res;
      reject = rej;
    });
  };
  const env = {
    // Exercise the callbacks' request-revision guards; real view disposal/dispatch is
    // covered with SourceSessions in authFilesSourceView.test.ts.
    sourceScope: {
      getRevision: () => revision,
      isCurrent: () => true,
      assertCurrent: () => {},
      session: { owner: { instanceId: 'fixture', sessionEpoch: 0, sourceGeneration: 1 } },
    },
    authFilesApi: { requestManualRefresh: request, requestAllManualRefresh: request },
    getAuthFileRefreshKey,
    isRuntimeOnlyAuthFile: () => false,
    supportsAuthFileManualRefresh: () => true,
    refreshAllPendingRef: { current: false },
    manualRefreshPendingRef: { current: new Set<string>() },
    setManualRefreshing: () => {},
    setRefreshingAllCredentials: () => {},
    showConfirmation: () => {
      confirmations++;
    },
    showNotification: (message: string, type: string) => {
      notifications.push([message, type]);
    },
    invalidateInFlightLoads: () => {
      invalidations++;
    },
    notifyAuthFilesChanged: () => {},
    onFilesMutatedRef: { current: () => {} },
    loadFiles: async () => {
      loads++;
    },
    t: (key: string, options?: Record<string, unknown>) =>
      options ? `${key} ${JSON.stringify(options)}` : key,
    useCallback: (fn: unknown) => fn,
  };
  const block = source.slice(
    source.indexOf('  const handleManualRefresh = useCallback('),
    source.indexOf('  const handleCooldownReset = useCallback(')
  );
  const callbacks = compile(
    block,
    '{single: handleManualRefresh, all: handleRefreshAllCredentials}',
    env
  );
  return {
    ...callbacks,
    switchConnection: () => {
      revision++;
    },
    resolve: (value: unknown) => resolve(value),
    reject: (error: Error) => reject(error),
    calls,
    notifications,
    get confirmations() {
      return confirmations;
    },
    get loads() {
      return loads;
    },
    get invalidations() {
      return invalidations;
    },
  };
}

describe('credential refresh action lifecycle', () => {
  test('runs at once with no dialog, prevents overlap, and reports results in one notice', async () => {
    const h = harness();
    const pending = h.all();
    expect(h.calls).toHaveLength(1);
    await h.all();
    await h.single({ name: 'one.json', authIndex: 'one' });
    expect(h.calls).toHaveLength(1);
    h.resolve([
      { id: 'one.json', success: false, error: 'fixture' },
      { id: 'two.json', success: true },
    ]);
    await pending;
    expect(h.confirmations).toBe(0);
    expect(h.notifications).toHaveLength(1);
    const [message, type] = h.notifications[0];
    expect(type).toBe('warning');
    expect(message).toContain('auth_files.refresh_all_summary {"success":1,"failed":1}');
    expect(message).toContain('one.json: fixture');
    expect(message).not.toContain('two.json');
    expect(h.loads).toBe(1);
    expect(h.invalidations).toBe(1);
  });

  test('a clean all-refresh is one success notice; none eligible says so', async () => {
    const h = harness();
    const pending = h.all();
    h.resolve([{ id: 'one.json', success: true }]);
    await pending;
    expect(h.notifications[0][1]).toBe('success');
    const empty = harness();
    const none = empty.all();
    empty.resolve([]);
    await none;
    expect(empty.notifications).toEqual([['auth_files.refresh_all_empty', 'success']]);
  });

  test('a failed all-refresh still reloads potentially changed backend state', async () => {
    const h = harness();
    const pending = h.all();
    h.reject(new Error('timeout'));
    await pending;
    expect(h.notifications).toHaveLength(1);
    expect(h.notifications[0][1]).toBe('error');
    expect(h.loads).toBe(1);
  });

  for (const all of [true, false]) {
    test(`stale ${all ? 'all' : 'single'} refresh cannot publish results or invalidate new caches`, async () => {
      const h = harness();
      const pending = all ? h.all() : h.single({ name: 'one.json', authIndex: 'one' });
      h.switchConnection();
      h.resolve([{ id: 'one.json', success: true }]);
      await pending;
      expect(h.notifications).toHaveLength(0);
      expect(h.loads).toBe(0);
      expect(h.invalidations).toBe(0);
    });
  }

  test('single refresh forwards the selected identity and blocks a duplicate', async () => {
    const h = harness();
    const item = { name: 'one.json', authIndex: 'two' };
    const pending = h.single(item);
    await h.single(item);
    await h.all();
    expect(h.calls).toEqual([['one.json', 'two']]);
    h.resolve(undefined);
    await pending;
    expect(h.loads).toBe(1);
  });
});

const claude = (name: string): AuthFileItem => ({ name, type: 'claude', authIndex: name });

/** The source between two markers of AuthFilesSourceContent.tsx. */
const groupSlice = (from: string, to: string) =>
  groupSource.slice(groupSource.indexOf(from), groupSource.indexOf(to));

function groupHarness(options: { compactMode?: boolean; pageItems: AuthFileItem[] }) {
  let revision = 1;
  let switchDuringCredentials = false;
  const events: string[] = [];
  const quotaBatches: string[][] = [];
  const busy: boolean[] = [];
  const env = {
    sourceScope: { getRevision: () => revision, isCurrent: () => true },
    filters: { compactMode: options.compactMode === true },
    pageItems: options.pageItems,
    activeQuotaFilter: 'all',
    quotaRefreshTargets,
    QUOTA_PAGE_SIZE,
    // The same loader the page-wide "Refresh quota" runner uses (useQuotaBatchLoader).
    loadQuota: async (targets: Array<{ file: AuthFileItem }>) => {
      events.push('quota');
      quotaBatches.push(targets.map((entry) => entry.file.name));
    },
    handleRefreshAllCredentials: async () => {
      events.push('credentials+list');
      if (switchDuringCredentials) revision++;
    },
    setGroupRefreshing: (value: boolean) => busy.push(value),
    useCallback: (fn: unknown) => fn,
  };
  const block = [
    groupSlice('  /** Reads the targets', '  const runQuotaRefresh = useCallback('),
    groupSlice('  const handleGroupRefresh', '  /* ---------- one-time card entrance cascade'),
  ].join('\n');
  const { refresh } = compile(block, '{refresh: handleGroupRefresh}', env);
  return {
    refresh: refresh as () => Promise<void>,
    events,
    quotaBatches,
    busy,
    switchConnectionDuringCredentials: () => {
      switchDuringCredentials = true;
    },
  };
}

describe('the group Refresh button: one click, credentials then every shown card quota', () => {
  test('reads the quota of every quota-capable card after the credential reload', async () => {
    const pageItems = [
      claude('a.json'),
      { name: 'gem.json', type: 'gemini-cli' },
      { ...claude('off.json'), disabled: true },
      claude('b.json'),
    ];
    const h = groupHarness({ pageItems });
    await h.refresh();
    // The reload clears this source's quota cache, so quota must be read after it.
    expect(h.events).toEqual(['credentials+list', 'quota']);
    // The same cards each card's own refresh icon serves: disabled and unsupported left out.
    expect(h.quotaBatches).toEqual([['a.json', 'b.json']]);
    expect(h.busy).toEqual([true, false]);
  });

  test('quota reads are bounded to QUOTA_PAGE_SIZE at a time', async () => {
    const pageItems = Array.from({ length: QUOTA_PAGE_SIZE + 3 }, (_, i) => claude(`${i}.json`));
    const h = groupHarness({ pageItems });
    await h.refresh();
    expect(h.quotaBatches.map((batch) => batch.length)).toEqual([QUOTA_PAGE_SIZE, 3]);
  });

  test('compact cards show no quota, so only the credentials refresh', async () => {
    const h = groupHarness({ compactMode: true, pageItems: [claude('a.json')] });
    await h.refresh();
    expect(h.events).toEqual(['credentials+list']);
  });

  test('a connection switched during the credential refresh reads no quota', async () => {
    const h = groupHarness({ pageItems: [claude('a.json')] });
    h.switchConnectionDuringCredentials();
    await h.refresh();
    expect(h.events).toEqual(['credentials+list']);
    expect(h.busy).toEqual([true, false]);
  });

  test('the header button runs the group refresh and opens no dialog', () => {
    const header = groupSource.split('<div className={styles.groupActions}>')[1];
    const button = header.slice(0, header.indexOf('</Button>'));
    expect(button).toContain('onClick={() => void handleGroupRefresh().catch(() => {})}');
    expect(button).toContain('loading={groupRefreshing}');
    const handler = source.slice(
      source.indexOf('  const handleRefreshAllCredentials = useCallback('),
      source.indexOf('  const handleCooldownReset = useCallback(')
    );
    expect(handler).not.toContain('showConfirmation');
    expect(groupSource).not.toContain('AuthFileRefreshResults');
    // The page-wide "Refresh quota" offers nothing of this group while its Refresh runs.
    expect(groupSource).toContain('disableControls || groupRefreshing ||');
  });
});
