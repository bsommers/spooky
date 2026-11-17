import { accessSync, constants, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { UI_CSP, createStaticHandler, hasBuiltUi, safeSegments } from '../../../src/api/static.js';
import { raw } from '../../helpers/surfaces.js';
import { SECRET, makeUiFixture } from '../../helpers/uiFixture.js';
import type { UiFixture } from '../../helpers/uiFixture.js';

// The handler on its own http server (no auth, no Host policy): what it serves and, above all, what it refuses.
let fx: UiFixture;
let server: Server;
let target: { host: string; port: number };

beforeAll(async () => {
  fx = makeUiFixture();
  const handler = await createStaticHandler({ root: fx.root });
  server = createServer((req, res) => {
    void (async () => {
      const handled = await handler(req, res, new URL(req.url ?? '/', 'http://127.0.0.1'));
      if (!handled) {
        res.statusCode = 404;
        res.end('not-handled');
      }
    })();
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  target = { host: '127.0.0.1', port: (server.address() as AddressInfo).port };
});
afterAll(async () => {
  await new Promise<void>((r) => server.close(() => r()));
  fx.cleanup();
});

describe('static handler: serving', () => {
  it('serves index.html at / with the CSP, nosniff and no framing', async () => {
    const r = await raw(target, '/');
    expect(r.status).toBe(200);
    expect(r.text).toContain('id="root"');
    expect(r.headers['content-type']).toBe('text/html; charset=utf-8');
    expect(r.headers['content-security-policy']).toBe(UI_CSP);
    expect(r.headers['x-content-type-options']).toBe('nosniff');
    expect(r.headers['x-frame-options']).toBe('DENY');
    expect(r.headers['permissions-policy']).toBe('camera=(), microphone=(), geolocation=()');
    expect(r.headers['cross-origin-opener-policy']).toBe('same-origin');
    expect(r.headers['cache-control']).toBe('no-store');
    expect(r.headers['content-length']).toBe(String(Buffer.byteLength(r.text)));
  });

  it('the CSP allows this origin only: no inline script or style, no remote anything, no frames, no <base>', () => {
    for (const d of ["default-src 'none'", "script-src 'self'", "style-src 'self' 'sha256-gYiS/BvZvRcK27JIXTuwhZ3hs2+VJ1X+2gUlE+farlg='", "font-src 'self'", "img-src 'self'", "connect-src 'self'", "base-uri 'none'", "frame-ancestors 'none'", "object-src 'none'", "form-action 'none'"]) {
      expect(UI_CSP).toContain(d);
    }
    expect(UI_CSP).not.toMatch(/unsafe-inline|unsafe-eval|\*|https?:|data:/);
  });

  it('serves each file type with its content type; hashed bundle files are immutable, everything else is not cached', async () => {
    const js = await raw(target, '/assets/app-AbCdEf12.js');
    expect([js.status, js.headers['content-type'], js.headers['cache-control']]).toEqual([200, 'text/javascript; charset=utf-8', 'public, max-age=31536000, immutable']);
    expect((await raw(target, '/assets/app-AbCdEf12.css')).headers['content-type']).toBe('text/css; charset=utf-8');
    expect((await raw(target, '/assets/font-AbCdEf12.woff2')).headers['content-type']).toBe('font/woff2');
    expect((await raw(target, '/favicon.svg')).headers['content-type']).toBe('image/svg+xml');
    const init = await raw(target, '/theme-init.js');
    expect([init.status, init.headers['cache-control']]).toEqual([200, 'no-store']);
    expect((await raw(target, '/sub/')).text).toContain('sub index'); // a directory serves its index.html
  });

  it('only Vite-hashed names under assets/ are immutable: judged by the requested name, not by hyphens or the symlink target', async () => {
    for (const p of ['/assets/font-regular.woff2', '/assets/my-notes.txt', '/assets/plain.js']) {
      const r = await raw(target, p);
      expect([p, r.status, r.headers['cache-control']], p).toEqual([p, 200, 'no-store']);
    }
  });

  it('the shipped licence text (.md) is served as inert text/plain so a browser shows it instead of downloading it', async () => {
    const r = await raw(target, '/licenses/THIRD_PARTY_LICENSES.md');
    expect([r.status, r.headers['content-type'], r.headers['x-content-type-options']]).toEqual([200, 'text/plain; charset=utf-8', 'nosniff']);
    expect(r.text).toContain('Third-party licences');
  });

  it('a file that cannot be opened is answered (404) before any header, not by resetting the connection', async () => {
    const file = join(fx.root, 'assets', 'locked-AbCdEf12.js');
    let readable = true;
    try {
      accessSync(file, constants.R_OK);
    } catch {
      readable = false;
    }
    const r = await raw(target, '/assets/locked-AbCdEf12.js'); // would reject with a socket error if the connection were destroyed
    if (readable) expect(r.status).toBe(200); // running as a user that bypasses file modes (root): nothing to refuse
    else expect([r.status, r.text, r.headers['content-security-policy']]).toEqual([404, 'not-handled', undefined]);
  });

  it('HEAD answers headers and length with no body; other methods are not handled', async () => {
    const head = await raw(target, '/', { method: 'HEAD' });
    expect([head.status, head.text, Number(head.headers['content-length']) > 0]).toEqual([200, '', true]);
    for (const method of ['POST', 'PUT', 'DELETE', 'OPTIONS']) expect((await raw(target, '/', { method })).text, method).toBe('not-handled');
  });

  it('SPA fallback: an extension-less path gets index.html, a missing file with an extension is not handled', async () => {
    expect((await raw(target, '/some/deep/link')).text).toContain('id="root"');
    for (const p of ['/missing.js', '/assets/nope-AbCdEf12.css', '/nothing.png']) expect((await raw(target, p)).text, p).toBe('not-handled');
  });

  it('never falls back for the protected namespace', async () => {
    for (const p of ['/api', '/api/', '/api/authors', '/api/anything/deep', '/openapi.json', '/mcp']) {
      const r = await raw(target, p);
      expect([p, r.status, r.text], p).toEqual([p, 404, 'not-handled']);
    }
  });
});

describe('static handler: a symlinked directory index', () => {
  it('never serves a directory index.html that is a symlink leaving the root (falls back to the SPA shell instead)', async () => {
    for (const p of ['/sub2/', '/sub2']) {
      const r = await raw(target, p);
      expect(r.text, p).not.toContain(SECRET);
      expect([p, r.status, r.text.includes('id="root"')], p).toEqual([p, 200, true]);
    }
  });
});

describe('static handler: path traversal and hidden files are 404', () => {
  const attacks = [
    '/../secret.txt',
    '/assets/../../secret.txt',
    '/%2e%2e/secret.txt',
    '/%2E%2E/secret.txt',
    '/assets/%2e%2e/%2e%2e/secret.txt',
    '/..%2fsecret.txt',
    '/%2e%2e%2fsecret.txt',
    '/assets/..%2f..%2fsecret.txt',
    '/..%5csecret.txt',
    '/assets/..%5c..%5csecret.txt',
    '/%252e%252e/secret.txt',
    '/..%00/secret.txt',
    '/index.html%00.png',
    '/dist-sibling.txt',
    '/../dist-sibling.txt',
    '/.hidden',
    '/assets/.hidden',
    '/%2ehidden',
    '/link.txt', // a symlink that points outside the root
    '/sub2/index.html',
    '/%ZZ', // malformed percent-encoding
  ];
  for (const p of attacks) {
    it(`${p}`, async () => {
      const r = await raw(target, p);
      expect(r.text).not.toContain(SECRET);
      expect(r.text).not.toContain('dotfile');
      expect(r.status).toBe(404);
    });
  }
});

describe('static handler: Windows path segments', () => {
  const hostile = ['/C:/Windows/win.ini', '/index.html::$DATA', '/assets/app-AbCdEf12.js:stream', '/sub/c:'];
  it('refuses a ":" in any segment on win32 (drive letters, alternate data streams)', () => {
    for (const p of hostile) expect(safeSegments(p, 'win32'), p).toBeUndefined();
    expect(safeSegments('/%43%3a/x', 'win32')).toBeUndefined(); // percent-encoded "C:" is decoded before the check
  });
  it('still accepts ordinary paths on win32, and leaves ":" alone on other platforms (a legal filename character there)', () => {
    expect(safeSegments('/assets/app-AbCdEf12.js', 'win32')).toEqual(['assets', 'app-AbCdEf12.js']);
    expect(safeSegments('/a:b', 'linux')).toEqual(['a:b']);
    expect(safeSegments('/a:b', 'darwin')).toEqual(['a:b']);
  });
});

describe('static handler setup', () => {
  it('refuses a directory without index.html and reports whether a build exists', async () => {
    await expect(createStaticHandler({ root: fx.base })).rejects.toThrow(/index\.html/);
    await expect(createStaticHandler({ root: `${fx.base}/does-not-exist` })).rejects.toThrow();
    expect(await hasBuiltUi(fx.root)).toBe(true);
    expect(await hasBuiltUi(fx.base)).toBe(false);
  });

  it('a root index.html that is a symlink leading outside the root is not a build and is refused', async () => {
    const base = mkdtempSync(join(tmpdir(), 'gw-ui-rootlink-'));
    try {
      const root = join(base, 'dist');
      mkdirSync(root);
      writeFileSync(join(base, 'secret.html'), SECRET);
      symlinkSync(join(base, 'secret.html'), join(root, 'index.html'));
      expect(await hasBuiltUi(root)).toBe(false);
      await expect(createStaticHandler({ root })).rejects.toThrow(/index\.html/);
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });
});
