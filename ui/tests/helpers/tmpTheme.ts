import { cpSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { THEMES_DIR, UI_ROOT } from './themes';

/** A scratch copy of themes/ and public/ so a test can add, break or remove a theme file without touching the repo. */
export function scratchThemes(): { themesDir: string; publicDir: string; write(name: string, css: string): void } {
  const base = mkdtempSync(join(tmpdir(), 'gw-themes-'));
  const themesDir = join(base, 'themes');
  const publicDir = join(base, 'public');
  cpSync(THEMES_DIR, themesDir, { recursive: true });
  cpSync(join(UI_ROOT, 'public'), publicDir, { recursive: true });
  return { themesDir, publicDir, write: (name, css) => writeFileSync(join(themesDir, name), css) };
}

/** The rule text of `theme` with `tweak` applied to its token map. */
export function themeCss(id: string, tokens: Record<string, string>): string {
  return `:root[data-theme="${id}"] {\n${Object.entries(tokens)
    .map(([k, v]) => `  ${k}: ${v};`)
    .join('\n')}\n}\n`;
}
