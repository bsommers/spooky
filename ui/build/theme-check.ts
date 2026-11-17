// Build-time theme validation (Node only): every theme file obeys the contract, the manifest and the files agree, every
// same-origin asset a token points at exists, and every declared contrast pair meets WCAG AA. A failure fails the build.
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseThemeCss, manifestSchema, ThemeContractError } from '../src/theme/contract.ts';
import type { ParsedTheme, ThemeManifestEntry } from '../src/theme/contract.ts';
import { failingPairs } from '../src/theme/contrast.ts';

export interface ThemeCheckInput {
  themesDir: string;
  publicDir: string;
  manifest: readonly ThemeManifestEntry[];
}

export function checkThemes({ themesDir, publicDir, manifest }: ThemeCheckInput): ParsedTheme[] {
  const problems: string[] = [];
  const parsedManifest = manifestSchema.safeParse(manifest);
  if (!parsedManifest.success) problems.push(`manifest: ${parsedManifest.error.issues.map((i) => i.message).join('; ')}`);

  const files = readdirSync(themesDir).filter((f) => f.endsWith('.css'));
  const ids = files.map((f) => f.replace(/\.css$/, ''));
  for (const e of manifest) if (!ids.includes(e.id)) problems.push(`manifest lists "${e.id}" but themes/${e.id}.css does not exist`);
  for (const id of ids) if (!manifest.some((e) => e.id === id)) problems.push(`themes/${id}.css has no manifest entry`);

  const themes: ParsedTheme[] = [];
  for (const f of files) {
    const id = f.replace(/\.css$/, '');
    try {
      const theme = parseThemeCss(readFileSync(join(themesDir, f), 'utf8'), id);
      themes.push(theme);
      for (const [name, value] of Object.entries(theme.tokens)) {
        for (const m of value.matchAll(/url\(\s*["']?([^"')]+)["']?\s*\)/g)) {
          const ref = m[1] as string;
          if (!ref.startsWith('/') || ref.startsWith('//')) problems.push(`${id} ${name}: url(${ref}) must be a same-origin /path in public/`);
          else if (!existsSync(join(publicDir, ref.replace(/^\//, '')))) problems.push(`${id} ${name}: public${ref} does not exist`);
        }
      }
      for (const { pair, ratio } of failingPairs(theme.tokens)) {
        problems.push(`${id}: ${pair.fg} on ${pair.bg} (${pair.use}) is ${ratio.toFixed(2)}:1, needs ${pair.min}:1`);
      }
    } catch (e) {
      if (e instanceof ThemeContractError) problems.push(...e.problems.map((p) => `${id}: ${p}`));
      else throw e;
    }
  }
  if (problems.length > 0) throw new ThemeContractError(problems, 'check');
  return themes;
}
