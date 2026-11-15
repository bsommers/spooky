import { useCallback, useEffect, useRef, useState } from 'react';
import type { ApiError } from '../api/client';
import { toApiError } from './errors';

export type Load<T> = { kind: 'loading' } | { kind: 'ok'; data: T } | { kind: 'error'; error: ApiError };

/**
 * Run `fn` when the screen opens or `deps` change, and again on `reload()`. A change of `deps` shows "loading" (the old
 * answer belongs to something else); `reload()` keeps showing the current answer until the new one arrives, so a list
 * does not flash empty after an ingest. An answer that arrives after a newer request or an unmount is dropped.
 */
export function useLoad<T>(fn: () => Promise<T>, deps: readonly unknown[]): [Load<T>, () => void] {
  const [state, setState] = useState<Load<T>>({ kind: 'loading' });
  const seq = useRef(0);
  const run = useCallback(fn, deps);
  const start = useCallback(
    (soft: boolean) => {
      const mine = ++seq.current;
      setState((prev) => (soft && prev.kind === 'ok' ? prev : { kind: 'loading' }));
      run().then(
        (data) => {
          if (seq.current === mine) setState({ kind: 'ok', data });
        },
        (e: unknown) => {
          if (seq.current === mine) setState({ kind: 'error', error: toApiError(e) });
        },
      );
    },
    [run],
  );
  useEffect(() => {
    start(false);
    return () => {
      seq.current++;
    };
  }, [start]);
  const reload = useCallback(() => start(true), [start]);
  return [state, reload];
}
