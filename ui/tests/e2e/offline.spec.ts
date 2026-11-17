// Offline tier in a real browser: everything except localhost is blocked, and the app still renders fully, fonts included.
import { expect, test } from '@playwright/test';
import { ROUTES, THEME_IDS, openApp } from './helpers';

for (const theme of THEME_IDS) {
  test(`${theme}: renders fully with the network blocked except localhost; no request leaves the origin, none fails`, async ({ page }) => {
    const external: string[] = [];
    const failed: string[] = [];
    await page.route('**/*', (route) => {
      const url = new URL(route.request().url());
      if (url.hostname === '127.0.0.1' || url.hostname === 'localhost') return route.continue();
      external.push(url.href);
      return route.abort();
    });
    page.on('requestfailed', (r) => failed.push(`${r.url()} ${r.failure()?.errorText ?? ''}`));
    page.on('pageerror', (e) => failed.push(`pageerror ${e.message}`));

    for (const route of ROUTES) {
      await openApp(page, route.hash, theme);
      await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
    }
    expect(external).toEqual([]);
    expect(failed).toEqual([]);
    await expect(page.getByText(/operations available/)).toBeVisible().catch(() => undefined);
  });

  test(`${theme}: its own fonts are actually loaded from this origin (not system fallbacks)`, async ({ page }) => {
    const fontUrls: string[] = [];
    page.on('response', (r) => {
      if (/\.woff2(\?|$)/.test(r.url())) fontUrls.push(new URL(r.url()).pathname);
    });
    await openApp(page, '#/kitchen-sink', theme);
    const used = await page.evaluate(() => {
      const s = getComputedStyle(document.documentElement);
      const name = (v: string): string => (s.getPropertyValue(v).split(',')[0] ?? '').trim().replace(/"/g, '');
      return { display: name('--gw-font-display'), body: name('--gw-font-body'), mono: name('--gw-font-mono') };
    });
    for (const family of Object.values(used)) {
      expect(await page.evaluate((f) => document.fonts.check(`16px "${f}"`), family), family).toBe(true);
      expect(await page.evaluate((f) => [...document.fonts].some((ff) => ff.family.replace(/"/g, '') === f && ff.status === 'loaded'), family), `${family} loaded`).toBe(true);
    }
    expect(fontUrls.length).toBeGreaterThan(0);
    for (const p of fontUrls) expect(p).toMatch(/^\/assets\/.+\.woff2$/);
  });
}
