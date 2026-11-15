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
//   - length: the word count stays within HUMANIZE_LENGTH_BOUNDS of the original
// Known limits, stated in docs/HUMANIZING.md: a sentence-initial proper noun is not tracked as an entity unless it also
// occurs elsewhere capitalized; negation flips, reordered facts and changed verbs pass. Violations are fixed codes, never text.
import { HUMANIZE_LENGTH_BOUNDS } from '../../config/humanize.js';
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
  | 'length_out_of_bounds';

export interface GuardResult {
  ok: boolean;
  violations: GuardViolation[];
}

const NUMBER_RE = /\p{N}+(?:[.,:/-]\p{N}+)*%?/gu;
const CAPITALIZED_RE = /\p{Lu}[\p{L}\p{N}]*(?:['’]\p{L}+)?/gu;
const WORD_RE = /[\p{L}\p{N}]+(?:['’][\p{L}]+)*/gu;
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

  const wb = wordCount(b);
  if (wb > 0) {
    const ratio = wordCount(a) / wb;
    if (ratio < HUMANIZE_LENGTH_BOUNDS.min || ratio > HUMANIZE_LENGTH_BOUNDS.max) violations.add('length_out_of_bounds');
  }
  return { ok: violations.size === 0, violations: [...violations].sort() };
}
