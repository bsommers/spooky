// Vite plugins: theme validation (a failing contrast pair fails the build), the theme list written into index.html for
// theme-init.js, and third-party font licenses copied next to the fonts they cover (OFL requires them to travel along).
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Plugin } from 'vite';
import { DEFAULT_THEME_ID, THEMES } from '../src/theme/manifest.ts';
import type { ThemeManifestEntry } from '../src/theme/contract.ts';
import { checkThemes } from './theme-check.ts';

const HTML_TAG = '<html lang="en">';
const COLOR_SCHEME_META = '<meta name="color-scheme" content="dark" />';

/**
 * Writes the theme list into <html> (for theme-init.js) and derives the color-scheme meta from the manifest, so a future
 * light theme does not flash dark browser chrome before the bootstrap runs. Throws when either anchor is missing from
 * index.html: a silent no-op would ship a page whose first paint has no theme, caught only by a late test.
 */
export function injectThemeHtml(html: string, themes: readonly ThemeManifestEntry[], defaultThemeId: string): string {
  if (!html.includes(HTML_TAG)) throw new Error(`gw-theme: index.html no longer contains ${HTML_TAG}; the theme list cannot be injected (theme-init.js would find no themes)`);
  if (!html.includes(COLOR_SCHEME_META)) throw new Error(`gw-theme: index.html no longer contains ${COLOR_SCHEME_META}; its value is derived from the theme manifest`);
  const list = JSON.stringify(themes.map((t) => ({ id: t.id, colorScheme: t.colorScheme }))).replace(/"/g, '&quot;');
  const schemes = [...new Set(themes.map((t) => t.colorScheme))].join(' ') || 'dark';
  return html
    .replace(HTML_TAG, () => `<html lang="en" data-themes="${list}" data-default-theme="${defaultThemeId}">`)
    .replace(COLOR_SCHEME_META, () => `<meta name="color-scheme" content="${schemes}" />`);
}

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

export function themePlugin(): Plugin {
  const run = (): void => {
    checkThemes({ themesDir: join(root, 'src', 'theme', 'themes'), publicDir: join(root, 'public'), manifest: THEMES });
  };
  return {
    name: 'gw-theme',
    buildStart: run,
    configureServer: run,
    transformIndexHtml: {
      order: 'pre',
      handler(html) {
        return injectThemeHtml(html, THEMES, DEFAULT_THEME_ID);
      },
    },
  };
}

/** Font packages whose woff2 files the bundle contains; each ships its LICENSE into dist/licenses/. */
export const FONT_PACKAGES = ['fraunces', 'inter', 'jetbrains-mono', 'orbitron'] as const;

export function fontLicensePlugin(): Plugin {
  return {
    name: 'gw-font-licenses',
    generateBundle() {
      for (const name of FONT_PACKAGES) {
        const dir = join(root, 'node_modules', '@fontsource-variable', name);
        const license = join(dir, 'LICENSE');
        if (!existsSync(license)) this.error(`font package @fontsource-variable/${name} has no LICENSE file; refusing to ship its font`);
        this.emitFile({ type: 'asset', fileName: `licenses/${name}-OFL.txt`, source: readFileSync(license) });
      }
    },
  };
}

