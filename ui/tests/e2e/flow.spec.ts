// End to end on the REAL server (tests/e2e/server/start.mjs: the real API server and built UI, the model scripted with
// MockLlmClient, one author ingested): the whole user flow, and the secret/offline/CSP properties over it.
import { execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test } from '@playwright/test';
import type { Page, Response } from '@playwright/test';
import { KEY_ENV, MODEL_ANSWER, PLANTED_KEY } from './server/constants.mjs';
import { SCREENS, THEME_IDS, openScreen } from './helpers';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const DRAFT = 'Please write the release note for Friday.';

for (const theme of THEME_IDS) {
  test(`${theme}: ingest an author, generate in their voice, and the output on screen is exactly what the API returns`, async ({ page, request }) => {
    const bodies: string[] = [];
    page.on('response', async (r: Response) => {
      if (r.url().includes('/api/')) bodies.push(await r.text().catch(() => ''));
    });
    await openScreen(page, SCREENS[1], theme); // authors
    const options = page.getByRole('listbox', { name: 'Authors' }).getByRole('option');
    await expect(options.first()).toBeVisible();
    const before = await options.count(); // the server keeps its state between specs
    const id = `e2e-${theme}`;
    await page.getByLabel('Author id').fill(id);
    await page.getByLabel('Writing sample').fill('Short sentences. Plain words. We ship on Fridays. We test first. We keep the notes brief and we say what changed.');
    await page.getByLabel('Display name').fill(`E2E ${theme}`);
    await page.getByRole('button', { name: 'Ingest' }).click();
    await expect(page.getByTestId('ingest-done')).toContainText(`Ingested ${id}`);
    await expect(options).toHaveCount(before + 1);
    await expect(page.getByTestId('profile')).toContainText('words');

    await page.getByRole('link', { name: 'Generate' }).click();
    await page.getByLabel('Draft', { exact: true }).waitFor();
    await page.getByRole('button', { name: /Author/ }).click();
    await page.getByRole('option', { name: new RegExp(`E2E ${theme}`) }).click();
    await page.getByLabel('Draft', { exact: true }).fill(DRAFT);
    await page.getByRole('button', { name: 'Generate' }).click();
    const out = page.getByRole('region', { name: 'Generated text' });
    await expect(out).toBeVisible();

    const api = await request.post('/api/generate', { data: { authorId: id, persona: 'exec', text: DRAFT } });
    const doc = (await api.json()) as { ok: boolean; text: string };
    expect(doc.ok).toBe(true);
    expect(await out.textContent()).toBe(doc.text);
    expect(doc.text).toBe(MODEL_ANSWER);

    // the model's markup is text: no element was made, no handler ran
    expect(await out.locator('img, script').count()).toBe(0);
    expect(await page.evaluate(() => (window as unknown as { __pwned?: number }).__pwned)).toBeUndefined();
    await expect(page.getByRole('table', { name: 'Filters that ran, in order' }).getByRole('row')).not.toHaveCount(1);
    await expect(page.getByTestId('indicator-Banned phrases')).toContainText('0 removed or replaced');
    await expect(page.getByTestId('indicator-Confidentiality')).toContainText('redaction');
    expect(bodies.join('\n')).not.toContain(PLANTED_KEY);
  });
}

test('every screen works with the network blocked except localhost, on the real server', async ({ page }) => {
  const external: string[] = [];
  await page.route('**/*', (route) => {
    const u = new URL(route.request().url());
    if (u.hostname === '127.0.0.1' || u.hostname === 'localhost') return route.continue();
    external.push(u.href);
    return route.abort();
  });
  const failed: string[] = [];
  page.on('requestfailed', (r) => failed.push(r.url()));
  for (const s of SCREENS) {
    await openScreen(page, s, 'black-cat');
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
  }
  await page.getByRole('link', { name: 'Generate' }).click();
  await page.getByLabel('Draft', { exact: true }).fill(DRAFT);
  await page.getByRole('button', { name: 'Generate' }).click();
  await expect(page.getByRole('region', { name: 'Generated text' })).toBeVisible();
  expect(external).toEqual([]);
  expect(failed).toEqual([]);
});

