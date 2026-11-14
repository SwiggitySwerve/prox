// The credential scrubber (a CPAMP port) backtracked quadratically on long words, because every
// word boundary inside one run is a new start. It is now linear: output equal to the frozen
// reference on the fixtures and on generated input, and bounded time on ~1 MB adversarial text.
import { describe, expect, test } from 'bun:test';
import { sanitizeCredentialText } from '../server/usage/credentialText';
import { failSummaryFromBody, scrubTraceId } from '../server/usage/normalize';
import fixtures from './fixtures/usageCredentialText.json';
import { legacySanitizeCredentialText } from './fixtures/credentialTextLegacy';

// A small deterministic generator (mulberry32): the same cases on every run.
function random(seed: number) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const PIECES = [
  'password', 'api_key', 'api key', 'x-api-key', 'token', 'Authorization', 'authorization', 'cookie',
  'Set-Cookie', 'secret', 'client_secret', 'session', 'user', 'name', 'id', 'status', 'error', 'a', 'b.c',
  'a-b', '..', '--', 'x_password', 'my cookie', 'Bearer', 'bearer', 'basic', 'sk-', 'AIza', 'ghp_',
  ':', '=', ': ', ' = ', '=', ':', '"', "'", ' ', '  ', '\t', '\n', '\r\n', ',', '&', '}', ']', '[', '{',
  '[redacted]', '-----BEGIN PRIVATE KEY-----', '-----END PRIVATE KEY-----', 'abcdefgh12345678',
  'A1b2C3d4E5f6G7h8I9j0K1l2M3n4', 'value', 'a\\"b', '\\', '1', 'é', '\u0000',
];

describe('the linear scrubber equals the reference scrubber', () => {
  test('on every CPAMP fixture', () => {
    for (const fixture of fixtures) {
      expect(sanitizeCredentialText(fixture.input)).toBe(legacySanitizeCredentialText(fixture.input));
      expect(sanitizeCredentialText(fixture.input)).toBe(fixture.expected);
    }
  });
  test('on 60,000 generated strings built from keys, separators, quotes and credentials', () => {
    const next = random(20261114);
    for (let n = 0; n < 60000; n++) {
      let text = '';
      for (let i = 1 + Math.floor(next() * 14); i > 0; i--) text += PIECES[Math.floor(next() * PIECES.length)];
      const expected = legacySanitizeCredentialText(text);
      if (sanitizeCredentialText(text) !== expected)
        throw new Error(`differs on ${JSON.stringify(text)}: ${JSON.stringify(sanitizeCredentialText(text))} vs ${JSON.stringify(expected)}`);
    }
  });
  test('on long words, dotted and dashed runs, and runs that begin with dots', () => {
    const next = random(77);
    const word = (n: number) => Array.from({ length: n }, () => 'ab._-9'[Math.floor(next() * 6)]).join('');
    for (let n = 0; n < 3000; n++) {
      const text = `${word(1 + Math.floor(next() * 60))}${['', ' ', '\t', ' \n '][Math.floor(next() * 4)]}${['password', 'api_key', 'x-authorization', 'cookie', 'token', ''][Math.floor(next() * 6)]}${[':', '=', ' = ', ': "', "='"][Math.floor(next() * 5)]}${word(Math.floor(next() * 20))} ${word(5)}`;
      expect(sanitizeCredentialText(text)).toBe(legacySanitizeCredentialText(text));
    }
  });
});

