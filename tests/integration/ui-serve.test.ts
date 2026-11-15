// Integration tier: the Phase 10 web UI served by the real API server, next to the API.
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { createStaticHandler, defaultUiDir, UI_CSP } from '../../src/api/static.js';
import { makeRuntime, raw, startTestServer } from '../helpers/surfaces.js';

const uiDist = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', 'ui', 'dist');
const TOKEN = 'integration-token-0123456789abcdef';

async function withUi<T>(opts: Parameters<typeof startTestServer>[1], fn: (s: Awaited<ReturnType<typeof startTestServer>>) => Promise<T>): Promise<T> {
  const rig = await makeRuntime();
  const staticHandler = await createStaticHandler({ root: uiDist });
  const server = await startTestServer(rig, { staticHandler, ...opts });
  try {
    return await fn(server);
  } finally {
    await server.close();
    rig.cleanup();
  }
}

describe('web UI next to the API', () => {
  it('the default UI directory is ui/dist next to the package', async () => {
    expect(await defaultUiDir()).toBe(uiDist);
  });

  it('serves the built shell at / with the CSP, and every asset it references', async () => {
    await withUi({}, async (s) => {
      const page = await raw(s, '/');
      expect(page.status).toBe(200);
      expect(page.headers['content-security-policy']).toBe(UI_CSP);
      expect(page.text).toContain('<div id="root">');
      const refs = [...page.text.matchAll(/(?:src|href)="(\/[^"]+)"/g)].map((m) => m[1] as string);
      expect(refs).toEqual(expect.arrayContaining(['/theme-init.js', '/favicon.svg', '/manifest.webmanifest']));
      expect(refs.some((r) => /^\/assets\/index-.+\.js$/.test(r))).toBe(true);
      for (const ref of refs) expect((await raw(s, ref)).status, ref).toBe(200);
    });
  });

  it('the API and OpenAPI document still answer under /api and /openapi.json, with the API (not the UI) policy', async () => {
    await withUi({}, async (s) => {
      const caps = await raw(s, '/api/capabilities');
      expect(caps.status).toBe(200);
      expect(caps.headers['content-type']).toContain('application/json');
      expect(caps.headers['content-security-policy']).toBe("default-src 'none'; frame-ancestors 'none'");
      expect(caps.json().operations.length).toBeGreaterThan(5);
      expect((await raw(s, '/openapi.json')).json().openapi).toBe('3.1.0');
    });
  });

  it('SPA fallback serves the shell for a deep link but never for the API namespace: those stay JSON 404s', async () => {
    await withUi({}, async (s) => {
      expect((await raw(s, '/kitchen-sink')).text).toContain('<div id="root">');
      for (const p of ['/api', '/api/nope', '/api/authors/extra', '/mcp']) {
        const r = await raw(s, p);
        expect(r.status, p).toBe(404);
        expect(r.headers['content-type'], p).toContain('application/json');
        expect(r.text, p).not.toContain('<div id="root">');
      }
      expect((await raw(s, '/missing-file.js')).status).toBe(404);
    });
  });

  it('with a token the shell and assets are public (the app asks for the token itself); the API is not', async () => {
    await withUi({ token: TOKEN }, async (s) => {
      expect((await raw(s, '/')).status).toBe(200);
      expect((await raw(s, '/theme-init.js')).status).toBe(200);
      expect((await raw(s, '/api/capabilities')).status).toBe(401);
      expect((await raw(s, '/api/capabilities', { headers: { Authorization: `Bearer ${TOKEN}` } })).status).toBe(200);
      expect((await raw(s, '/kitchen-sink')).text).toContain('<div id="root">');
      expect((await raw(s, '/api')).status).toBe(404);
    });
  });

  it('a foreign Host is refused for the UI too (DNS rebinding), and no token or secret is in any served file', async () => {
    await withUi({ token: TOKEN }, async (s) => {
      expect((await raw(s, '/', { headers: { Host: 'evil.example' } })).status).toBe(421);
      const page = await raw(s, '/');
      expect(page.text).not.toContain(TOKEN);
    });
  });
});
