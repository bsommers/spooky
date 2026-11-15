// Interpretable text features for the AI-likeness scorer (SCR-01). Pure, deterministic, offline, linear time.
//
// Every feature maps the text onto [0,1] where HIGHER = reads more machine-generated, and says whether it could be
// computed at all (`available: false` = too little text for that statistic; the scorer then leaves it out and
// renormalizes the weights of the others instead of inventing a neutral number).
//
// Protected spans (fenced/inline code, URLs, blockquotes: src/filters/protectedSpans.ts) are removed before anything
// is measured: code and quotations say nothing about how the surrounding prose was written.
import { CLICHE_PHRASES, FEATURE_NAMES, FEATURE_PARAMS } from '../../config/scorer.js';
import type { FeatureName } from '../../config/scorer.js';
import { splitProtected } from '../filters/protectedSpans.js';

export type { FeatureName };
export { FEATURE_NAMES };

export interface FeatureResult {
  /** In [0,1]; 0.5 when `available` is false. */
  value: number;
  available: boolean;
}

/** The text after protected spans were removed, cut into the units the features measure. */
export interface PreparedText {
  /** Lower-cased words (letters/digits, inner apostrophes kept, curly apostrophes normalized). */
  words: string[];
  /** Words per sentence, in order (sentences with no word are dropped). */
  sentenceLengths: number[];
  /** Words per paragraph (blank-line separated), in order. */
  paragraphLengths: number[];
  /** Count of punctuation marks beyond `.` and `,` per class, over the prose only. */
  punctuation: Record<PunctuationClass, number>;
}

const PUNCTUATION_CLASSES = ['semicolon', 'colon', 'exclaim', 'question', 'dash', 'paren', 'quote', 'ellipsis'] as const;
type PunctuationClass = (typeof PUNCTUATION_CLASSES)[number];

