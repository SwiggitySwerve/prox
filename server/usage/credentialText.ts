// CPAMP usage/persistence_security.go diagnostic text scrubber, without persistence helpers.
const authColonHeaderRegex = new RegExp(
  '\\b((?:[a-zA-Z0-9_.-]+[ \\t]+)?[a-zA-Z0-9_.-]*authorization)(\\s*:\\s*)[^\\r\\n]+',
  'gi'
);
const authSimpleAssignmentRegex = new RegExp(
  '\\b((?:[a-zA-Z0-9_.-]+[ \\t]+)?[a-zA-Z0-9_.-]*authorization)(\\s*=\\s*)(?:basic|bearer)\\s+[A-Za-z0-9._~+/=-]+',
  'gi'
);
const authComplexAssignmentRegex = new RegExp(
  '\\b((?:[a-zA-Z0-9_.-]+[ \\t]+)?[a-zA-Z0-9_.-]*authorization)(\\s*=\\s*)[a-zA-Z][^\\r\\n]*',
  'gi'
);
const cookieColonHeaderRegex = new RegExp(
  '\\b((?:[a-zA-Z0-9_.-]+[ \\t]+)?[a-zA-Z0-9_.-]*cookie)(\\s*:\\s*)[^\\r\\n]+',
  'gi'
);
const cookieAssignmentRegex = new RegExp(
  '\\b((?:[a-zA-Z0-9_.-]+[ \\t]+)?[a-zA-Z0-9_.-]*cookie)(\\s*=\\s*)([^"\'\\r\\n][^\\r\\n]*)',
  'gi'
);
const bearerTokenRegex = new RegExp('\\bbearer\\s+[A-Za-z0-9._~+/=-]{8,}', 'gi');
const pemPrivateKeyBlockRegex = new RegExp(
  '-----BEGIN (?:RSA |EC |OPENSSH |ENCRYPTED |DSA )?PRIVATE KEY-----.*?-----END (?:RSA |EC |OPENSSH |ENCRYPTED |DSA )?PRIVATE KEY-----',
  'gs'
);
const quotedKeyDoubleQuotedRegex = new RegExp(
  '(?:"([^"\\r\\n]+)"|\'([^\'\\r\\n]+)\')(\\s*[:=]\\s*)"((?:[^"\\\\]|\\\\.)*)"',
  'gi'
);
const quotedKeySingleQuotedRegex = new RegExp(
  "(?:\"([^\"\\r\\n]+)\"|'([^'\\r\\n]+)')(\\s*[:=]\\s*)'((?:[^'\\\\]|\\\\.)*)'",
  'gi'
);
const quotedKeyUnterminatedDoubleRegex = new RegExp(
  '(?:"([^"\\r\\n]+)"|\'([^\'\\r\\n]+)\')(\\s*[:=]\\s*)"((?:[^"\\\\\\r\\n]|\\\\.)*\\\\?)(\\r?\\n|$)',
  'gi'
);
const quotedKeyUnterminatedSingleRegex = new RegExp(
  "(?:\"([^\"\\r\\n]+)\"|'([^'\\r\\n]+)')(\\s*[:=]\\s*)'((?:[^'\\\\\\r\\n]|\\\\.)*\\\\?)(\\r?\\n|$)",
  'gi'
);
const quotedKeyUnquotedRegex = new RegExp(
  '(?:"([^"\\r\\n]+)"|\'([^\'\\r\\n]+)\')(\\s*[:=]\\s*)(\\[redacted\\]|[^"\',\\s&}\\]\\r\\n]+)',
  'gi'
);
const unquotedKeyDoubleQuotedRegex = new RegExp(
  '\\b([a-zA-Z0-9_.-]+(?:[ \\t]+[a-zA-Z0-9_.-]+){0,2})\\b(\\s*[:=]\\s*)"((?:[^"\\\\]|\\\\.)*)"',
  'gi'
);
const unquotedKeySingleQuotedRegex = new RegExp(
  "\\b([a-zA-Z0-9_.-]+(?:[ \\t]+[a-zA-Z0-9_.-]+){0,2})\\b(\\s*[:=]\\s*)'((?:[^'\\\\]|\\\\.)*)'",
  'gi'
);
const unquotedKeyUnterminatedDoubleRegex = new RegExp(
  '\\b([a-zA-Z0-9_.-]+(?:[ \\t]+[a-zA-Z0-9_.-]+){0,2})\\b(\\s*[:=]\\s*)"((?:[^"\\\\\\r\\n]|\\\\.)*\\\\?)(\\r?\\n|$)',
  'gi'
);
const unquotedKeyUnterminatedSingleRegex = new RegExp(
  "\\b([a-zA-Z0-9_.-]+(?:[ \\t]+[a-zA-Z0-9_.-]+){0,2})\\b(\\s*[:=]\\s*)'((?:[^'\\\\\\r\\n]|\\\\.)*\\\\?)(\\r?\\n|$)",
  'gi'
);
const unquotedKeyUnquotedEqualsRegex = new RegExp(
  '\\b([a-zA-Z0-9_.-]+(?:[ \\t]+[a-zA-Z0-9_.-]+){0,2})\\b(\\s*=\\s*)(\\[redacted\\]|[^"\',\\s&}\\]\\r\\n]+)',
  'gi'
);
const unquotedKeyUnquotedColonRegex = new RegExp(
  '\\b([a-zA-Z0-9_.-]+(?:[ \\t]+[a-zA-Z0-9_.-]+){0,2})\\b(\\s*:\\s*)(\\[redacted\\]|[^"\',\\s&}\\]\\r\\n]+)',
  'gi'
);
const strongTokenRegex = new RegExp(
  '\\b(sk-proj-[A-Za-z0-9_-]{24,}|sk-ant-[A-Za-z0-9_-]{24,}|sk-[A-Za-z0-9]{24,}|github_pat_[A-Za-z0-9_]{40,}|ghp_[A-Za-z0-9]{30,}|AIza[0-9A-Za-z_-]{30,}|hf_[A-Za-z0-9]{30,}|sess-[A-Za-z0-9_-]{24,}|pk_(?:live|test)_[0-9a-zA-Z]{24,}|pk_[0-9a-zA-Z]{24,}|rk_(?:live|test)_[0-9a-zA-Z]{24,}|rk_[0-9a-zA-Z]{24,}|cpamp_[A-Za-z0-9_-]{32,})\\b',
  'gi'
);
const secretSuffixes = [
  '_api_key',
  '_management_key',
  '_access_token',
  '_refresh_token',
  '_id_token',
  '_auth_token',
  '_session_token',
  '_client_secret',
  '_private_key',
  '_password',
  '_passwd',
  '_secret',
  '_authorization',
  '_cookie',
];
const secretKeys = new Set([
  'api_key',
  'apikey',
  'x_api_key',
  'xapi_key',
  'xapikey',
  'management_key',
  'managementkey',
  'cpa_management_key',
  'cpamanagementkey',
  'authorization',
  'cookie',
  'set_cookie',
  'access_token',
  'refresh_token',
  'id_token',
  'token',
  'client_secret',
  'clientsecret',
  'private_key',
  'privatekey',
  'secret',
  'password',
  'passwd',
  'auth_token',
  'authtoken',
  'session',
  'session_token',
  'sessiontoken',
]);
function normalizeKey(key: string): string {
  const chars = [...key.trim()];
  let result = '';
  const upper = (value: string) => /\p{Lu}/u.test(value);
  for (let i = 0; i < chars.length; i++) {
    const char = chars[i];
    if (upper(char)) {
      const previous = chars[i - 1];
      if (
        i > 0 &&
        !['_', '-', ' '].includes(previous) &&
        (!upper(previous) || (i + 1 < chars.length && /\p{Ll}/u.test(chars[i + 1])))
      )
        result += '_';
      result += char.toLowerCase();
    } else result += char === '-' || char === ' ' ? '_' : char;
  }
  return result.replace(/^_+|_+$/g, '');
}
function secret(key: string) {
  const normalized = normalizeKey(key);
  return (
    secretKeys.has(normalized) ||
    normalized.startsWith('secret_') ||
    secretSuffixes.some((suffix) => normalized.endsWith(suffix))
  );
}
function unquotedSecret(key: string) {
  if (secret(key)) return true;
  const words = key.trim().split(/\s+/);
  return words.slice(1).some((_, i) => {
    const candidate = words.slice(i + 1).join(' ');
    return normalizeKey(candidate) !== 'token' && secret(candidate);
  });
}
function header(input: string, pattern: RegExp, kind: 'authorization' | 'cookie') {
  return input.replace(pattern, (match: string, key: string, separator: string) => {
    const normalized = normalizeKey(key);
    const matches =
      kind === 'authorization'
        ? normalized === kind || normalized.endsWith('_authorization')
        : normalized === kind || normalized === 'set_cookie' || normalized.endsWith('_cookie');
    return matches && match.slice(key.length + separator.length).trim() !== '[redacted]'
      ? key + separator + '[redacted]'
      : match;
  });
}
function assignments(
  input: string,
  pattern: RegExp,
  quoted: boolean,
  quote: string,
  unterminated = false
) {
  return input.replace(pattern, (...args: unknown[]) => {
    const match = args[0] as string;
    const key = args[1] as string;
    const other = args[2] as string;
    if (quoted ? !secret(key || other) : !unquotedSecret(key)) return match;
    const separator = args[quoted ? 3 : 2] as string;
    const prefix = match.slice(0, match.indexOf(separator) + separator.length);
    const trailing = unterminated ? (args[quoted ? 5 : 4] as string) : quote;
    return prefix + quote + '[redacted]' + trailing;
  });
}
// A key (quoted, or a word of at most 128 characters) followed by a separator and `[` or `{`.
const keyBeforeCollectionRegex = new RegExp(
  '(?:"([^"\\r\\n]+)"|\'([^\'\\r\\n]+)\'|\\b([A-Za-z0-9_.-]{1,128})\\b)\\s*[:=]\\s*(?=[\\[{])',
  'g'
);
/**
 * The index just past the array or object that opens at `open`; the end of the text if unclosed.
 * Brackets inside quoted strings (with backslash escapes) do not count.
 */
