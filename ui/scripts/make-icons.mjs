// Renders public/favicon.svg to the PNG sizes the page and manifest name (favicon-32, apple-touch-icon, icon-192/512).
// Hand-authored SVG is the source of truth; run `node scripts/make-icons.mjs` after changing it and commit the PNGs.
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';

const pub = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'public');
const svg = readFileSync(resolve(pub, 'favicon.svg'), 'utf8');
const sizes = { 'favicon-32.png': 32, 'apple-touch-icon.png': 180, 'icon-192.png': 192, 'icon-512.png': 512 };

const browser = await chromium.launch();
try {
  for (const [file, size] of Object.entries(sizes)) {
    const page = await browser.newPage({ viewport: { width: size, height: size } });
    await page.setContent(`<style>html,body{margin:0;background:transparent}svg{display:block;width:${size}px;height:${size}px}</style>${svg}`);
    writeFileSync(resolve(pub, file), await page.screenshot({ omitBackground: true, clip: { x: 0, y: 0, width: size, height: size } }));
    await page.close();
    console.log(`wrote public/${file}`);
  }
} finally {
  await browser.close();
}
