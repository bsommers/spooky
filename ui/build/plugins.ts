// Vite plugins: theme validation (a failing contrast pair fails the build), the theme list written into index.html for
// theme-init.js, and third-party font licenses copied next to the fonts they cover (OFL requires them to travel along).
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Plugin } from 'vite';
import { DEFAULT_THEME_ID, THEMES } from '../src/theme/manifest.ts';
import { checkThemes } from './theme-check.ts';

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
        const themes = JSON.stringify(THEMES.map((t) => ({ id: t.id, colorScheme: t.colorScheme }))).replace(/"/g, '&quot;');
        return html.replace('<html lang="en">', `<html lang="en" data-themes="${themes}" data-default-theme="${DEFAULT_THEME_ID}">`);
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

