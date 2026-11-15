import { act, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { ThemeSwitcher } from '../../src/app/ThemeSwitcher';
import { STORAGE_KEY } from '../../src/theme/engine';
import { ThemeProvider, useTheme } from '../../src/theme/ThemeProvider';
import { DARK, REDUCE, memoryStorage, mediaWith, throwingStorage } from '../helpers/media';

function setup(props: Partial<Parameters<typeof ThemeProvider>[0]> = {}) {
  const storage = memoryStorage();
  const utils = render(
    <ThemeProvider storage={storage} matchMedia={mediaWith([DARK])} {...props}>
      <ThemeSwitcher />
    </ThemeProvider>,
  );
  return { storage, ...utils, user: userEvent.setup() };
}

describe('ThemeSwitcher', () => {
  it('is labelled "Theme", shows the current theme, and sets <html data-theme> on mount', () => {
    setup();
    const trigger = screen.getByRole('button', { name: /theme/i });
    expect(trigger).toHaveTextContent('Black Cat');
    expect(document.documentElement.getAttribute('data-theme')).toBe('black-cat');
  });

  it('is keyboard operable: Enter opens the list, arrows move, Enter picks; html, storage and the live region follow', async () => {
    const { user, storage } = setup();
    screen.getByRole('button', { name: /theme/i }).focus();
    await user.keyboard('{Enter}');
    const list = await screen.findByRole('listbox');
    const options = within(list).getAllByRole('option');
    expect(options.map((o) => o.textContent)).toEqual(['Black Cat', 'Tron Neon']);
    await user.keyboard('{ArrowDown}{Enter}');
    expect(document.documentElement.getAttribute('data-theme')).toBe('tron-neon');
    expect(storage.data.get(STORAGE_KEY)).toBe('tron-neon');
    expect(screen.getByRole('button', { name: /theme/i })).toHaveTextContent('Tron Neon');
    expect(screen.getByRole('status')).toHaveTextContent('Theme changed to Tron Neon');
  });

  it('announces nothing until the user changes the theme', () => {
    setup();
    expect(screen.getByRole('status')).toBeEmptyDOMElement();
  });

  it('a stored theme wins, and works when storage throws on every call', async () => {
    const { unmount } = setup({ storage: memoryStorage({ [STORAGE_KEY]: 'tron-neon' }) });
    expect(document.documentElement.getAttribute('data-theme')).toBe('tron-neon');
    unmount();
    const { user } = setup({ storage: throwingStorage });
    expect(document.documentElement.getAttribute('data-theme')).toBe('black-cat');
    screen.getByRole('button', { name: /theme/i }).focus();
    await user.keyboard('{Enter}{ArrowDown}{Enter}');
    expect(document.documentElement.getAttribute('data-theme')).toBe('tron-neon'); // the choice applies even though it cannot be saved
  });

  it('follows prefers-reduced-motion live: scale 0 and the marker, then back', async () => {
    const mm = mediaWith([DARK, REDUCE]);
    render(
      <ThemeProvider storage={memoryStorage()} matchMedia={mm}>
        <ThemeSwitcher />
      </ThemeProvider>,
    );
    expect(document.documentElement.style.getPropertyValue('--gw-motion-scale')).toBe('0');
    expect(document.documentElement.getAttribute('data-motion')).toBe('reduced');
    act(() => mm.fire(REDUCE, false));
    expect(document.documentElement.hasAttribute('data-motion')).toBe(false);
  });

  it('setTheme ignores an id that is not in the manifest', () => {
    let api!: ReturnType<typeof useTheme>;
    function Probe() {
      api = useTheme();
      return null;
    }
    render(
      <ThemeProvider storage={memoryStorage()} matchMedia={mediaWith([DARK])}>
        <Probe />
      </ThemeProvider>,
    );
    act(() => api.setTheme('nope'));
    expect(document.documentElement.getAttribute('data-theme')).toBe('black-cat');
  });

  it('useTheme outside the provider is an error, not a silent default', () => {
    function Probe() {
      useTheme();
      return null;
    }
    expect(() => render(<Probe />)).toThrow(/ThemeProvider/);
  });
});
