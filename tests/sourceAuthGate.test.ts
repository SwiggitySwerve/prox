import { describe, expect, test } from 'bun:test';
import type { AxiosAdapter } from 'axios';
import { SourceSessions } from '../src/services/api/sourceSession';

const hub = {
  instanceId: 'alpha',
  apiBase: 'https://fixture.invalid/a',
  managementKey: 'fixture-wrong-key',
  configurationRevision: '1',
};
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

/** A hub that answers every request by hand and counts what reached it. */
function fakeHub() {
  const received: Array<{ url: string; answer: (status: number) => void }> = [];
  const adapter: AxiosAdapter = (config) =>
    new Promise((resolve, reject) => {
      received.push({
        url: config.url ?? '',
        answer: (status) => {
          if (status === 200) {
            resolve({ data: 'ok', status, statusText: 'OK', headers: {}, config });
          } else {
            reject({
              isAxiosError: true,
              message: `HTTP ${status}`,
              config,
              response: { status, data: {} },
            });
          }
        },
      });
    });
  return { received, adapter };
}

describe('one failed management-auth request per hub per refresh', () => {
  test('a new session sends at once: sign-in already proved the key', async () => {
    const sessions = new SourceSessions();
    sessions.configure([hub]);
    const { management } = sessions.captureSource('alpha');
    const { received, adapter } = fakeHub();
    const reads = [management.get('/a', { adapter }), management.get('/b', { adapter })];
    await tick();
    expect(received).toHaveLength(2);
    received.forEach((request) => request.answer(200));
    await Promise.all(reads);
  });

  test('six parallel reads with a wrong key: one reaches the hub, all six fail', async () => {
    const sessions = new SourceSessions();
    sessions.configure([hub]);
    const { management } = sessions.captureSource('alpha');
    sessions.armAuthProbes(); // a refresh begins
    const { received, adapter } = fakeHub();
    const reads = Array.from({ length: 6 }, (_, index) =>
      management.get(`/quota/${index}`, { adapter }).then(
        () => 'ok',
        (error: { status?: number }) => error.status
      )
    );
    await tick();
    expect(received).toHaveLength(1);
    received[0].answer(401);
    expect(await Promise.all(reads)).toEqual([401, 401, 401, 401, 401, 401]);
    expect(received).toHaveLength(1);
    // the rest of the session (and of this refresh) never calls the hub again
    await expect(management.get('/later', { adapter })).rejects.toMatchObject({ status: 401 });
    expect(received).toHaveLength(1);
    expect(sessions.deniedSources()).toEqual(['alpha']);
    // a new refresh does not re-open a hub that refused the key
    sessions.armAuthProbes();
    await expect(management.get('/next-refresh', { adapter })).rejects.toMatchObject({
      status: 401,
    });
    expect(received).toHaveLength(1);
  });

  test('once the first answer proves the key, the rest go out in parallel', async () => {
    const sessions = new SourceSessions();
    sessions.configure([hub]);
    const { management } = sessions.captureSource('alpha');
    sessions.armAuthProbes(); // a refresh begins
    const { received, adapter } = fakeHub();
    const reads = Array.from({ length: 4 }, (_, index) =>
      management.get(`/quota/${index}`, { adapter })
    );
    await tick();
    expect(received).toHaveLength(1);
    received[0].answer(200);
    await tick();
    await tick();
    expect(received).toHaveLength(4);
    received.slice(1).forEach((request) => request.answer(200));
    expect(await Promise.all(reads)).toEqual(['ok', 'ok', 'ok', 'ok']);
  });

  test('each refresh probes again: a key revoked between refreshes costs one failure', async () => {
    const sessions = new SourceSessions();
    sessions.configure([hub]);
    const { management } = sessions.captureSource('alpha');
    sessions.armAuthProbes(); // a refresh begins
    const { received, adapter } = fakeHub();
    const first = management.get('/one', { adapter });
    await tick();
    received[0].answer(200);
    await first;

    sessions.armAuthProbes();
    const reads = Array.from({ length: 5 }, () =>
      management.get('/two', { adapter }).catch((error: { status?: number }) => error.status)
    );
    await tick();
    expect(received).toHaveLength(2);
    received[1].answer(401);
    expect(await Promise.all(reads)).toEqual([401, 401, 401, 401, 401]);
    expect(received).toHaveLength(2);
  });

  test('a probe that never got an answer (network) hands the probe to the next request', async () => {
    const sessions = new SourceSessions();
    sessions.configure([hub]);
    const { management } = sessions.captureSource('alpha');
    sessions.armAuthProbes();
    let calls = 0;
    const adapter: AxiosAdapter = async (config) => {
      calls += 1;
      if (calls === 1) throw { isAxiosError: true, message: 'Network Error', config };
      return { data: 'ok', status: 200, statusText: 'OK', headers: {}, config };
    };
    const results = await Promise.allSettled([
      management.get('/a', { adapter }),
      management.get('/b', { adapter }),
      management.get('/c', { adapter }),
    ]);
    expect(results.map((result) => result.status)).toEqual(['rejected', 'fulfilled', 'fulfilled']);
    expect(sessions.deniedSources()).toEqual([]);
  });

  test('another hub is not held up by one that refused the key', async () => {
    const sessions = new SourceSessions();
    sessions.configure([hub, { ...hub, instanceId: 'beta', apiBase: 'https://fixture.invalid/b' }]);
    sessions.armAuthProbes();
    const denied: AxiosAdapter = async (config) => {
      throw { isAxiosError: true, message: 'x', config, response: { status: 401, data: {} } };
    };
    const ok: AxiosAdapter = async (config) => ({
      data: 'ok',
      status: 200,
      statusText: 'OK',
      headers: {},
      config,
    });
    await sessions
      .captureSource('alpha')
      .management.get('/a', { adapter: denied })
      .catch(() => {});
    expect(await sessions.captureSource('beta').management.get('/b', { adapter: ok })).toBe('ok');
    expect(sessions.deniedSources()).toEqual(['alpha']);
  });
});
