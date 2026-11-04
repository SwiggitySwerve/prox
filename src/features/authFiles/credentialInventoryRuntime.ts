import { createAuthFilesApi } from '@/services/api/authFiles';
import { createCredentialInventoryApi } from '@/services/api/credentialInventory';
import { providerSources } from '@/stores/useProviderSources';
import {
  useCredentialInventoryStore,
  type ChannelMessage,
  type InventoryRuntime,
} from '@/stores/useCredentialInventoryStore';

const CHANNEL_NAME = 'prox-credential-inventory';

function createChannel(): InventoryRuntime['channel'] {
  if (typeof BroadcastChannel === 'undefined') return null;
  const channel = new BroadcastChannel(CHANNEL_NAME);
  return {
    post: (message) => channel.postMessage(message),
    close: () => channel.close(),
    subscribe: (listener) => {
      const receive = (event: MessageEvent<ChannelMessage>) => {
        if (event.data?.type === 'changed') listener(event.data);
      };
      channel.addEventListener('message', receive);
      return () => channel.removeEventListener('message', receive);
    },
  };
}

/** The browser-backed runtime: the live source sessions, prox-history, the page and the channel. */
export function createInventoryRuntime(): InventoryRuntime {
  return {
    sources: () =>
      providerSources.getSnapshot().sources.flatMap((view) => {
        const session = view.session;
        if (!session || view.status !== 'ready') return [];
        return [
          {
            instanceId: view.source.instanceId,
            owner: session.owner,
            list: async () => (await createAuthFilesApi(session).list()).files,
          },
        ];
      }),
    readVersion: (known) => createCredentialInventoryApi().read(known),
    sync: (change) => createCredentialInventoryApi().sync(change),
    visible: () => document.visibilityState !== 'hidden',
    onVisibilityChange: (listener) => {
      document.addEventListener('visibilitychange', listener);
      return () => document.removeEventListener('visibilitychange', listener);
    },
    every: (ms, run) => {
      const id = window.setInterval(run, ms);
      return () => window.clearInterval(id);
    },
    channel: createChannel(),
  };
}

/** Called once by the app shell: connect the store to the browser and start the one poller. */
export function startCredentialInventory(): () => void {
  const store = useCredentialInventoryStore.getState();
  const runtime = createInventoryRuntime();
  store.configure(runtime);
  const stop = store.startPolling();
  return () => {
    stop();
    runtime.channel?.close();
    store.configure(null);
  };
}
