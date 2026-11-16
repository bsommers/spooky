// Topic mode of the Generate screen in a REAL browser: the whole flow on the real server (both themes), the keyboard-only path,
// the caveat on every topic result, no CSP violation, and axe (color contrast included) in both themes.
import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import { MODEL_ANSWER } from './server/constants.mjs';
import { SCREENS, THEME_IDS, openScreen } from './helpers';
import { mockApi } from './mockApi';
import { TOPIC_CAVEAT } from '../../src/screens/generate/topicCaveat';

const generate = SCREENS.find((s) => s.name === 'generate')!;
const TOPIC = 'Why small teams ship faster';
const NOTES = 'The team shipped 12 releases in 2024. Median review time was 3 hours.';

async function toTopic(page: Page): Promise<void> {
  await page.getByRole('radio', { name: 'Write about a topic' }).check({ force: true });
  await page.getByLabel("Topic we're researching").waitFor();
}

for (const theme of THEME_IDS) {
  test(`${theme}: on the real server, a topic and notes give new text, and the caveat is on screen with it`, async ({ page, request }) => {
    const problems: string[] = [];
    await page.addInitScript(() => {
      document.addEventListener('securitypolicyviolation', (e) => {
        (window as unknown as { __csp: string[] }).__csp ??= [];
        (window as unknown as { __csp: string[] }).__csp.push(`${e.violatedDirective} ${e.blockedURI}`);
      });
    });
    page.on('console', (m) => {
      if (m.type() === 'error' || m.type() === 'warning') problems.push(`${m.type()}: ${m.text()}`);
    });
    await openScreen(page, generate, theme);
    await expect(page.getByRole('radio', { name: 'Rewrite my draft' })).toBeChecked();
    await toTopic(page);
    await expect(page.getByLabel('Draft', { exact: true })).toHaveCount(0);
    await expect(page.getByTestId('topic-help')).toContainText('Nothing is looked up online');
    await page.getByLabel("Topic we're researching").fill(TOPIC);
    await page.getByLabel('Notes and facts to use (optional)').fill(NOTES);
    await page.getByRole('button', { name: /Length/ }).click();
    await page.getByRole('option', { name: 'Short' }).click();
    await page.getByRole('button', { name: 'Generate' }).click();
    const out = page.getByRole('region', { name: 'Generated text' });
    await expect(out).toBeVisible();
    await expect(page.getByTestId('topic-caveat')).toBeVisible();
    await expect(page.getByTestId('topic-caveat')).toContainText(TOPIC_CAVEAT);

    const api = await request.post('/api/generate', { data: { authorId: 'terse', persona: 'exec', text: TOPIC, mode: 'topic', notes: NOTES, length: 'short' } });
    const doc = (await api.json()) as { ok: boolean; text: string; mode: string; caveat: string };
    expect(doc.ok).toBe(true);
    expect(doc.mode).toBe('topic');
    expect(doc.caveat).toBe(TOPIC_CAVEAT); // the UI's copy is the server's, word for word
    expect(doc.text).toBe(MODEL_ANSWER);
    expect(await out.textContent()).toBe(doc.text);
    expect(await page.evaluate(() => (window as unknown as { __csp?: string[] }).__csp ?? [])).toEqual([]);
    expect(problems).toEqual([]);
  });

  test(`${theme}: the whole topic flow works from the keyboard`, async ({ page }) => {
    await mockApi(page);
    await openScreen(page, generate, theme);
    await page.getByRole('button', { name: /Persona/ }).focus();
    await page.keyboard.press('Tab'); // the mode switch is one tab stop: the checked radio
    await expect(page.getByRole('radio', { name: 'Rewrite my draft' })).toBeFocused();
    await page.keyboard.press('ArrowRight'); // arrows move the choice
    await expect(page.getByRole('radio', { name: 'Write about a topic' })).toBeChecked();
    await page.keyboard.press('Tab');
    await expect(page.getByLabel("Topic we're researching")).toBeFocused();
    await page.keyboard.type(TOPIC);
    await page.keyboard.press('Tab');
    await expect(page.getByLabel('Notes and facts to use (optional)')).toBeFocused();
    await page.keyboard.type(NOTES);
    await page.keyboard.press('Tab');
    await expect(page.getByRole('button', { name: /Length/ })).toBeFocused();
    await page.keyboard.press('Enter');
    await page.getByRole('option', { name: 'Medium' }).waitFor();
    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('Enter');
    await expect(page.getByRole('button', { name: /Length/ })).toContainText('Short');
    await page.getByRole('button', { name: 'Generate' }).focus();
    await page.keyboard.press('Enter');
    await expect(page.getByRole('region', { name: 'Generated text' })).toBeVisible();
    await expect(page.getByTestId('topic-caveat')).toBeVisible();
  });
}
