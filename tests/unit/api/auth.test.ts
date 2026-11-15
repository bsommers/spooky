import { describe, expect, it } from 'vitest';
import {
  assertBindAllowed,
  bearerMatches,
  buildHostPolicy,
  checkHost,
  classifyOrigin,
  hostnameOfHostHeader,
  isLoopbackBind,
  normalizeAllowedOrigin,
  validateToken,
} from '../../../src/api/auth.js';
import { ConfigError } from '../../../src/models/errors.js';
import { SurfaceError } from '../../../src/service/errors.js';
import { makeRuntime, postJson, raw, startTestServer } from '../../helpers/surfaces.js';
import { startApiServer } from '../../../src/api/server.js';

const TOKEN = 'correct-horse-battery-staple-1234';

describe('token', () => {
  it('accepts 16-512 printable characters and refuses short, spaced or control-character tokens without echoing them', () => {
    expect(validateToken(TOKEN)).toBe(TOKEN);
    for (const bad of ['short', 'has space in it 1234567890', 'ctrl\u0007char-1234567890123', 'x'.repeat(513), '']) {
      let message = '';
      try {
        validateToken(bad);
      } catch (e) {
        expect(e).toBeInstanceOf(ConfigError);
        message = (e as Error).message;
      }
      expect(message, JSON.stringify(bad)).not.toBe('');
      if (bad.length > 4) expect(message).not.toContain(bad);
    }
  });

  it('bearerMatches: right token passes; missing, wrong, other scheme, lowercase scheme, extra text fail', () => {
    expect(bearerMatches(`Bearer ${TOKEN}`, TOKEN)).toBe(true);
    for (const h of [undefined, '', 'Bearer', 'Bearer ', `Bearer ${TOKEN}x`, `Bearer ${TOKEN.slice(1)}`, `Basic ${TOKEN}`, `bearer ${TOKEN}`, `Bearer  ${TOKEN}`, `Bearer ${TOKEN} extra`, TOKEN]) {
      expect(bearerMatches(h, TOKEN), String(h)).toBe(false);
    }
  });

  it('the comparison is constant-time: it goes through timingSafeEqual on equal-length digests (source check)', async () => {
    const { readFileSync } = await import('node:fs');
    const src = readFileSync(new URL('../../../src/api/auth.ts', import.meta.url), 'utf8');
    expect(src).toContain('timingSafeEqual(digest(');
    expect(src).toContain("createHash('sha256')");
    expect(src).not.toMatch(/presented\s*===\s*token|token\s*===\s*presented/);
  });
});

