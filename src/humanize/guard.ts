// Meaning-preservation guard (HUM-02): a mechanical diff check between the text a rewrite started from and the
// candidate it produced. It cannot judge meaning; it proves the things that carry the facts did not change.
//
//   const g = checkMeaning(before, after);   // { ok: false, violations: ['number_added', ...] }
//
// Checked, all on exact strings:
//   - numbers (digits, with their separators and %): none dropped, none added or altered
//   - proper nouns and acronyms (capitalized words away from a sentence start, and ALL-CAPS words): none dropped, and no
//     capitalized word the original never had (a hallucinated name)
//   - quoted spans ("..." and curly quotes), protected spans (code, URLs, blockquotes) and code identifiers: byte-identical
//   - links: URLs, emails, bare hosts and markdown link targets form the same multiset (none added, swapped or dropped);
//     no new code fence
//   - added prose: sentences made mostly of words the original never used are counted; more than a small tolerance fails
//   - length: the word count stays within HUMANIZE_LENGTH_BOUNDS of the original
// Known limits, stated in docs/HUMANIZING.md: a sentence-initial proper noun is not tracked as an entity unless it also
// occurs elsewhere capitalized; negation flips, reordered facts and changed verbs pass. Violations are fixed codes, never text.
import { HUMANIZE_LENGTH_BOUNDS, HUMANIZE_NOVEL_SENTENCE_MIN_WORDS, HUMANIZE_NOVEL_SENTENCE_OVERLAP, HUMANIZE_NOVEL_SENTENCE_TOLERANCE } from '../../config/humanize.js';
import { PLACEHOLDER_RE } from '../filters/confidentiality.js';
import { splitProtected } from '../filters/protectedSpans.js';

export type GuardViolation =
  | 'empty'
  | 'number_dropped'
  | 'number_added'
  | 'entity_dropped'
  | 'entity_added'
  | 'quote_changed'
  | 'protected_changed'
  | 'identifier_dropped'
  | 'link_added'
  | 'link_dropped'
  | 'fence_added'
  | 'sentences_added'
  | 'length_out_of_bounds';

export interface GuardResult {
  ok: boolean;
  violations: GuardViolation[];
}

