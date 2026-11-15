// Accessibility tier in a REAL browser: axe with color-contrast on (jsdom cannot compute it), both themes, the shell,
// the kitchen sink, and the overlays. Zero violations.
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import { ROUTES, THEME_IDS, openApp } from './helpers';

const axeSource = readFileSync(createRequire(import.meta.url).resolve('axe-core/axe.min.js'), 'utf8');

async function violations(page: Page): Promise<string> {
  await page.evaluate(axeSource); // test-side injection into the page under test (the app's own CSP is not involved: see below)
  const results = await page.evaluate(async () => {
    const axe = (window as unknown as { axe: { run: (c: unknown, o: unknown) => Promise<{ violations: Array<{ id: string; impact: string; help: string; nodes: Array<{ target: string[]; failureSummary: string }> }> }> } }).axe;
    return axe.run(document, { runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa', 'best-practice'] } });
  });
  return results.violations.map((v) => `${v.id} (${v.impact}): ${v.help}\n${v.nodes.map((n) => `  ${n.target.join(' ')}: ${n.failureSummary.split('\n')[1] ?? ''}`).join('\n')}`).join('\n');
}

test.use({ bypassCSP: true }); // axe is injected by the test; the app's CSP is tested separately in csp.spec.ts

for (const theme of THEME_IDS) {
  for (const route of ROUTES) {
    test(`axe: ${route.name} in ${theme} has zero violations (contrast included)`, async ({ page }) => {
      await openApp(page, route.hash, theme);
      expect(await violations(page)).toBe('');
    });
  }

  test(`axe: kitchen sink in ${theme} with the dialog open, then the theme list open`, async ({ page }) => {
    await openApp(page, '#/kitchen-sink', theme);
    await page.getByRole('button', { name: 'Open dialog' }).click();
    await page.getByRole('dialog').waitFor();
    expect(await violations(page)).toBe('');
    await page.keyboard.press('Escape');
    await page.getByRole('dialog').waitFor({ state: 'detached' });
    await page.getByRole('button', { name: /theme/i }).click();
    await page.getByRole('listbox').waitFor();
    expect(await violations(page)).toBe('');
  });
}

test('the harness sees real contrast failures (so zero above means something)', async ({ page }) => {
  await openApp(page, '#/kitchen-sink', 'black-cat');
  await page.addStyleTag({ content: '.gw-lede { color: #3a3a3a !important; }' });
  expect(await violations(page)).toMatch(/color-contrast/);
});
