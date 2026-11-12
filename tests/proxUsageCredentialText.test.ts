import { expect, test } from 'bun:test';
import { sanitizeCredentialText } from '../server/usage/credentialText';
import fixtures from './fixtures/usageCredentialText.json';

for (const [index, fixture] of fixtures.entries()) {
  test(`CPAMP ${fixture.origin} case ${index}`, () => {
    const value = sanitizeCredentialText(fixture.input);
    expect(value).toBe(fixture.expected);
    expect(sanitizeCredentialText(value)).toBe(value);
  });
}
test('strong token formats and all PEM private key forms are scrubbed', () => {
  for (const prefix of [
    'sk-proj-',
    'sk-ant-',
    'sk-',
    'github_pat_',
    'ghp_',
    'AIza',
    'hf_',
    'sess-',
    'pk_live_',
    'pk_test_',
    'pk_',
    'rk_live_',
    'rk_test_',
    'rk_',
    'cpamp_',
  ]) {
    const input = `client/1.0 ${prefix}${'a'.repeat(50)}`;
    expect(sanitizeCredentialText(input)).toBe('client/1.0 [redacted]');
  }
  for (const label of [
    'PRIVATE KEY',
    'ENCRYPTED PRIVATE KEY',
    'RSA PRIVATE KEY',
    'DSA PRIVATE KEY',
    'EC PRIVATE KEY',
    'OPENSSH PRIVATE KEY',
  ]) {
    expect(
      sanitizeCredentialText(
        `prefix -----BEGIN ${label}-----\nSECRET\n-----END ${label}----- suffix`
      )
    ).toBe('prefix [redacted] suffix');
  }
});
test('safe diagnostics and filenames are preserved byte for byte', () => {
  for (const text of [
    'client/1.0',
    'sk-account-production.json',
    'sk-proj-account-backup1.json',
    'AIza_account.json',
    'max_tokens=1000',
    'token_count=500',
    'authorization_error=true',
  ])
    expect(sanitizeCredentialText(text)).toBe(text);
});
