import { createContext, useContext, useMemo } from 'react';
import type { ReactNode } from 'react';
import { createApiClient } from './client';
import type { ApiClient } from './client';

const ApiContext = createContext<ApiClient | undefined>(undefined);

export function ApiProvider({ children, client }: { children: ReactNode; client?: ApiClient }) {
  const value = useMemo(() => client ?? createApiClient(), [client]);
  return <ApiContext.Provider value={value}>{children}</ApiContext.Provider>;
}

export function useApi(): ApiClient {
  const v = useContext(ApiContext);
  if (v === undefined) throw new Error('useApi must be used inside <ApiProvider>');
  return v;
}