function collectionEnd(value: string, open: number): number {
  let depth = 0;
  let quote = '';
  for (let i = open; i < value.length; i++) {
    const char = value[i];
    if (quote) {
      if (char === '\\') i += 1;
      else if (char === quote) quote = '';
    } else if (char === '"' || char === "'") quote = char;
    else if (char === '[' || char === '{') depth += 1;
    else if ((char === ']' || char === '}') && --depth === 0) return i + 1;
  }
  return value.length;
}
/**
 * The scrubber above redacts scalar values only, so `"Cookie": ["sid=..."]` keeps its secret. This
 * replaces a whole array or object value held by a secret-named key. Prox-only hardening: used
 * where upstream text is stored (failure text, header values), not by the CPAMP-ported scrubber.
 */
export function redactSecretCollections(value: string): string {
  let out = '';
  let last = 0;
  for (const match of value.matchAll(keyBeforeCollectionRegex)) {
    if (match.index < last || !secret(match[1] || match[2] || match[3])) continue;
    const open = match.index + match[0].length;
    out += `${value.slice(last, open)}"[redacted]"`;
    last = collectionEnd(value, open);
  }
  return out + value.slice(last);
}
export function sanitizeCredentialText(value: string): string {
  let result = value;
  for (const pattern of [
    authColonHeaderRegex,
    authSimpleAssignmentRegex,
    authComplexAssignmentRegex,
  ])
    result = header(result, pattern, 'authorization');
  for (const pattern of [cookieColonHeaderRegex, cookieAssignmentRegex])
    result = header(result, pattern, 'cookie');
  result = result
    .replace(pemPrivateKeyBlockRegex, '[redacted]')
    .replace(bearerTokenRegex, 'Bearer [redacted]');
  for (const [quoted, patterns] of [
    [
      true,
      [
        quotedKeyDoubleQuotedRegex,
        quotedKeySingleQuotedRegex,
        quotedKeyUnterminatedDoubleRegex,
        quotedKeyUnterminatedSingleRegex,
        quotedKeyUnquotedRegex,
      ],
    ],
    [
      false,
      [
        unquotedKeyDoubleQuotedRegex,
        unquotedKeySingleQuotedRegex,
        unquotedKeyUnterminatedDoubleRegex,
        unquotedKeyUnterminatedSingleRegex,
        unquotedKeyUnquotedEqualsRegex,
        unquotedKeyUnquotedColonRegex,
      ],
    ],
  ] as const) {
    for (let index = 0; index < patterns.length; index++)
      result = assignments(
        result,
        patterns[index],
        quoted,
        index < 4 ? (index % 2 ? "'" : '"') : '',
        index === 2 || index === 3
      );
  }
  return result.replace(strongTokenRegex, '[redacted]');
}
