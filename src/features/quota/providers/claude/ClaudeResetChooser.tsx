import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/Button';
import { IconAlertTriangle } from '@/components/ui/icons';
import { formatPoolDate } from '@/features/quotaPool/presentation';
import { useNow } from '@/hooks/useNow';
import type { AnthropicResetGrant } from '@/services/api/claudeResetGrants';
import { useNotificationStore } from '@/stores';
import { formatRelativeInstant } from '@/utils/quota';
import type { ResetGrantChoice } from './selectResetGrant';
import styles from './ClaudeResetChooser.module.scss';

type Props = {
  name: string;
  /** Usable choices in spend order, soonest expiry first. */
  choices: ResetGrantChoice[];
  /** Spends one reset from this grant; the dialog stays open and busy until it settles. */
  onUse: (grant: AnthropicResetGrant) => Promise<void>;
};

/**
 * The reset dialog's body: one row per kind and expiry, each with its own Use button, laid out as
 * borderless table columns (kind, expiry, action) so the rows read across.
 */
export function ClaudeResetChooser({ name, choices, onUse }: Props) {
  const { t, i18n } = useTranslation();
  const now = useNow();
  const busy = useNotificationStore((state) => state.confirmation.isLoading);
  const [using, setUsing] = useState<string | null>(null);
  return (
    <div className={styles.chooser}>
      <p>
        {t(choices.length > 1 ? 'claude_reset.choose_intro' : 'claude_reset.confirm_text', {
          name,
        })}
      </p>
      <ul className={styles.rows}>
        {choices.map(({ grant, count }) => {
          const end = grant.endsAt ? Date.parse(grant.endsAt) : NaN;
          const kind = t(`claude_reset.kind_${grant.kind}`);
          const date = Number.isFinite(end) ? formatPoolDate(end, i18n.language) : null;
          return (
            <li key={grant.id} className={styles.row}>
              <span className={styles.kind} data-kind={grant.kind}>
                {kind}
                {count > 1 && ` × ${count}`}
              </span>
              <span className={styles.when}>
                <span>
                  {date
                    ? t('claude_reset.choice_expires', { date })
                    : t('claude_reset.choice_no_expiry')}
                </span>
                <span className={styles.detail}>
                  {[
                    date && formatRelativeInstant(end, now, i18n.language),
                    count > 1 && t('claude_reset.choice_uses_one', { count }),
                  ]
                    .filter(Boolean)
                    .join(' · ')}
                </span>
              </span>
              <Button
                size="sm"
                variant="secondary"
                aria-label={t('claude_reset.use_kind', { kind })}
                disabled={busy}
                loading={busy && using === grant.id}
                onClick={() => {
                  setUsing(grant.id);
                  void onUse(grant);
                }}
              >
                {t('claude_reset.use_short')}
              </Button>
              {/* What a Fable reset does is what decides the pick, so it sits under its row. */}
              {grant.kind === 'fable' && (
                <span className={styles.note}>{t('claude_reset.kind_fable_note')}</span>
              )}
            </li>
          );
        })}
      </ul>
      <p className={styles.warning}>
        <IconAlertTriangle size={14} aria-hidden="true" />
        {t('claude_reset.irreversible')}
      </p>
    </div>
  );
}
