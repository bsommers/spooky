import { Button, Label, ListBox, ListBoxItem, Popover, Select, SelectValue } from 'react-aria-components';
import { CheckIcon, ChevronIcon } from '../icons';
import { useTheme } from '../theme/ThemeProvider';

export function ThemeSwitcher() {
  const { themeId, themes, setTheme, announcement } = useTheme();
  return (
    <div className="gw-theme-switcher">
      <Select className="gw-select" selectedKey={themeId} onSelectionChange={(key) => setTheme(String(key))}>
        <Label className="gw-label">Theme</Label>
        <Button className="gw-btn gw-select__button">
          <SelectValue />
          <ChevronIcon size={16} className="gw-select__chevron" />
        </Button>
        <Popover className="gw-popover">
          <ListBox className="gw-listbox" items={themes}>
            {(t) => (
              <ListBoxItem id={t.id} textValue={t.label} className="gw-listbox__item">
                <span>{t.label}</span>
                <CheckIcon size={16} className="gw-listbox__check" />
              </ListBoxItem>
            )}
          </ListBox>
        </Popover>
      </Select>
      <div role="status" aria-live="polite" className="gw-sr-only">
        {announcement}
      </div>
    </div>
  );
}
