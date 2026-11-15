import { describe, expect, it } from 'vitest';
import { checkThemes } from '../../build/theme-check';
import { CONTRAST_PAIRS, contrastRatio, failingPairs, luminance } from '../../src/theme/contrast';
import { THEMES } from '../../src/theme/manifest';
import { scratchThemes, themeCss } from '../helpers/tmpTheme';
import { loadThemes } from '../helpers/themes';

describe('contrast arithmetic', () => {
  it('matches the WCAG reference values', () => {
    expect(contrastRatio('#000000', '#ffffff')).toBeCloseTo(21, 5);
    expect(contrastRatio('#ffffff', '#ffffff')).toBeCloseTo(1, 5);
    expect(contrastRatio('#777777', '#ffffff')).toBeCloseTo(4.48, 2); // the classic "just fails AA" grey
    expect(luminance('#ff0000')).toBeCloseTo(0.2126, 4);
  });
  it('rejects a color it cannot read instead of guessing', () => {
    expect(() => luminance('red')).toThrow();
    expect(() => luminance('#fff')).toThrow();
  });
});

describe('theme palettes meet WCAG AA', () => {
  for (const theme of loadThemes()) {
    describe(theme.id, () => {
      for (const pair of CONTRAST_PAIRS) {
        it(`${pair.fg} on ${pair.bg} >= ${pair.min}:1 (${pair.use})`, () => {
          expect(contrastRatio(theme.tokens[pair.fg] as string, theme.tokens[pair.bg] as string)).toBeGreaterThanOrEqual(pair.min);
        });
      }
    });
  }

  it('covers the declared pairs: text, muted, accent-text on accent, accent, status colors and the focus ring', () => {
    const fgs = new Set(CONTRAST_PAIRS.map((p) => p.fg));
    for (const t of ['--gw-text', '--gw-text-muted', '--gw-accent-text', '--gw-accent', '--gw-danger', '--gw-warning', '--gw-success', '--gw-focus-ring']) expect(fgs.has(t), t).toBe(true);
    expect(CONTRAST_PAIRS.filter((p) => p.fg === '--gw-focus-ring').every((p) => p.min === 3)).toBe(true);
    expect(CONTRAST_PAIRS.filter((p) => p.fg === '--gw-text').every((p) => p.min === 4.5)).toBe(true);
  });

  it('a failing pair is reported, and fails the build check', () => {
    const base = loadThemes().find((t) => t.id === 'tron-neon')!;
    const bad = { ...base.tokens, '--gw-text-muted': '#3a3a3a' };
    expect(failingPairs(bad).map((f) => f.pair.fg)).toContain('--gw-text-muted');
    const s = scratchThemes();
    s.write('tron-neon.css', themeCss('tron-neon', bad));
    expect(() => checkThemes({ ...s, manifest: THEMES })).toThrow(/--gw-text-muted on --gw-bg.*needs 4.5:1/);
  });

  it('a low-contrast focus ring fails at the 3:1 bar', () => {
    const base = loadThemes().find((t) => t.id === 'black-cat')!;
    const bad = { ...base.tokens, '--gw-focus-ring': '#26262c' };
    expect(failingPairs(bad).some((f) => f.pair.fg === '--gw-focus-ring' && f.pair.min === 3)).toBe(true);
  });
});
