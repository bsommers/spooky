import { describe, expect, it } from 'vitest';
import { auc, bestThreshold, bootstrapAuc, histogram, mean } from '../../../src/scoring/calibration.js';
import type { Labeled } from '../../../src/scoring/calibration.js';

const L = (score: number, label: 0 | 1): Labeled => ({ score, label });

describe('auc', () => {
  it('is 1 for perfect separation, 0 for perfectly reversed, 0.5 for all ties', () => {
    expect(auc([L(0.1, 0), L(0.2, 0), L(0.8, 1), L(0.9, 1)])).toBe(1);
    expect(auc([L(0.1, 1), L(0.2, 1), L(0.8, 0), L(0.9, 0)])).toBe(0);
    expect(auc([L(0.5, 0), L(0.5, 1), L(0.5, 0), L(0.5, 1)])).toBe(0.5);
  });
  it('matches the pairwise definition on a mixed example (ties count 1/2)', () => {
    const xs = [L(0.2, 0), L(0.4, 0), L(0.4, 1), L(0.6, 0), L(0.7, 1), L(0.9, 1)];
    const pos = xs.filter((x) => x.label === 1);
    const neg = xs.filter((x) => x.label === 0);
    let wins = 0;
    for (const p of pos) for (const n of neg) wins += p.score > n.score ? 1 : p.score === n.score ? 0.5 : 0;
    expect(auc(xs)).toBeCloseTo(wins / (pos.length * neg.length), 12);
  });
  it('is NaN when a class is empty and independent of input order', () => {
    expect(auc([L(0.1, 0), L(0.2, 0)])).toBeNaN();
    expect(auc([])).toBeNaN();
    const xs = [L(0.3, 1), L(0.1, 0), L(0.9, 1), L(0.5, 0)];
    expect(auc(xs)).toBe(auc([...xs].reverse()));
  });
});

describe('bootstrapAuc', () => {
  const xs = Array.from({ length: 40 }, (_, i) => L(((i * 37) % 100) / 100 + (i % 2) * 0.2, (i % 2) as 0 | 1));
  it('is deterministic for a seed and brackets the point estimate loosely', () => {
    const a = bootstrapAuc(xs, { resamples: 300 });
    expect(bootstrapAuc(xs, { resamples: 300 })).toEqual(a);
    expect(a.lo).toBeLessThanOrEqual(auc(xs) + 0.2);
    expect(a.hi).toBeGreaterThanOrEqual(auc(xs) - 0.2);
    expect(a.lo).toBeLessThanOrEqual(a.hi);
  });
  it('is NaN for a single class', () => {
    expect(bootstrapAuc([L(0.1, 0)]).lo).toBeNaN();
  });
});

describe('histogram, bestThreshold, mean', () => {
  it('puts 1.0 in the last bin and counts everything once', () => {
    const h = histogram([0, 0.05, 0.1, 0.55, 0.99, 1], 10);
    expect(h).toEqual([2, 1, 0, 0, 0, 1, 0, 0, 0, 2]);
    expect(h.reduce((a, b) => a + b, 0)).toBe(6);
  });
  it('finds the best cut and its accuracy', () => {
    const r = bestThreshold([L(0.1, 0), L(0.2, 0), L(0.6, 1), L(0.7, 1), L(0.3, 1)]);
    expect(r).toEqual({ threshold: 0.3, accuracy: 1 });
  });
  it('mean of nothing is NaN', () => {
    expect(mean([])).toBeNaN();
    expect(mean([1, 2, 3])).toBe(2);
  });
});

describe('calibrate --weights parsing', () => {
  it('accepts a JSON object and gives a typed one-line ConfigError for anything else', async () => {
    const { parseWeightsArg } = await import('../../../scripts/calibrate.js');
    const { ConfigError } = await import('../../../src/models/errors.js');
    expect(parseWeightsArg('{"cliche":2}')).toEqual({ cliche: 2 });
    for (const bad of ['{bad', '[1]', 'null', '3', undefined, '--json']) {
      const run = (): unknown => parseWeightsArg(bad);
      expect(run, String(bad)).toThrow(ConfigError);
      expect(run, String(bad)).toThrow(/^[^\n]*$/);
    }
  });
});
