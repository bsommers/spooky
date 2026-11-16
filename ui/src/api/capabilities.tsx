// The server's capability document, loaded once for the whole app. It decides which screens are usable (Score and
// Humanize only when the server lists them) and drives the token prompt: a 401 here means every screen needs the token.
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { ApiError } from './client';
import type { GetResponse } from './client';
import { useApi } from './context';

export type Capabilities = GetResponse<'/api/capabilities'>;
export type CapsState =
  | { kind: 'loading' }
  | { kind: 'ok'; caps: Capabilities }
  | { kind: 'auth'; wrong: boolean; waitSeconds?: number; busy?: boolean }
  | { kind: 'error'; error: ApiError };

interface CapsValue {
  state: CapsState;
  /** Ask the server again. `wrongToken` marks the attempt as one made with a token the user just typed. */
  reload(wrongToken?: boolean): Promise<void>;
  /** True when the server lists the operation. False while unknown, so a gated panel never flashes as available. */
  has(operation: string): boolean;
}

const CapsContext = createContext<CapsValue | undefined>(undefined);

export function CapabilitiesProvider({ children }: { children: ReactNode }) {
  const api = useApi();
  const [state, setState] = useState<CapsState>({ kind: 'loading' });
  const seq = useRef(0); // only the newest reload may write the state: an older answer arriving late is dropped

  const reload = useCallback(
    async (wrongToken = false) => {
      // Keep the token form mounted while a submitted token is being checked, so keyboard focus is not dropped to <body>.
      const mine = ++seq.current;
      setState((prev) => (prev.kind === 'auth' ? { ...prev, busy: true } : { kind: 'loading' }));
      try {
        const caps = await api.get('/api/capabilities');
        if (seq.current === mine) setState({ kind: 'ok', caps });
      } catch (e) {
        if (seq.current !== mine) return;
        if (e instanceof ApiError && e.unauthorized) {
          // Forget the rejected token: otherwise every remount resends it and the server counts each as a wrong guess.
          api.setToken(undefined);
          setState({ kind: 'auth', wrong: wrongToken });
        } else if (e instanceof ApiError && e.status === 429 && e.code === 'RATE_LIMITED') {
          // The server's lockout after too many wrong tokens (it refuses even the right one meanwhile): forget the guess.
          // Any other 429 is not about the token and is shown as the ordinary error below.
          api.setToken(undefined);
          setState({ kind: 'auth', wrong: true, ...(e.retryAfterSeconds === undefined ? {} : { waitSeconds: e.retryAfterSeconds }) });
        } else {
          setState({ kind: 'error', error: e instanceof ApiError ? e : new ApiError(0, 'INTERNAL', 'something went wrong') });
        }
      }
    },
    [api],
  );

  useEffect(() => {
    void reload();
  }, [reload]);

  // Any later request answered 401 (the token expired, the server restarted with another one, a wrong token was typed under
  // Settings): the client has dropped it, so go back to asking for one instead of leaving screens that all fail.
  useEffect(() => api.onUnauthorized((hadToken) => setState((prev) => (prev.kind === 'ok' ? { kind: 'auth', wrong: hadToken } : prev))), [api]);

  const value = useMemo<CapsValue>(
    () => ({ state, reload, has: (op) => state.kind === 'ok' && state.caps.operations.some((o) => o.name === op) }),
    [state, reload],
  );
  return <CapsContext.Provider value={value}>{children}</CapsContext.Provider>;
}

export function useCapabilities(): CapsValue {
  const v = useContext(CapsContext);
  if (v === undefined) throw new Error('useCapabilities must be used inside <CapabilitiesProvider>');
  return v;
}
