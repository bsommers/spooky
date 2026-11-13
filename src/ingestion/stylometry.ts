// Stylometric profile extraction (SRC-01). Pure and deterministic: the same text always yields a deep-equal profile.
// Every metric is a cheap, explainable heuristic, not linguistics; they exist to give the prompt a measurable target
// and to tell authors apart. Definitions (also the contract the tests pin down):
//
//   sentence             text between sentence terminators (. ! ? … followed by whitespace, or 。！？), blank lines
//                        and bullet / numbered / heading line starts. Sentences with no words are dropped.
//   word                 a run of letters/digits with inner apostrophes, lower-cased. A CJK run counts as ONE word, so
//                        non-English text degrades to coarse but finite numbers rather than failing.
//   avgSentenceLength    mean words per sentence; sentenceLengthStdDev is the POPULATION standard deviation.
//   lexicalDensityRatio  unique words / total words (raw type-token ratio; it falls as a corpus grows).
//   preferredPunctuation the (up to) 3 most frequent of ; : — ( ! ?, ties in that fixed order, absent ones omitted.
//   hedgingFrequency     hedge phrases per 100 words (HEDGES below).
//   activePassiveRatio   share of sentences WITHOUT a passive construction (be-verb + past participle), in [0,1].
//   commonTransitionWords the (up to) 5 most frequent entries of TRANSITIONS, ties in list order.
//
// `[REDACTED:*]` placeholders left by the confidentiality filter are removed before measuring: they are not the
// author's style and their `:` and `[` would otherwise skew punctuation counts.
import { PLACEHOLDER_RE } from '../filters/confidentiality.js';
import { ProfileError } from '../models/errors.js';
import type { StylometricProfile } from '../models/types.js';

/** Name of the vector collection that holds an author's chunks. */
export function vectorCollectionName(authorId: string): string {
  return `author/${authorId}`;
}

