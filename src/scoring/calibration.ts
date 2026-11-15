// Statistics for scorer calibration (SCR-04): AUC, score histograms and a seeded bootstrap interval. Pure, no I/O.
// Convention throughout: label 1 = machine-generated ("positive"), label 0 = human-written.

export interface Labeled {
  score: number;
  label: 0 | 1;
}

/**
 * Area under the ROC curve = P(score of a random positive > score of a random negative), ties counting 1/2
 * (Mann-Whitney U / (n_pos * n_neg)). `NaN` when either class is empty. O(n log n).
 */
export function auc(samples: readonly Labeled[]): number {
  const pos = samples.filter((s) => s.label === 1).length;
  const neg = samples.length - pos;
  if (pos === 0 || neg === 0) return Number.NaN;
  const sorted = [...samples].sort((a, b) => a.score - b.score);
  let rankSumPos = 0;
  for (let i = 0; i < sorted.length; ) {
    let j = i;
    while (j < sorted.length && (sorted[j] as Labeled).score === (sorted[i] as Labeled).score) j++;
    const avgRank = (i + 1 + j) / 2; // mean of ranks i+1..j
    for (let k = i; k < j; k++) if ((sorted[k] as Labeled).label === 1) rankSumPos += avgRank;
    i = j;
  }
  return (rankSumPos - (pos * (pos + 1)) / 2) / (pos * neg);
}

/** Seeded PRNG (mulberry32) so the bootstrap interval is reproducible. */
export function seededRandom(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Percentile bootstrap interval for the AUC, resampling each class separately. Deterministic for a given seed. */
export function bootstrapAuc(samples: readonly Labeled[], options: { resamples?: number; seed?: number; level?: number } = {}): { lo: number; hi: number } {
  const { resamples = 2000, seed = 20260101, level = 0.95 } = options;
  const pos = samples.filter((s) => s.label === 1);
  const neg = samples.filter((s) => s.label === 0);
  if (pos.length === 0 || neg.length === 0) return { lo: Number.NaN, hi: Number.NaN };
  const rnd = seededRandom(seed);
  const draw = (xs: readonly Labeled[]): Labeled[] => xs.map(() => xs[Math.floor(rnd() * xs.length)] as Labeled);
  const stats: number[] = [];
  for (let i = 0; i < resamples; i++) stats.push(auc([...draw(pos), ...draw(neg)]));
  stats.sort((a, b) => a - b);
  const at = (q: number): number => stats[Math.min(stats.length - 1, Math.max(0, Math.floor(q * stats.length)))] as number;
  return { lo: at((1 - level) / 2), hi: at(1 - (1 - level) / 2) };
}

/** Counts of `scores` in `bins` equal-width bins over [0,1]; a score of exactly 1 falls in the last bin. */
export function histogram(scores: readonly number[], bins = 10): number[] {
  const out = new Array<number>(bins).fill(0);
  for (const s of scores) out[Math.min(bins - 1, Math.max(0, Math.floor(s * bins)))]!++;
  return out;
}

/** Highest accuracy over all cut points `score >= t` => positive, and the (lowest) cut that reaches it. Chosen on the data it is measured on, so optimistic. */
export function bestThreshold(samples: readonly Labeled[]): { threshold: number; accuracy: number } {
  const cuts = [...new Set(samples.map((s) => s.score))].sort((a, b) => a - b);
  let best = { threshold: 0.5, accuracy: -1 };
  for (const t of cuts) {
    const correct = samples.filter((s) => (s.score >= t ? 1 : 0) === s.label).length;
    const accuracy = correct / samples.length;
    if (accuracy > best.accuracy) best = { threshold: t, accuracy };
  }
  return best;
}

export const mean = (xs: readonly number[]): number => (xs.length === 0 ? Number.NaN : xs.reduce((a, b) => a + b, 0) / xs.length);
