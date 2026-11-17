// The theme contract. A theme is ONE css file `themes/<id>.css` holding exactly one rule,
//   :root[data-theme="<id>"] { --gw-...: value; ... }
// that defines every token below (no more, no fewer), plus one manifest entry in `manifest.ts`. Components read only
// `--gw-*` tokens, never raw colors (stylelint enforces it), so a third theme is a new token file and a manifest line.
import { z } from 'zod';

/** Tokens whose value must be an opaque `#rrggbb` color: the contrast test needs to read them. */
export const COLOR_TOKENS = [
  '--gw-bg',
  '--gw-bg-raised',
  '--gw-surface',
  '--gw-border',
  '--gw-text',
  '--gw-text-muted',
  '--gw-accent',
  '--gw-accent-text',
  '--gw-accent-2',
  '--gw-danger',
  '--gw-warning',
  '--gw-success',
  '--gw-focus-ring',
] as const;

/** Tokens with free-form CSS values (lengths, shadows, font stacks, gradients, animation shorthands). */
export const FREE_TOKENS = [
  '--gw-glow', // box-shadow value
  '--gw-radius',
  '--gw-font-display',
  '--gw-font-body',
  '--gw-font-mono',
  '--gw-motion-scale', // 0..1; 0 = no motion
  '--gw-bg-art', // background layer: gradients (moon and haze, neon glow)
  '--gw-bg-grid', // perspective floor grid image, or `none`
  '--gw-bg-grid-cell', // one grid cell, a length (the animation scrolls by exactly one)
  '--gw-bg-grid-transform', // transform for the grid plane, or `none`
  '--gw-bg-mark', // watermark image, or `none`
  '--gw-anim-grid', // animation shorthand for the grid, or `none`
  '--gw-anim-glow', // animation shorthand for the art layer, or `none`
] as const;

export const REQUIRED_TOKENS = [...COLOR_TOKENS, ...FREE_TOKENS] as const;
export type TokenName = (typeof REQUIRED_TOKENS)[number];

const HEX = /^#[0-9a-fA-F]{6}$/;

/** A free-form value must stay inside one declaration: no statement or block breaks, no remote fetch, no escapes. */
const SAFE_VALUE = /^[^;{}\\@]+$/;

const colorValue = z.string().regex(HEX, 'must be an opaque #rrggbb color');
const freeValue = z
  .string()
  .min(1)
  .max(2000)
  .regex(SAFE_VALUE, 'must be one plain CSS value')
  .refine((v) => !/(?:https?:|\/\/)/i.test(v), 'no remote url (only same-origin /paths)');

export const themeTokensSchema = z
  .object({
    ...Object.fromEntries(COLOR_TOKENS.map((t) => [t, colorValue])),
    ...Object.fromEntries(FREE_TOKENS.map((t) => [t, freeValue])),
  } as Record<TokenName, z.ZodString>)
  .strict();

export const THEME_ID = /^[a-z][a-z0-9-]{0,31}$/;

export const manifestEntrySchema = z
  .object({
    id: z.string().regex(THEME_ID),
    label: z.string().min(1).max(40),
    colorScheme: z.enum(['dark', 'light']),
  })
  .strict();
export type ThemeManifestEntry = z.infer<typeof manifestEntrySchema>;

export const manifestSchema = z
  .array(manifestEntrySchema)
  .min(1)
  .superRefine((entries, ctx) => {
    const seen = new Set<string>();
    for (const [i, e] of entries.entries()) {
      if (seen.has(e.id)) ctx.addIssue({ code: 'custom', message: `duplicate theme id "${e.id}"`, path: [i, 'id'] });
      seen.add(e.id);
    }
  });

export interface ParsedTheme {
  id: string;
  tokens: Record<string, string>;
}

export class ThemeContractError extends Error {
  constructor(
    readonly problems: readonly string[],
    where: string,
  ) {
    super(`theme ${where}: ${problems.join('; ')}`);
    this.name = 'ThemeContractError';
  }
}

const RULE = /^:root\[data-theme="([a-z][a-z0-9-]*)"\]\s*\{([^{}]*)\}$/;

/**
 * Parses a theme file into `{ id, tokens }` and checks it against the contract. The file must contain exactly one rule
 * (`:root[data-theme="<id>"] { ... }`) whose `<id>` is `expectedId`; every required token once; no other declaration.
 */
export function parseThemeCss(css: string, expectedId: string): ParsedTheme {
  const problems: string[] = [];
  const stripped = css.replace(/\/\*[\s\S]*?\*\//g, '').trim();
  const m = RULE.exec(stripped);
  if (m === null) throw new ThemeContractError(['must contain exactly one rule of the form :root[data-theme="<id>"] { --gw-*: value; }'], expectedId);
  const id = m[1] as string;
  if (id !== expectedId) problems.push(`selector names theme "${id}" but the file is ${expectedId}.css`);
  const tokens: Record<string, string> = {};
  for (const decl of (m[2] as string).split(/;(?![^(]*\))/)) {
    const d = decl.trim();
    if (d === '') continue;
    const colon = d.indexOf(':');
    const name = colon < 0 ? d : d.slice(0, colon).trim();
    const value = colon < 0 ? '' : d.slice(colon + 1).trim();
    if (!name.startsWith('--gw-')) {
      problems.push(`"${name}" is not a --gw-* token (a theme defines tokens only)`);
      continue;
    }
    if (name in tokens) problems.push(`${name} is defined twice`);
    tokens[name] = value;
  }
  const result = themeTokensSchema.safeParse(tokens);
  if (!result.success) {
    for (const issue of result.error.issues) {
      if (issue.code === 'unrecognized_keys') problems.push(`unknown token ${issue.keys.join(', ')}`);
      else problems.push(`${issue.path.join('.') || 'tokens'}: ${issue.message}`);
    }
  }
  if (problems.length > 0) throw new ThemeContractError(problems, expectedId);
  return { id, tokens };
}
