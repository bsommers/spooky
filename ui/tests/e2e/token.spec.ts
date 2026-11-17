// The token flows in a real browser against the REAL server started with a bearer token required (tests/e2e/server/start.mjs
// --token-env, the second webServer in playwright.config.ts): the gate, a wrong token, the right one, a token that stops
// working mid-session, and the lockout. The first server has no token, so none of this is exercised anywhere else outside jsdom.
// Throughout: the token is memory-only. It is sent as the Authorization header and nowhere else, and never appears in the
// address, storage, the page, a response body or an error message.
import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import { E2E_TOKEN, PLANTED_KEY } from './server/constants.mjs';

/** playwright.config.ts starts the token server on the next port after the open one. */
const TOKEN_PORT = Number(process.env.GW_E2E_PORT ?? 4873) + 1;

test.use({ baseURL: `http://127.0.0.1:${TOKEN_PORT}` });
test.describe.configure({ mode: 'serial' });

const WRONG = 'wrong-bearer-Zq3Jd8Wm5Ns2Vc7Xb1Kp';
const DRAFT = 'Please write the release note for Friday.';

/** Collect every response body and every header the page sends, to look for the token where it must not be. */
function watch(page: Page) {
  const seen = { bodies: [] as string[], authHeaders: [] as Array<{ url: string; value: string | undefined }>, urls: [] as string[], console: [] as string[] };
  page.on('response', async (r) => seen.bodies.push(await r.text().catch(() => '')));
  page.on('request', (r) => {
    seen.urls.push(r.url());
    seen.authHeaders.push({ url: r.url(), value: r.headers().authorization });
  });
  page.on('console', (m) => seen.console.push(m.text()));
  return seen;
}

async function nowhere(page: Page, seen: ReturnType<typeof watch>, secret: string): Promise<void> {
  const stores = await page.evaluate(() => ({
    local: JSON.stringify({ ...localStorage }),
    session: JSON.stringify({ ...sessionStorage }),
    cookie: document.cookie,
    url: location.href,
    // the password field may hold what the user is typing; everything else in the page must not hold the token
    html: (() => {
      const copy = document.documentElement.cloneNode(true) as HTMLElement;
      copy.querySelectorAll('input').forEach((i) => i.removeAttribute('value'));
      return copy.outerHTML;
    })(),
  }));
  for (const [where, text] of Object.entries({ ...stores, bodies: seen.bodies.join('\n'), urls: seen.urls.join('\n'), console: seen.console.join('\n') })) {
    expect(text, where).not.toContain(secret);
  }
  expect(seen.bodies.join('\n')).not.toContain(PLANTED_KEY);
  // the header only ever goes to the API, never to a static file
  for (const h of seen.authHeaders) if (h.value !== undefined) expect(new URL(h.url).pathname.startsWith('/api/'), h.url).toBe(true);
}

async function connect(page: Page, token: string): Promise<void> {
  await page.getByLabel('API token').fill(token);
  await page.getByRole('button', { name: 'Connect' }).click();
}

test('a server that requires a token: no screen shows data before it, a wrong token is refused and not kept', async ({ page }) => {
  const seen = watch(page);
  await page.goto('/#/generate');
  await expect(page.getByText('This server asks for an API token.')).toBeVisible();
  await expect(page.getByRole('heading', { level: 1, name: 'Generate' })).toBeVisible();
  await expect(page.getByLabel('Draft', { exact: true })).toHaveCount(0);
  await connect(page, WRONG);
  await expect(page.getByText('That token was not accepted.')).toBeVisible();
  await expect(page.getByLabel('Draft', { exact: true })).toHaveCount(0);
  await nowhere(page, seen, WRONG);
  // nothing in the page text names the model's key either
  expect(await page.locator('body').innerText()).not.toContain(PLANTED_KEY);
});

test('the right token opens the gate, moves focus to the content and announces it; a full flow then works with the token in the header only', async ({ page }) => {
  const seen = watch(page);
  await page.goto('/#/generate');
  await connect(page, E2E_TOKEN);
  await page.getByLabel('Draft', { exact: true }).waitFor();
  await expect(page.locator('main')).toBeFocused();
  await expect(page.getByTestId('live-region')).toContainText('Connected');
  await page.getByLabel('Draft', { exact: true }).fill(DRAFT);
  await page.getByRole('button', { name: 'Generate' }).click();
  await expect(page.getByRole('region', { name: 'Generated text' })).toBeVisible();
  await page.getByRole('link', { name: 'Authors' }).click();
  await page.getByTestId('profile').waitFor();
  const withToken = seen.authHeaders.filter((h) => h.value === `Bearer ${E2E_TOKEN}`);
  expect(withToken.length).toBeGreaterThan(3);
  await nowhere(page, seen, E2E_TOKEN);
});

test('a token that stops working mid-session sends the app back to the token form and is not sent again', async ({ page }) => {
  const seen = watch(page);
  await page.goto('/#/generate');
  await connect(page, E2E_TOKEN);
  await page.getByLabel('Draft', { exact: true }).fill(DRAFT);
  // the server (or a proxy) now refuses the token on the next call
  await page.route('**/api/generate', (route) => route.fulfill({ status: 401, contentType: 'application/json', body: JSON.stringify({ ok: false, error: { code: 'UNAUTHORIZED', message: 'a valid bearer token is required' } }) }));
  await page.getByRole('button', { name: 'Generate' }).click();
  await expect(page.getByText('That token was not accepted.')).toBeVisible();
  await expect(page.getByLabel('Draft', { exact: true })).toHaveCount(0);
  const count = seen.authHeaders.length;
  await page.getByRole('link', { name: 'Personas' }).click(); // moving around while signed out sends nothing with the old token
  await expect(page.getByText('That token was not accepted.')).toBeVisible();
  expect(seen.authHeaders.slice(count).filter((h) => h.value !== undefined)).toEqual([]);
  // a new token gets the app working again
  await page.unroute('**/api/generate');
  await connect(page, E2E_TOKEN);
  await expect(page.getByRole('listbox', { name: 'Personas' })).toBeVisible();
  await nowhere(page, seen, E2E_TOKEN);
});

test('too many wrong tokens locks the address out: the page says to wait, forgets the token, and even the right one is refused meanwhile', async ({ page }) => {
  const seen = watch(page);
  await page.goto('/#/settings');
  let locked = false;
  for (let i = 0; i < 10 && !locked; i++) {
    await connect(page, `${WRONG}${i}`);
    await expect(page.getByText(/That token was not accepted\.|Too many attempts/)).toBeVisible();
    locked = await page.getByText(/Too many attempts; try again in \d+ seconds/).isVisible();
  }
  expect(locked).toBe(true);
  await connect(page, E2E_TOKEN);
  await expect(page.getByText(/Too many attempts; try again in \d+ seconds/)).toBeVisible();
  await expect(page.getByLabel('Draft', { exact: true })).toHaveCount(0);
  await nowhere(page, seen, WRONG);
  await nowhere(page, seen, E2E_TOKEN);
});
