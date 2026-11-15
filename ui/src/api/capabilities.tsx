// The server's capability document, loaded once for the whole app. It decides which screens are usable (Score and
// Humanize only when the server lists them) and drives the token prompt: a 401 here means every screen needs the token.
import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
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

  const reload = useCallback(
    async (wrongToken = false) => {
      // Keep the token form mounted while a submitted token is being checked, so keyboard focus is not dropped to <body>.
      setState((prev) => (prev.kind === 'auth' ? { ...prev, busy: true } : { kind: 'loading' }));
      try {
        setState({ kind: 'ok', caps: await api.get('/api/capabilities') });
      } catch (e) {
        if (e instanceof ApiError && e.unauthorized) {
          // Forget the rejected token: otherwise every remount resends it and the server counts each as a wrong guess.
          api.setToken(undefined);
          setState({ kind: 'auth', wrong: wrongToken });
        } else if (e instanceof ApiError && e.status === 429) {
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
