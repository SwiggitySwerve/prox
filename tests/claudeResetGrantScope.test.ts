import { describe, expect, test } from 'bun:test';
import { createSourceResetGrants } from '@/features/quota/providers/claude/resetGrantScope';
import { createSourceLease } from '@/services/api/sourceLease';
import { SourceSessions } from '@/services/api/sourceSession';

const connection = {
  instanceId: 'claude-primary',
  apiBase: 'https://source.invalid',
  managementKey: 'fixture-management',
  configurationRevision: '1',
};

function openPage(sessions: SourceSessions) {
  const lease = createSourceLease(sessions.captureSource('claude-primary'));
  lease.activate();
  return lease;
}

const failure = (run: Promise<unknown>) => run.catch((reason: unknown) => reason);

describe('source reset-grant scope', () => {
  test('shares the claim journal between pages of one authenticated source', async () => {
    const sessions = new SourceSessions();
    sessions.configure([connection]);
    const first = openPage(sessions);
    const second = openPage(sessions);
    const pending = createSourceResetGrants(first.session).operations.run('k', 'a1', 'g1');
    const concurrent = createSourceResetGrants(second.session).operations.run('k', 'a1', 'g1');
    expect(await failure(concurrent)).toMatchObject({ reason: 'busy' });
    first.dispose();
    second.dispose();
    await failure(pending);
  });

  test('keeps a retained page current after a child page closes', () => {
    const sessions = new SourceSessions();
    sessions.configure([connection]);
    const parent = openPage(sessions);
    const scope = createSourceResetGrants(parent.session);
    const editor = openPage(sessions);
    createSourceResetGrants(editor.session);
    editor.dispose();
    expect(scope.current()).toBe(true);
  });

  test('releases a claim interrupted by leaving the page', async () => {
    const sessions = new SourceSessions();
    sessions.configure([connection]);
    const first = openPage(sessions);
    const interrupted = createSourceResetGrants(first.session).operations.run('k', 'a1', 'g1');
    first.dispose();
    await failure(interrupted);

    const second = openPage(sessions);
    const retry = createSourceResetGrants(second.session).operations.run('k', 'a1', 'g1');
    second.dispose();
    expect(await failure(retry)).not.toMatchObject({ reason: 'busy' });
  });

  test('starts a fresh journal after reconnecting', async () => {
    const sessions = new SourceSessions();
    sessions.configure([connection]);
    const old = createSourceResetGrants(openPage(sessions).session).operations.run('k', 'a1', 'g1');
    sessions.reset();
    sessions.configure([connection]);
    const page = openPage(sessions);
    const fresh = createSourceResetGrants(page.session).operations.run('k', 'a1', 'g1');
    page.dispose();
    expect(await failure(fresh)).not.toMatchObject({ reason: 'busy' });
    await failure(old);
  });
});
