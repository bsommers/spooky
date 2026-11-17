// A number field whose emptied state is a visible, named problem instead of a silent NaN. React Aria reports NaN when the
// input is cleared; callers keep that value, treat it as "not ready" and never put it in a request (it would be sent as null).
import { FieldError, Input, Label, NumberField } from 'react-aria-components';

export function NumberInput({
  label,
  value,
  onChange,
  min,
  max,
  step,
}: {
  label: string;
  /** NaN while the field is empty. */
  value: number;
  onChange(v: number): void;
  min: number;
  max: number;
  step: number;
}) {
  return (
    <NumberField className="gw-field gw-field--inline" value={value} onChange={onChange} minValue={min} maxValue={max} step={step} isInvalid={!Number.isFinite(value)}>
      <Label className="gw-label">{label}</Label>
      <Input className="gw-input" />
      <FieldError className="gw-field__error">{`Enter a number from ${min} to ${max}.`}</FieldError>
    </NumberField>
  );
}
