// Security tier in a real browser: the served CSP is enforced, the app causes no violation while it is used, and an
// injected inline script is blocked (so a clean run is not just a missing policy).
import { expect, test } from '@playwright/test';
import { THEME_IDS, openApp } from './helpers';

test('/ is served with the CSP header and the other hardening headers', async ({ request }) => {
  const res = await request.get('/');
  expect(res.status()).toBe(200);
  const csp = res.headers()['content-security-policy'] ?? '';
  expect(csp).toContain("script-src 'self'");
  expect(csp).toContain("default-src 'none'");
  expect(csp).not.toMatch(/unsafe-inline|unsafe-eval/);
  expect(res.headers()['x-content-type-options']).toBe('nosniff');
  expect(res.headers()['x-frame-options']).toBe('DENY');
});

for (const theme of THEME_IDS) {
  test(`${theme}: using the app (navigate, switch theme, open the dialog, the list and a tooltip) reports no CSP violation and no console error`, async ({ page }) => {
    const problems: string[] = [];
    await page.addInitScript(() => {
      document.addEventListener('securitypolicyviolation', (e) => {
        (window as unknown as { __csp: string[] }).__csp ??= [];
        (window as unknown as { __csp: string[] }).__csp.push(`${e.violatedDirective} ${e.blockedURI} ${e.sample}`);
      });
    });
    page.on('console', (m) => {
      if (m.type() === 'error' || m.type() === 'warning') problems.push(`${m.type()}: ${m.text()}`);
    });
    page.on('pageerror', (e) => problems.push(`pageerror: ${e.message}`));
    await openApp(page, '#/', theme);
    await page.getByRole('link', { name: 'Kitchen sink' }).click();
    await page.getByRole('heading', { level: 1, name: 'Kitchen sink' }).waitFor();
    await page.getByRole('button', { name: /theme/i }).click();
    await page.getByRole('option', { name: theme === 'black-cat' ? 'Tron Neon' : 'Black Cat' }).click();
    await page.getByRole('button', { name: 'Open dialog' }).click();
    await page.getByRole('dialog').waitFor();
    await page.keyboard.press('Escape');
    await page.getByRole('button', { name: 'Paw tooltip demo' }).focus();
    await page.keyboard.press('Tab');
    await page.keyboard.press('Shift+Tab');
    await page.getByRole('tooltip').waitFor();
    const violations = await page.evaluate(() => (window as unknown as { __csp?: string[] }).__csp ?? []);
    expect(violations).toEqual([]);
    expect(problems).toEqual([]);
  });
}

test('an inline script injected into the page is blocked by the policy', async ({ page }) => {
  await openApp(page, '#/', 'black-cat');
  const result = await page.evaluate(
    () =>
      new Promise<{ ran: boolean; violated: string | null }>((resolve) => {
        let violated: string | null = null;
        document.addEventListener('securitypolicyviolation', (e) => (violated = e.violatedDirective), { once: true });
        (window as unknown as { __ran?: boolean }).__ran = false;
        const s = document.createElement('script');
        s.textContent = 'window.__ran = true';
        document.head.append(s);
        setTimeout(() => resolve({ ran: (window as unknown as { __ran: boolean }).__ran, violated }), 100);
      }),
  );
  expect(result.ran).toBe(false);
  expect(result.violated).toMatch(/^script-src/);
});

test('a script from another origin and an inline style element are blocked as well', async ({ page }) => {
  await openApp(page, '#/', 'black-cat');
  const violated = await page.evaluate(
    () =>
      new Promise<string[]>((resolve) => {
        const seen: string[] = [];
        document.addEventListener('securitypolicyviolation', (e) => seen.push(e.violatedDirective));
        const s = document.createElement('script');
        s.src = 'https://cdn.example.invalid/x.js';
        document.head.append(s);
        const st = document.createElement('style');
        st.textContent = 'body { background: red }';
        document.head.append(st);
        setTimeout(() => resolve(seen), 200);
      }),
  );
  expect(violated.some((d) => d.startsWith('script-src'))).toBe(true);
  expect(violated.some((d) => d.startsWith('style-src'))).toBe(true);
});
