// Visual tier: committed PNG baselines of the shell and the kitchen sink, both themes, two viewports. Generated in the
// pinned Playwright container (ui/scripts/e2e-container.sh --update-snapshots); see docs/UI.md. Animations are disabled by
// the screenshot option and fonts are awaited, so a diff is a real change.
import { expect, test } from '@playwright/test';
import { ROUTES, THEME_IDS, openApp } from './helpers';

const VIEWPORTS = [
  { name: 'desktop', width: 1280, height: 800 },
  { name: 'phone', width: 390, height: 844 },
] as const;

for (const vp of VIEWPORTS) {
  for (const theme of THEME_IDS) {
    for (const route of ROUTES) {
      test(`${route.name} / ${theme} / ${vp.name}`, async ({ page }) => {
        await page.setViewportSize({ width: vp.width, height: vp.height });
        await openApp(page, route.hash, theme);
        await expect(page).toHaveScreenshot(`${route.name}-${theme}-${vp.name}.png`, { fullPage: route.name === 'kitchen-sink' });
      });
    }
  }
}

for (const theme of THEME_IDS) {
  test(`the open dialog and the open theme list / ${theme}`, async ({ page }) => {
    await openApp(page, '#/kitchen-sink', theme);
    await page.getByRole('button', { name: 'Open dialog' }).click();
    await page.getByRole('dialog').waitFor();
    await expect(page).toHaveScreenshot(`dialog-${theme}.png`);
    await page.keyboard.press('Escape');
    await page.getByRole('dialog').waitFor({ state: 'detached' });
    await page.getByRole('button', { name: /theme/i }).click();
    await page.getByRole('listbox').waitFor();
    await expect(page).toHaveScreenshot(`themelist-${theme}.png`);
  });
}