describe('about 1 MB of adversarial text is scrubbed in bounded time', () => {
  const MB = 1 << 20;
  const cases: Record<string, string> = {
    dots: 'a.'.repeat(MB / 2),
    dotsThenEquals: `${'a.'.repeat(MB / 2)}=`,
    dashes: 'a-'.repeat(MB / 2),
    oneLongWord: 'x'.repeat(MB),
    words: 'a b c '.repeat(MB / 6),
    authorizationLike: `${'x'.repeat(MB)}authorizatio`,
    authorizationRuns: 'xauthorization '.repeat(MB / 15),
    cookies: 'cookie '.repeat(MB / 7),
    bearers: 'bearer '.repeat(MB / 7),
    keysAndEquals: 'a='.repeat(MB / 2),
    colonsAndNewlines: 'a:\n'.repeat(MB / 3),
    quotedKeys: '"k":"'.repeat(MB / 5),
    unterminatedQuoted: `"k": "${'a'.repeat(MB)}`,
    escapes: `"k":"${'\\a'.repeat(MB / 2)}`,
    manyPemBegins: '-----BEGIN PRIVATE KEY-----'.repeat(MB / 27),
    manyPemPairs: '-----BEGIN PRIVATE KEY----- x -----END PRIVATE KEY-----'.repeat(MB / 55),
    strongTokenPrefixes: 'sk-'.repeat(MB / 3),
    emailish: 'a.'.repeat(MB / 2) + '@',
    ats: 'a@'.repeat(MB / 2),
    collections: '{"token":['.repeat(MB / 10),
    collectionKeys: 'api key=[a] '.repeat(MB / 12),
    longKeyedCollections: `${'x'.repeat(MB / 2)}_token=[1]`,
    spaces: ' '.repeat(MB),
    mixed: ('a.b-'.repeat(30) + ' = [ ').repeat(MB / 130),
  };
  for (const [name, text] of Object.entries(cases)) {
    test(name, () => {
      let start = performance.now();
      sanitizeCredentialText(text);
      const scrubber = performance.now() - start;
      start = performance.now();
      failSummaryFromBody(text);
      scrubTraceId(text.slice(0, 5000));
      const summary = performance.now() - start;
      // Measured: 40 to 140 ms each; the bound leaves room for a loaded CI machine, and the
      // quadratic scrubber needed minutes on these.
      expect({ name, scrubber: scrubber < 1500, summary: summary < 2000 }).toEqual({
        name,
        scrubber: true,
        summary: true,
      });
    });
  }
});

describe('nothing is withheld, cut or left half scrubbed', () => {
  test('a long text keeps its scrubbed head and every secret form is still redacted', () => {
    const long = `{"password": "first\nSECRETVALUE\n${'padding '.repeat(3000)}"}`;
    expect(failSummaryFromBody(long)).not.toContain('SECRETVALUE');
    expect(failSummaryFromBody(`${'-'.repeat(300)}Bearer abcdef0123456789`)).not.toContain('abcdef0123456789');
    expect(failSummaryFromBody(`{"${'x'.repeat(300)}_api_key":"SECRETVALUE"}`)).not.toContain('SECRETVALUE');
    expect(failSummaryFromBody(`${'a.'.repeat(5000)} password=SECRETVALUE`)).not.toContain('SECRETVALUE');
    expect(failSummaryFromBody(`${'y'.repeat(200)}_password: SECRETVALUE`)).not.toContain('SECRETVALUE');
    expect(failSummaryFromBody(`${'x'.repeat(200)}_api_key=["SECRETVALUE"]`)).not.toContain('SECRETVALUE');
    expect(failSummaryFromBody(`${'x'.repeat(200000)}_api_key=["SECRETVALUE"]`)).not.toContain('SECRETVALUE');
    expect(failSummaryFromBody(`${'word '.repeat(4000)}end`)).toStartWith('word word');
    expect(failSummaryFromBody('z'.repeat(20000))).toBe('z'.repeat(4093) + '...');
    // A JWT-like long run is stored as CPAMP stores it: scrubbed text, capped.
    const jwt = `eyJ${'a'.repeat(300)}.${'b'.repeat(300)}.${'c'.repeat(300)}`;
    expect(failSummaryFromBody(`invalid token ${jwt}`)).toContain('invalid token');
    expect(scrubTraceId('c'.repeat(200))).toBe('c'.repeat(200));
    // Private-key blocks: the linear scan agrees with the lazy pattern, markers and all.
    const next = random(5);
    const marker = ['-----BEGIN PRIVATE KEY-----', '-----END PRIVATE KEY-----', '-----BEGIN RSA PRIVATE KEY-----', '-----END EC PRIVATE KEY-----', 'x', ' ', '\n', 'sk-', '-----BEGIN CERTIFICATE-----'];
    for (let n = 0; n < 5000; n++) {
      let text = '';
      for (let i = 1 + Math.floor(next() * 10); i > 0; i--) text += marker[Math.floor(next() * marker.length)];
      expect(sanitizeCredentialText(text)).toBe(legacySanitizeCredentialText(text));
    }
  });
});
