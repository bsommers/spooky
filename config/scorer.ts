// AI-likeness scorer settings as data (SCR-01). The curve constants were committed before the calibration corpus was
// added. The feature weights and the stock-word list were re-derived from the dev split only (docs/CALIBRATION.md);
// the test split was not used for any decision.
// Higher feature value = reads more machine-generated; every feature value is in [0,1].

/** The six interpretable features, in the fixed order used for breakdowns and sums. */
export const FEATURE_NAMES = ['burstiness', 'lexicalDiversity', 'cliche', 'punctuation', 'repetition', 'paragraphUniformity'] as const;
export type FeatureName = (typeof FEATURE_NAMES)[number];

/**
 * Default weights; they sum to 1 but any non-negative set is accepted and normalized (src/scoring/scorer.ts). Derived
 * on the dev split of the calibration corpus only, by the rule in scripts/calibrate.ts `deriveWeights` (feature AUC
 * minus 0.5, eligible features only); `lexicalDiversity` and `repetition` point the wrong way on dev and get 0, and
 * `paragraphUniformity` is computable on too few texts to carry weight. A test fails if these drift from the rule.
 * The previous defaults (0.25, 0.15, 0.25, 0.10, 0.10, 0.15) are kept in scripts/calibrate.ts as LEGACY_WEIGHTS.
 */
export const DEFAULT_SCORER_WEIGHTS: Readonly<Record<FeatureName, number>> = {
  burstiness: 0.323,
  lexicalDiversity: 0,
  cliche: 0.132,
  punctuation: 0.545,
  repetition: 0,
  paragraphUniformity: 0,
};

/** Below this many words a score is still returned but flagged `low_confidence`. */
export const LOW_CONFIDENCE_WORDS = 50;

/** Default weight of the local heuristic in the ensemble, and the default per-detector timeout. */
export const DEFAULT_LOCAL_WEIGHT = 1;
export const DEFAULT_DETECTOR_TIMEOUT_MS = 10_000;
/** Longest text the scorer accepts (characters). The protected-span pass is quadratic on newline-heavy input; 500k keeps the worst case under about a second. */
export const MAX_SCORE_INPUT_CHARS = 500_000;
/** Largest detector response body read (a score is a few bytes). */
export const MAX_DETECTOR_RESPONSE_BYTES = 64 * 1024;

/**
 * Shape constants for the feature curves. Each feature maps a raw statistic linearly (or, for `cliche`, with a
 * saturating exponential) onto [0,1]; `min`/`max` are the raw values that map to the two ends.
 */
export const FEATURE_PARAMS = {
  /** Sentence-length coefficient of variation (sd/mean). cv >= `cvForZero` scores 0; cv = 0 (all sentences equal) scores 1. Needs >= `minSentences`. */
  burstiness: { cvForZero: 0.9, minSentences: 3 },
  /** Moving-average type-token ratio over `window` words. mattr <= `lo` scores 1, mattr >= `hi` scores 0. Needs >= `minWords`. */
  lexicalDiversity: { window: 50, lo: 0.6, hi: 0.85, minWords: 30 },
  /** Stock phrases + connectives per 100 words, v = 1 - exp(-density / `scale`). Needs >= `minWords`. */
  cliche: { scale: 2, minWords: 20 },
  /** Punctuation beyond `.` and `,`: per-100-word rate and number of distinct classes. v = 1 - (0.5*min(1,rate/`rateForZero`) + 0.5*min(1,classes/`classesForZero`)). Needs >= `minWords`. */
  punctuation: { rateForZero: 6, classesForZero: 5, minWords: 20 },
  /** Share of word trigrams that occur more than once. rate >= `rateForOne` scores 1. Needs >= `minWords`. */
  repetition: { rateForOne: 0.1, minWords: 30 },
  /** Paragraph word-count coefficient of variation. cv >= `cvForZero` scores 0. Needs >= `minParagraphs` paragraphs. */
  paragraphUniformity: { cvForZero: 0.8, minParagraphs: 3 },
} as const;

/**
 * Candidate stock words for the `cliche` feature: the single style words named in the text or figure labels of Kobak et
 * al. 2024, "Delving into LLM-assisted writing in biomedical publications through excess vocabulary" (arXiv:2406.07016),
 * a study of words whose frequency jumped in 2024 abstracts. Function and content words the paper lists (these, while,
 * through, potential, findings) are excluded. No word was taken from the AI calibration fixtures.
 */
export const CLICHE_CANDIDATES: readonly string[] = [
  'delve', 'delves', 'delved', 'delving', 'underscore', 'underscores', 'showcasing', 'grappling', 'garnered', 'aligning',
  'pivotal', 'notably', 'additionally', 'significant', 'crucial', 'exhibited', 'insights', 'comprehensive', 'enhancing',
  'particularly', 'within', 'across', 'valuable', 'highlights', 'offering', 'excels', 'intricate', 'meticulously', 'realm',
];
/** A candidate is dropped if it occurs more than this many times per 10,000 words in the human texts of the dev split (scripts/calibrate.ts `applyClicheRule`). */
export const CLICHE_MAX_HUMAN_RATE_PER_10K = 2;

/**
 * The stock words the `cliche` feature counts: CLICHE_CANDIDATES filtered by the rule above, with the dev-split human
 * texts of the calibration corpus. Regenerate with `npm run calibrate -- --dev-only` (key `clicheKept`); a test fails
 * if this list drifts from the rule. It is not independent of the corpus in one respect only: the human dev texts
 * decide which candidates are too common in ordinary prose. The AI fixtures play no part (docs/CALIBRATION.md).
 */
export const CLICHE_PHRASES: readonly string[] = [
  'delve', 'delves', 'delved', 'delving', 'underscore', 'underscores', 'showcasing', 'grappling', 'garnered', 'aligning', 'pivotal', 'notably', 'additionally', 'significant', 'crucial', 'exhibited', 'insights', 'enhancing', 'across', 'valuable', 'offering', 'excels', 'intricate', 'meticulously', 'realm',
];
