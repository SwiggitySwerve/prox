import type { AxiosRequestConfig } from 'axios';
import type { ManagementTransport, SourceSession } from '@/services/api/sourceSession';

/** A view may disappear while its authenticated registry session remains alive. */
export function createSourceLease(owner: SourceSession) {
  let active = true;
  let controller = new AbortController();
  let revision = 0;
  const assertCurrent = () => {
    owner.assertCurrent();
    if (!active) throw new Error('Source view closed');
  };
  const isCurrent = () => {
    try {
      assertCurrent();
      return true;
    } catch {
      return false;
    }
  };
  async function guard<Result>(operation: () => Promise<Result>): Promise<Result> {
    assertCurrent();
    const started = revision;
    const result = await operation();
    assertCurrent();
    if (started !== revision) throw new Error('Source view changed');
    return result;
  }
  // Axios dispatches in a later microtask. Cancellation also closes that gap between
  // a successful synchronous guard and the actual request interceptor/adapter.
  const requestConfig = (config?: AxiosRequestConfig): AxiosRequestConfig => ({
    ...config,
    signal: AbortSignal.any([
      owner.signal,
      controller.signal,
      ...(config?.signal ? [config.signal as AbortSignal] : []),
    ]),
  });
  const management: ManagementTransport = Object.freeze({
    get: <T>(...args: Parameters<ManagementTransport['get']>) =>
      guard(() => owner.management.get<T>(args[0], requestConfig(args[1]))),
    post: <T>(...args: Parameters<ManagementTransport['post']>) =>
      guard(() => owner.management.post<T>(args[0], args[1], requestConfig(args[2]))),
    put: <T>(...args: Parameters<ManagementTransport['put']>) =>
      guard(() => owner.management.put<T>(args[0], args[1], requestConfig(args[2]))),
    patch: <T>(...args: Parameters<ManagementTransport['patch']>) =>
      guard(() => owner.management.patch<T>(args[0], args[1], requestConfig(args[2]))),
    delete: <T>(...args: Parameters<ManagementTransport['delete']>) =>
      guard(() => owner.management.delete<T>(args[0], requestConfig(args[1]))),
    postForm: <T>(...args: Parameters<ManagementTransport['postForm']>) =>
      guard(() => owner.management.postForm<T>(args[0], args[1], requestConfig(args[2]))),
    getRaw: (...args: Parameters<ManagementTransport['getRaw']>) =>
      guard(() => owner.management.getRaw(args[0], requestConfig(args[1]))),
  });
  const session: SourceSession = Object.freeze({
    owner: owner.owner,
    get signal() {
      return AbortSignal.any([owner.signal, controller.signal]);
    },
    management,
    assertCurrent,
  });
  return Object.freeze({
    session,
    assertCurrent,
    isCurrent,
    getRevision: () => (isCurrent() ? revision : -1),
    // React StrictMode replays layout effects; pending results keep their original revision.
    activate: () => {
      if (controller.signal.aborted) controller = new AbortController();
      active = true;
    },
    dispose: () => {
      active = false;
      controller.abort();
      revision += 1;
    },
  });
}
