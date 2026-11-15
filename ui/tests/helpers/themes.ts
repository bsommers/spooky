import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseThemeCss } from '../../src/theme/contract';
import type { ParsedTheme } from '../../src/theme/contract';

export const UI_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
export const THEMES_DIR = join(UI_ROOT, 'src', 'theme', 'themes');

export function themeFiles(dir: string = THEMES_DIR): string[] {
  return readdirSync(dir).filter((f) => f.endsWith('.css')).sort();
}

export function loadThemes(dir: string = THEMES_DIR): ParsedTheme[] {
  return themeFiles(dir).map((f) => parseThemeCss(readFileSync(join(dir, f), 'utf8'), f.replace(/\.css$/, '')));
}