// Terminators are matched only at the start of a run (look-behind) so a long run such as "......" cannot be rescanned
// from every position (quadratic).
const SENTENCE_BREAK =
  /(?<![.!?…])[.!?…]+["'”’)\]]*(?:\s+|$)|[。！？]+[」』"'”’)\]]*\s*|\n[ \t]*\n\s*|\n(?=[ \t]*(?:[-*•+]|\d+[.)]|#{1,6})[ \t])/g;
const WORD = /[\p{L}\p{N}]+(?:['’]\p{L}+)*/gu;

const PUNCTUATION = [';', ':', '—', '(', '!', '?'] as const;

const HEDGES = [
  'perhaps', 'maybe', 'might', 'possibly', 'probably', 'presumably', 'arguably', 'apparently', 'seemingly',
  'somewhat', 'supposedly', 'conceivably', 'seems', 'appears', 'tends to', 'tend to', 'i think', 'i believe',
  'i guess', 'i suppose', 'i feel', 'it seems', 'sort of', 'kind of', 'in my opinion', 'to some extent', 'more or less',
] as const;

const TRANSITIONS = [
  'however', 'therefore', 'moreover', 'furthermore', 'thus', 'hence', 'consequently', 'additionally', 'nevertheless',
  'nonetheless', 'meanwhile', 'instead', 'otherwise', 'besides', 'similarly', 'likewise', 'finally', 'overall',
  'specifically', 'indeed', 'also', 'but', 'yet', 'for example', 'for instance', 'in addition', 'in particular',
  'in conclusion', 'in summary', 'on the other hand', 'as a result', 'in contrast',
] as const;

/** Case-insensitive alternation of phrases (longest first), matched on whole words; inner spaces match any whitespace run. */
function phraseRegex(phrases: readonly string[]): RegExp {
  const alts = [...phrases]
    .sort((a, b) => b.length - a.length || (a < b ? -1 : 1))
    .map((p) => p.split(' ').join('\\s+'));
  return new RegExp(`(?<![\\p{L}\\p{N}])(?:${alts.join('|')})(?![\\p{L}\\p{N}])`, 'giu');
}
const HEDGE_RE = phraseRegex(HEDGES);
const TRANSITION_RE = phraseRegex(TRANSITIONS);

const PASSIVE_RE =
  /(?<![\p{L}\p{N}])(?:am|is|are|was|were|be|been|being)\s+(?:(?:not|also|often|always|never|then|now|still|already|just|really|very|quite|being|been)\s+|\p{L}+ly\s+)*(\p{L}+)(?![\p{L}])/giu;
const IRREGULAR_PARTICIPLES = new Set([
  'done', 'made', 'seen', 'known', 'given', 'taken', 'written', 'built', 'shown', 'found', 'held', 'kept', 'sent', 'lost',
  'won', 'brought', 'bought', 'caught', 'taught', 'told', 'sold', 'paid', 'said', 'heard', 'met', 'led', 'chosen',
  'broken', 'spoken', 'driven', 'forgotten', 'hidden', 'stolen', 'worn', 'torn', 'begun', 'drawn', 'grown', 'thrown',
  'eaten', 'beaten', 'bitten', 'set', 'put', 'cut', 'sung', 'struck',
]);
const NOT_PARTICIPLES = new Set([
  'need', 'speed', 'seed', 'feed', 'breed', 'weed', 'bleed', 'proceed', 'exceed', 'succeed', 'indeed', 'hundred',
  'sacred', 'naked', 'wicked', 'shed', 'sled', 'bed', 'red',
]);
// "set/put/cut" are in the list because "was set", "was put", "was cut" are overwhelmingly passive in prose.

function isParticiple(word: string): boolean {
  if (IRREGULAR_PARTICIPLES.has(word)) return true;
  return word.length >= 4 && word.endsWith('ed') && !NOT_PARTICIPLES.has(word);
}

const count = (text: string, re: RegExp): number => {
  let n = 0;
  for (const _ of text.matchAll(re)) n++;
  return n;
};

function topN(counts: Map<string, number>, order: readonly string[], n: number): string[] {
  return [...counts.entries()]
    .filter(([, c]) => c > 0)
    .sort((a, b) => b[1] - a[1] || order.indexOf(a[0]) - order.indexOf(b[0]))
    .slice(0, n)
    .map(([k]) => k);
}

export function extractProfile(authorId: string, displayName: string, text: string): StylometricProfile {
  if (typeof authorId !== 'string') throw new TypeError('extractProfile: authorId must be a string');
  if (typeof displayName !== 'string') throw new TypeError('extractProfile: displayName must be a string');
  if (typeof text !== 'string') throw new TypeError('extractProfile: text must be a string');

  const clean = text.replace(PLACEHOLDER_RE, ' ').replace(/\r\n?/g, '\n').toLowerCase();

  const sentenceLengths: number[] = [];
  const unique = new Set<string>();
  let totalWords = 0;
  let passiveSentences = 0;
  for (const sentence of clean.split(SENTENCE_BREAK)) {
    if (sentence === '') continue;
    let words = 0;
    for (const m of sentence.matchAll(WORD)) {
      words++;
      unique.add(m[0]);
    }
    if (words === 0) continue;
    sentenceLengths.push(words);
    totalWords += words;
    for (const m of sentence.matchAll(PASSIVE_RE)) {
      if (isParticiple(m[1] as string)) {
        passiveSentences++;
        break;
      }
    }
  }
  if (totalWords === 0 || sentenceLengths.length === 0) {
    throw new ProfileError('cannot build a profile: the corpus contains no words');
  }

  const sentences = sentenceLengths.length;
  const avg = totalWords / sentences;
  let squares = 0;
  for (const len of sentenceLengths) squares += (len - avg) * (len - avg);

  const punct = new Map<string, number>(PUNCTUATION.map((p) => [p, 0]));
  for (let i = 0; i < clean.length; i++) {
    const ch = clean[i] as string;
    const c = punct.get(ch);
    if (c !== undefined) punct.set(ch, c + 1);
  }

  const transitions = new Map<string, number>();
  for (const m of clean.matchAll(TRANSITION_RE)) {
    const key = m[0].replace(/\s+/g, ' ');
    transitions.set(key, (transitions.get(key) ?? 0) + 1);
  }

  return {
    authorId,
    displayName,
    avgSentenceLength: avg,
    sentenceLengthStdDev: Math.sqrt(squares / sentences),
    lexicalDensityRatio: unique.size / totalWords,
    preferredPunctuation: topN(punct, PUNCTUATION, 3),
    hedgingFrequency: (count(clean, HEDGE_RE) / totalWords) * 100,
    activePassiveRatio: (sentences - passiveSentences) / sentences,
    commonTransitionWords: topN(transitions, TRANSITIONS, 5),
    vectorCollectionName: vectorCollectionName(authorId),
    corpusWordCount: totalWords,
  };
}
