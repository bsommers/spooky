import { Button, FieldError, Form, Input, Label, TextField } from 'react-aria-components';
import { WarningIcon } from '../icons';

export interface TokenFormProps {
  wrong: boolean;
  waitSeconds?: number | undefined;
  busy?: boolean | undefined;
  onSubmit(token: string): void;
}

/** The server asks for a bearer token. It is typed into a password field, handed to the API client (memory only) and never stored. */
export function TokenForm({ wrong, waitSeconds, busy, onSubmit }: TokenFormProps) {
  return (
    <Form
      className="gw-form"
      onSubmit={(e) => {
        e.preventDefault();
        const value = String(new FormData(e.currentTarget).get('token') ?? '');
        if (busy === true) return;
        onSubmit(value);
      }}
    >
      <p className="gw-status gw-status--warning" role="alert">
        <WarningIcon size={18} />
        {wrong ? (waitSeconds === undefined ? 'That token was not accepted.' : `Too many wrong tokens; try again in ${waitSeconds} seconds.`) : 'This server asks for an API token.'}
      </p>
      <TextField name="token" type="password" isRequired autoComplete="off" className="gw-field">
        <Label className="gw-label">API token</Label>
        <Input className="gw-input" spellCheck={false} />
        <FieldError className="gw-field__error" />
      </TextField>
      <p className="gw-hint">The token stays in this page&apos;s memory only. Reloading the page forgets it.</p>
      <Button type="submit" className="gw-btn gw-btn--primary" aria-disabled={busy === true || undefined}>
        {busy === true ? 'Checking...' : 'Connect'}
      </Button>
    </Form>
  );
}