describe('bind policy', () => {
  it('loopback addresses are allowed without a token, anything else needs one', () => {
    for (const h of ['127.0.0.1', '127.1.2.3', 'localhost', '::1', '[::1]', 'LOCALHOST']) {
      expect(isLoopbackBind(h), h).toBe(true);
      expect(() => assertBindAllowed({ host: h, hasToken: false }), h).not.toThrow();
    }
    for (const h of ['0.0.0.0', '::', '192.168.1.5', '10.0.0.1', 'example.com', 'localhost.evil.com', '127.0.0.1.evil.com']) {
      expect(() => assertBindAllowed({ host: h, hasToken: false }), h).toThrow(ConfigError);
      expect(() => assertBindAllowed({ host: h, hasToken: true }), h).not.toThrow();
    }
  });

  it('the default host is 127.0.0.1, and --host 0.0.0.0 without a token refuses to start with a ConfigError', async () => {
    const rig = await makeRuntime();
    try {
      await expect(startApiServer({ runtime: rig.runtime, port: 0, host: '0.0.0.0' })).rejects.toThrow(ConfigError);
      const s = await startApiServer({ runtime: rig.runtime, port: 0 });
      try {
        expect(s.host).toBe('127.0.0.1');
        expect(s.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
        expect((s.server.address() as { address: string }).address).toBe('127.0.0.1');
      } finally {
        await s.close();
      }
    } finally {
      rig.cleanup();
    }
  });
});

describe('Host and Origin policy', () => {
  it('parses Host headers: names are lower-cased, ports dropped, junk refused', () => {
    expect(hostnameOfHostHeader('LocalHost:8787')).toBe('localhost');
    expect(hostnameOfHostHeader('[::1]:80')).toBe('[::1]');
    expect(hostnameOfHostHeader('127.0.0.1')).toBe('127.0.0.1');
    for (const bad of [undefined, '', 'a b', 'evil.com/x', 'a:b', 'x'.repeat(300), 'host:99999999']) expect(hostnameOfHostHeader(bad), String(bad)).toBeUndefined();
  });

  it('loopback names are accepted; other names are 421; a wildcard bind with a token turns the check off', () => {
    const p = buildHostPolicy('127.0.0.1', false);
    for (const h of ['localhost:1', '127.0.0.1:1', '[::1]:1', 'LOCALHOST']) expect(() => checkHost(p, h), h).not.toThrow();
    for (const h of ['evil.com', 'evil.com:8787', '127.0.0.1.evil.com', 'localhost.evil.com', undefined, '']) {
      expect(() => checkHost(p, h), String(h)).toThrow(SurfaceError);
    }
    expect(() => checkHost(buildHostPolicy('127.0.0.1', false, ['gw.internal']), 'gw.internal:9')).not.toThrow();
    expect(() => checkHost(buildHostPolicy('0.0.0.0', true), 'anything.example')).not.toThrow();
    expect(() => checkHost(buildHostPolicy('192.168.1.5', true), 'evil.com')).toThrow(SurfaceError);
  });

  it('--allow-origin is an exact origin: never *, null, a path, credentials or a non-http scheme', () => {
    expect(normalizeAllowedOrigin('http://localhost:5173')).toBe('http://localhost:5173');
    expect(normalizeAllowedOrigin('https://App.Example.com')).toBe('https://app.example.com');
    for (const bad of ['*', 'null', 'http://a.com/path', 'http://a.com?x=1', 'ftp://a.com', 'http://u:p@a.com', 'not a url', '']) {
      expect(() => normalizeAllowedOrigin(bad), bad).toThrow(ConfigError);
    }
  });

  it('classifyOrigin: none without a header, same-origin when it names this host, allowed from the list, else denied', () => {
    const pol = { allowedOrigins: new Set(['http://localhost:5173']) };
    expect(classifyOrigin(pol, undefined, 'localhost:8787')).toBe('none');
    expect(classifyOrigin(pol, 'http://localhost:8787', 'localhost:8787')).toBe('same-origin');
    expect(classifyOrigin(pol, 'http://localhost:5173', 'localhost:8787')).toBe('allowed');
    for (const o of ['http://evil.com', 'http://localhost:8788', 'null', 'http://localhost:5173/', 'garbage', 'file://']) {
      expect(classifyOrigin(pol, o, 'localhost:8787'), o).toBe('denied');
    }
  });
});

describe('auth over HTTP', () => {
  it('no token configured: open on loopback', async () => {
    const rig = await makeRuntime();
    const server = await startTestServer(rig);
    try {
      expect((await raw(server, '/api/personas')).status).toBe(200);
    } finally {
      await server.close();
      rig.cleanup();
    }
  });

  it('token configured: 401 without or with a wrong bearer, 200 with the right one; the token is in no log line and no response', async () => {
    const rig = await makeRuntime();
    const server = await startTestServer(rig, { token: TOKEN });
    try {
      const none = await raw(server, '/api/personas');
      expect(none.status).toBe(401);
      expect(none.json()).toEqual({ ok: false, error: { code: 'UNAUTHORIZED', message: expect.any(String) } });
      expect(none.headers['www-authenticate']).toBe('Bearer');
      const wrong = await raw(server, '/api/personas', { headers: { Authorization: `Bearer ${TOKEN}x` } });
      expect(wrong.status).toBe(401);
      expect(wrong.text).not.toContain(TOKEN);
      const ok = await raw(server, '/api/personas', { headers: { Authorization: `Bearer ${TOKEN}` } });
      expect(ok.status).toBe(200);
      expect(ok.text).not.toContain(TOKEN);
      for (const p of ['/openapi.json', '/api/config', '/api/capabilities', '/api/nope']) expect((await raw(server, p)).status, p).toBe(401);
      expect((await postJson(server, '/api/score', { text: 'hi there' })).status).toBe(401);
      const cfg = await raw(server, '/api/config', { headers: { Authorization: `Bearer ${TOKEN}` } });
      expect(cfg.text).not.toContain(TOKEN);
      expect(server.logs.join('\n')).not.toContain(TOKEN);
      expect(server.logs.length).toBeGreaterThan(0);
    } finally {
      await server.close();
      rig.cleanup();
    }
  });
});

describe('CORS', () => {
  it('no Access-Control-Allow-Origin by default, and never *', async () => {
    const rig = await makeRuntime();
    const server = await startTestServer(rig);
    try {
      const r = await raw(server, '/api/personas');
      expect(r.headers['access-control-allow-origin']).toBeUndefined();
      const same = await raw(server, '/api/personas', { headers: { Origin: `http://127.0.0.1:${server.port}` } });
      expect(same.status).toBe(200);
      expect(same.headers['access-control-allow-origin']).toBeUndefined();
      const other = await raw(server, '/api/personas', { headers: { Origin: 'http://evil.example' } });
      expect(other.status).toBe(403);
      expect(other.headers['access-control-allow-origin']).toBeUndefined();
    } finally {
      await server.close();
      rig.cleanup();
    }
  });

  it('an allow-listed origin is echoed exactly (with Vary); preflight from it succeeds; from any other origin it is 403', async () => {
    const rig = await makeRuntime();
    const server = await startTestServer(rig, { allowOrigins: ['http://localhost:5173'] });
    try {
      const get = await raw(server, '/api/personas', { headers: { Origin: 'http://localhost:5173' } });
      expect(get.status).toBe(200);
      expect(get.headers['access-control-allow-origin']).toBe('http://localhost:5173');
      expect(get.headers.vary).toContain('Origin');
      const pre = await raw(server, '/api/generate', { method: 'OPTIONS', headers: { Origin: 'http://localhost:5173', 'Access-Control-Request-Method': 'POST' } });
      expect(pre.status).toBe(204);
      expect(pre.headers['access-control-allow-origin']).toBe('http://localhost:5173');
      expect(pre.headers['access-control-allow-methods']).toContain('POST');
      expect(pre.headers['access-control-allow-headers']?.toLowerCase()).toContain('authorization');
      for (const o of ['http://evil.example', 'http://localhost:5174', 'http://localhost:5173.evil.example', 'null']) {
        const bad = await raw(server, '/api/generate', { method: 'OPTIONS', headers: { Origin: o, 'Access-Control-Request-Method': 'POST' } });
        expect(bad.status, o).toBe(403);
        expect(bad.headers['access-control-allow-origin'], o).toBeUndefined();
      }
    } finally {
      await server.close();
      rig.cleanup();
    }
  });

  it('a wildcard allow-origin is refused at startup', async () => {
    const rig = await makeRuntime();
    try {
      await expect(startApiServer({ runtime: rig.runtime, port: 0, allowOrigins: ['*'] })).rejects.toThrow(ConfigError);
    } finally {
      rig.cleanup();
    }
  });
});
