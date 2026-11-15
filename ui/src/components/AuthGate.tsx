// Feature screens render only once the server has answered the capability request: with a token prompt when it asked
// for one, and an error banner when it could not be reached. The screen itself never sees an unauthenticated state.
import type { ReactNode } from 'react';
import { useApi } from '../api/context';
import { useCapabilities } from '../api/capabilities';
import { ErrorBanner } from './ErrorBanner';
import { TokenForm } from './TokenForm';

export function AuthGate({ title, children }: { title: string; children: ReactNode }) {
  const { state, reload } = useCapabilities();
  const api = useApi();
  if (state.kind === 'ok') return <>{children}</>;
  return (
    <section aria-labelledby="gate-h" className="gw-page">
      <h1 id="gate-h">{title}</h1>
      {state.kind === 'loading' && <p role="status">Checking the server...</p>}
      {state.kind === 'error' && <ErrorBanner error={state.error} onRetry={() => void reload()} />}
      {state.kind === 'auth' && (
        <div className="gw-card">
          <TokenForm
            wrong={state.wrong}
            waitSeconds={state.waitSeconds}
            busy={state.busy}
            onSubmit={(t) => {
              api.setToken(t);
              void reload(true);
            }}
          />
        </div>
      )}
    </section>
  );
}
