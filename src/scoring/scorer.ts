// The local AI-likeness scorer (SCR-01, SCR-02): a deterministic, offline weighted mean of interpretable features.
//
//   score = sum over available features of value_i * w_i / sum(w of available features)
//
// Weights come from config (`scorer.weights`), need not sum to 1 (they are normalized) and may not be negative. A
// feature that cannot be computed (too little text for that statistic) is left out and the remaining weights are
// renormalized, so the breakdown decomposes the score (contributions sum to it to within floating-point error). With NO computable feature the result
// is the neutral 0.5 flagged `insufficient_text`. A score is a heuristic proxy, not a detector verdict (docs/CALIBRATION.md).
import { DEFAULT_SCORER_WEIGHTS, FEATURE_NAMES, LOW_CONFIDENCE_WORDS } from '../../config/scorer.js';
import type { FeatureName } from '../../config/scorer.js';
import { ConfigError } from '../models/errors.js';
import type { AiLikenessScorer, ScoreBreakdown } from '../models/types.js';
import { computeFeatures, prepareText } from './features.js';

export type ScorerWeights = Readonly<Record<FeatureName, number>>;

/**
 * Merge `weights` over the defaults, validate and normalize to sum 1. `ConfigError` for an unknown feature name, a
 * negative / non-finite / non-number weight, a set whose sum overflows, or a set with no positive weight.
 */
export function normalizeWeights(weights: Readonly<Partial<Record<string, number>>> = {}): ScorerWeights {
  const merged: Record<string, number> = { ...DEFAULT_SCORER_WEIGHTS };
  for (const [key, value] of Object.entries(weights)) {
    if (!(FEATURE_NAMES as readonly string[]).includes(key)) throw new ConfigError(`scorer weights: unknown feature "${key.slice(0, 40)}"`, [{ path: `scorer.weights.${key.slice(0, 40)}`, message: 'unknown feature' }]);
    if (value === undefined) continue;
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
      throw new ConfigError(`scorer weights: ${key} must be a finite non-negative number`, [{ path: `scorer.weights.${key}`, message: 'must be a non-negative number' }]);
    }
    merged[key] = value;
  }
  const total = FEATURE_NAMES.reduce((sum, name) => sum + (merged[name] as number), 0);
  if (!Number.isFinite(total)) throw new ConfigError('scorer weights: the weights are too large (their sum is not finite)', [{ path: 'scorer.weights', message: 'sum of weights overflows' }]);
  if (!(total > 0)) throw new ConfigError('scorer weights: at least one weight must be positive', [{ path: 'scorer.weights', message: 'at least one weight must be positive' }]);
  return Object.fromEntries(FEATURE_NAMES.map((name) => [name, (merged[name] as number) / total])) as Record<FeatureName, number>;
}

export class HeuristicScorer implements AiLikenessScorer {
  /** The normalized weights in effect (sum 1). */
  readonly weights: ScorerWeights;

  constructor(weights?: Readonly<Partial<Record<string, number>>>) {
    this.weights = normalizeWeights(weights);
  }

  score(text: string): ScoreBreakdown {
    if (typeof text !== 'string') throw new ConfigError('score: text must be a string');
    const prepared = prepareText(text);
    const results = computeFeatures(prepared);
    const availableWeight = FEATURE_NAMES.reduce((sum, name) => sum + (results[name].available ? this.weights[name] : 0), 0);

    const features: ScoreBreakdown['features'] = {};
    const flags: string[] = [];
    let score = 0;
    for (const name of FEATURE_NAMES) {
      const { value, available } = results[name];
      const weight = available && availableWeight > 0 ? this.weights[name] / availableWeight : 0;
      const contribution = value * weight;
      features[name] = { value, weight, contribution };
      score += contribution;
      if (!available) flags.push(`unavailable:${name}`);
    }
    if (availableWeight === 0) {
      // Nothing measurable (empty text, or every computable feature has zero weight): defined, neutral, flagged.
      score = 0.5;
      flags.unshift('insufficient_text');
    } else if (prepared.words.length < LOW_CONFIDENCE_WORDS) {
      flags.unshift('low_confidence');
    }
    return {
      score: Math.min(1, Math.max(0, score)),
      features,
      flags,
      stats: { words: prepared.words.length, sentences: prepared.sentenceLengths.length, paragraphs: prepared.paragraphLengths.length },
    };
  }
}
