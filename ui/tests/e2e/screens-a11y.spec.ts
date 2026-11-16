// Accessibility tier for the feature screens in a REAL browser (color-contrast included): every screen x both themes x
// the key states (idle, result, error, busy). Zero violations.
import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import { SCREENS, THEME_IDS, axeViolations, openScreen } from './helpers';
import { mockApi } from './mockApi';
import { ERR } from '../helpers/fixtures';

test.use({ bypassCSP: true }); // axe is injected by the test; the app's CSP is tested in csp.spec.ts

const screen = (name: string) => SCREENS.find((s) => s.name === name)!;
const gen = async (p: Page) => {
  await p.getByLabel('Draft').fill('Please write the release note.');
  await p.getByRole('button', { name: 'Generate' }).click();
};

for (const theme of THEME_IDS) {
  for (const s of SCREENS) {
    test(`axe: ${s.name} / ${theme} / idle`, async ({ page }) => {
      await mockApi(page);
      await openScreen(page, s, theme);
      expect(await axeViolations(page)).toBe('');
    });
  }

  test(`axe: generate / ${theme} / result, over the cap, error and busy`, async ({ page }) => {
    let release: () => void = () => undefined;
    const held = new Promise<void>((r) => (release = r));
    await mockApi(page, { 'POST /api/generate': () => ({ status: 200, body: { ok: true, text: 'x', trace: [], promptTokensEstimate: 1 } }) }, {});
    await openScreen(page, screen('generate'), theme);
    await page.getByLabel('Draft').fill('x'.repeat(5001));
    await expect(page.getByText('1 characters over the limit of 5,000.')).toBeVisible();
    expect(await axeViolations(page), 'over the cap').toBe('');
    await page.unrouteAll();
    await mockApi(page);
    await page.getByLabel('Draft').fill('Please write the release note.');
    await page.getByRole('button', { name: 'Generate' }).click();
    await page.getByRole('region', { name: 'Generated text' }).waitFor();
    expect(await axeViolations(page), 'result').toBe('');
    await page.unrouteAll();
    await mockApi(page, { 'POST /api/generate': () => ({ status: 502, body: ERR('LLM_FAILED', 'the model call failed') }) });
    await gen(page);
    await page.getByRole('alert').waitFor();
    expect(await axeViolations(page), 'error').toBe('');
    await page.unrouteAll();
    await mockApi(page, {}, { 'POST /api/generate': held });
    await gen(page);
    await page.getByRole('button', { name: 'Generating...' }).waitFor();
    expect(await axeViolations(page), 'busy').toBe('');
    release();
  });

  test(`axe: authors and score / ${theme} / with the ingest error, score result, humanize result and the gated-off panels`, async ({ page }) => {
    await mockApi(page, { 'POST /api/ingest': () => ({ status: 413, body: ERR('INPUT_TOO_LARGE', 'too large') }) });
    await openScreen(page, screen('authors'), theme);
    await page.getByLabel('Author id').fill('abc');
    await page.getByLabel('Display name').fill('Abc');
    await page.getByLabel('Writing sample').fill('Some text.');
    await page.getByRole('button', { name: 'Ingest' }).click();
    await page.getByRole('alert').waitFor();
    expect(await axeViolations(page), 'ingest error').toBe('');

    await page.unrouteAll();
    await mockApi(page);
    await openScreen(page, screen('score'), theme);
    await page.getByLabel('Text to score').fill('A paragraph.');
    await page.getByRole('button', { name: 'Score' }).click();
    await page.getByTestId('score-value').waitFor();
    expect(await axeViolations(page), 'score result').toBe('');
    await page.getByRole('tab', { name: 'Humanize' }).click();
    await page.getByLabel('Text to humanize').fill('A paragraph with 42.');
    await page.getByRole('button', { name: 'Humanize' }).click();
    await page.getByTestId('score-after').waitFor();
    expect(await axeViolations(page), 'humanize result').toBe('');

    await page.unrouteAll();
    await page.goto('about:blank'); // a fresh page load: the capability list is read once per load
    await mockApi(page, { 'GET /api/capabilities': () => ({ status: 200, body: { ok: true, operations: [], pending: [] } }) });
    await openScreen(page, { ...screen('score'), ready: (p: Page) => p.getByTestId('unavailable').waitFor() }, theme);
    expect(await axeViolations(page), 'gated off').toBe('');
  });
}
