// Keyboard tier in a REAL browser: tab order, visible focus on every stop, skip link, Escape and arrows in the select,
// Enter/Space on controls, no keyboard trap, and the live region announcing completion and errors.
import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import { SCREENS, THEME_IDS, openScreen } from './helpers';
import { mockApi } from './mockApi';
import { ERR } from '../helpers/fixtures';

const screen = (name: string) => SCREENS.find((s) => s.name === name)!;

/** What the focused element is called, and whether anything in its control shows a focus indicator. */
async function focused(page: Page): Promise<{ name: string; visible: boolean; tag: string }> {
  return page.evaluate(() => {
    const el = document.activeElement as HTMLElement | null;
    if (el === null || el === document.body) return { name: '(body)', visible: false, tag: 'body' };
    const labelled = (el as HTMLInputElement).labels?.[0]?.textContent;
    const name = (el.getAttribute('aria-label') ?? labelled ?? el.textContent ?? '').trim().replace(/\s+/g, ' ').slice(0, 60) || el.tagName.toLowerCase();
    const shows = (e: Element): boolean => {
      const cs = getComputedStyle(e);
      return (cs.outlineStyle !== 'none' && parseFloat(cs.outlineWidth) >= 2) || cs.boxShadow !== 'none';
    };
    // a hidden native input (switch, file) shows its ring on the visible track beside it
    const scope = el.closest('label, [data-rac]') ?? el.parentElement ?? el;
    const visible = shows(el) || [...scope.querySelectorAll('*')].some(shows) || shows(scope);
    return { name, visible, tag: el.tagName.toLowerCase() };
  });
}

for (const theme of THEME_IDS) {
  test(`${theme}: the skip link is the first stop, shows itself, and moves focus to the content`, async ({ page }) => {
    await mockApi(page);
    await openScreen(page, screen('generate'), theme);
    await page.keyboard.press('Tab');
    expect((await focused(page)).name).toBe('Skip to content');
    expect((await focused(page)).visible).toBe(true);
    expect(await page.getByRole('link', { name: 'Skip to content' }).boundingBox().then((b) => b!.y >= 0)).toBe(true);
    await page.keyboard.press('Enter');
    expect(await page.evaluate(() => document.activeElement?.id)).toBe('main');
  });

  for (const s of SCREENS) {
    test(`${theme}: ${s.name}: every Tab stop shows a focus indicator, the order follows the page, and there is no trap`, async ({ page }) => {
      await mockApi(page);
      await openScreen(page, s, theme);
      const stops: string[] = [];
      const hidden: string[] = [];
      for (let i = 0; i < 80; i++) {
        await page.keyboard.press('Tab');
        const f = await focused(page);
        if (f.name === '(body)') break; // focus left the page (browser chrome): not a trap
        stops.push(f.name);
        if (!f.visible) hidden.push(f.name);
        if (i > 3 && f.name === 'Skip to content') break; // wrapped around
      }
      expect(hidden, 'stops without a visible focus indicator').toEqual([]);
      expect(stops.length).toBeGreaterThan(10);
      expect(stops.slice(0, 2)).toEqual(['Skip to content', 'Spooky home']);
      const nav = ['Overview', 'Generate', 'Authors', 'Personas', 'Score / Humanize', 'Settings', 'Kitchen sink'];
      expect(stops.slice(2, 2 + nav.length)).toEqual(nav);
      // Shift+Tab walks back
      await page.keyboard.press('Shift+Tab');
      await page.keyboard.press('Shift+Tab');
      expect((await focused(page)).name).not.toBe('(body)');
    });
  }

  test(`${theme}: the persona select: Enter opens, arrows move, Escape closes and keeps the value; Space activates Generate`, async ({ page }) => {
    await mockApi(page);
    await openScreen(page, screen('generate'), theme);
    const persona = page.getByRole('button', { name: /Persona/ });
    await persona.focus();
    await page.keyboard.press('Enter');
    await expect(page.getByRole('listbox')).toBeVisible();
    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('Escape');
    await expect(page.getByRole('listbox')).toBeHidden();
    await expect(persona).toBeFocused();
    await expect(persona).toContainText('Executive');
    await page.keyboard.press('Enter');
    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('Enter');
    await expect(persona).toContainText('Engineer');
    await page.getByLabel('Draft').fill('A draft.');
    await page.getByRole('button', { name: 'Generate' }).focus();
    await page.keyboard.press('Space');
    await expect(page.getByRole('region', { name: 'Generated text' })).toBeVisible();
  });

  test(`${theme}: Enter in the ingest form submits; the live region says when generation finished, and a failure is said once by the alert`, async ({ page }) => {
    await mockApi(page);
    await openScreen(page, screen('generate'), theme);
    await page.getByLabel('Draft').fill('A draft.');
    await page.getByRole('button', { name: 'Generate' }).click();
    await expect(page.getByTestId('live-region')).toContainText('Generation finished');
    await page.unrouteAll();
    await mockApi(page, { 'POST /api/generate': () => ({ status: 502, body: ERR('LLM_FAILED', 'm') }) });
    await page.getByRole('button', { name: 'Generate' }).click();
    // the failure is said once, by the alert; the polite live region no longer repeats it
    await expect(page.getByRole('alert')).toHaveAttribute('data-code', 'LLM_FAILED');
    await expect(page.getByTestId('live-region')).toHaveText('');

    await page.unrouteAll();
    await mockApi(page);
    await openScreen(page, screen('authors'), theme);
    await page.getByLabel('Author id').fill('kb-author');
    await page.getByLabel('Writing sample').fill('Typed with the keyboard.');
    await page.getByLabel('Display name').fill('KB');
    await page.keyboard.press('Enter'); // implicit submission from a single-line field (Enter in the text area is a new line)
    await expect(page.getByTestId('ingest-done')).toContainText('Ingested');
    await expect(page.getByTestId('live-region')).toContainText('Ingested');
  });

  test(`${theme}: the Humanize tab opens by arrow key and the dialog-free page has no focus loss after a result`, async ({ page }) => {
    await mockApi(page);
    await openScreen(page, screen('score'), theme);
    await page.getByRole('tab', { name: 'Score' }).focus();
    await page.keyboard.press('ArrowRight');
    await expect(page.getByRole('tab', { name: 'Humanize' })).toHaveAttribute('aria-selected', 'true');
    await page.getByLabel('Text to humanize').fill('Text to rewrite.');
    await page.getByRole('button', { name: 'Humanize' }).focus();
    await page.keyboard.press('Enter');
    await page.getByTestId('score-after').waitFor();
    expect((await focused(page)).name, 'focus stays on the button').toBe('Humanize');
  });
}
