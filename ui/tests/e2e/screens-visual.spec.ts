// Visual tier for the feature screens: committed PNG baselines of every screen in both themes (desktop 1280x800, and a
// phone width for the main states), plus the Generate error state. The API is answered from fixtures (mockApi), so every
// number and timing is fixed; fonts are awaited and animations are frozen by the screenshot option. Baselines come from
// the pinned Playwright image (ui/scripts/e2e-container.sh --update-snapshots); the threshold is in playwright.config.ts
// (maxDiffPixelRatio 0.002 = 0.2% of pixels), documented in docs/UI.md.
import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import { SCREENS, THEME_IDS, openScreen } from './helpers';
import { mockApi } from './mockApi';
import { ERR } from '../helpers/fixtures';

const VIEWPORTS = [
  { name: 'desktop', width: 1280, height: 800 },
  { name: 'phone', width: 390, height: 844 },
] as const;

const screen = (name: string) => SCREENS.find((s) => s.name === name)!;

async function generate(page: Page): Promise<void> {
  await page.getByLabel('Draft').fill('Please write the release note for Friday. Keep it short.');
  await page.getByRole('button', { name: 'Generate' }).click();
}

interface State {
  name: string;
  screen: string;
  phone: boolean;
  setup?: (page: Page) => Promise<void>;
  after?: (page: Page) => Promise<void>;
}

const STATES: State[] = [
  { name: 'generate', screen: 'generate', phone: true },
  { name: 'generate-result', screen: 'generate', phone: false, after: async (p) => { await generate(p); await p.getByRole('region', { name: 'Generated text' }).waitFor(); } },
  {
    name: 'generate-error',
    screen: 'generate',
    phone: false,
    setup: (p) => mockApi(p, { 'POST /api/generate': () => ({ status: 502, body: ERR('LLM_FAILED', 'the model call failed after 2 retries') }) }),
    after: async (p) => { await generate(p); await p.getByRole('alert').waitFor(); },
  },
  { name: 'authors', screen: 'authors', phone: true },
  { name: 'personas', screen: 'personas', phone: true },
  { name: 'settings', screen: 'settings', phone: true },
  { name: 'score', screen: 'score', phone: true },
  {
    name: 'humanize-result',
    screen: 'score',
    phone: false,
    after: async (p) => {
      await p.getByRole('tab', { name: 'Humanize' }).click();
      await p.getByLabel('Text to humanize').fill('A draft with 42 and 7.5 in it.');
      await p.getByRole('button', { name: 'Humanize' }).click();
      await p.getByTestId('score-after').waitFor();
    },
  },
];

for (const st of STATES) {
  for (const vp of VIEWPORTS) {
    if (vp.name === 'phone' && !st.phone) continue;
    for (const theme of THEME_IDS) {
      test(`${st.name} / ${theme} / ${vp.name}`, async ({ page }) => {
        await page.setViewportSize({ width: vp.width, height: vp.height });
        if (st.setup) await st.setup(page);
        else await mockApi(page);
        await openScreen(page, screen(st.screen), theme);
        if (st.after) await st.after(page);
        await expect(page).toHaveScreenshot(`${st.name}-${theme}-${vp.name}.png`, { fullPage: true });
      });
    }
  }
}
