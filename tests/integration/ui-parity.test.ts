// Parity (Phase 11): the web UI is one more surface over the operations registry. It may call only operations that exist,
// and every operation reachable over HTTP must be used by some screen (the surface matrix in docs/SURFACES.md has no
// "planned" UI cell left). The UI's own manifest, ui/src/api/operations.ts, is generated from the registry's OpenAPI
// document and kept honest by `node ui/scripts/gen-api.mjs --check` and ui/tests/unit/api-types.test.ts.
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { OPERATIONS } from '../../src/service/operations.js';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const walk = (d: string): string[] => readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(join(d, e.name)) : [join(d, e.name)]));
const uiSources = walk(join(root, 'ui', 'src')).filter((f) => /\.tsx?$/.test(f) && !f.endsWith('schema.d.ts') && !f.endsWith('operations.ts'));

/** Every `api.get('/api/x')` / `api.post('/api/x')` in the UI source: [method, path]. */
function uiCalls(): Array<[string, string]> {
  const out: Array<[string, string]> = [];
  for (const f of uiSources) {
    for (const m of readFileSync(f, 'utf8').matchAll(/\bapi\s*\.\s*(get|post)\(\s*'(\/[^']*)'/g)) out.push([m[1]!.toUpperCase(), m[2]!]);
  }
  return out;
}

describe('UI uses the registry', () => {
  const routes = OPERATIONS.map((o) => `${o.http.method} ${o.http.path}`);

  it('every route the UI calls is an operation in the registry, with the right method', () => {
    const calls = uiCalls();
    expect(calls.length).toBeGreaterThan(8);
    for (const [method, path] of calls) expect(routes, `${method} ${path}`).toContain(`${method} ${path}`);
  });

  it('every registry operation is used by the UI', () => {
    const used = new Set(uiCalls().map(([m, p]) => `${m} ${p}`));
    for (const r of routes) expect(used.has(r), `${r} has no screen`).toBe(true);
  });

  it('the UI never builds an API path by hand outside the typed client calls, and never uses a route twice under two spellings', () => {
    for (const f of uiSources) {
      const text = readFileSync(f, 'utf8');
      for (const m of text.matchAll(/['"`](\/api\/[^'"`?]*)/g)) {
        expect(routes.map((r) => r.split(' ')[1]), `${f}: ${m[1]}`).toContain(m[1]);
      }
    }
  });

  it('docs/SURFACES.md no longer lists any UI cell as planned', () => {
    const matrix = readFileSync(join(root, 'docs', 'SURFACES.md'), 'utf8').split('\n').filter((l) => /^\| (ingest|generate|score|profile|list|config|capabilities|humanize)/.test(l));
    expect(matrix.length).toBeGreaterThanOrEqual(10);
    for (const row of matrix) expect(row, row).not.toMatch(/\bP11\b/);
  });
});
