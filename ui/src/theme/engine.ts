// Theme engine: pure functions over injected storage / matchMedia / element so every path is unit-testable.
// Persistence is best-effort (localStorage throws in some private modes); an unknown stored id is ignored.
import type { ThemeManifestEntry } from './contract';
import { DEFAULT_THEME_ID, THEMES } from './manifest';

export const STORAGE_KEY = 'gw-theme';
export const REDUCED_MOTION_QUERY = '(prefers-reduced-motion: reduce)';
export const DARK_SCHEME_QUERY = '(prefers-color-scheme: dark)';

export interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}
export type MatchMedia = (query: string) => { matches: boolean };

/** `window.localStorage`, or undefined when merely reading the property throws (blocked storage). */
export function safeStorage(): StorageLike | undefined {
  try {
    return typeof window === 'undefined' ? undefined : window.localStorage;
  } catch {
    return undefined;
  }
}

export function isThemeId(id: unknown, themes: readonly ThemeManifestEntry[] = THEMES): id is string {
  return typeof id === 'string' && themes.some((t) => t.id === id);
}

export function readStoredTheme(storage: StorageLike | undefined, themes: readonly ThemeManifestEntry[] = THEMES): string | undefined {
  try {
    const v = storage?.getItem(STORAGE_KEY);
    return isThemeId(v, themes) ? v : undefined;
  } catch {
    return undefined;
  }
}

/** First theme whose color scheme matches the system preference, else the default theme. */
export function themeForScheme(scheme: 'dark' | 'light', themes: readonly ThemeManifestEntry[] = THEMES, fallback: string = DEFAULT_THEME_ID): string {
  return themes.find((t) => t.colorScheme === scheme)?.id ?? fallback;
}

export interface InitialThemeInput {
  storage?: StorageLike | undefined;
  matchMedia?: MatchMedia | undefined;
}

/** Stored choice if valid, else the theme for the system color scheme, else the default. */
export function resolveInitialTheme({ storage, matchMedia }: InitialThemeInput, themes: readonly ThemeManifestEntry[] = THEMES): string {
  const stored = readStoredTheme(storage, themes);
  if (stored !== undefined) return stored;
  let scheme: 'dark' | 'light' = 'dark';
  try {
    if (matchMedia !== undefined && !matchMedia(DARK_SCHEME_QUERY).matches && matchMedia('(prefers-color-scheme: light)').matches) scheme = 'light';
  } catch {
    /* no preference available */
  }
  return themeForScheme(scheme, themes);
}

export function persistTheme(storage: StorageLike | undefined, id: string): boolean {
  try {
    if (storage === undefined) return false;
    storage.setItem(STORAGE_KEY, id);
    return true;
  } catch {
    return false;
  }
}

export function applyTheme(root: HTMLElement, id: string, themes: readonly ThemeManifestEntry[] = THEMES): void {
  root.setAttribute('data-theme', id);
  const scheme = themes.find((t) => t.id === id)?.colorScheme;
  if (scheme !== undefined) root.style.colorScheme = scheme;
}

export function prefersReducedMotion(matchMedia: MatchMedia | undefined): boolean {
  try {
    return matchMedia?.(REDUCED_MOTION_QUERY).matches === true;
  } catch {
    return false;
  }
}

/** Reduced motion: scale 0 (inline, so it beats every theme) and a marker the stylesheet turns into `animation: none`. */
export function applyMotion(root: HTMLElement, reduced: boolean): void {
  if (reduced) {
    root.setAttribute('data-motion', 'reduced');
    root.style.setProperty('--gw-motion-scale', '0');
  } else {
    root.removeAttribute('data-motion');
    root.style.removeProperty('--gw-motion-scale');
  }
}
