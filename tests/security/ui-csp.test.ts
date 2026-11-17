// Security tier, web UI (Phase 11): the served Content-Security-Policy. The UI's own scripts, styles and requests are all
// same-origin; nothing needs `unsafe-inline`, `unsafe-eval`, `data:` or a remote origin. Phase 10 chose a policy stricter
// than the phase-11 plan's table (`default-src 'none'`, no `data:` images, `form-action 'none'`); this pins that it stays
// at least that strict, on the lazily loaded feature chunks as well as the shell.
import { readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { createStaticHandler, UI_CSP } from '../../src/api/static.js';
import { makeRuntime, raw, startTestServer } from '../helpers/surfaces.js';

const uiDist = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', 'ui', 'dist');

function directives(csp: string): Map<string, string[]> {
  return new Map(csp.split(';').map((d) => d.trim()).filter(Boolean).map((d) => { const [name, ...vals] = d.split(/\s+/); return [name!, vals] as const; }));
}

describe('UI_CSP', () => {
  const d = directives(UI_CSP);

  it('has the required directives', () => {
    expect(d.get('default-src')).toEqual(["'none'"]);
    expect(d.get('script-src')).toEqual(["'self'"]);
    expect(d.get('connect-src')).toEqual(["'self'"]);
    expect(d.get('frame-ancestors')).toEqual(["'none'"]);
    expect(d.get('base-uri')).toEqual(["'none'"]);
    expect(d.get('form-action')).toEqual(["'none'"]);
    expect(d.get('object-src')).toEqual(["'none'"]);
  });

  it('allows no inline script, eval, remote origin, wildcard or data: source for scripts, styles, connections or frames', () => {
    for (const [name, values] of d) {
      for (const v of values) {
        expect(v, `${name} ${v}`).not.toMatch(/unsafe-inline|unsafe-eval|unsafe-hashes|^\*$|^https?:|^wss?:|^data:|^blob:|strict-dynamic/);
      }
    }
    expect(d.get('style-src')![0]).toBe("'self'");
    // the only non-'self' style source is one exact sha256 (React Aria's iOS scroll-lock rule), checked by ui/tests/build/csp-compat.test.ts
    expect(d.get('style-src')!.slice(1).every((v) => /^'sha256-[A-Za-z0-9+/=]{43,}'$/.test(v))).toBe(true);
    expect(d.get('img-src')).toEqual(["'self'"]);
    expect(d.get('font-src')).toEqual(["'self'"]);
  });
});

describe('served by the real server', () => {
  it('the shell, the entry chunk and every lazily loaded feature chunk carry the policy, nosniff and no framing', async () => {
    const rig = await makeRuntime();
    const staticHandler = await createStaticHandler({ root: uiDist });
    const server = await startTestServer(rig, { staticHandler });
    try {
      const chunks = readdirSync(join(uiDist, 'assets')).filter((f) => f.endsWith('.js'));
      expect(chunks.length, 'screens are lazy chunks').toBeGreaterThanOrEqual(6);
      for (const path of ['/', '/authors', '/score', '/settings', ...chunks.map((c) => `/assets/${c}`)]) {
        const r = await raw(server, path);
        expect(r.status, path).toBe(200);
        expect(r.headers['content-security-policy'], path).toBe(UI_CSP);
        expect(r.headers['x-content-type-options'], path).toBe('nosniff');
        expect(r.headers['x-frame-options'], path).toBe('DENY');
        expect(r.headers['permissions-policy'], path).toBe('camera=(), microphone=(), geolocation=()');
        expect(r.headers['cross-origin-opener-policy'], path).toBe('same-origin');
      }
    } finally {
      await server.close();
      rig.cleanup();
    }
  });
});
