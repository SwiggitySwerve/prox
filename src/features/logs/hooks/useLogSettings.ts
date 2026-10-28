import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createConfigApi } from '@/services/api/config';
import type { SourceSession } from '@/services/api/sourceSession';
import type { Config } from '@/types';
import { getErrorMessage } from '@/utils/helpers';

/** Logging controls must describe the same source as the cursor and downloads. */
export function useLogSettings(session: SourceSession) {
  const api = useMemo(() => createConfigApi(session), [session]);
  const [config, setConfig] = useState<Config>();
  const [error, setError] = useState('');
  const revision = useRef(0);
  const mounted = useRef(true);
  const refreshSettings = useCallback(async () => {
    if (!mounted.current || session.signal.aborted) return;
    const request = ++revision.current;
    try {
      const value = await api.getConfig();
      if (!mounted.current || session.signal.aborted || revision.current !== request) return;
      setConfig(value);
      setError('');
      return value;
    } catch (failure: unknown) {
      if (!mounted.current || session.signal.aborted || revision.current !== request) return;
      setError(getErrorMessage(failure));
    }
  }, [api, session]);
  useEffect(() => {
    mounted.current = true;
    void refreshSettings();
    return () => {
      mounted.current = false;
      revision.current += 1;
    };
  }, [refreshSettings]);
  return { config, error, refreshSettings };
}
