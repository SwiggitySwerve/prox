import { useEffect, useLayoutEffect, useRef, useState, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { useLocalStorage } from '@/hooks/useLocalStorage';
import { useNotificationStore } from '@/stores';
import { createLogsApi } from '@/services/api/logs';
import { useSelectedSourceSession } from '@/components/sources/SelectedSourceBoundary';
import { getErrorMessage } from '@/utils/helpers';
import {
  applyLogPage,
  buildLogsQuery,
  emptyLogBuffer,
  shouldCatchUp,
  INITIAL_VISIBLE_LINES,
} from '../model/logBuffer';
import { createLogRequestGuard, createLogRequestQueue } from '../model/logRequests';

const INITIAL_DISPLAY_LINES = INITIAL_VISIBLE_LINES;

const getErrorPayloadText = (err: unknown): string => {
  if (typeof err !== 'object' || err === null) return '';
  const payloads = [
    (err as { data?: unknown }).data,
    (err as { details?: unknown }).details,
  ].filter((payload) => payload !== undefined);
  return payloads
    .map((payload) => {
      if (typeof payload === 'string') return payload;
      try {
        return JSON.stringify(payload);
      } catch {
        return '';
      }
    })
    .join(' ');
};

const isLoggingToFileDisabledError = (err: unknown): boolean => {
  const text = `${getErrorMessage(err)} ${getErrorPayloadText(err)}`.toLowerCase();
  return text.includes('logging to file disabled');
};

type LogStreamOptions = {
  active: boolean;
  loggingToFileEnabled: boolean;
  isFollowing: () => boolean;
  onFollow: () => void;
};

/** Owns application-log requests and invalidates synchronously, including A→B→A switches. */
export function useLogStream({
  active,
  isFollowing,
  onFollow,
  loggingToFileEnabled,
}: LogStreamOptions) {
  const { t } = useTranslation();
  const { showNotification, showConfirmation } = useNotificationStore();
  const sourceSession = useSelectedSourceSession();
  const logsApi = useMemo(() => createLogsApi(sourceSession), [sourceSession]);
  const loggingEnabledRef = useRef(loggingToFileEnabled);
  useLayoutEffect(() => {
    loggingEnabledRef.current = loggingToFileEnabled;
  }, [loggingToFileEnabled]);
  const cpaNeedsFileLogging = !loggingToFileEnabled;
  const [fileLoggingRequired, setFileLoggingRequired] = useState(false);
  const showFileLoggingRequired = cpaNeedsFileLogging || fileLoggingRequired;
  const [requests] = useState(() => ({
    session: createLogRequestGuard(),
    logs: createLogRequestQueue(),
  }));
  const [logBuffer, setLogBuffer] = useState(emptyLogBuffer);
  const logBufferRef = useRef(logBuffer);
  const [visibleCount, setVisibleCount] = useState(INITIAL_DISPLAY_LINES);
  const [lastUpdated, setLastUpdated] = useState<number>();
  const [catchingUp, setCatchingUp] = useState(false);
  const [wasReset, setWasReset] = useState(false);
  const retryDelayRef = useRef(8000);
  const nextReadAtRef = useRef(0);
  const [loading, setLoading] = useState(true);
  const [clearingLogs, setClearingLogs] = useState(false);
  const [error, setError] = useState('');
  const [autoRefresh, setAutoRefresh] = useLocalStorage('logsPage.autoRefresh', false);
  const autoRefreshRef = useRef(autoRefresh);
  useLayoutEffect(() => {
    autoRefreshRef.current = autoRefresh;
  }, [autoRefresh]);
  const resetLogPosition = () => {
    const empty = emptyLogBuffer();
    logBufferRef.current = empty;
    setLogBuffer(empty);
    setVisibleCount(INITIAL_DISPLAY_LINES);
    setLastUpdated(undefined);
    setWasReset(false);
    setCatchingUp(false);
    nextReadAtRef.current = 0;
    retryDelayRef.current = 8000;
  };

  async function loadLogs(incremental = false) {
    // Queued reloads must read live context, not the render that started the old request.
    if (sourceSession.signal.aborted) {
      setLoading(false);
      return;
    }

    if (!loggingEnabledRef.current) {
      if (!incremental) {
        resetLogPosition();
        setFileLoggingRequired(false);
        setError('');
        setLoading(false);
      }
      return;
    }

    const request = requests.logs.startRead(incremental);
    if (request === null) return;

    if (logBufferRef.current.buffer.length === 0) setLoading(true);

    try {
      // One owner drains at most three pages, then yields to the UI and other actions.
      for (let page = 0; page < 3; page++) {
        const cursor = logBufferRef.current.cursor;
        const data = await logsApi.fetchLogs(buildLogsQuery(cursor));
        if (sourceSession.signal.aborted || !requests.logs.isCurrent(request)) return;
        const stickToBottom = isFollowing();
        const next = applyLogPage(logBufferRef.current, data, cursor);
        const added = next.nextId - logBufferRef.current.nextId;
        logBufferRef.current = next;
        setLogBuffer(next);
        if (data.cursorReset) {
          setWasReset(true);
          setVisibleCount(INITIAL_DISPLAY_LINES);
        } else if (!stickToBottom) {
          setVisibleCount((count) => Math.min(next.buffer.length, count + added));
        }
        if (stickToBottom) onFollow();
        setFileLoggingRequired(false);
        setError('');
        setLastUpdated(Date.now());
        retryDelayRef.current = 8000;
        const more = shouldCatchUp(data, cursor);
        setCatchingUp(more);
        nextReadAtRef.current = Date.now() + (more ? 1000 : 8000);
        if (!more || (incremental && !autoRefreshRef.current)) break;
      }
    } catch (err: unknown) {
      if (sourceSession.signal.aborted || !requests.logs.isCurrent(request)) return;
      setCatchingUp(false);
      if (isLoggingToFileDisabledError(err)) {
        setFileLoggingRequired(true);
        setError('');
        return;
      }
      setError(getErrorMessage(err) || t('logs.load_error'));
      nextReadAtRef.current = Date.now() + retryDelayRef.current;
      retryDelayRef.current = Math.min(retryDelayRef.current * 2, 60000);
    } finally {
      if (!sourceSession.signal.aborted && requests.logs.isCurrent(request)) {
        setLoading(false);
        if (requests.logs.finish(request)) void loadLogs(false);
      }
    }
  }

  const clearLogs = async () => {
    if (cpaNeedsFileLogging) {
      showNotification(t('logs.cpa_file_logging_required'), 'warning');
      return;
    }
    if (fileLoggingRequired) {
      showNotification(t('logs.file_logging_required'), 'warning');
      return;
    }
    const session = requests.session.capture();
    showConfirmation({
      title: t('logs.clear_confirm_title', { defaultValue: 'Clear Logs' }),
      message: t('logs.clear_application_confirm'),
      variant: 'danger',
      confirmText: t('common.confirm'),
      onConfirm: async () => {
        if (!requests.session.isCurrent(session)) return;
        if (sourceSession.signal.aborted) return;
        if (!loggingEnabledRef.current) return;
        const request = requests.logs.startClear();
        if (request === null) return;
        setClearingLogs(true);
        setLoading(false);
        setError('');
        let clearFailed = false;
        try {
          await logsApi.clearLogs();
          if (sourceSession.signal.aborted || !requests.logs.isCurrent(request)) return;
          resetLogPosition();
          setFileLoggingRequired(false);
          showNotification(t('logs.clear_success'), 'success');
        } catch (err: unknown) {
          if (sourceSession.signal.aborted || !requests.logs.isCurrent(request)) return;
          clearFailed = true;
          const message = getErrorMessage(err);
          showNotification(
            `${t('notification.delete_failed')}${message ? `: ${message}` : ''}`,
            'error'
          );
        } finally {
          if (!sourceSession.signal.aborted && requests.logs.isCurrent(request)) {
            setClearingLogs(false);
            // Clear superseded the old read; recover it even when deletion fails.
            if (requests.logs.finish(request, clearFailed)) void loadLogs(false);
          }
        }
      },
    });
  };

  useEffect(() => {
    const resetLogs = () => {
      requests.logs.invalidate();
      resetLogPosition();
      setLoading(false);
      setClearingLogs(false);
      setError('');
      setFileLoggingRequired(false);
    };
    const invalidateSession = () => {
      requests.session.invalidate();
      requests.logs.invalidate();
    };
    const invalidate = () => {
      invalidateSession();
      resetLogs();
    };
    sourceSession.signal.addEventListener('abort', invalidate);
    return () => {
      sourceSession.signal.removeEventListener('abort', invalidate);
      invalidateSession();
    };
  }, [requests, sourceSession]);

  useEffect(() => {
    requests.session.invalidate();
    requests.logs.invalidate();
    if (!sourceSession.signal.aborted) {
      resetLogPosition();
      setFileLoggingRequired(false);
      loadLogs(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sourceSession, loggingToFileEnabled]);

  useEffect(() => {
    if (!autoRefresh || !active || sourceSession.signal.aborted || showFileLoggingRequired) {
      return;
    }
    const id = window.setInterval(() => {
      if (document.visibilityState === 'hidden' || Date.now() < nextReadAtRef.current) return;
      void loadLogs(true);
    }, 1000);
    return () => window.clearInterval(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoRefresh, active, sourceSession, showFileLoggingRequired]);

  return {
    logBuffer,
    visibleCount,
    setVisibleCount,
    lastUpdated,
    catchingUp,
    wasReset,
    loading,
    clearingLogs,
    error,
    autoRefresh,
    setAutoRefresh,
    cpaNeedsFileLogging,
    showFileLoggingRequired,
    loadLogs,
    clearLogs,
  };
}
