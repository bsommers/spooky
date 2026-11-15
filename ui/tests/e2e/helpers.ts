import type { Page } from '@playwright/test';

export const THEME_IDS = ['black-cat', 'tron-neon'] as const;
export const ROUTES = [
  { name: 'shell', hash: '#/' },
  { name: 'kitchen-sink', hash: '#/kitchen-sink' },
] as const;

/** Open a route with a theme pre-chosen (the same localStorage key the app writes), wait for fonts and the data to settle. */
export async function openApp(page: Page, hash: string, theme: string): Promise<void> {
  await page.addInitScript((t) => window.localStorage.setItem('gw-theme', t), theme);
  await page.goto(`/${hash}`);
  await settle(page);
}

export async function settle(page: Page): Promise<void> {
  await page.waitForFunction(() => document.documentElement.getAttribute('data-theme') !== null);
  // The overview shows the server's operations once the request answered; the kitchen sink has no request.
  if (page.url().endsWith('#/') || !page.url().includes('#/')) await page.getByText(/operations available/).waitFor();
  await page.evaluate(async () => {
    // Fonts load lazily, only for the families in use: force the three the theme uses, then wait.
    const style = getComputedStyle(document.documentElement);
    const families = [style.getPropertyValue('--gw-font-display'), style.getPropertyValue('--gw-font-body'), style.getPropertyValue('--gw-font-mono')];
    for (const stack of families) {
      const first = stack.split(',')[0]?.trim();
      if (first) await document.fonts.load(`16px ${first}`, 'AaBb0123 Spooky');
    }
    await document.fonts.ready;
  });
}
