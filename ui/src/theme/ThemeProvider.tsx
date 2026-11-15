import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import type { ThemeManifestEntry } from './contract';
import { REDUCED_MOTION_QUERY, applyMotion, applyTheme, isThemeId, persistTheme, prefersReducedMotion, resolveInitialTheme, safeStorage } from './engine';
import type { MatchMedia, StorageLike } from './engine';
import { THEMES } from './manifest';

export interface ThemeContextValue {
  themeId: string;
  themes: readonly ThemeManifestEntry[];
  setTheme(id: string): void;
  reducedMotion: boolean;
  /** Text for a polite live region; changes on every explicit theme change. */
  announcement: string;
}

const ThemeContext = createContext<ThemeContextValue | undefined>(undefined);

export interface ThemeProviderProps {
  children: ReactNode;
  /** Injection points for tests; default to the real window. */
  storage?: StorageLike | undefined;
  matchMedia?: MatchMedia | undefined;
  themes?: readonly ThemeManifestEntry[];
  root?: HTMLElement;
}

export function ThemeProvider({ children, storage, matchMedia, themes = THEMES, root }: ThemeProviderProps) {
  const store = storage ?? safeStorage();
  const mm: MatchMedia | undefined = matchMedia ?? (typeof window !== 'undefined' && typeof window.matchMedia === 'function' ? window.matchMedia.bind(window) : undefined);
  const el = root ?? document.documentElement;
  const [themeId, setThemeId] = useState(() => resolveInitialTheme({ storage: store, matchMedia: mm }, themes));
  const [reducedMotion, setReduced] = useState(() => prefersReducedMotion(mm));
  const [announcement, setAnnouncement] = useState('');

  useEffect(() => applyTheme(el, themeId, themes), [el, themeId, themes]);
  useEffect(() => applyMotion(el, reducedMotion), [el, reducedMotion]);
  useEffect(() => {
    if (mm === undefined) return;
    let list: ReturnType<MatchMedia> & { addEventListener?: (t: 'change', f: () => void) => void; removeEventListener?: (t: 'change', f: () => void) => void };
    try {
      list = mm(REDUCED_MOTION_QUERY);
    } catch {
      return;
    }
    const onChange = (): void => setReduced(prefersReducedMotion(mm));
    list.addEventListener?.('change', onChange);
    return () => list.removeEventListener?.('change', onChange);
  }, [mm]);

  const setTheme = useCallback(
    (id: string) => {
      if (!isThemeId(id, themes)) return;
      setThemeId(id);
      persistTheme(store, id);
      setAnnouncement(`Theme changed to ${themes.find((t) => t.id === id)?.label ?? id}`);
    },
    [store, themes],
  );

  const value = useMemo<ThemeContextValue>(() => ({ themeId, themes, setTheme, reducedMotion, announcement }), [themeId, themes, setTheme, reducedMotion, announcement]);
  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

export function useTheme(): ThemeContextValue {
  const v = useContext(ThemeContext);
  if (v === undefined) throw new Error('useTheme must be used inside <ThemeProvider>');
  return v;
}
