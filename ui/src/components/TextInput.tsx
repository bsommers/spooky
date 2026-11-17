// A text area with a live character count against the server's cap. Over the cap the field is invalid and says by how much.
import { FieldError, Label, TextArea, TextField } from 'react-aria-components';

export function TextInput({
  label,
  value,
  onChange,
  cap,
  rows = 10,
  hint,
  isDisabled,
}: {
  label: string;
  value: string;
  onChange(v: string): void;
  /** `limits.maxInputChars`; undefined while the config is loading. */
  cap: number | undefined;
  rows?: number;
  hint?: string;
  isDisabled?: boolean;
}) {
  const over = cap !== undefined && value.length > cap;
  return (
    <TextField className="gw-field gw-field--wide" value={value} onChange={onChange} isInvalid={over} isDisabled={isDisabled === true}>
      <Label className="gw-label">{label}</Label>
      <TextArea className="gw-input gw-textarea" rows={rows} spellCheck={false} />
      <div className="gw-count" data-over={over ? 'true' : undefined}>
        <span data-testid="char-count">
          {value.length.toLocaleString('en-US')}
          {cap === undefined ? '' : ` / ${cap.toLocaleString('en-US')}`} characters
        </span>
        {hint !== undefined && <span className="gw-hint">{hint}</span>}
      </div>
      <FieldError className="gw-field__error">{over && cap !== undefined ? `${(value.length - cap).toLocaleString('en-US')} characters over the limit of ${cap.toLocaleString('en-US')}.` : ''}</FieldError>
    </TextField>
  );
}
