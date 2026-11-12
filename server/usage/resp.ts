// The proxy's small RESP subset. Frames are decoded incrementally, including split UTF-8.
import { createConnection, type Socket } from 'node:net';
import { connect as connectTls } from 'node:tls';
import { UsageAuthError } from './proxyHttp';

type Frame = string | number | null | Frame[] | Error;
const MAX_FRAME = 1024 * 1024;

export function encodeCommand(...args: string[]): string {
  return `*${args.length}\r\n${args.map((s) => `$${Buffer.byteLength(s)}\r\n${s}\r\n`).join('')}`;
}

function parse(buffer: Buffer, offset = 0, depth = 0): [Frame, number] | null {
  if (depth > 4) throw new Error('RESP nesting limit');
  const end = buffer.indexOf('\r\n', offset);
  if (end === -1) return null;
  const prefix = String.fromCharCode(buffer[offset]);
  const line = buffer.toString('utf8', offset + 1, end);
  const next = end + 2;
  if (prefix === '+') return [line, next];
  // Never propagate an upstream error text: it may contain credentials.
  if (prefix === '-') return [new Error('Proxy protocol error'), next];
  const size = Number(line);
  if (!/^-?\d+$/.test(line) || !Number.isSafeInteger(size)) throw new Error('Invalid RESP length');
  if (prefix === ':') return [size, next];
  if (size === -1 && (prefix === '$' || prefix === '*')) return [null, next];
  if (size < 0 || size > MAX_FRAME) throw new Error('RESP size limit');
  if (prefix === '$') {
    if (buffer.length < next + size + 2) return null;
    if (buffer.toString('ascii', next + size, next + size + 2) !== '\r\n') {
      throw new Error('Invalid RESP bulk terminator');
    }
    return [buffer.toString('utf8', next, next + size), next + size + 2];
  }
  if (prefix !== '*' || size > 1024) throw new Error('Invalid RESP frame');
  const frames: Frame[] = [];
  let position = next;
  for (let i = 0; i < size; i += 1) {
    const item = parse(buffer, position, depth + 1);
    if (!item) return null;
    frames.push(item[0]);
    position = item[1];
  }
  return [frames, position];
}

/** Exposed for the in-process fake proxy as well as production socket reads. */
export class RespDecoder {
  private buffer = Buffer.alloc(0);
  feed(chunk: Uint8Array, accept: (frame: Frame) => void): void {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    let position = 0;
    while (position < this.buffer.length) {
      const frame = parse(this.buffer, position);
      if (!frame) break;
      position = frame[1];
      accept(frame[0]);
    }
    this.buffer = this.buffer.subarray(position);
    if (this.buffer.length > MAX_FRAME) throw new Error('RESP frame limit');
  }
}

export interface UsageSubscription {
  closed: Promise<void>;
  ping(): void;
  unsubscribe(): Promise<void>;
  close(): void;
}

export async function subscribeUsage(options: {
  origin: string;
  key: string;
  signal: AbortSignal;
  onPayload(payload: string): void;
  onActivity(): void;
}): Promise<UsageSubscription> {
  const url = new URL(options.origin);
  const address = {
    host: url.hostname.replace(/^\[|\]$/g, ''),
    port: Number(url.port || (url.protocol === 'https:' ? 443 : 80)),
  };
  const socket: Socket =
    url.protocol === 'https:' ? connectTls(address) : createConnection(address);
  socket.setNoDelay(true);
  const decoder = new RespDecoder();
  let finish!: () => void;
  const closed = new Promise<void>((resolve) => {
    finish = resolve;
  });
  let waiter: { accept(frame: Frame): void; reject(error: Error): void } | null = null;
  let ended = false;
  const fail = () => {
    ended = true;
    waiter?.reject(new Error('Usage connection closed'));
    waiter = null;
    finish();
  };
  const abort = () => socket.destroy();
  options.signal.addEventListener('abort', abort, { once: true });
  socket.on('error', fail);
  socket.on('close', () => {
    options.signal.removeEventListener('abort', abort);
    fail();
  });
  socket.on('data', (chunk) => {
    try {
      options.onActivity();
      decoder.feed(typeof chunk === 'string' ? Buffer.from(chunk) : chunk, (frame) => {
        if (Array.isArray(frame) && frame[0] === 'message' && frame[1] === 'usage') {
          if (typeof frame[2] !== 'string') throw new Error('Invalid usage message');
          options.onPayload(frame[2]);
        } else if (Array.isArray(frame) && frame[0] === 'pong') {
          // Pongs only count as activity; they must not consume an unsubscribe waiter.
        } else if (waiter) {
          const current = waiter;
          waiter = null;
          current.accept(frame);
        } else if (frame instanceof Error) {
          throw frame;
        }
      });
    } catch {
      socket.destroy();
    }
  });
  const command = (args: string[], expected: (frame: Frame) => boolean, auth = false) =>
    new Promise<void>((resolve, reject) => {
      if (ended || options.signal.aborted) {
        reject(new Error('Usage connection closed'));
        return;
      }
      const timer = setTimeout(() => {
        waiter = null;
        socket.destroy();
        reject(new Error('RESP command timed out'));
      }, 10_000);
      const done = (error?: Error) => {
        clearTimeout(timer);
        if (error) reject(error);
        else resolve();
      };
      waiter = {
        accept(frame) {
          if (frame instanceof Error || !expected(frame))
            done(auth ? new UsageAuthError() : new Error('Unexpected RESP response'));
          else done();
        },
        reject(error) {
          done(error);
        },
      };
      socket.write(encodeCommand(...args));
    });
  try {
    // Writes are buffered until connect. The command deadline also bounds TCP/TLS establishment.
    await command(['AUTH', options.key], (frame) => frame === 'OK', true);
    await command(
      ['SUBSCRIBE', 'usage'],
      (frame) =>
        Array.isArray(frame) && frame[0] === 'subscribe' && frame[1] === 'usage' && frame[2] === 1
    );
  } catch (error) {
    socket.destroy();
    throw error;
  }
  return {
    closed,
    ping: () => {
      if (!ended) socket.write(encodeCommand('PING'));
    },
    async unsubscribe() {
      try {
        await command(
          ['UNSUBSCRIBE', 'usage'],
          (frame) =>
            Array.isArray(frame) &&
            frame[0] === 'unsubscribe' &&
            frame[1] === 'usage' &&
            frame[2] === 0
        );
      } finally {
        socket.destroy();
      }
    },
    close: () => socket.destroy(),
  };
}
