// WCAG 2.x contrast, used by the build check and the tests so a palette that fails AA fails the build.

const channel = (v: number): number => {
  const c = v / 255;
  return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
};

export function luminance(hex: string): number {
  const m = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex);
  if (m === null) throw new Error(`not an opaque #rrggbb color: ${hex}`);
  const [r, g, b] = [m[1], m[2], m[3]].map((h) => channel(parseInt(h as string, 16))) as [number, number, number];
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

export function contrastRatio(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
}

export interface ContrastPair {
  fg: string;
  bg: string;
  /** 4.5 for text, 3 for large text, UI components and focus indicators, 1.1 for decorative separators (see CONTRAST_PAIRS). */
  min: 1.1 | 3 | 4.5;
  use: string;
}

const onAllSurfaces = (fg: string, min: ContrastPair['min'], use: string): ContrastPair[] =>
  ['--gw-bg', '--gw-surface', '--gw-bg-raised'].map((bg) => ({ fg, bg, min, use }));

/** The declared pairs every theme must satisfy (WCAG 2.2 AA). */
export const CONTRAST_PAIRS: readonly ContrastPair[] = [
  ...onAllSurfaces('--gw-text', 4.5, 'body text'),
  ...onAllSurfaces('--gw-text-muted', 4.5, 'secondary text'),
  ...onAllSurfaces('--gw-accent', 4.5, 'accent text and links'),
  ...onAllSurfaces('--gw-accent-2', 4.5, 'secondary accent text'),
  { fg: '--gw-accent-text', bg: '--gw-accent', min: 4.5, use: 'text on an accent fill' },
  ...onAllSurfaces('--gw-danger', 4.5, 'danger text'),
  ...onAllSurfaces('--gw-warning', 4.5, 'warning text'),
  ...onAllSurfaces('--gw-success', 4.5, 'success text'),
  ...onAllSurfaces('--gw-focus-ring', 3, 'focus indicator'),
  ...onAllSurfaces('--gw-accent', 3, 'UI component boundary'),
  // --gw-border is a decorative separator (card, popover, header and footer rules) and the edge of text-labelled buttons. WCAG 1.4.11
  // asks 3:1 only for a boundary that is the SOLE cue to a control, and every control here is identified by its text or label, so the
  // border is exempt from 3:1. This floor only guards the token from becoming invisible (border equal to a surface = 1:1). A control that
  // relies on its border alone must use --gw-accent (the 3:1 pair above), not --gw-border.
  ...onAllSurfaces('--gw-border', 1.1, 'decorative separator (exempt from 1.4.11; controls carry text)'),
];

export interface ContrastFailure {
  pair: ContrastPair;
  ratio: number;
}

export function failingPairs(tokens: Readonly<Record<string, string>>, pairs: readonly ContrastPair[] = CONTRAST_PAIRS): ContrastFailure[] {
  const out: ContrastFailure[] = [];
  for (const pair of pairs) {
    const ratio = contrastRatio(tokens[pair.fg] as string, tokens[pair.bg] as string);
    if (ratio < pair.min) out.push({ pair, ratio });
  }
  return out;
}
