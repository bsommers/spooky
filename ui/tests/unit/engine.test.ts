import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { STORAGE_KEY, applyMotion, applyTheme, persistTheme, prefersReducedMotion, readStoredTheme, resolveInitialTheme, themeForScheme } from '../../src/theme/engine';
import type { ThemeManifestEntry } from '../../src/theme/contract';
import { THEMES } from '../../src/theme/manifest';
import { DARK, LIGHT, REDUCE, memoryStorage, mediaWith, throwingStorage } from '../helpers/media';
import { UI_ROOT } from '../helpers/themes';

const WITH_LIGHT: ThemeManifestEntry[] = [...THEMES, { id: 'daylight', label: 'Daylight', colorScheme: 'light' }];

describe('theme switch', () => {
  it('sets data-theme on <html> and the matching color-scheme', () => {
    applyTheme(document.documentElement, 'tron-neon');
    expect(document.documentElement.getAttribute('data-theme')).toBe('tron-neon');
    expect(document.documentElement.style.colorScheme).toBe('dark');
    applyTheme(document.documentElement, 'black-cat');
    expect(document.documentElement.getAttribute('data-theme')).toBe('black-cat');
  });

  it('persists the choice to localStorage under one key', () => {
    const s = memoryStorage();
    expect(persistTheme(s, 'tron-neon')).toBe(true);
    expect(s.data.get(STORAGE_KEY)).toBe('tron-neon');
    expect(readStoredTheme(s)).toBe('tron-neon');
  });

  it('storage that throws (private mode, blocked) still works: read gives nothing, write reports false and does not throw', () => {
    expect(() => readStoredTheme(throwingStorage)).not.toThrow();
    expect(readStoredTheme(throwingStorage)).toBeUndefined();
    expect(persistTheme(throwingStorage, 'black-cat')).toBe(false);
    expect(persistTheme(undefined, 'black-cat')).toBe(false);
    expect(resolveInitialTheme({ storage: throwingStorage, matchMedia: mediaWith([DARK]) })).toBe('black-cat');
  });

  it('an invalid stored id falls back to the system preference, never to the invalid value', () => {
    for (const bad of ['', 'nope', 'BLACK-CAT', '"><script>', 'tron-neon ', '__proto__', 'x'.repeat(5000)]) {
      const s = memoryStorage({ [STORAGE_KEY]: bad });
      expect(readStoredTheme(s), JSON.stringify(bad).slice(0, 20)).toBeUndefined();
      expect(resolveInitialTheme({ storage: s, matchMedia: mediaWith([DARK]) }), bad.slice(0, 20)).toBe('black-cat');
    }
    expect(resolveInitialTheme({ storage: memoryStorage({ [STORAGE_KEY]: 'tron-neon' }), matchMedia: mediaWith([DARK]) })).toBe('tron-neon'); // a valid one wins over the preference
  });
});

describe('defaults', () => {
  it('no stored value: the system color scheme picks the first theme with that scheme', () => {
    expect(resolveInitialTheme({ storage: memoryStorage(), matchMedia: mediaWith([DARK]) })).toBe('black-cat');
    expect(themeForScheme('dark', THEMES)).toBe('black-cat');
    expect(themeForScheme('light', WITH_LIGHT)).toBe('daylight');
    expect(resolveInitialTheme({ storage: memoryStorage(), matchMedia: mediaWith([LIGHT]) }, WITH_LIGHT)).toBe('daylight');
  });

  it('a light preference with no light theme, no preference, or no matchMedia at all gives the default theme', () => {
    expect(resolveInitialTheme({ storage: memoryStorage(), matchMedia: mediaWith([LIGHT]) })).toBe('black-cat');
    expect(resolveInitialTheme({ storage: memoryStorage(), matchMedia: mediaWith([]) })).toBe('black-cat');
    expect(resolveInitialTheme({})).toBe('black-cat');
    const broken = (() => {
      throw new Error('boom');
    }) as never;
    expect(resolveInitialTheme({ matchMedia: broken })).toBe('black-cat');
  });

  it('prefers-reduced-motion: scale 0, a marker for the stylesheet, and it comes back off', () => {
    const root = document.documentElement;
    expect(prefersReducedMotion(mediaWith([REDUCE]))).toBe(true);
    expect(prefersReducedMotion(mediaWith([]))).toBe(false);
    expect(prefersReducedMotion(undefined)).toBe(false);
    applyMotion(root, true);
    expect(root.style.getPropertyValue('--gw-motion-scale')).toBe('0');
    expect(root.getAttribute('data-motion')).toBe('reduced');
    applyMotion(root, false);
    expect(root.style.getPropertyValue('--gw-motion-scale')).toBe('');
    expect(root.hasAttribute('data-motion')).toBe(false);
  });

  it('the stylesheet turns the reduced-motion marker and the media query into "animation: none" for the grid, the haze and the logo', () => {
    const css = [readFileSync(join(UI_ROOT, 'src/styles/base.css'), 'utf8'), readFileSync(join(UI_ROOT, 'src/styles/backdrop.css'), 'utf8')].join('\n');
    expect(css).toMatch(/:root\[data-motion="reduced"\] \*[\s\S]*?animation: none !important/);
    expect(css).toMatch(/@media \(prefers-reduced-motion: reduce\)[\s\S]*?animation: none !important/);
    // the only places an animation is declared read it from a token (theme decides) or are covered by the universal rules above
    const decls = [...css.matchAll(/^\s*animation:\s*([^;]+);/gm)].map((m) => (m[1] as string).trim());
    expect(decls.filter((d) => d !== 'none !important' && !d.startsWith('var(--gw-anim-'))).toEqual([]);
  });
});

