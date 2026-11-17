import { useState } from 'react';
import { Button, FieldError, Form, Input, Label, TextField } from 'react-aria-components';
import { isHeaderSafe } from '../api/client';
import { WarningIcon } from '../icons';

export interface TokenFormProps {
  wrong: boolean;
  waitSeconds?: number | undefined;
  busy?: boolean | undefined;
  onSubmit(token: string): void;
}

/** The server asks for a bearer token. It is typed into a password field, handed to the API client (memory only) and never stored. */
export function TokenForm({ wrong, waitSeconds, busy, onSubmit }: TokenFormProps) {
  const [unsafe, setUnsafe] = useState(false);
  return (
    <Form
      className="gw-form"
      onSubmit={(e) => {
        e.preventDefault();
        const value = String(new FormData(e.currentTarget).get('token') ?? '').trim(); // a pasted newline or space is not part of the token
        if (busy === true) return;
        if (!isHeaderSafe(value)) {
          setUnsafe(true);
          return;
        }
        setUnsafe(false);
        onSubmit(value);
      }}
    >
      <p className="gw-status gw-status--warning" role="alert">
        <WarningIcon size={18} />
        {wrong ? (waitSeconds === undefined ? 'That token was not accepted.' : `Too many attempts; try again in ${waitSeconds} seconds.`) : 'This server asks for an API token.'}
      </p>
      <TextField name="token" type="password" isRequired autoComplete="off" className="gw-field" isInvalid={unsafe} onChange={() => setUnsafe(false)}>
        <Label className="gw-label">API token</Label>
        <Input className="gw-input" spellCheck={false} />
        <FieldError className="gw-field__error">
          {({ validationErrors }) => (unsafe ? 'The token contains characters that cannot be sent. Paste it again, exactly as the server printed it.' : validationErrors.join(' '))}
        </FieldError>
      </TextField>
      <p className="gw-hint">The token stays in this page&apos;s memory only. Reloading the page forgets it.</p>
      <Button type="submit" className="gw-btn gw-btn--primary" aria-disabled={busy === true || undefined}>
        {busy === true ? 'Checking...' : 'Connect'}
      </Button>
    </Form>
  );
}
