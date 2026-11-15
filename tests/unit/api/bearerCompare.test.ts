// The bearer comparison must go through crypto.timingSafeEqual on equal-length buffers for EVERY header, valid or not.
// A spy on the real function (not a source-text check) fails if the comparison is replaced by `===`, short-circuits on a
// missing header, or compares unequal lengths.
import { describe, expect, it, vi } from 'vitest';

const spy = vi.hoisted(() => ({ calls: [] as { a: number; b: number }[] }));
vi.mock('node:crypto', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:crypto')>();
  return {
    ...actual,
    timingSafeEqual: (a: NodeJS.ArrayBufferView, b: NodeJS.ArrayBufferView): boolean => {
      spy.calls.push({ a: a.byteLength, b: b.byteLength });
      return actual.timingSafeEqual(a, b);
    },
  };
});

import { bearerMatches } from '../../../src/api/auth.js';

const TOKEN = 'correct-horse-battery-staple-1234';

describe('bearerMatches uses timingSafeEqual', () => {
  it('exactly one equal-length comparison per call, for a right token, a wrong one, a wrong length, no header and a malformed header', () => {
    const headers: [string | undefined, boolean][] = [
      [`Bearer ${TOKEN}`, true],
      [`Bearer ${TOKEN.slice(0, -1)}X`, false],
      ['Bearer short', false],
      [`Bearer ${'x'.repeat(500)}`, false],
      [undefined, false],
      ['', false],
      ['Basic abc', false],
      ['Bearer ', false],
      [`Bearer ${TOKEN} trailing`, false],
    ];
    for (const [header, expected] of headers) {
      spy.calls.length = 0;
      expect(bearerMatches(header, TOKEN), String(header)).toBe(expected);
      expect(spy.calls, String(header)).toHaveLength(1);
      expect(spy.calls[0]?.a).toBe(spy.calls[0]?.b); // fixed-size digests, never the raw strings
      expect(spy.calls[0]?.a).toBe(32);
    }
  });
});
