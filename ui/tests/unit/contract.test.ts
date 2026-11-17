import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { checkThemes } from '../../build/theme-check';
import { REQUIRED_TOKENS, ThemeContractError, manifestSchema, parseThemeCss } from '../../src/theme/contract';
import { THEMES } from '../../src/theme/manifest';
import { scratchThemes, themeCss } from '../helpers/tmpTheme';
import { THEMES_DIR, loadThemes, themeFiles } from '../helpers/themes';

const blackCat = (): Record<string, string> => ({ ...loadThemes().find((t) => t.id === 'black-cat')!.tokens });

describe('theme contract', () => {
  it('every theme file defines every required token, and nothing else', () => {
    const themes = loadThemes();
    expect(themes.map((t) => t.id).sort()).toEqual(['black-cat', 'tron-neon']);
    for (const t of themes) expect(Object.keys(t.tokens).sort(), t.id).toEqual([...REQUIRED_TOKENS].sort());
  });

  it('the token list is the plan list plus the background-art tokens', () => {
    for (const t of ['--gw-bg', '--gw-bg-raised', '--gw-surface', '--gw-border', '--gw-text', '--gw-text-muted', '--gw-accent', '--gw-accent-text', '--gw-accent-2', '--gw-danger', '--gw-warning', '--gw-success', '--gw-focus-ring', '--gw-glow', '--gw-radius', '--gw-font-display', '--gw-font-body', '--gw-font-mono', '--gw-motion-scale', '--gw-bg-art']) {
      expect(REQUIRED_TOKENS).toContain(t);
    }
  });

  it('a missing token fails', () => {
    const tokens = blackCat();
    delete tokens['--gw-focus-ring'];
    expect(() => parseThemeCss(themeCss('black-cat', tokens), 'black-cat')).toThrow(/--gw-focus-ring/);
  });

  it('an unknown extra token fails', () => {
    const tokens = { ...blackCat(), '--gw-sparkle': '#ffffff' };
    expect(() => parseThemeCss(themeCss('black-cat', tokens), 'black-cat')).toThrow(/unknown token --gw-sparkle/);
  });

  it('a non-token declaration, a duplicate, a second rule and a wrong selector id fail', () => {
    const ok = themeCss('black-cat', blackCat());
    expect(() => parseThemeCss(ok.replace('}', '  color: red;\n}'), 'black-cat')).toThrow(/not a --gw-\* token/);
    expect(() => parseThemeCss(ok.replace('}', '  --gw-bg: #000000;\n}'), 'black-cat')).toThrow(/defined twice/);
    expect(() => parseThemeCss(`${ok}\nbody { margin: 0 }`, 'black-cat')).toThrow(ThemeContractError);
    expect(() => parseThemeCss(ok, 'tron-neon')).toThrow(/names theme "black-cat"/);
    expect(() => parseThemeCss('', 'black-cat')).toThrow(/exactly one rule/);
  });

  it('color tokens must be opaque hex; free values may not smuggle a second declaration, an import or a remote url', () => {
    const bad = (patch: Record<string, string>): string => themeCss('black-cat', { ...blackCat(), ...patch });
    expect(() => parseThemeCss(bad({ '--gw-text': 'red' }), 'black-cat')).toThrow(/--gw-text/);
    expect(() => parseThemeCss(bad({ '--gw-text': '#fff' }), 'black-cat')).toThrow(/--gw-text/);
    expect(() => parseThemeCss(bad({ '--gw-text': '#ffffff80' }), 'black-cat')).toThrow(/--gw-text/);
    expect(() => parseThemeCss(bad({ '--gw-bg-mark': 'url("https://evil.example/x.svg")' }), 'black-cat')).toThrow(/remote/);
    expect(() => parseThemeCss(bad({ '--gw-bg-mark': 'url(//evil.example/x.svg)' }), 'black-cat')).toThrow(/remote/);
    expect(() => parseThemeCss(bad({ '--gw-radius': '1px } body { display: none' }), 'black-cat')).toThrow(ThemeContractError);
    expect(() => parseThemeCss(bad({ '--gw-radius': '@import x' }), 'black-cat')).toThrow(/plain CSS value/);
  });

  it('manifest ids are unique and well formed; a duplicate or bad entry fails', () => {
    expect(manifestSchema.safeParse(THEMES).success).toBe(true);
    expect(new Set(THEMES.map((t) => t.id)).size).toBe(THEMES.length);
    expect(manifestSchema.safeParse([...THEMES, { ...THEMES[0] }]).success).toBe(false);
    expect(manifestSchema.safeParse([{ id: 'Bad Id', label: 'x', colorScheme: 'dark' }]).success).toBe(false);
    expect(manifestSchema.safeParse([{ id: 'ok', label: 'x', colorScheme: 'sepia' }]).success).toBe(false);
    expect(manifestSchema.safeParse([{ id: 'ok', label: 'x', colorScheme: 'dark', extra: 1 }]).success).toBe(false);
    expect(manifestSchema.safeParse([]).success).toBe(false);
  });

  it('the manifest and the theme files agree: a file without a line, or a line without a file, fails the check', () => {
    expect(themeFiles().map((f) => f.replace('.css', '')).sort()).toEqual(THEMES.map((t) => t.id).sort());
    const s = scratchThemes();
    expect(() => checkThemes({ ...s, manifest: THEMES })).not.toThrow();
    expect(() => checkThemes({ ...s, manifest: THEMES.slice(0, 1) })).toThrow(/has no manifest entry/);
    expect(() => checkThemes({ ...s, manifest: [...THEMES, { id: 'ghost', label: 'Ghost', colorScheme: 'dark' }] })).toThrow(/ghost.css does not exist/);
  });

  it('adding a third theme is one token file plus one manifest line, nothing else', () => {
    const s = scratchThemes();
    const tokens = { ...blackCat(), '--gw-bg': '#101010' };
    s.write('midnight.css', themeCss('midnight', tokens));
    const themes = checkThemes({ ...s, manifest: [...THEMES, { id: 'midnight', label: 'Midnight', colorScheme: 'dark' }] });
    expect(themes.map((t) => t.id).sort()).toEqual(['black-cat', 'midnight', 'tron-neon']);
  });

  it('an asset a token points at must exist in public/ and be same-origin', () => {
    const s = scratchThemes();
    s.write('black-cat.css', themeCss('black-cat', { ...blackCat(), '--gw-bg-mark': 'url("/art/missing.svg")' }));
    expect(() => checkThemes({ ...s, manifest: THEMES })).toThrow(/public\/art\/missing.svg does not exist/);
    s.write('black-cat.css', themeCss('black-cat', { ...blackCat(), '--gw-bg-mark': 'url("art/relative.svg")' }));
    expect(() => checkThemes({ ...s, manifest: THEMES })).toThrow(/same-origin/);
  });

  it('theme files are plain files in themes/ and nothing but the rule (no comment can hide a second rule)', () => {
    for (const f of themeFiles()) {
      const stripped = readFileSync(join(THEMES_DIR, f), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
      expect((stripped.match(/\{/g) ?? []).length, f).toBe(1);
    }
  });
});
