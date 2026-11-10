import { describe, expect, test } from 'bun:test';
import { oauthProviderKeys } from '../src/features/authFiles/hooks/useAuthFilesOauth';
import type { AuthFileItem } from '../src/types';

const file = (fields: Record<string, unknown>) => ({ name: 'f.json', ...fields }) as AuthFileItem;

describe('oauthProviderKeys', () => {
  test('spells every provider the way the Models screen and the store key it', () => {
    expect(
      oauthProviderKeys(
        ['Gemini_CLI', 'grok'],
        [file({ type: 'x-ai' }), file({ provider: 'Muse' }), file({ type: 'Anti_Gravity' })]
      ).sort()
    ).toEqual(['antigravity', 'gemini-cli', 'meta', 'xai']);
  });

  test('skips blank keys and counts a provider once', () => {
    expect(
      oauthProviderKeys([' '], [file({ type: 'claude', provider: 'claude' }), file({})])
    ).toEqual(['claude']);
  });
});
