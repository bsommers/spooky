// Deterministic API for the visual and accessibility tiers: the page is the real built UI served by the real server, but
// every /api request is answered from tests/helpers/fixtures.ts (fixed numbers, fixed timings). The real-server flow is
// tested in flow.spec.ts.
import type { Page } from '@playwright/test';
import { respond } from '../helpers/fixtures';
import type { Overrides } from '../helpers/fixtures';

export async function mockApi(page: Page, overrides: Overrides = {}, hold: Record<string, Promise<void>> = {}): Promise<void> {
  await page.route('**/api/**', async (route) => {
    const req = route.request();
    const url = new URL(req.url());
    const raw = req.postData();
    const body = raw === null ? undefined : (JSON.parse(raw) as unknown);
    const key = `${req.method()} ${url.pathname}`;
    const h = hold[key];
    if (h !== undefined) await h;
    const r = respond(req.method(), url.pathname + url.search, body, overrides);
    await route.fulfill({ status: r.status, contentType: 'application/json', body: JSON.stringify(r.body), headers: r.headers ?? {} });
  });
}
