import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
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

/** The feature screens, by the heading each one shows. */
export const SCREENS = [
  { name: 'generate', hash: '#/generate', heading: 'Generate', ready: (p: Page) => p.getByLabel('Draft', { exact: true }).waitFor() },
  { name: 'authors', hash: '#/authors', heading: 'Authors and ingest', ready: (p: Page) => p.getByTestId('profile').waitFor() },
  { name: 'personas', hash: '#/personas', heading: 'Personas', ready: (p: Page) => p.getByRole('listbox', { name: 'Personas' }).waitFor() },
  { name: 'score', hash: '#/score', heading: 'Score and humanize', ready: (p: Page) => p.getByLabel('Text to score').waitFor() },
  { name: 'settings', hash: '#/settings', heading: 'Settings', ready: (p: Page) => p.getByRole('table', { name: 'Configured filters' }).waitFor() },
] as const;

/** Open a feature screen in a theme and wait until its data is on screen and the fonts are loaded. */
export async function openScreen(page: Page, screen: (typeof SCREENS)[number], theme: string): Promise<void> {
  await page.addInitScript((t) => window.localStorage.setItem('gw-theme', t), theme);
  await page.goto(`/${screen.hash}`);
  await screen.ready(page);
  await settle(page);
}

/** Axe in the page (contrast included). Needs `test.use({ bypassCSP: true })` because the test injects axe itself. */
export async function axeViolations(page: Page): Promise<string> {
  await page.evaluate(AXE_SOURCE);
  const results = await page.evaluate(async () => {
    const axe = (window as unknown as { axe: { run: (c: unknown, o: unknown) => Promise<{ violations: Array<{ id: string; impact: string; help: string; nodes: Array<{ target: string[]; failureSummary: string }> }> }> } }).axe;
    return axe.run(document, { runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa', 'best-practice'] } });
  });
  return results.violations.map((v) => `${v.id} (${v.impact}): ${v.help}\n${v.nodes.map((n) => `  ${n.target.join(' ')}: ${n.failureSummary.split('\n')[1] ?? ''}`).join('\n')}`).join('\n');
}
const AXE_SOURCE = readFileSync(createRequire(import.meta.url).resolve('axe-core/axe.min.js'), 'utf8');
