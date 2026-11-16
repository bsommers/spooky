// The UI shows the weak-scorer caveat at all times; its copy must be the registry's, word for word (Phase 8 / Phase 11).
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { HEURISTIC_HELD_OUT_AUC } from '../../config/humanize.js';
import { HUMANIZE_CAVEAT } from '../../src/service/operations.js';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

describe('UI caveat', () => {
  it('ui/src/screens/score/caveat.ts equals HUMANIZE_CAVEAT', () => {
    const src = readFileSync(join(root, 'ui', 'src', 'screens', 'score', 'caveat.ts'), 'utf8');
    const m = /HUMANIZE_CAVEAT =\s*\n?\s*'((?:[^'\\]|\\.)*)'/.exec(src);
    expect(m, 'caveat literal not found').not.toBeNull();
    expect(m![1]!.replace(/\\'/g, "'")).toBe(HUMANIZE_CAVEAT);
    expect(HUMANIZE_CAVEAT).toContain(String(HEURISTIC_HELD_OUT_AUC));
  });

  it('the shared Caveat component renders that constant (not a paraphrase), and the Score and Generate screens both use it', () => {
    const comp = readFileSync(join(root, 'ui', 'src', 'components', 'Caveat.tsx'), 'utf8');
    expect(comp).toMatch(/import \{ HUMANIZE_CAVEAT \} from '\.\.\/screens\/score\/caveat'/);
    expect(comp).toMatch(/\{HUMANIZE_CAVEAT\}/);
    for (const f of [['score', 'ScoreScreen.tsx'], ['generate', 'GenerateScreen.tsx']] as const) {
      const screen = readFileSync(join(root, 'ui', 'src', 'screens', f[0], f[1]), 'utf8');
      expect(screen, f[1]).toMatch(/import \{ Caveat \} from '\.\.\/\.\.\/components\/Caveat'/);
      expect(screen, f[1]).toMatch(/<Caveat \/>/);
    }
  });

  it('the Score screen shows the server-sent caveat with each humanize result', () => {
    const screen = readFileSync(join(root, 'ui', 'src', 'screens', 'score', 'ScoreScreen.tsx'), 'utf8');
    expect(screen).toMatch(/\{result\.caveat\}/);
  });
});
