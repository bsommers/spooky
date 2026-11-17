// Security tier for the built bundle: it must run under `script-src 'self'; style-src 'self'` with no allowance for
// inline code. The served policy is src/api/static.ts (UI_CSP); the real-browser run in tests/e2e/csp.spec.ts proves no
// violation is reported while the app is used.
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { UI_ROOT } from '../helpers/themes';

const DIST = join(UI_ROOT, 'dist');
const html = (): string => readFileSync(join(DIST, 'index.html'), 'utf8').replace(/<!--[\s\S]*?-->/g, '');
const rootStatic = (): string => readFileSync(join(UI_ROOT, '..', 'src', 'api', 'static.ts'), 'utf8');
const reactAria = (rel: string): string => readFileSync(join(UI_ROOT, 'node_modules', 'react-aria', 'dist', 'private', rel), 'utf8');

describe('index.html is CSP-compatible', () => {
  it('has no inline script: every <script> has a same-origin src, and the theme bootstrap is a file loaded before the app', () => {
    const scripts = [...html().matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)];
    expect(scripts.length).toBe(2);
    for (const [, attrs, body] of scripts) {
      expect(attrs, 'inline script').toMatch(/\bsrc="\/[^"]+"/);
      expect((body as string).trim()).toBe('');
    }
    const order = scripts.map((s) => /src="([^"]+)"/.exec(s[1] as string)?.[1]);
    expect(order[0]).toBe('/theme-init.js');
    expect(order[1]).toMatch(/^\/assets\/index-.+\.js$/);
  });

  it('has no <style> element, no style="" attribute, no on*="" handler, no javascript: URL, no <base>, no <iframe>/<object>/<embed>', () => {
    const h = html();
    expect(h).not.toMatch(/<style\b/i);
    expect(h).not.toMatch(/\sstyle\s*=/i);
    expect(h).not.toMatch(/\son[a-z]+\s*=/i);
    expect(h).not.toMatch(/javascript:/i);
    expect(h).not.toMatch(/<(?:base|iframe|object|embed|form)\b/i);
  });

  it('the bundle does not use eval or the Function constructor, and the app source never uses dangerouslySetInnerHTML or innerHTML', () => {
    const js = readdirSync(join(DIST, 'assets')).filter((f) => f.endsWith('.js'));
    expect(js.length).toBeGreaterThan(0);
    for (const f of js) {
      const text = readFileSync(join(DIST, 'assets', f), 'utf8');
      expect(text, f).not.toMatch(/\beval\s*\(/);
      expect(text, f).not.toMatch(/new\s+Function\s*\(/);
    }
    const walk = (d: string): string[] => readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(join(d, e.name)) : [join(d, e.name)]));
    for (const f of walk(join(UI_ROOT, 'src')).filter((x) => /\.tsx?$/.test(x))) {
      const text = readFileSync(f, 'utf8');
      expect(text, f).not.toMatch(/dangerouslySetInnerHTML|\.innerHTML\s*=|insertAdjacentHTML|document\.write/);
    }
  });

  it('the theme bootstrap and every public script are plain same-origin files', () => {
    expect(existsSync(join(DIST, 'theme-init.js'))).toBe(true);
    expect(readFileSync(join(DIST, 'theme-init.js'), 'utf8')).not.toMatch(/\beval\b|innerHTML/);
  });
});

describe('React Aria runtime <style> injections are handled without unsafe-inline', () => {
  it('the pressable rule ships as a linked stylesheet under the id React Aria checks, so it never injects its own <style>', () => {
    const source = reactAria('interactions/usePress.mjs');
    const id = /STYLE_ID = '([^']+)'/.exec(source)?.[1];
    const attr = /PRESSABLE_ATTRIBUTE = '([^']+)'/.exec(source)?.[1];
    const touch = /touch-action:\s*([^;]+);/.exec(source)?.[1];
    expect(id).toBeDefined();
    expect(html()).toMatch(new RegExp(`<link[^>]*rel="stylesheet"[^>]*id="${id}"[^>]*href="/react-aria-pressable\\.css"|<link[^>]*id="${id}"[^>]*href="/react-aria-pressable\\.css"`));
    const css = readFileSync(join(DIST, 'react-aria-pressable.css'), 'utf8');
    expect(css).toContain(`[${attr}]`);
    expect(css).toContain(`touch-action: ${touch}`);
    expect(source).toMatch(/getElementById\(\$?\w*\$?STYLE_ID\)\)\s*return|getElementById\([^)]*STYLE_ID\)\)\s*return/);
  });

  it('the one inline <style> React Aria still inserts (iOS scroll lock) is allowed by an exact hash in the served CSP, and the hash matches the installed library', () => {
    const source = reactAria('overlays/usePreventScroll.mjs');
    const text = /style\.textContent = `\n?([\s\S]*?)`\.trim\(\)/.exec(source)?.[1];
    expect(text).toBeDefined();
    const hash = `'sha256-${createHash('sha256').update((text as string).trim()).digest('base64')}'`;
    expect(rootStatic()).toContain(hash);
  });

  it('the served policy has no unsafe-inline, unsafe-eval, wildcard or remote source', () => {
    const csp = /export const UI_CSP = \[([\s\S]*?)\]\.join/.exec(rootStatic())?.[1] ?? '';
    expect(csp).toContain("script-src 'self'");
    expect(csp).not.toMatch(/unsafe-inline|unsafe-eval|\*|https?:|data:/);
  });
});