test('CSP: no violation and no console error or warning on any screen, including a generated result with markup in it', async ({ page }) => {
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
  page.on('pageerror', (e) => problems.push(`pageerror: ${e.message}`));
  for (const theme of THEME_IDS) {
    for (const s of SCREENS) await openScreen(page, s, theme);
    await page.getByRole('link', { name: 'Generate' }).click();
    await page.getByLabel('Draft', { exact: true }).fill(DRAFT);
    await page.getByRole('button', { name: 'Generate' }).click();
    await page.getByRole('region', { name: 'Generated text' }).waitFor();
    await page.getByRole('button', { name: /Persona/ }).click();
    await page.getByRole('option', { name: 'Engineer' }).click();
    await page.getByRole('link', { name: 'Score / Humanize' }).click();
    await page.getByRole('tab', { name: 'Humanize' }).click();
    await page.getByLabel('Text to humanize').fill('A short text to rewrite, with 42 in it.');
    await page.getByRole('button', { name: 'Humanize' }).click();
    await page.getByTestId('score-after').waitFor();
    await page.getByRole('tab', { name: 'Score' }).click();
    await page.getByLabel('Text to score').fill('A short text to measure.');
    await page.getByRole('button', { name: 'Score' }).click();
    await page.getByTestId('score-value').waitFor();
  }
  expect(await page.evaluate(() => (window as unknown as { __csp?: string[] }).__csp ?? [])).toEqual([]);
  expect(problems).toEqual([]);
});

test('secrets: a key planted in the server environment never reaches the browser: not in any API response, storage, cookie or the bundle', async ({ page, context }) => {
  const seen: string[] = [];
  page.on('response', async (r) => {
    if (r.url().startsWith('http://127.0.0.1')) seen.push(await r.text().catch(() => ''));
  });
  await openScreen(page, SCREENS[4], 'black-cat'); // settings
  await expect(page.getByRole('region', { name: 'Model' })).toContainText(KEY_ENV);
  await expect(page.getByRole('region', { name: 'Model' })).toContainText('set on the server');
  // a full flow, then a token typed into Settings (held in memory)
  await page.getByLabel('API token').fill('memory-only-token-0123456789');
  await page.getByRole('button', { name: 'Use token' }).click();
  await page.getByRole('link', { name: 'Generate' }).click();
  await page.getByLabel('Draft', { exact: true }).fill(DRAFT);
  await page.getByRole('button', { name: 'Generate' }).click();
  await page.getByRole('region', { name: 'Generated text' }).waitFor();
  await page.getByRole('link', { name: 'Authors' }).click();
  await page.getByTestId('profile').waitFor();

  const stores = await page.evaluate(async () => {
    const dbs = (await indexedDB.databases?.()) ?? [];
    const cacheNames = typeof caches === 'undefined' ? [] : await caches.keys();
    return { local: { ...localStorage }, session: { ...sessionStorage }, dbs: dbs.map((d) => d.name), cache: cacheNames, cookie: document.cookie, url: location.href, html: document.documentElement.outerHTML };
  });
  expect(Object.keys(stores.local)).toEqual(['gw-theme']);
  expect(stores.session).toEqual({});
  expect(stores.dbs).toEqual([]);
  expect(stores.cache).toEqual([]);
  expect(stores.cookie).toBe('');
  for (const [where, text] of Object.entries({ storage: JSON.stringify(stores), responses: seen.join('\n') })) {
    expect(text, where).not.toContain(PLANTED_KEY);
    expect(text, where).not.toContain('memory-only-token');
  }
  expect(await context.cookies()).toEqual([]);
  expect(seen.length).toBeGreaterThan(3);
});

test('secrets: the built bundle holds no secret-shaped string and not the planted canary', () => {
  const out = execFileSync('node', [join(root, 'scripts', 'scan-bundle.mjs'), join(root, 'ui', 'dist'), '--planted', PLANTED_KEY], { encoding: 'utf8' });
  expect(out).toContain('clean');
});
