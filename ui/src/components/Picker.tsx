import { Button, Label, ListBox, ListBoxItem, Popover, Select, SelectValue } from 'react-aria-components';
import { CheckIcon, ChevronIcon } from '../icons';

export interface PickerItem {
  id: string;
  label: string;
}

/** A labelled select (arrow keys, type-ahead, Esc to close come from React Aria). */
export function Picker({
  label,
  items,
  value,
  onChange,
  placeholder,
  isDisabled,
}: {
  label: string;
  items: readonly PickerItem[];
  value: string | undefined;
  onChange(id: string): void;
  placeholder?: string;
  isDisabled?: boolean;
}) {
  return (
    <Select
      className="gw-select gw-select--field"
      selectedKey={value ?? null}
      onSelectionChange={(k) => {
        if (k !== null) onChange(String(k));
      }}
      isDisabled={isDisabled === true}
      {...(placeholder === undefined ? {} : { placeholder })}
    >
      <Label className="gw-label">{label}</Label>
      <Button className="gw-btn gw-select__button">
        <SelectValue />
        <ChevronIcon size={16} className="gw-select__chevron" />
      </Button>
      <Popover className="gw-popover">
        <ListBox className="gw-listbox" items={items}>
          {(it) => (
            <ListBoxItem id={it.id} textValue={it.label} className="gw-listbox__item">
              <span>{it.label}</span>
              <CheckIcon size={16} className="gw-listbox__check" />
            </ListBoxItem>
          )}
        </ListBox>
      </Popover>
    </Select>
  );
}
