// Performance budget of the first load: the shell only. Feature screens are separate chunks fetched on first visit.
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { UI_ROOT } from '../helpers/themes';

const DIST = join(UI_ROOT, 'dist');
const html = readFileSync(join(DIST, 'index.html'), 'utf8').replace(/<!--[\s\S]*?-->/g, '');
export const BUDGET_JS_GZIP = 250 * 1024;
export const BUDGET_CSS_GZIP = 40 * 1024;
const gz = (rel: string): number => gzipSync(readFileSync(join(DIST, rel.replace(/^\//, '')))).length;

describe('initial load budget', () => {
  const scripts = [...html.matchAll(/<script\b[^>]*\bsrc="([^"]+)"/g)].map((m) => m[1]!);
  const preloads = [...html.matchAll(/<link\b[^>]*rel="modulepreload"[^>]*href="([^"]+)"/g)].map((m) => m[1]!);
  const styles = [...html.matchAll(/<link\b[^>]*rel="stylesheet"[^>]*href="([^"]+)"/g)].map((m) => m[1]!).filter((h) => h.startsWith('/assets/'));

  it(`the JavaScript needed for first paint is at most ${BUDGET_JS_GZIP / 1024} KB gzipped`, () => {
    const total = [...scripts, ...preloads].reduce((n, s) => n + gz(s), 0);
    expect(scripts.length).toBeGreaterThan(0);
    expect(total).toBeLessThanOrEqual(BUDGET_JS_GZIP);
  });

  it(`the stylesheet is at most ${BUDGET_CSS_GZIP / 1024} KB gzipped`, () => {
    expect(styles.length).toBe(1);
    expect(gz(styles[0]!)).toBeLessThanOrEqual(BUDGET_CSS_GZIP);
  });

  it('every feature screen is its own chunk, none of them is loaded by index.html, and the entry chunk does not contain their code', () => {
    const assets = readdirSync(join(DIST, 'assets')).filter((f) => f.endsWith('.js'));
    const entry = readFileSync(join(DIST, scripts.find((s) => s.startsWith('/assets/'))!.replace(/^\//, '')), 'utf8');
    for (const name of ['GenerateScreen', 'AuthorsScreen', 'PersonasScreen', 'ScoreScreen', 'SettingsScreen']) {
      const chunk = assets.find((a) => a.startsWith(`${name}-`));
      expect(chunk, `${name} chunk`).toBeDefined();
      expect([...scripts, ...preloads].some((s) => s.includes(chunk!)), `${name} in first load`).toBe(false);
    }
    // marker strings that exist only in screen code
    for (const marker of ['Read this first: the score is a weak proxy.', 'Ingesting an id that already exists', 'Filter the trace']) {
      expect(entry, marker).not.toContain(marker);
    }
  });
});
