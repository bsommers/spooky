// Humanizer settings as data (Phase 8). Defaults mirror HUM-01: stop at `targetScore` 0.3 or after `maxIterations` 3.
// The target is a threshold on the LOCAL heuristic score (a weak, confounded proxy: docs/CALIBRATION.md), not a promise
// about any third-party detector (docs/HUMANIZING.md).

export const DEFAULT_HUMANIZE = { targetScore: 0.3, maxIterations: 3 } as const;

/** Hard upper bound on `maxIterations` (each iteration can cost one model call). */
export const MAX_HUMANIZE_ITERATIONS = 10;

/** A rewrite may not shrink the text below, or grow it beyond, these fractions of the word count it started from. */
export const HUMANIZE_LENGTH_BOUNDS = { min: 0.5, max: 2 } as const;

/** Largest model answer the rewrite step accepts, as a multiple of the input length (plus a floor), in characters. */
export const HUMANIZE_OUTPUT_FACTOR = 3;
export const HUMANIZE_OUTPUT_FLOOR = 2000;

/** Sentence-level rewrite thresholds for the deterministic step (words). */
export const HUMANIZE_RHYTHM = {
  /** a sentence needs at least this many words before it is split */
  splitMinWords: 24,
  /** both sentences of a merged pair have at most this many words */
  mergeMaxWords: 20,
  /** at most this many splits / merges per iteration and per paragraph-free text */
  maxEditsPerIteration: 3,
} as const;

/**
 * Plain replacements for the stock words the `cliche` feature counts (config/scorer.ts CLICHE_PHRASES). A word with no
 * entry here is left to the model pass: replacing it blindly would change its meaning ("significant", "across").
 * `null` deletes the word (an adverb whose removal leaves a grammatical sentence).
 */
export const HUMANIZE_CLICHE_REPLACEMENTS: Readonly<Record<string, string | null>> = {
  delve: 'dig',
  delves: 'digs',
  delved: 'dug',
  delving: 'digging',
  underscore: 'stress',
  underscores: 'stresses',
  showcasing: 'showing',
  grappling: 'struggling',
  garnered: 'earned',
  aligning: 'matching',
  pivotal: 'key',
  notably: null,
  additionally: 'also',
  crucial: 'key',
  exhibited: 'showed',
  enhancing: 'improving',
  valuable: 'useful',
  excels: 'does well',
  intricate: 'complex',
  meticulously: 'carefully',
  realm: 'area',
};

/** Words that may lose their capital when a sentence is joined to the one before it with a semicolon. */
export const HUMANIZE_LOWERABLE_STARTERS: readonly string[] = [
  'the', 'this', 'that', 'these', 'those', 'it', 'its', 'they', 'their', 'we', 'he', 'she', 'there', 'a', 'an', 'in', 'on', 'at', 'for',
  'with', 'but', 'so', 'and', 'then', 'now', 'here', 'some', 'many', 'most', 'each', 'every', 'both', 'such', 'one', 'when', 'while',
  'because', 'since', 'if', 'as', 'by', 'from', 'to', 'of', 'our', 'your', 'his', 'her', 'what', 'which', 'who', 'how', 'why',
];

/** What to ask the model for, per scorer feature (a feature with no entry is not asked about). */
export const HUMANIZE_FEATURE_INSTRUCTIONS: Readonly<Record<string, string>> = {
  burstiness: 'Vary the sentence length: mix very short sentences with longer ones instead of sentences of similar length.',
  cliche: 'Replace stock words and connectives (for example delve, pivotal, crucial, notably, additionally, furthermore, moreover) with plain wording.',
  punctuation: 'Use a wider range of punctuation where it reads naturally (semicolons, colons, dashes, parentheses, question marks).',
  lexicalDiversity: 'Vary word choice; do not reuse the same words and phrases.',
  repetition: 'Remove repeated three-word phrases by rewording.',
  paragraphUniformity: 'Vary paragraph length; do not make paragraphs the same size.',
};
