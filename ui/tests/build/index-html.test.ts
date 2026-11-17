// Build tier for index.html: the theme list and color-scheme meta are injected from the manifest at build time, the build
// fails (rather than silently shipping a page with no theme bootstrap data) when the anchors change, and the page says
// something useful without JavaScript.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { injectThemeHtml } from '../../build/plugins';
import type { ThemeManifestEntry } from '../../src/theme/contract';
import { DEFAULT_THEME_ID, THEMES } from '../../src/theme/manifest';
import { UI_ROOT } from '../helpers/themes';

const source = readFileSync(join(UI_ROOT, 'index.html'), 'utf8');
const built = (): string => readFileSync(join(UI_ROOT, 'dist', 'index.html'), 'utf8');

describe('injectThemeHtml', () => {
  it('writes data-themes, data-default-theme and a color-scheme meta derived from the manifest', () => {
    const out = injectThemeHtml(source, THEMES, DEFAULT_THEME_ID);
    expect(out).toContain(`<html lang="en" data-themes="[{&quot;id&quot;:&quot;black-cat&quot;`);
    expect(out).toContain(`data-default-theme="${DEFAULT_THEME_ID}"`);
    expect(out).toContain('<meta name="color-scheme" content="dark" />');
  });

  it('lists every scheme the manifest offers, so a light theme does not flash dark browser chrome', () => {
    const mixed: ThemeManifestEntry[] = [...THEMES, { id: 'paper', label: 'Paper', colorScheme: 'light' }];
    expect(injectThemeHtml(source, mixed, DEFAULT_THEME_ID)).toContain('<meta name="color-scheme" content="dark light" />');
  });

  it('fails the build when the <html> tag changes (an added attribute would otherwise silently drop the theme list)', () => {
    const changed = source.replace('<html lang="en">', '<html lang="en" class="x">');
    expect(changed).not.toBe(source);
    expect(() => injectThemeHtml(changed, THEMES, DEFAULT_THEME_ID)).toThrow(/no longer contains <html lang="en">/);
  });

  it('fails the build when the color-scheme meta anchor is gone', () => {
    const changed = source.replace(/<meta name="color-scheme"[^>]*>/, '');
    expect(() => injectThemeHtml(changed, THEMES, DEFAULT_THEME_ID)).toThrow(/color-scheme/);
  });
});

describe('the built index.html', () => {
  it('carries the injected theme data and meta', () => {
    const h = built();
    expect(h).toMatch(/<html lang="en" data-themes="[^"]+" data-default-theme="black-cat">/);
    expect(h).toContain('<meta name="color-scheme" content="dark" />');
  });

  it('has a <noscript> explanation beside #root (plain text only: nothing inline, so the CSP is untouched)', () => {
    const m = /<noscript>([\s\S]*?)<\/noscript>/.exec(built());
    expect(m, 'no <noscript> block').not.toBeNull();
    const body = (m as RegExpExecArray)[1] as string;
    expect(body).toMatch(/needs JavaScript/);
    expect(body).not.toMatch(/<(script|style|link|img|iframe)\b|\sstyle=|\son\w+=/i);
    expect(built().indexOf('id="root"')).toBeLessThan(built().indexOf('<noscript>'));
  });
});
