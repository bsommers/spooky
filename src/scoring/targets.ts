// Which scorer features a humanizer iteration should work on: the worst-scoring ones.
//
//   selectTargets(breakdown)   // ['punctuation', 'burstiness']
//
// "Worst" = the largest contribution to the score (value x applied weight), so a feature the weights switch off, or one
// that could not be computed for this text, is never a target: changing it would not move the score.
import { FEATURE_NAMES } from '../../config/scorer.js';
import type { FeatureName } from '../../config/scorer.js';
import type { ScoreBreakdown } from '../models/types.js';

export const DEFAULT_TARGET_COUNT = 2;

/** At most `count` features with a positive contribution, largest first (ties in `FEATURE_NAMES` order). */
export function selectTargets(breakdown: Pick<ScoreBreakdown, 'features'>, count: number = DEFAULT_TARGET_COUNT): FeatureName[] {
  return FEATURE_NAMES.map((name, order) => ({ name, order, contribution: breakdown.features[name]?.contribution ?? 0 }))
    .filter((f) => f.contribution > 0)
    .sort((a, b) => b.contribution - a.contribution || a.order - b.order)
    .slice(0, Math.max(0, count))
    .map((f) => f.name);
}