describe('theme-init.js (the no-flash bootstrap) agrees with the engine', () => {
  const source = readFileSync(join(UI_ROOT, 'public/theme-init.js'), 'utf8');

  function runInit(opts: { storage?: Record<string, string>; throwing?: boolean; queries?: string[]; themes?: ThemeManifestEntry[] }): HTMLElement {
    const root = document.createElement('html');
    const themes = opts.themes ?? THEMES;
    root.setAttribute('data-themes', JSON.stringify(themes.map((t) => ({ id: t.id, colorScheme: t.colorScheme }))));
    root.setAttribute('data-default-theme', themes[0]!.id);
    const storage = opts.throwing ? throwingStorage : memoryStorage(opts.storage);
    const fakeWindow = { localStorage: storage, matchMedia: mediaWith(opts.queries) };
    new Function('document', 'window', source)({ documentElement: root }, fakeWindow);
    return root;
  }

  const cases: Array<{ name: string; storage?: Record<string, string>; throwing?: boolean; queries?: string[]; themes?: ThemeManifestEntry[] }> = [
    { name: 'stored valid', storage: { [STORAGE_KEY]: 'tron-neon' } },
    { name: 'stored invalid', storage: { [STORAGE_KEY]: 'nope' }, queries: [DARK] },
    { name: 'nothing stored, dark', queries: [DARK] },
    { name: 'nothing stored, light, no light theme', queries: [LIGHT] },
    { name: 'nothing stored, light, with a light theme', queries: [LIGHT], themes: WITH_LIGHT },
    { name: 'storage throws', throwing: true, queries: [DARK] },
    { name: 'no preference at all' },
  ];
  for (const c of cases) {
    it(`${c.name}: same theme as resolveInitialTheme`, () => {
      const root = runInit(c);
      const expected = resolveInitialTheme({ storage: c.throwing ? throwingStorage : memoryStorage(c.storage), matchMedia: mediaWith(c.queries) }, c.themes ?? THEMES);
      expect(root.getAttribute('data-theme')).toBe(expected);
    });
  }

  it('reduced motion is applied before first paint too', () => {
    const root = runInit({ queries: [DARK, REDUCE] });
    expect(root.getAttribute('data-motion')).toBe('reduced');
    expect(root.style.getPropertyValue('--gw-motion-scale')).toBe('0');
    expect(runInit({ queries: [DARK] }).hasAttribute('data-motion')).toBe(false);
  });

  it('a missing or corrupt theme list leaves the page alone instead of throwing', () => {
    const root = document.createElement('html');
    root.setAttribute('data-themes', '{not json');
    expect(() => new Function('document', 'window', source)({ documentElement: root }, { matchMedia: mediaWith(), localStorage: memoryStorage() })).not.toThrow();
    expect(root.hasAttribute('data-theme')).toBe(false);
  });

  it('is a tiny classic script with no network access and no eval', () => {
    expect(source.length).toBeLessThan(2500);
    expect(source).not.toMatch(/\b(fetch|XMLHttpRequest|eval|import\(|document\.write|innerHTML)\b/);
    expect(source).not.toMatch(/https?:\/\//);
  });
});
