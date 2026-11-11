import { beforeAll, describe, expect, test } from 'bun:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import i18n from '@/i18n';
import { maskIdentifier } from '@/domain/quotaPool/mask';
import { resetAccountName } from '@/features/quota/logic';
import { ClaudeResetChooser } from '@/features/quota/providers/claude/ClaudeResetChooser';
import type { AnthropicResetGrant } from '@/services/api/claudeResetGrants';
import type { AuthFileItem } from '@/types';

const EMAIL = 'ada.lovelace@example.test';
const claudeFile: AuthFileItem = {
  name: `claude-0a1b2c3d-${EMAIL}.json`,
  type: 'claude',
  email: EMAIL,
};
const codexFile: AuthFileItem = { name: `codex-0a1b2c3d-${EMAIL}-pro.json`, type: 'codex' };
const grant: AnthropicResetGrant = {
  id: 'weekly',
  label: '',
  resetsTotal: 1,
  resetsLeft: 1,
  startsAt: null,
  endsAt: null,
  clears: ['seven_day'],
  paused: false,
  usableNow: true,
  useRequiresLimit: false,
  percentUsed: {},
  kind: 'weekly',
};
// The full address, its local part, or the credential file name that embeds them.
const leaks = (text: string) =>
  [EMAIL, 'ada.lovelace', 'example.test', claudeFile.name, codexFile.name].filter((part) =>
    text.includes(part)
  );

beforeAll(async () => {
  await i18n.changeLanguage('en');
});

describe('reset dialogs name the masked account', () => {
  test('the dialog name is the masked identifier the pool rows show', () => {
    expect(resetAccountName(claudeFile)).toBe('ada•••ce@ex•••.test');
    // The server masks `email || name`; the dialog must read the same as the pool's row.
    expect(resetAccountName(claudeFile)).toBe(maskIdentifier(EMAIL));
    // A credential with no email still never shows the address its file name carries.
    expect(leaks(resetAccountName(codexFile))).toEqual([]);
    expect(resetAccountName(codexFile)).toBe(maskIdentifier(codexFile.name));
  });

  test('no full email reaches the reset dialog text, in any locale', async () => {
    const name = resetAccountName(claudeFile);
    for (const language of ['en', 'zh-CN', 'zh-TW', 'ru', 'vi', 'ko']) {
      await i18n.changeLanguage(language);
      const strings = [
        renderToStaticMarkup(
          createElement(ClaudeResetChooser, {
            name,
            choices: [{ grant, count: 1 }],
            onUse: async () => {},
          })
        ),
        renderToStaticMarkup(
          createElement(ClaudeResetChooser, {
            name,
            choices: [
              { grant, count: 1 },
              { grant: { ...grant, id: 'fable', kind: 'fable' }, count: 1 },
            ],
            onUse: async () => {},
          })
        ),
        i18n.t('claude_reset.retry_confirm', { name }),
        i18n.t('codex_quota.reset_confirm_message', { name }),
        i18n.t('quota_pool.reset_early_intro', { name }),
        i18n.t('codex_quota.reset_success', { name }),
        i18n.t('codex_quota.reset_failed', { name, message: 'x' }),
      ];
      for (const text of strings) {
        expect(text).toContain(name);
        expect(leaks(text)).toEqual([]);
      }
    }
    await i18n.changeLanguage('en');
  });

  test('every reset dialog and its notices take the masked name, never the file name', async () => {
    const sources = [
      'src/features/quota/providers/claude/ClaudeResetGrants.tsx',
      'src/features/quotaPool/PoolAccountResets.tsx',
      'src/features/quota/hooks/useQuotaActions.ts',
      'src/features/authFiles/components/AuthFileQuotaSection.tsx',
    ];
    for (const path of sources) {
      const source = await Bun.file(path).text();
      expect(source).toContain('resetAccountName(file)');
      const resetCalls = source.match(
        /t\(\s*'(?:claude_reset|codex_quota\.reset|quota_pool\.reset)[^']*',\s*\{[^}]*\}/g
      );
      expect(resetCalls?.length ?? 0).toBeGreaterThan(0);
      for (const call of resetCalls ?? []) expect(call).not.toContain('file.name');
      expect(source).not.toMatch(/<ClaudeResetChooser[^>]*name=\{file\.name\}/);
      expect(source).not.toMatch(/value=\{name\}/);
    }
  });
});
