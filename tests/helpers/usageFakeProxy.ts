// Synthetic, in-process HTTP + RESP proxy on an ephemeral loopback port. No live endpoints.
import { createServer, type Socket } from 'node:net';
import { RespDecoder } from '../../server/usage/resp';
import type { UsageClock } from '../../server/usage/clock';

export function frame(value: string | number | unknown[]): string {
  if (Array.isArray(value))
    return `*${value.length}\r\n${value.map((v) => frame(v as string | number | unknown[])).join('')}`;
  if (typeof value === 'number') return `:${value}\r\n`;
  return `$${Buffer.byteLength(value)}\r\n${value}\r\n`;
}

export async function fakeUsageProxy() {
  const sockets = new Set<Socket>();
  const subscriptions = new Set<Socket>();
  const log: string[] = [];
  const fake = {
    origin: '',
    log,
    subscriptions,
    authFailures: 0,
    httpAuthFailures: 0,
    credentials: {
      files: [{ auth_index: '3', label: 'Test account', account: 'test@example.test' }],
    },
    queued: [] as unknown[],
    holdUnsubscribe: false,
    unsubscribeSocket: null as Socket | null,
    pong: true,
    emit(payload: unknown) {
      for (const socket of subscriptions)
        socket.write(frame(['message', 'usage', JSON.stringify(payload)]));
    },
    drop() {
      for (const socket of subscriptions) socket.destroy();
      subscriptions.clear();
    },
    ackUnsubscribe() {
      fake.unsubscribeSocket?.end(frame(['unsubscribe', 'usage', 0]));
      fake.unsubscribeSocket = null;
    },
    async close() {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
  const server = createServer((socket) => {
    sockets.add(socket);
    socket.on('error', () => {});
    socket.on('close', () => {
      sockets.delete(socket);
      subscriptions.delete(socket);
    });
    let protocol = '';
    let httpBuffer = '';
    const decoder = new RespDecoder();
    socket.on('data', (chunk) => {
      protocol ||= chunk[0] === 42 ? 'resp' : 'http';
      if (protocol === 'http') {
        httpBuffer += chunk.toString();
        if (!httpBuffer.includes('\r\n\r\n')) return;
        const path = httpBuffer.split(' ')[1];
        log.push(path.includes('/credentials') ? 'credentials' : 'drain');
        let value: unknown;
        let status = '200 OK';
        if (fake.httpAuthFailures > 0) {
          fake.httpAuthFailures -= 1;
          status = '401 Unauthorized';
          value = { error: 'synthetic failure' };
        } else if (path.includes('/credentials')) value = fake.credentials;
        else {
          value = fake.queued.splice(0, 100);
        }
        const body = JSON.stringify(value);
        socket.end(
          `HTTP/1.1 ${status}\r\nContent-Type: application/json\r\nContent-Length: ${Buffer.byteLength(body)}\r\nConnection: close\r\n\r\n${body}`
        );
        return;
      }
      decoder.feed(chunk, (decoded) => {
        if (!Array.isArray(decoded)) throw new Error('Expected a command');
        const [command] = decoded;
        log.push(String(command));
        if (command === 'AUTH') {
          if (fake.authFailures > 0) {
            fake.authFailures -= 1;
            socket.write('-ERR invalid management key\r\n');
          } else socket.write('+OK\r\n');
        } else if (command === 'SUBSCRIBE') {
          subscriptions.add(socket);
          socket.write(frame(['subscribe', 'usage', 1]));
          fake.emit({ support_refresh: true });
        } else if (command === 'PING' && fake.pong) socket.write(frame(['pong', '']));
        else if (command === 'UNSUBSCRIBE') {
          fake.unsubscribeSocket = socket;
          if (!fake.holdUnsubscribe) fake.ackUnsubscribe();
        }
      });
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('No fake proxy port');
  fake.origin = `http://127.0.0.1:${address.port}`;
  return fake;
}

export async function eventually(predicate: () => boolean, message = 'condition'): Promise<void> {
  for (let i = 0; i < 1000; i += 1) {
    if (predicate()) return;
    await Bun.sleep(2);
  }
  throw new Error(`Timed out waiting for ${message}`);
}

export class FakeUsageClock implements UsageClock {
  time = 1_800_000_000_000;
  private waits = new Set<{ at: number; done(): void }>();
  now = () => this.time;
  sleep = (ms: number, signal: AbortSignal): Promise<void> =>
    new Promise((resolve) => {
      const wait = {
        at: this.time + ms,
        done: () => {
          this.waits.delete(wait);
          signal.removeEventListener('abort', wait.done);
          resolve();
        },
      };
      this.waits.add(wait);
      signal.addEventListener('abort', wait.done, { once: true });
      if (signal.aborted) wait.done();
    });
  async advance(ms: number): Promise<void> {
    this.time += ms;
    for (const wait of [...this.waits]) if (wait.at <= this.time) wait.done();
    await Bun.sleep(2);
  }
}
