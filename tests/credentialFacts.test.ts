import { describe, expect, test } from 'bun:test';
import {
  countCredentials,
  credentialHealth,
  isNamedProvider,
  providerOfCredential,
} from '../src/features/authFiles/credentialFacts';
import type { AuthFileItem } from '../src/types';

const file = (fields: Record<string, unknown>): AuthFileItem =>
  ({ name: 'f.json', ...fields }) as AuthFileItem;

describe('providerOfCredential', () => {
  const cases: Array<[Record<string, unknown>, string]> = [
    [{ type: 'claude', provider: 'claude' }, 'claude'],
    [{ type: ' Codex ' }, 'codex'],
    [{ provider: 'gemini_cli' }, 'gemini-cli'],
    [{ type: 'grok' }, 'xai'],
    [{ type: 'x.ai' }, 'xai'],
    [{ type: 'muse' }, 'meta'],
    [{ type: 'Anti_Gravity' }, 'antigravity'],
    [{}, ''],
  ];
  for (const [fields, expected] of cases) {
    test(`${JSON.stringify(fields)} -> ${expected || '(none)'}`, () =>
      expect(providerOfCredential(file(fields))).toBe(expected));
  }

  test('placeholders are not named providers', () => {
    expect(['', 'unknown', 'empty'].map(isNamedProvider)).toEqual([false, false, false]);
    expect(isNamedProvider('claude')).toBe(true);
  });
});

describe('credentialHealth: one of three, disabled wins', () => {
  const cases: Array<[string, Record<string, unknown>, string]> = [
    ['plain', {}, 'active'],
    ['healthy status message', { status: 'active', status_message: 'ok' }, 'active'],
    ['disabled flag', { disabled: true }, 'disabled'],
    ['disabled as a string', { disabled: 'true' }, 'disabled'],
    ['disabled status', { status: 'disabled' }, 'disabled'],
    ['disabled and unavailable', { disabled: true, unavailable: true }, 'disabled'],
    ['unavailable', { unavailable: true }, 'problem'],
    ['error status', { status: 'error' }, 'problem'],
    ['warning message', { status_message: 'quota exhausted' }, 'problem'],
  ];
  for (const [name, fields, expected] of cases) {
    test(name, () => expect(credentialHealth(file(fields))).toBe(expected as never));
  }

  test('the three counts always add up to the total', () => {
    const counts = countCredentials([
      file({}),
      file({ disabled: true, unavailable: true }),
      file({ unavailable: true }),
      file({ status: 'error', runtime_only: true }),
    ]);
    expect(counts).toEqual({ total: 4, active: 1, problem: 2, disabled: 1, runtime: 1 });
    expect(counts.active + counts.problem + counts.disabled).toBe(counts.total);
  });
});
