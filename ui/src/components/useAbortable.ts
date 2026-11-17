import { useCallback, useEffect, useRef } from 'react';

/**
 * One cancellable request at a time for a screen. `begin()` aborts any earlier request and returns the signal for the new
 * one; `cancel()` aborts it (a Cancel button); leaving the screen aborts it too, so a stalled or abandoned call stops
 * instead of running on with its answer thrown away.
 */
export function useAbortable(): { begin(): AbortSignal; cancel(): void } {
  const current = useRef<AbortController | undefined>(undefined);
  useEffect(() => () => current.current?.abort(), []);
  const begin = useCallback(() => {
    current.current?.abort();
    current.current = new AbortController();
    return current.current.signal;
  }, []);
  const cancel = useCallback(() => current.current?.abort(), []);
  return { begin, cancel };
}
