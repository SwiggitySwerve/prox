import { afterEach, describe, expect, test } from 'bun:test';
import { deobfuscateData, isCurrentObfuscated, obfuscateData } from '@/utils/encryption';

const originalWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
const originalNavigator = Object.getOwnPropertyDescriptor(globalThis, 'navigator');

afterEach(() => {
  for (const [key, descriptor] of [
    ['window', originalWindow],
    ['navigator', originalNavigator],
  ] as const) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor);
    else Reflect.deleteProperty(globalThis, key);
  }
});

describe('v2 storage obfuscation', () => {
  test('new values remain readable when the browser UA changes', () => {
    Object.defineProperty(globalThis, 'window', {
      configurable: true,
      value: { location: { host: 'panel.example.com' } },
    });
    Object.defineProperty(globalThis, 'navigator', {
      configurable: true,
      value: { userAgent: 'Firefox/158.0' },
    });
    // Long enough to exercise the UA-dependent portion of the old XOR key.
    const value = JSON.stringify({ managementKey: 'test-only-'.repeat(100), label: '测试' });
    const encoded = obfuscateData(value);
    expect(encoded.startsWith('enc::v2::')).toBe(true);
    Object.defineProperty(globalThis, 'navigator', {
      configurable: true,
      value: { userAgent: 'Firefox/159.0' },
    });
    expect(deobfuscateData(encoded)).toBe(value);
    expect(obfuscateData(value)).toBe(encoded);
  });

  // ProxUI keeps a remembered sign-in across this upgrade: the auth store still reads the
  // previous format (src/stores/useAuthStore.ts), and the next save writes the new one.
  test('a sign-in remembered in the previous format still reads back, then saves as v2', () => {
    const host = 'panel.example.com';
    const userAgent = 'Firefox/158.0';
    Object.defineProperty(globalThis, 'window', {
      configurable: true,
      value: { location: { host } },
    });
    Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { userAgent } });
    const value = JSON.stringify({ state: { managementKey: 'test-only-key', apiBase: 'x' } });
    // The previous writer: XOR with a key that includes the user agent, prefixed enc::v1::.
    const key = new TextEncoder().encode(
      `cli-proxy-api-webui::secure-storage|${host}|${userAgent}`
    );
    const bytes = new TextEncoder().encode(value).map((byte, i) => byte ^ key[i % key.length]);
    const stored = `enc::v1::${btoa(String.fromCharCode(...bytes))}`;

    expect(deobfuscateData(stored)).toBe(value);
    const resaved = obfuscateData(deobfuscateData(stored));
    expect(resaved.startsWith('enc::v2::')).toBe(true);
    expect(deobfuscateData(resaved)).toBe(value);
  });

  test('auth format detection rejects legacy and plaintext values', () => {
    expect(isCurrentObfuscated('enc::v1::old')).toBe(false);
    expect(isCurrentObfuscated('plaintext')).toBe(false);
    expect(isCurrentObfuscated(obfuscateData('test-key'))).toBe(true);
  });
});
