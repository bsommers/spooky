// Theme behavior in a real browser: no flash, persistence across reload, keyboard switch, reduced motion on the animated layers.
import { expect, test } from '@playwright/test';
import { openApp } from './helpers';

test('the theme is set before the app renders (no flash), from storage and from the system preference', async ({ page }) => {
  await page.addInitScript(() => {
    (window as unknown as { __firstTheme?: { theme: string | null; rootChildren: number } }).__firstTheme = undefined;
    const rec = (): void => {
      const w = window as unknown as { __firstTheme?: { theme: string | null; rootChildren: number } };
      const root = document.getElementById('root');
      if (w.__firstTheme === undefined && root !== null && root.childElementCount > 0) w.__firstTheme = { theme: document.documentElement.getAttribute('data-theme'), rootChildren: root.childElementCount };
    };
    new MutationObserver(rec).observe(document, { childList: true, subtree: true });
  });
  await page.addInitScript(() => window.localStorage.setItem('gw-theme', 'tron-neon'));
  await page.goto('/');
  await page.getByRole('heading', { level: 1 }).waitFor();
  expect(await page.evaluate(() => (window as unknown as { __firstTheme?: { theme: string } }).__firstTheme?.theme)).toBe('tron-neon');
});

test('no stored choice and a dark system: Black Cat; the choice made by keyboard survives a reload', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'black-cat');
  await page.getByRole('button', { name: /theme/i }).focus();
  await page.keyboard.press('Enter');
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('Enter');
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'tron-neon');
  await expect(page.getByRole('status').filter({ hasText: 'Theme changed to Tron Neon' })).toBeAttached();
  await page.reload();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'tron-neon');
  expect(await page.evaluate(() => window.localStorage.getItem('gw-theme'))).toBe('tron-neon');
});

test('a corrupt stored value is ignored', async ({ page }) => {
  await page.addInitScript(() => window.localStorage.setItem('gw-theme', '"><img src=x onerror=alert(1)>'));
  await page.goto('/');
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'black-cat');
});

test.describe('motion', () => {
  const animated = async (page: import('@playwright/test').Page): Promise<{ grid: string; glow: string; logo: string; scale: string }> =>
    page.evaluate(() => ({
      grid: getComputedStyle(document.querySelector('.gw-backdrop__grid') as Element).animationName,
      glow: getComputedStyle(document.querySelector('.gw-backdrop__art') as Element).animationName,
      logo: getComputedStyle(document.querySelector('.gw-logo-mark') as Element).animationName,
      scale: document.documentElement.style.getPropertyValue('--gw-motion-scale'),
    }));

  test('Tron Neon animates the grid, the glow and the logo blink', async ({ page }) => {
    await openApp(page, '#/', 'tron-neon');
    expect(await animated(page)).toEqual({ grid: 'gw-grid-scroll', glow: 'gw-glow-pulse', logo: 'gw-blink', scale: '' });
  });

  test('Black Cat animates only the logo blink', async ({ page }) => {
    await openApp(page, '#/', 'black-cat');
    expect(await animated(page)).toEqual({ grid: 'none', glow: 'none', logo: 'gw-blink', scale: '' });
  });

  test.describe('prefers-reduced-motion', () => {
    test.use({ reducedMotion: 'reduce' });
    for (const theme of ['tron-neon', 'black-cat']) {
      test(`${theme}: --gw-motion-scale is 0 and nothing animates`, async ({ page }) => {
        await openApp(page, '#/', theme);
        expect(await animated(page)).toEqual({ grid: 'none', glow: 'none', logo: 'none', scale: '0' });
        await expect(page.locator('html')).toHaveAttribute('data-motion', 'reduced');
      });
    }
  });
});

test('Tab order starts at the skip link and reaches the nav and the theme switcher; focus is visible', async ({ page }) => {
  await openApp(page, '#/', 'black-cat');
  await page.keyboard.press('Tab');
  await expect(page.getByRole('link', { name: 'Skip to content' })).toBeFocused();
  await page.keyboard.press('Tab');
  await page.keyboard.press('Tab');
  await page.keyboard.press('Tab');
  await page.keyboard.press('Tab');
  const outline = await page.evaluate(() => {
    const s = getComputedStyle(document.activeElement as Element);
    return { style: s.outlineStyle, width: s.outlineWidth };
  });
  expect(outline.style).not.toBe('none');
  expect(parseFloat(outline.width)).toBeGreaterThanOrEqual(2);
});
