import { useAuthStore } from '@/stores/useAuthStore';

/** Observe every auth transition, including a reconnect with identical credentials. */
export function createPoolSessionObserver() {
  let generation = 0;
  return {
    getSnapshot: () => generation,
    subscribe: (notify: () => void) =>
      useAuthStore.subscribe((current, previous) => {
        if (
          current.apiBase !== previous.apiBase ||
          current.managementKey !== previous.managementKey ||
          current.isAuthenticated !== previous.isAuthenticated ||
          current.connectionStatus !== previous.connectionStatus
        ) {
          generation += 1;
          notify();
        }
      }),
  };
}
