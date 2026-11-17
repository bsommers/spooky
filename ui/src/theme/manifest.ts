// The themes the app offers. Adding a theme = drop `themes/<id>.css` (see contract.ts) and add one line here; the
// first entry is the default when nothing is stored and the system preference matches no theme.
import type { ThemeManifestEntry } from './contract.ts';

export const THEMES: readonly ThemeManifestEntry[] = [
  { id: 'black-cat', label: 'Black Cat', colorScheme: 'dark' },
  { id: 'tron-neon', label: 'Tron Neon', colorScheme: 'dark' },
];

export const DEFAULT_THEME_ID: string = (THEMES[0] as ThemeManifestEntry).id;
