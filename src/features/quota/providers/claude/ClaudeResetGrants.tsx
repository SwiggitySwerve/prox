import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { TFunction } from 'i18next';
import { useNow } from '@/hooks/useNow';
import { useAuthStore } from '@/stores/useAuthStore';
import { useNotificationStore } from '@/stores';
import {
  AnthropicResetGrantError,
  type AnthropicResetGrant,
  type AnthropicResetGrantStatus,
} from '@/services/api/claudeResetGrants';
import type { AuthFileItem } from '@/types';
import { normalizeAuthIndex } from '@/utils/quota';
import { formatPoolDate } from '@/features/quotaPool/presentation';
import {
  RETRY_WINDOW_MS,
  ResetGrantPreflightError,
  resetGrantFailureMessageKey,
} from './resetGrantOperations';
import { resetGrantChoices, selectResetGrant } from './selectResetGrant';
import { ClaudeResetChooser } from './ClaudeResetChooser';
import { scheduleResetGrantRead } from './resetGrantReads';
import type { ResetGrantScope } from './resetGrantScope';

/** A retry spends the same reset as the first try, so its dialog names that reset. */
export function retryResetText(grant: AnthropicResetGrant, t: TFunction, language: string) {
  const end = grant.endsAt ? Date.parse(grant.endsAt) : NaN;
  const kind = t(`claude_reset.kind_${grant.kind}`);
  return Number.isFinite(end)
    ? t('claude_reset.retry_reset_date', { kind, date: formatPoolDate(end, language) })
    : t('claude_reset.retry_reset', { kind });
}

/** Card-owned reads; the session-scoped journal owns spending and ambiguous retries. */
export function useClaudeResetGrants(
  file: AuthFileItem,
  enabled: boolean,
  disabled: boolean,
  refreshToken: unknown,
  onRefresh: () => void,
  scope: ResetGrantScope
) {
  const { t, i18n } = useTranslation();
  const connectionStatus = useAuthStore((state) => state.connectionStatus);
  const [session] = useState(() => scope.revision());
  const sessionActive =
    connectionStatus === 'connected' && scope.current() && session === scope.revision();
  const showConfirmation = useNotificationStore((state) => state.showConfirmation);
  const showNotification = useNotificationStore((state) => state.showNotification);
  const now = useNow();
  const authIndex = normalizeAuthIndex(file.auth_index ?? file.authIndex);
  const key = JSON.stringify([file.name, authIndex]);
  const [status, setStatus] = useState<AnthropicResetGrantStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [reload, setReload] = useState(0);
  const lock = useRef(false);
  const generation = useRef(0);
  useEffect(() => {
    const version = ++generation.current;
    setStatus(null);
    if (!enabled || disabled || !sessionActive || !authIndex) return;
    let cancelled = false;
    const current = () =>
      !cancelled &&
      version === generation.current &&
      scope.current() &&
      session === scope.revision();
    const cancelRead = scheduleResetGrantRead(() => {
      void scope.read(authIndex).then(
        (result) => {
          if (current()) {
            setStatus(result);
            setMessage('');
          }
        },
        (error: unknown) => {
          if (current()) {
            setMessage(
              error instanceof AnthropicResetGrantError && error.code === 'rate_limited'
                ? 'rate_limited'
                : 'read_error'
            );
          }
        }
      );
    }, current);
    return () => {
      cancelled = true;
      cancelRead();
      generation.current += 1;
    };
  }, [authIndex, key, enabled, disabled, sessionActive, session, refreshToken, reload, scope]);

  const operation = scope.operations.inspect(key);
  const pending = operation && !operation.code ? operation : undefined;
  const expired = Boolean(pending && now - pending.createdAt >= RETRY_WINDOW_MS);
  const selected = pending?.grantId ?? (status ? selectResetGrant(status, now)?.id : undefined);
  const selectedGrant = status?.grants.find((grant) => grant.id === selected);
  // What the operator can pick from; a pending claim may only be retried as it was.
  const choices = status && !pending ? resetGrantChoices(status, now) : [];
  const blocked = disabled || !sessionActive || !authIndex || busy || expired || !selected;
  const confirm = () => {
    if (blocked || lock.current || !selected || !authIndex) return;
    const version = generation.current;
    const current = () =>
      scope.current() && session === scope.revision() && version === generation.current;
    const spend = async (grantId: string) => {
      if (!current() || lock.current || useAuthStore.getState().connectionStatus !== 'connected')
        return;
      lock.current = true;
      setBusy(true);
      try {
        const answer = await scope.operations.run(key, authIndex, grantId);
        if (!current()) return;
        showNotification(
          t(`claude_reset.${answer.unresolved ? 'unknown' : answer.code}`),
          !answer.unresolved && (answer.code === 'reset' || answer.code === 'already_used')
            ? 'success'
            : 'error'
        );
      } catch (error: unknown) {
        if (!current()) return;
        const unresolved = scope.operations.inspect(key);
        showNotification(
          t(
            unresolved && !unresolved.code
              ? 'claude_reset.unknown'
              : resetGrantFailureMessageKey(error),
            {
              code: error instanceof ResetGrantPreflightError ? error.reason : '',
            }
          ),
          'error'
        );
      } finally {
        lock.current = false;
        // A concurrent page-wide refresh can invalidate this read generation.
        // Release the local lock regardless, but never refresh a replacement account.
        setBusy(false);
        setReload((value) => value + 1);
        if (current()) onRefresh();
      }
    };
    showConfirmation({
      title: t(choices.length > 1 ? 'claude_reset.choose_title' : 'quota_pool.reset_confirm_title'),
      message: pending ? (
        [
          t('claude_reset.retry_confirm', { name: file.name }),
          selectedGrant ? retryResetText(selectedGrant, t, i18n.language) : '',
        ]
          .filter(Boolean)
          .join(' ')
      ) : (
        <ClaudeResetChooser
          name={file.name}
          choices={choices}
          onUse={async (grant) => {
            const dialog = useNotificationStore.getState();
            dialog.setConfirmationLoading(true);
            try {
              await spend(grant.id);
            } finally {
              dialog.setConfirmationLoading(false);
              dialog.hideConfirmation();
            }
          }}
        />
      ),
      // Each choice carries its own Use button; only a retry confirms in the footer.
      hideConfirm: !pending,
      confirmText: t('claude_reset.retry'),
      variant: 'primary',
      onConfirm: () => spend(selected),
    });
  };
  return {
    count: status?.grants.reduce((sum, grant) => sum + grant.resetsLeft, 0) ?? null,
    grants: status?.grants ?? [],
    busy,
    blocked,
    confirm,
    message: pending ? (expired ? 'expired' : 'unknown') : message,
    /** "choose" when the dialog offers two or more resets to pick from. */
    buttonLabel: pending ? 'retry' : choices.length > 1 ? 'choose' : 'use',
  };
}
