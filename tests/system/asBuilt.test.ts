// Keeps docs/AS-BUILT.md honest. The defect table maps each of the nine defects found in the seed code
// (.planning/PROJECT.md "Motivation") to the tests that pin it fixed, written as: `tests/<file>.test.ts` :: `<exact test title>`.
// This test fails if a defect has no mapping, a mapped file is gone, or a mapped title is no longer the exact title of a
// real (not skipped, not todo, not merely mentioned in a comment or a describe name) it()/test()/it.each() call in its file.
// (That those tests pass is the job of the suite itself; this guards the map.)
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const doc = readFileSync(join(root, 'docs', 'AS-BUILT.md'), 'utf8');

const section = doc.split(/^## /m).find((s) => s.startsWith('Defects from the seed code'));
const rows = (section ?? '').split('\n').filter((l) => /^\|\s*\d+\s*\|/.test(l));
const REF = /`(tests\/[^`]+\.test\.ts)` :: `([^`]+)`/g;

/** True if `src` contains an active `it('title', ...)`, `test('title', ...)` or `it.each(...)('title', ...)` (also with ` or "). */
export function hasActiveTest(src: string, title: string): boolean {
  for (const q of ["'", '"', '`']) {
    const needle = q + title + q; // the title is the whole string literal: a longer title that contains it does not count
    for (let i = src.indexOf(needle); i >= 0; i = src.indexOf(needle, i + 1)) {
      const prefix = src.slice(Math.max(0, i - 2000), i);
      const heads = [...prefix.matchAll(/(?<![.\w])(it|test)((?:\.\w+)*)\s*\(/g)];
      const head = heads[heads.length - 1];
      if (!head) continue; // a comment, a describe name, a plain string
      const before = prefix.slice(0, head.index ?? 0);
      if (before.slice(before.lastIndexOf('\n') + 1).includes('//')) continue; // in a line comment
      if (before.lastIndexOf('/*') > before.lastIndexOf('*/')) continue; // in a block comment
      const rest = prefix.slice((head.index ?? 0) + head[0].length);
      if (head[2] === '' && rest.trim() === '') return true; // it('title'
      if (head[2] === '.each' && /\)\s*\(\s*$/.test(rest)) return true; // it.each(table)('title'
      // anything else (it.skip, it.todo, it.skipIf(c)('title') ...) is not an active test
    }
  }
  return false;
}

describe('hasActiveTest (the guard itself)', () => {
  const t = 'my title';
  it.each([
    ["it('my title', () => {})", true],
    ['test("my title", async () => {})', true],
    ["it(\n  'my title',\n  () => {})", true],
    ["it.each(rows.map((r) => [r]))('my title', (r) => {})", true],
    ["it.each([\n [1],\n])(\n'my title', () => {})", true],
    ["it.skip('my title', () => {})", false],
    ["it.todo('my title')", false],
    ["it.skipIf(x)('my title', () => {})", false],
    ["it.each([1]).skip('my title', () => {})", false],
    ["// it('my title', ...) was removed", false],
    ["/*\n it('my title', () => {})\n*/", false],
    ["describe('my title', () => {})", false],
    ["it('my title and more', () => {})", false],
    ["it('not my title', () => {})", false],
    ["const s = 'my title'", false],
  ] as const)('%s -> %s', (src, expected) => {
    expect(hasActiveTest(src, t)).toBe(expected);
  });
});

describe('docs/AS-BUILT.md defect map', () => {
  it('has a section with one row per defect 1..9', () => {
    expect(section).toBeDefined();
    expect(rows.map((r) => Number(/^\|\s*(\d+)\s*\|/.exec(r)?.[1]))).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9]);
  });

  it.each(rows.map((r) => [Number(/^\|\s*(\d+)\s*\|/.exec(r)?.[1]), r] as const))('defect %i: marked fixed and every referenced test exists', (_n, row) => {
    expect(row).toMatch(/\bfixed\b/i);
    const refs = [...row.matchAll(REF)];
    expect(refs.length).toBeGreaterThanOrEqual(1);
    for (const [, file, title] of refs) {
      const path = join(root, file as string);
      expect(existsSync(path), `${file} exists`).toBe(true);
      expect(hasActiveTest(readFileSync(path, 'utf8'), title as string), `${file} has an active (not skipped) test titled "${title}"`).toBe(true);
    }
  });
});
