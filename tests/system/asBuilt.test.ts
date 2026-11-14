// Keeps docs/AS-BUILT.md honest. The defect table maps each of the nine defects found in the seed code
// (.planning/PROJECT.md "Motivation") to the tests that pin it fixed, written as: `tests/<file>.test.ts` :: `<exact test title>`.
// This test fails if a defect has no mapping, a mapped file is gone, or a mapped title no longer exists in its file.
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
      expect(readFileSync(path, 'utf8'), `${file} contains "${title}"`).toContain(title as string);
    }
  });
});
