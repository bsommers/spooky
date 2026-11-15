import { useCallback, useEffect, useRef, useState } from 'react';
import { Button, FieldError, Form, Input, Label, TextField } from 'react-aria-components';
import { ApiError } from '../../api/client';
import type { GetResponse } from '../../api/client';
import { useApi } from '../../api/context';
import { CheckIcon, WarningIcon } from '../../icons';

type Capabilities = GetResponse<'/api/capabilities'>;
type State =
  | { kind: 'loading' }
  | { kind: 'ok'; caps: Capabilities }
  | { kind: 'auth'; wrong: boolean; waitSeconds?: number; busy?: boolean }
  | { kind: 'error'; message: string };

export function Overview() {
  const api = useApi();
  const [state, setState] = useState<State>({ kind: 'loading' });
  const heading = useRef<HTMLHeadingElement>(null);
  const submitted = useRef(false);

  const load = useCallback(
    async (wrongToken = false) => {
      // Keep the token form mounted while a submitted token is being checked, so keyboard focus is not dropped to <body>.
      setState((prev) => (prev.kind === 'auth' ? { ...prev, busy: true } : { kind: 'loading' }));
      try {
        setState({ kind: 'ok', caps: await api.get('/api/capabilities') });
      } catch (e) {
        if (e instanceof ApiError && e.unauthorized) {
          // Forget the rejected token: otherwise every remount (navigation, StrictMode) resends it and the server counts each as a wrong guess.
          api.setToken(undefined);
          setState({ kind: 'auth', wrong: wrongToken });
        } else if (e instanceof ApiError && e.status === 429) setState({ kind: 'auth', wrong: true, ...(e.retryAfterSeconds === undefined ? {} : { waitSeconds: e.retryAfterSeconds }) });
        else setState({ kind: 'error', message: e instanceof ApiError ? e.message : 'something went wrong' });
      }
    },
    [api],
  );

  useEffect(() => {
    void load();
  }, [load]);

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
      <p className="gw-lede">Write in an author&apos;s voice, for the audience you have in mind. The screens for that arrive next; this page shows the server this app is talking to.</p>
      <div className="gw-card">
        <h2 tabIndex={-1} ref={heading}>
          Server
        </h2>
        {state.kind === 'loading' && <p role="status">Checking the server...</p>}
        {state.kind === 'error' && (
          <p role="alert" className="gw-status gw-status--danger">
            <WarningIcon size={18} /> {state.message}
          </p>
        )}
        {state.kind === 'auth' && (
          <Form
            className="gw-form"
            onSubmit={(e) => {
              e.preventDefault();
              const value = String(new FormData(e.currentTarget).get('token') ?? '');
              if (state.busy === true) return;
              submitted.current = true;
              api.setToken(value);
              void load(true);
            }}
          >
            <p className="gw-status gw-status--warning" role="alert">
              <WarningIcon size={18} />
              {state.wrong ? (state.waitSeconds === undefined ? 'That token was not accepted.' : `Too many wrong tokens; try again in ${state.waitSeconds} seconds.`) : 'This server asks for an API token.'}
            </p>
            <TextField name="token" type="password" isRequired autoComplete="off" className="gw-field">
              <Label className="gw-label">API token</Label>
              <Input className="gw-input" spellCheck={false} />
              <FieldError className="gw-field__error" />
            </TextField>
            <p className="gw-hint">The token stays in this page&apos;s memory only. Reloading the page forgets it.</p>
            <Button type="submit" className="gw-btn gw-btn--primary" isPending={state.busy === true}>
              {state.busy === true ? 'Checking...' : 'Connect'}
            </Button>
          </Form>
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