const NUMBER_RE = /\p{N}+(?:[.,:/-]\p{N}+)*%?/gu;
const CAPITALIZED_RE = /\p{Lu}[\p{L}\p{N}]*(?:['’]\p{L}+)?/gu;
const WORD_RE = /[\p{L}\p{N}]+(?:['’][\p{L}]+)*/gu;
/**
 * Link-like tokens, leftmost-longest in this order: a URL with a scheme, an email address, a bare host (with an optional
 * path). Markdown link targets `](target)` are collected separately. Compared as multisets between before and after, so an
 * ADDED, swapped or dropped link is a violation (a rewrite must not smuggle a URL or an address in, nor change one).
 */
const LINK_RE = /[A-Za-z][A-Za-z0-9+.-]{1,15}:\/\/[^\s<>"`]+|[\w.+-]+@[\w-]+(?:\.[\w-]+)+|\b[a-z0-9-]+(?:\.[a-z0-9-]+)*\.[a-z]{2,}(?:\/\S*)?/gi;
const MD_LINK_TARGET_RE = /\]\(\s*<?([^)\s>]+)/g;
const FENCE_RE = /^[ \t]*(?:`{3,}|~{3,})/gm;
const LINK_TAIL = /[.,;:!?)\]}'"”’]+$/;
const QUOTE_RES = [/"[^"\n]{1,500}"/g, /“[^”\n]{1,500}”/g];
const IDENTIFIER_RES = [/\b[a-z][a-z0-9]*(?:[A-Z][a-z0-9]+)+\b/g, /\b[A-Za-z0-9]+(?:_[A-Za-z0-9]+)+\b/g];
/** After a sentence terminator (and closers), a line start, or a list/heading marker: a capital here proves nothing. */
const SENTENCE_START_TAIL = /(?:^|[.!?…][)"'”’\]]*\s+|\n\s*(?:(?:[-*+]|\d{1,3}[.)]|#{1,6})\s+)?)$/;

const strip = (s: string): string => s.replace(PLACEHOLDER_RE, ' ');

const matches = (s: string, re: RegExp): string[] => [...s.matchAll(re)].map((m) => m[0]);

const isAcronym = (w: string): boolean => w.length >= 2 && w === w.toUpperCase() && /\p{Lu}/u.test(w);
const hasInnerCapital = (w: string): boolean => /\p{Ll}\p{Lu}/u.test(w);

/** Capitalized tokens that name something: not at a sentence start, or an acronym, or with an inner capital ("McDonald"). */
function entities(text: string): { named: Set<string>; anyCapitalized: Set<string> } {
  const named = new Set<string>();
  const anyCapitalized = new Set<string>();
  for (const m of text.matchAll(CAPITALIZED_RE)) {
    const w = m[0];
    if (w.length < 2) continue; // "I", "A"
    anyCapitalized.add(w);
    const before = text.slice(Math.max(0, (m.index ?? 0) - 12), m.index ?? 0);
    const start = (m.index ?? 0) === 0 || SENTENCE_START_TAIL.test(before);
    if (!start || isAcronym(w) || hasInnerCapital(w)) named.add(w);
  }
  return { named, anyCapitalized };
}

const wordCount = (s: string): number => s.match(WORD_RE)?.length ?? 0;

/** Counts of each token (a multiset), so a repeated or swapped token is not lost the way it is in a Set. */
function counts(tokens: readonly string[]): Map<string, number> {
  const m = new Map<string, number>();
  for (const t of tokens) m.set(t, (m.get(t) ?? 0) + 1);
  return m;
}

function linkTokens(text: string): string[] {
  const out = matches(text, LINK_RE).map((t) => t.replace(LINK_TAIL, ''));
  for (const m of text.matchAll(MD_LINK_TARGET_RE)) out.push(`](${(m[1] as string).replace(LINK_TAIL, '')}`);
  return out;
}

const fenceCount = (s: string): number => s.match(FENCE_RE)?.length ?? 0;

/** Distinct lower-case words of 3+ letters: the vocabulary a sentence is compared against. */
const vocabulary = (s: string): Set<string> => new Set(matches(s, WORD_RE).map((w) => w.toLowerCase()).filter((w) => w.length >= 3));
const sentencesOf = (s: string): string[] => s.split(/(?<=[.!?…])["')\]”’]*\s+|\n+/u).map((x) => x.trim()).filter((x) => x !== '');

/** `[]` violations = the candidate keeps every number, name, quote, protected span and identifier of `before`. */
export function checkMeaning(before: string, after: string): GuardResult {
  const violations = new Set<GuardViolation>();
  if (typeof after !== 'string' || after.trim() === '') return { ok: false, violations: ['empty'] };

  // protected spans (code, URLs, blockquotes) and quoted spans: byte-identical
  for (const seg of splitProtected(before)) if (seg.protected && !after.includes(seg.text.replace(/\n$/, ''))) violations.add('protected_changed');
  for (const re of QUOTE_RES) for (const q of matches(before, re)) if (!after.includes(q)) violations.add('quote_changed');
  const b = strip(before);
  const a = strip(after);
  for (const re of IDENTIFIER_RES) for (const id of matches(b, re)) if (!a.includes(id)) violations.add('identifier_dropped');

  const nb = new Set(matches(b, NUMBER_RE));
  const na = new Set(matches(a, NUMBER_RE));
  for (const n of nb) if (!na.has(n)) violations.add('number_dropped');
  for (const n of na) if (!nb.has(n)) violations.add('number_added');

  const eb = entities(b);
  const ea = entities(a);
  for (const e of eb.named) if (!ea.anyCapitalized.has(e)) violations.add('entity_dropped');
  for (const e of ea.named) if (!eb.anyCapitalized.has(e)) violations.add('entity_added');

  // links: the multiset of URLs, emails, bare hosts and markdown link targets must be the same; no new code fence
  const lb = counts(linkTokens(b));
  const la = counts(linkTokens(a));
  for (const [t, n] of la) if (n > (lb.get(t) ?? 0)) violations.add('link_added');
  for (const [t, n] of lb) if (n > (la.get(t) ?? 0)) violations.add('link_dropped');
  if (fenceCount(a) > fenceCount(b)) violations.add('fence_added');

  // added prose: a sentence that mostly uses words the original never had is new content, not a rewording
  const vb = vocabulary(b);
  const sb = sentencesOf(b).length;
  let novel = 0;
  for (const sentence of sentencesOf(a)) {
    const words = vocabulary(sentence);
    if (wordCount(sentence) < HUMANIZE_NOVEL_SENTENCE_MIN_WORDS || words.size === 0) continue;
    let known = 0;
    for (const w of words) if (vb.has(w)) known++;
    if (known / words.size < HUMANIZE_NOVEL_SENTENCE_OVERLAP) novel++;
  }
  if (novel > Math.floor(sb * HUMANIZE_NOVEL_SENTENCE_TOLERANCE)) violations.add('sentences_added');

  const wb = wordCount(b);
  if (wb > 0) {
    const ratio = wordCount(a) / wb;
    if (ratio < HUMANIZE_LENGTH_BOUNDS.min || ratio > HUMANIZE_LENGTH_BOUNDS.max) violations.add('length_out_of_bounds');
  }
  return { ok: violations.size === 0, violations: [...violations].sort() };
}
