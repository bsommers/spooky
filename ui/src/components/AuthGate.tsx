// Feature screens render only once the server has answered the capability request: with a token prompt when it asked
// for one, and an error banner when it could not be reached. The screen itself never sees an unauthenticated state.
import { useEffect, useRef } from 'react';
import type { ReactNode } from 'react';
import { useApi } from '../api/context';
import { useCapabilities } from '../api/capabilities';
import { useAnnounce } from './Announcer';
import { ErrorBanner } from './ErrorBanner';
import { TokenForm } from './TokenForm';

export function AuthGate({ title, children }: { title: string; children: ReactNode }) {
  const { state, reload } = useCapabilities();
  const api = useApi();
  const announce = useAnnounce();
  const submitted = useRef(false);

  // The token form that had focus is replaced by the screen: without this, focus falls to <body> and the keyboard or screen
  // reader user starts again from the top of the page. Move it to the content landmark (always present) and say why.
  useEffect(() => {
    if (state.kind === 'ok' && submitted.current) {
      submitted.current = false;
      document.getElementById('main')?.focus();
      announce('Connected');
    }
  }, [state.kind, announce]);

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
              submitted.current = true;
              api.setToken(t);
              void reload(true);
            }}
          />
        </div>
      )}
    </section>
  );
}
