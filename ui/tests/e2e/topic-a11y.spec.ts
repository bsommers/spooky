// Accessibility of the Generate screen in topic mode, in a REAL browser (color contrast included), both themes.
import { expect, test } from '@playwright/test';
import { SCREENS, THEME_IDS, axeViolations, openScreen } from './helpers';
import { mockApi } from './mockApi';

test.use({ bypassCSP: true }); // axe is injected by the test; the app's CSP is tested in csp.spec.ts and topic.spec.ts

const generate = SCREENS.find((s) => s.name === 'generate')!;
const TOPIC = 'Why small teams ship faster';
const NOTES = 'The team shipped 12 releases in 2024. Median review time was 3 hours.';

for (const theme of THEME_IDS) {
  test(`${theme}: axe in topic mode, idle, over the cap and with a result`, async ({ page }) => {
    await mockApi(page);
    await openScreen(page, generate, theme);
    await page.getByRole('radio', { name: 'Write about a topic' }).check({ force: true });
    await page.getByLabel("Topic we're researching").waitFor();
    expect(await axeViolations(page), 'idle').toBe('');
    await page.getByLabel('Notes and facts to use (optional)').fill('x'.repeat(5001));
    await expect(page.getByText('1 characters over the limit of 5,000.')).toBeVisible();
    expect(await axeViolations(page), 'over the cap').toBe('');
    await page.getByLabel('Notes and facts to use (optional)').fill(NOTES);
    await page.getByLabel("Topic we're researching").fill(TOPIC);
    await page.getByRole('button', { name: 'Generate' }).click();
    await page.getByRole('region', { name: 'Generated text' }).waitFor();
    expect(await axeViolations(page), 'result').toBe('');
  });
}