const WORD_RE = /[\p{L}\p{N}]+(?:['’][\p{L}]+)*/gu;
const BLOCK_START_RE = /^\s*(?:#{1,6}\s|[-*+]\s|\d{1,3}[.)]\s)/;
const MARKER_RE = /^\s*(?:#{1,6}\s+|[-*+]\s+|\d{1,3}[.)]\s+)/;
const ABBREVIATIONS = new Set(['mr', 'mrs', 'ms', 'dr', 'prof', 'sr', 'jr', 'st', 'vs', 'etc', 'eg', 'ie', 'no', 'fig', 'inc', 'ltd', 'co']);
const TERMINATORS = new Set(['.', '!', '?', '…']);
const CLOSERS = new Set(['"', "'", ')', ']', '”', '’']);

const clamp01 = (x: number): number => (x < 0 ? 0 : x > 1 ? 1 : x);
const UNAVAILABLE: FeatureResult = { value: 0.5, available: false };

/** Text with code, URLs and blockquotes cut out. A block-level cut becomes a paragraph break, an inline one a space. */
function proseOf(raw: string): string {
  let out = '';
  for (const seg of splitProtected(raw.replace(/\r\n?/g, '\n'))) {
    out += seg.protected ? (seg.text.includes('\n') ? '\n\n' : ' ') : seg.text;
  }
  return out;
}

const wordCount = (s: string): number => s.match(WORD_RE)?.length ?? 0;

/** Split one block of prose into sentences. A boundary is a terminator run (plus closing quotes/brackets) followed by whitespace or the end. */
function splitSentences(block: string): string[] {
  const out: string[] = [];
  let start = 0;
  const n = block.length;
  for (let i = 0; i < n; i++) {
    if (!TERMINATORS.has(block[i] as string)) continue;
    let j = i + 1;
    while (j < n && (TERMINATORS.has(block[j] as string) || CLOSERS.has(block[j] as string))) j++;
    if (j < n && !/\s/.test(block[j] as string)) {
      i = j - 1; // "3.5", "e.g.x": not a boundary
      continue;
    }
    if (block[i] === '.' && j === i + 1) {
      // a lone period after an abbreviation or a single initial is not a boundary ("Dr. Smith", "J. Smith")
      let k = i;
      while (k > start && /[\p{L}.]/u.test(block[k - 1] as string)) k--;
      const token = block.slice(k, i).toLowerCase().replace(/\./g, '');
      if (ABBREVIATIONS.has(token) || (token.length === 1 && /\p{Lu}/u.test(block[k] as string))) {
        i = j - 1;
        continue;
      }
    }
    out.push(block.slice(start, j));
    start = j;
    i = j - 1;
  }
  if (start < n) out.push(block.slice(start));
  return out;
}

/** Cut `raw` into words, sentences and paragraphs after removing protected spans. */
export function prepareText(raw: string): PreparedText {
  const prose = proseOf(raw);
  const words = (prose.toLowerCase().replace(/’/g, "'").match(WORD_RE) ?? []).slice();
  const sentenceLengths: number[] = [];
  const paragraphLengths: number[] = [];
  for (const paragraph of prose.split(/\n[ \t]*\n/)) {
    const total = wordCount(paragraph);
    if (total === 0) continue;
    paragraphLengths.push(total);
    // Inside a paragraph, list items and headings are their own units; other line breaks are just wrapping.
    const blocks: string[] = [];
    for (const line of paragraph.split('\n')) {
      if (BLOCK_START_RE.test(line) || blocks.length === 0) blocks.push(line.replace(MARKER_RE, ''));
      else blocks[blocks.length - 1] += ` ${line}`;
    }
    for (const block of blocks) {
      for (const sentence of splitSentences(block)) {
        const w = wordCount(sentence);
        if (w > 0) sentenceLengths.push(w);
      }
    }
  }
  const punctuation = Object.fromEntries(PUNCTUATION_CLASSES.map((c) => [c, 0])) as Record<PunctuationClass, number>;
  for (const ch of prose) {
    switch (ch) {
      case ';': punctuation.semicolon++; break;
      case ':': punctuation.colon++; break;
      case '!': punctuation.exclaim++; break;
      case '?': punctuation.question++; break;
      case '—': case '–': punctuation.dash++; break;
      case '(': case ')': punctuation.paren++; break;
      case '"': case '“': case '”': punctuation.quote++; break;
      case '…': punctuation.ellipsis++; break;
      default:
    }
  }
  punctuation.dash += prose.match(/ -- /g)?.length ?? 0;
  punctuation.ellipsis += prose.match(/\.{3}/g)?.length ?? 0;
  return { words, sentenceLengths, paragraphLengths, punctuation };
}

function coefficientOfVariation(xs: readonly number[]): number {
  const mean = xs.reduce((a, b) => a + b, 0) / xs.length;
  if (mean === 0) return 0;
  const variance = xs.reduce((a, b) => a + (b - mean) ** 2, 0) / xs.length;
  return Math.sqrt(variance) / mean;
}

/** Uniform sentence lengths read as machine-made: 1 when every sentence is equally long, 0 at a high coefficient of variation. */
export function burstiness(p: PreparedText): FeatureResult {
  const k = FEATURE_PARAMS.burstiness;
  if (p.sentenceLengths.length < k.minSentences) return UNAVAILABLE;
  return { value: clamp01(1 - coefficientOfVariation(p.sentenceLengths) / k.cvForZero), available: true };
}

/** Moving-average type-token ratio (window of `window` words, or the whole text when shorter): a narrow vocabulary scores high. */
export function lexicalDiversity(p: PreparedText): FeatureResult {
  const k = FEATURE_PARAMS.lexicalDiversity;
  const n = p.words.length;
  if (n < k.minWords) return UNAVAILABLE;
  const w = Math.min(k.window, n);
  const counts = new Map<string, number>();
  let distinct = 0;
  let sum = 0;
  for (let i = 0; i < n; i++) {
    const add = p.words[i] as string;
    const c = counts.get(add) ?? 0;
    if (c === 0) distinct++;
    counts.set(add, c + 1);
    if (i >= w) {
      const drop = p.words[i - w] as string;
      const d = (counts.get(drop) as number) - 1;
      counts.set(drop, d);
      if (d === 0) distinct--;
    }
    if (i >= w - 1) sum += distinct / w;
  }
  const mattr = sum / (n - w + 1);
  return { value: clamp01((k.hi - mattr) / (k.hi - k.lo)), available: true };
}

// Phrase lookup: first word -> phrases (as word arrays) starting with it, longest first.
let phraseIndex: Map<string, string[][]> | undefined;
function phrases(): Map<string, string[][]> {
  if (phraseIndex === undefined) {
    const index = new Map<string, string[][]>();
    for (const phrase of CLICHE_PHRASES) {
      const ws = phrase.toLowerCase().replace(/’/g, "'").match(WORD_RE) ?? [];
      if (ws.length === 0) continue;
      const bucket = index.get(ws[0] as string) ?? [];
      bucket.push(ws);
      index.set(ws[0] as string, bucket);
    }
    for (const bucket of index.values()) bucket.sort((a, b) => b.length - a.length);
    phraseIndex = index;
  }
  return phraseIndex;
}

/** Count non-overlapping occurrences of the stock phrases / connectives in `words` (longest match first). */
export function countCliches(words: readonly string[]): number {
  const index = phrases();
  let count = 0;
  for (let i = 0; i < words.length; ) {
    const candidates = index.get(words[i] as string);
    const hit = candidates?.find((ph) => ph.every((w, j) => words[i + j] === w));
    if (hit !== undefined) {
      count++;
      i += hit.length;
    } else {
      i++;
    }
  }
  return count;
}

/** Stock phrases and connectives per 100 words, saturating: 0 at none, approaching 1 as they pile up. */
export function cliche(p: PreparedText): FeatureResult {
  const k = FEATURE_PARAMS.cliche;
  if (p.words.length < k.minWords) return UNAVAILABLE;
  const density = (countCliches(p.words) * 100) / p.words.length;
  return { value: clamp01(1 - Math.exp(-density / k.scale)), available: true };
}

/** Few distinct non-`.`/`,` marks, rarely used: scores high. */
export function punctuation(p: PreparedText): FeatureResult {
  const k = FEATURE_PARAMS.punctuation;
  if (p.words.length < k.minWords) return UNAVAILABLE;
  const counts = Object.values(p.punctuation);
  const total = counts.reduce((a, b) => a + b, 0);
  const classes = counts.filter((c) => c > 0).length;
  const rate = (total * 100) / p.words.length;
  return { value: clamp01(1 - (0.5 * Math.min(1, rate / k.rateForZero) + 0.5 * Math.min(1, classes / k.classesForZero))), available: true };
}

/** Share of word trigrams that occur more than once in the text. */
export function repetition(p: PreparedText): FeatureResult {
  const k = FEATURE_PARAMS.repetition;
  if (p.words.length < k.minWords) return UNAVAILABLE;
  const counts = new Map<string, number>();
  const total = p.words.length - 2;
  for (let i = 0; i < total; i++) {
    const key = `${p.words[i]} ${p.words[i + 1]} ${p.words[i + 2]}`;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  let repeated = 0;
  for (const c of counts.values()) if (c > 1) repeated += c;
  return { value: clamp01(repeated / total / k.rateForOne), available: true };
}

/** Paragraphs of near-equal length score high; needs at least `minParagraphs` paragraphs. */
export function paragraphUniformity(p: PreparedText): FeatureResult {
  const k = FEATURE_PARAMS.paragraphUniformity;
  if (p.paragraphLengths.length < k.minParagraphs) return UNAVAILABLE;
  return { value: clamp01(1 - coefficientOfVariation(p.paragraphLengths) / k.cvForZero), available: true };
}

export const FEATURES: Readonly<Record<FeatureName, (p: PreparedText) => FeatureResult>> = {
  burstiness,
  lexicalDiversity,
  cliche,
  punctuation,
  repetition,
  paragraphUniformity,
};

/** Every feature of `p`, keyed in `FEATURE_NAMES` order. */
export function computeFeatures(p: PreparedText): Record<FeatureName, FeatureResult> {
  return Object.fromEntries(FEATURE_NAMES.map((name) => [name, FEATURES[name](p)])) as Record<FeatureName, FeatureResult>;
}
