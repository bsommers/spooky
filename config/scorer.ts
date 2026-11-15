// AI-likeness scorer settings as data (SCR-01). Every number here was chosen BEFORE the calibration corpus was
// measured (see docs/CALIBRATION.md for what was measured and what was changed afterwards, if anything).
// Higher feature value = reads more machine-generated; every feature value is in [0,1].

/** The six interpretable features, in the fixed order used for breakdowns and sums. */
export const FEATURE_NAMES = ['burstiness', 'lexicalDiversity', 'cliche', 'punctuation', 'repetition', 'paragraphUniformity'] as const;
export type FeatureName = (typeof FEATURE_NAMES)[number];

/** Default weights; they sum to 1 but any non-negative set is accepted and normalized (src/scoring/scorer.ts). */
export const DEFAULT_SCORER_WEIGHTS: Readonly<Record<FeatureName, number>> = {
  burstiness: 0.25,
  lexicalDiversity: 0.15,
  cliche: 0.25,
  punctuation: 0.1,
  repetition: 0.1,
  paragraphUniformity: 0.15,
};

/** Below this many words a score is still returned but flagged `low_confidence`. */
export const LOW_CONFIDENCE_WORDS = 50;

/** Default weight of the local heuristic in the ensemble, and the default per-detector timeout. */
export const DEFAULT_LOCAL_WEIGHT = 1;
export const DEFAULT_DETECTOR_TIMEOUT_MS = 10_000;
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
 * Connectives and stock phrases (literal, lower-case, matched on word boundaries; apostrophes may be straight or
 * curly): commonly cited "assistant prose" tells. NOT independent of the calibration corpus: the list was written by
 * the same model that wrote the AI fixtures, after them, with them in context. Phrases that appeared to be echoes of a
 * specific fixture were removed, but the `cliche` feature's measured AUC is optimistic for that reason
 * (docs/CALIBRATION.md).
 */
export const CLICHE_PHRASES: readonly string[] = [
  // connectives / signposts
  'moreover', 'furthermore', 'additionally', 'in addition', 'consequently', 'overall', 'ultimately',
  'in conclusion', 'in summary', 'to summarize', 'that said', 'of course', 'importantly', 'notably',
  'it is important to note', "it's important to note", 'it is worth noting', "it's worth noting",
  'it should be noted', 'needless to say', 'at the end of the day', 'when it comes to',
  // stock vocabulary
  'delve', 'delves', 'delving', 'tapestry', 'testament', 'landscape', 'realm', 'beacon', 'myriad',
  'pivotal', 'crucial', 'vital', 'essential', 'robust', 'seamless', 'seamlessly', 'comprehensive',
  'vibrant', 'foster', 'fosters', 'fostering', 'leverage', 'leverages', 'leveraging', 'harness', 'empower',
  'empowers', 'unlock', 'navigate', 'embrace', 'embarking', 'journey', 'meaningful', 'valuable',
  'significant', 'significantly', 'remarkable',
  'transformative', 'holistic', 'streamline', 'cutting-edge', 'game-changer',
  // stock frames
  'plays a crucial role', 'plays a vital role', 'plays an important role', 'a wide range of', 'a variety of',
  'in today\'s', 'ever-evolving', 'fast-paced', 'look no further', 'whether you are', 'whether you\'re',
  'not only', 'serves as', 'stands as', 'beyond the',
  'in the realm of', 'strike a balance', 'a balanced approach',
  'make a difference',
];
