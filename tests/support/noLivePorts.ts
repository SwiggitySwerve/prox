// Fail before network admission: test fixtures must use ephemeral fake servers.
import { Socket } from 'node:net';
import { afterEach } from 'bun:test';
const violations: number[] = [];
export const takeBlockedTestPorts = () => violations.splice(0);
afterEach(() => {
  const blocked = takeBlockedTestPorts();
  if (blocked.length) throw new Error(`Test attempted live network ports: ${blocked.join(', ')}`);
});
const livePorts = new Set([18317, 18320, 8317, 8319]);
export function assertTestPort(port: unknown): void {
  if (livePorts.has(Number(port))) {
    violations.push(Number(port));
    throw new Error(`Tests must not contact live port ${port}`);
  }
}
const fetchOriginal = globalThis.fetch;
globalThis.fetch = Object.assign(
  (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    assertTestPort(url.port);
    return fetchOriginal(input, init);
  },
  fetchOriginal
);
const connectOriginal = Socket.prototype.connect;
Socket.prototype.connect = function (this: Socket, ...args: unknown[]) {
  let first = args[0];
  while (Array.isArray(first)) first = first[0];
  assertTestPort(
    typeof first === 'object' && first !== null && 'port' in first ? first.port : first
  );
  return Reflect.apply(connectOriginal, this, args);
} as typeof Socket.prototype.connect;
const bunConnectOriginal = Bun.connect;
Bun.connect = ((options: Parameters<typeof Bun.connect>[0]) => {
  if ('port' in options) assertTestPort(options.port);
  return bunConnectOriginal(options);
}) as typeof Bun.connect;
