import { useEffect, useRef } from 'react';
import { useCapabilities } from '../../api/capabilities';
import { useApi } from '../../api/context';
import { ErrorBanner } from '../../components/ErrorBanner';
import { TokenForm } from '../../components/TokenForm';
import { CheckIcon } from '../../icons';

export function Overview() {
  const api = useApi();
  const { state, reload } = useCapabilities();
  const heading = useRef<HTMLHeadingElement>(null);
  const submitted = useRef(false);
  const mountedState = useRef(state.kind);

  // Coming back to this page after a failure asks the server again; a first load is already in flight from the provider.
  useEffect(() => {
    if (mountedState.current === 'auth' || mountedState.current === 'error') void reload();
  }, [reload]);

  // The form that had focus is replaced by the result: move focus to the result's heading instead of losing it.
  useEffect(() => {
    if (state.kind === 'ok' && submitted.current) {
      submitted.current = false;
      heading.current?.focus();
    }
  }, [state.kind]);

  return (
    <section aria-labelledby="ov-h" className="gw-page">
      <h1 id="ov-h">Overview</h1>
      <p className="gw-lede">Write in an author&apos;s voice, for the audience you have in mind. Ingest an author, pick a persona, generate; or score and humanize a draft. This page shows the server this app is talking to.</p>
      <div className="gw-card">
        <h2 tabIndex={-1} ref={heading}>
          Server
        </h2>
        {state.kind === 'loading' && <p role="status">Checking the server...</p>}
        {state.kind === 'error' && <ErrorBanner error={state.error} onRetry={() => void reload()} />}
        {state.kind === 'auth' && (
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
        )}
        {state.kind === 'ok' && (
          <>
            <p className="gw-status gw-status--success" role="status">
              <CheckIcon size={18} /> Connected. {state.caps.operations.length} operations available
              {state.caps.pending.length > 0 ? `, ${state.caps.pending.length} planned` : ''}.
            </p>
            <table className="gw-table">
              <caption className="gw-sr-only">Operations offered by this server</caption>
              <thead>
                <tr>
                  <th scope="col">Operation</th>
                  <th scope="col">HTTP</th>
                  <th scope="col">CLI</th>
                </tr>
              </thead>
              <tbody>
                {state.caps.operations.map((op) => (
                  <tr key={op.name}>
                    <th scope="row">{op.name}</th>
                    <td>
                      <code>
                        {op.http.method} {op.http.path}
                      </code>
                    </td>
                    <td>
                      <code>{op.cli}</code>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </>
        )}
      </div>
    </section>
  );
}
