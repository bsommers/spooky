// Deterministic rewrite steps of the humanizer (HUM-01): pure functions, no model, no randomness.
//
//   const r = deterministicRewrite(text, ['punctuation', 'burstiness']);   // { text, applied: { merged: 2, split: 1 } }
//
// Each targeted scorer feature maps to a small set of bounded edits:
//   cliche      the stock words the scorer counts are replaced by plainer ones (or deleted, for adverbs)
//   burstiness  split the longest long sentence at a conjunction / semicolon; join the shortest adjacent pair with ";"
//   punctuation join up to two adjacent short sentences with ";" (a mark the scorer rewards)
// A feature with no deterministic edit (lexicalDiversity, repetition, paragraphUniformity) is left to the model pass.
// Only unprotected prose is edited: code, URLs and blockquotes are byte-identical (src/filters/protectedSpans.ts).
// These edits are chosen because the LOCAL scorer rewards them; docs/HUMANIZING.md states what that does and does not mean.
import { HUMANIZE_CLICHE_REPLACEMENTS, HUMANIZE_LOWERABLE_STARTERS, HUMANIZE_RHYTHM } from '../../config/humanize.js';
import type { FeatureName } from '../../config/scorer.js';
import { join, splitProtected } from '../filters/protectedSpans.js';

export interface RewriteResult {
  text: string;
  /** Edits made, by kind (`replaced`, `deleted`, `split`, `merged`). Empty when nothing changed. */
  applied: Record<string, number>;
}

// ---------------------------------------------------------------- cliche words

const escape = (s: string): string => s.replace(/[\\^$.*+?()[\]{}|/]/g, '\\$&');
// A match must stand alone as a word: not inside a dotted name (realm.property, config.realm), a path, a hyphenated
// compound, an email or a snake_case identifier. A sentence-final "realm." (a dot then a space) is still a word.
const WORD_EDGE_BEFORE = '(?<![\\p{L}\\p{N}_.\\-/@])';
const WORD_EDGE_AFTER = '(?![\\p{L}\\p{N}_]|[.\\-/@][\\p{L}\\p{N}_])';
const QUOTED = /"[^"\n]{1,500}"|“[^”\n]{1,500}”/g;

const REPLACE_KEYS = Object.keys(HUMANIZE_CLICHE_REPLACEMENTS).filter((k) => HUMANIZE_CLICHE_REPLACEMENTS[k] !== null).sort((a, b) => b.length - a.length);
const DELETE_KEYS = Object.keys(HUMANIZE_CLICHE_REPLACEMENTS).filter((k) => HUMANIZE_CLICHE_REPLACEMENTS[k] === null);

const capitalize = (s: string): string => s.replace(/^\p{Ll}/u, (c) => c.toUpperCase());
const lowerFirst = (s: string): string => s.replace(/^\p{Lu}/u, (c) => c.toLowerCase());

function matchCase(original: string, replacement: string): string {
  const letters = original.replace(/[^\p{L}]/gu, '');
  if (letters.length >= 2 && letters === letters.toUpperCase()) return replacement.toUpperCase();
  return /^\p{Lu}/u.test(original) ? capitalize(replacement) : replacement;
}

const SENTENCE_END_BEFORE = /(?:^|[.!?…]["')\]”’]*[ \t]+|\n[ \t]*)$/;

/** True when the word starts with a vowel SOUND (an approximation: "useful", "unit" and "one" start with a consonant sound). */
const vowelSound = (w: string): boolean => /^(?:[aeio]|u(?!s[aeiou]|ni|ti|ro|k))/i.test(w) && !/^one\b/i.test(w);

/** `article` ("a", "An", ...) agreed with `word`, keeping the capital. */
function agreeArticle(article: string, word: string): string {
  const an = vowelSound(word);
  const base = an ? 'an' : 'a';
  return article[0] === article[0]?.toUpperCase() ? capitalize(base) : base;
}

/** Replace / delete the stock words in one unprotected segment, outside quoted spans. `startsSentence`: the segment begins a sentence. */
function clicheSegment(text: string, startsSentence: boolean, applied: Record<string, number>): string {
  // A quoted span is quoted text: the guard requires it byte-identical, so it is not edited.
  const parts = text.split(new RegExp(`(${QUOTED.source})`, 'g'));
  return parts.map((part, i) => (i % 2 === 1 ? part : clicheText(part, i === 0 && startsSentence, applied))).join('');
}

function clicheText(text: string, startsSentence: boolean, applied: Record<string, number>): string {
  let out = text;
  if (REPLACE_KEYS.length > 0) {
    const re = new RegExp(`(?:\\b(an?)([ \\t]+))?${WORD_EDGE_BEFORE}(?:${REPLACE_KEYS.map(escape).join('|')})${WORD_EDGE_AFTER}`, 'giu');
    out = out.replace(re, (m, article: string | undefined, space: string | undefined) => {
      applied.replaced = (applied.replaced ?? 0) + 1;
      const word = article === undefined ? m : m.slice(article.length + (space as string).length);
      const replacement = matchCase(word, HUMANIZE_CLICHE_REPLACEMENTS[word.toLowerCase()] as string);
      return article === undefined ? replacement : `${agreeArticle(article, replacement)}${space as string}${replacement}`;
    });
  }
  if (DELETE_KEYS.length > 0) {
    const re = new RegExp(`(,[ \\t]*|[ \\t]+)?${WORD_EDGE_BEFORE}(?:${DELETE_KEYS.map(escape).join('|')})${WORD_EDGE_AFTER}(,)?([ \\t]*)(\\p{L})?`, 'giu');
    out = out.replace(re, (_m, lead: string | undefined, trail: string | undefined, _space: string, next: string | undefined, offset: number, whole: string) => {
      applied.deleted = (applied.deleted ?? 0) + 1;
      if (next === undefined) return '';
      const before = whole.slice(Math.max(0, offset - 12), offset);
      const plain = lead !== undefined && /^[ \t]+$/.test(lead);
      const atStart = lead === undefined ? (offset === 0 ? startsSentence : SENTENCE_END_BEFORE.test(before)) : plain && SENTENCE_END_BEFORE.test(before + lead);
      if (atStart) return (plain ? (lead as string) : '') + next.toUpperCase();
      if (lead === undefined) return next;
      if (plain) return ` ${next}`;
      return trail !== undefined ? `, ${next}` : ` ${next}`;
    });
  }
  return out;
}

// ---------------------------------------------------------------- sentences

const ABBREVIATIONS = new Set(['mr', 'mrs', 'ms', 'dr', 'prof', 'vs', 'eg', 'ie', 'etc', 'no', 'st', 'jr', 'sr', 'inc', 'ltd', 'fig', 'cf']);
const LINE_PREFIX = /^[ \t]*(?:(?:[-*+]|\d{1,3}[.)])[ \t]+)?/;
const WORD_RE = /[\p{L}\p{N}]+(?:['’][\p{L}]+)*/gu;
const wc = (s: string): number => s.match(WORD_RE)?.length ?? 0;

/** One line of prose cut into sentences: `prefix + s0 + sep0 + s1 + ... + sN + suffix` is the line. */
interface Line {
  prefix: string;
  sentences: string[];
  seps: string[];
  suffix: string;
}

function isBoundary(body: string, i: number): boolean {
  // body[i] is . ! or ?; a boundary needs (closers) whitespace then a capital letter / digit / opening quote.
  let j = i + 1;
  while (j < body.length && /["')\]”’]/.test(body[j] as string)) j++;
  if (j >= body.length || !/[ \t]/.test(body[j] as string)) return false;
  let k = j;
  while (k < body.length && /[ \t]/.test(body[k] as string)) k++;
  if (k >= body.length || !/[\p{Lu}\p{N}"“'‘(]/u.test(body[k] as string)) return false;
  if (body[i] !== '.') return true;
  let s = i;
  while (s > 0 && /[\p{L}.]/u.test(body[s - 1] as string)) s--;
  const token = body.slice(s, i).replace(/\./g, '');
  if (ABBREVIATIONS.has(token.toLowerCase())) return false;
  if (token.length === 1 && /\p{Lu}/u.test(token)) return false; // an initial
  if (/\p{N}$/u.test(body.slice(0, i)) && /\p{N}/u.test(body[k] as string)) return false;
  return true;
}

function parseLine(raw: string): Line {
  const prefix = LINE_PREFIX.exec(raw)?.[0] ?? '';
  const rest = raw.slice(prefix.length);
  const body = rest.replace(/[ \t]+$/, '');
  const suffix = rest.slice(body.length);
  const sentences: string[] = [];
  const seps: string[] = [];
  let start = 0;
  for (let i = 0; i < body.length; i++) {
    if (!'.!?'.includes(body[i] as string) || !isBoundary(body, i)) continue;
    let end = i + 1;
    while (end < body.length && /["')\]”’]/.test(body[end] as string)) end++;
    let next = end;
    while (next < body.length && /[ \t]/.test(body[next] as string)) next++;
    sentences.push(body.slice(start, end));
    seps.push(body.slice(end, next));
    start = next;
    i = next - 1;
  }
  sentences.push(body.slice(start));
  return { prefix, sentences, seps, suffix };
}

const unparse = (l: Line): string => l.prefix + l.sentences.map((s, i) => s + (l.seps[i] ?? '')).join('') + l.suffix;

// A conjunction starts a new clause (not the next item of a list) only when a subject follows it.
const SUBJECT = '(?:the|this|that|these|those|it|they|we|he|she|there|you|i|our|their|its)';
const SPLITTERS: readonly { re: RegExp; head: string; tail: (rest: string) => string }[] = [
  { re: /; (?=\p{L})/u, head: '.', tail: capitalize },
  { re: new RegExp(`, (?=(?:but|and|so)\\s+${SUBJECT}\\b)`, 'iu'), head: '.', tail: capitalize },
];

/** Best split of `sentence`: the unevenest cut that leaves at least 4 words on each side, or null. */
function splitSentence(sentence: string): [string, string] | null {
  let best: { at: number; len: number; spl: (typeof SPLITTERS)[number]; first: number } | null = null;
  for (const spl of SPLITTERS) {
    const re = new RegExp(spl.re.source, 'gu');
    for (const m of sentence.matchAll(re)) {
      const at = m.index ?? 0;
      const first = wc(sentence.slice(0, at));
      const second = wc(sentence.slice(at + m[0].length));
      if (first < 4 || second < 4) continue;
      if (best === null || first < best.first) best = { at, len: m[0].length, spl, first };
    }
  }
  if (best === null) return null;
  return [sentence.slice(0, best.at) + best.spl.head, best.spl.tail(sentence.slice(best.at + best.len))];
}

const LOWERABLE = new Set(HUMANIZE_LOWERABLE_STARTERS);

/** `a` and `b` joined with a semicolon, or null when `b` cannot lose its capital safely or `a` does not end with a period. */
function mergeSentences(a: string, b: string): string | null {
  if (!/\.$/.test(a) || a.endsWith('..')) return null;
  const first = /^[\p{L}]+/u.exec(b)?.[0];
  if (first === undefined || !/^\p{Lu}\p{Ll}*$/u.test(first) || !LOWERABLE.has(first.toLowerCase())) return null;
  if (/;/.test(a) || /;/.test(b)) return null;
  return `${a.slice(0, -1)}; ${lowerFirst(b)}`;
}

interface Where {
  seg: number;
  line: number;
  at: number;
}

/** All lines of all unprotected segments, parsed once; edits mutate the parsed lines. */
class Doc {
  readonly segments: ReturnType<typeof splitProtected>;
  readonly lines: Map<number, Line[]> = new Map();
  readonly newlines: Map<number, string[]> = new Map();
  /** Sentences this run created (split parts, merged pairs): a later edit of the same run leaves them alone. */
  readonly touched = new Set<string>();

  constructor(text: string) {
    this.segments = splitProtected(text);
    this.segments.forEach((seg, si) => {
      if (seg.protected) return;
      const parts = seg.text.split(/(\n)/); // keeps separators at odd indices
      const lines: Line[] = [];
      const seps: string[] = [];
      for (let i = 0; i < parts.length; i += 2) {
        const raw = parts[i] as string;
        // headings are not prose
        lines.push(/^[ \t]*#{1,6}[ \t]/.test(raw) ? { prefix: raw, sentences: [], seps: [], suffix: '' } : parseLine(raw));
        seps.push(parts[i + 1] ?? '');
      }
      this.lines.set(si, lines);
      this.newlines.set(si, seps);
    });
  }

  *sentences(): Generator<Where & { text: string }> {
    for (const [seg, lines] of this.lines) for (let line = 0; line < lines.length; line++) {
      const l = lines[line] as Line;
      for (let at = 0; at < l.sentences.length; at++) yield { seg, line, at, text: l.sentences[at] as string };
    }
  }

  line(w: Where): Line {
    return (this.lines.get(w.seg) as Line[])[w.line] as Line;
  }

  toString(): string {
    return join(
      this.segments.map((seg, si) => {
        if (seg.protected) return seg;
        const lines = this.lines.get(si) as Line[];
        const seps = this.newlines.get(si) as string[];
        return { protected: false, text: lines.map((l, i) => (l.sentences.length === 0 ? l.prefix : unparse(l)) + (seps[i] ?? '')).join('') };
      }),
    );
  }
}

/** Split the longest sentence that has a usable cut. */
function splitLongest(doc: Doc): boolean {
  let best: (Where & { len: number; parts: [string, string] }) | null = null;
  for (const s of doc.sentences()) {
    const len = wc(s.text);
    if (len < HUMANIZE_RHYTHM.splitMinWords || (best !== null && len <= best.len) || doc.touched.has(s.text)) continue;
    const parts = splitSentence(s.text);
    if (parts !== null) best = { seg: s.seg, line: s.line, at: s.at, len, parts };
  }
  if (best === null) return false;
  const l = doc.line(best);
  doc.touched.add(best.parts[0]).add(best.parts[1]);
  l.sentences.splice(best.at, 1, best.parts[0], best.parts[1]);
  l.seps.splice(best.at, 1, ' ', l.seps[best.at] ?? '');
  return true;
}

/** Join the shortest adjacent pair (both at most `maxWords`) with a semicolon. */
function mergeShortest(doc: Doc, maxWords: number): boolean {
  let best: (Where & { total: number; merged: string }) | null = null;
  for (const [seg, lines] of doc.lines) {
    for (let line = 0; line < lines.length; line++) {
      const l = lines[line] as Line;
      for (let at = 0; at + 1 < l.sentences.length; at++) {
        const a = l.sentences[at] as string;
        const b = l.sentences[at + 1] as string;
        const total = wc(a) + wc(b);
        if (wc(a) > maxWords || wc(b) > maxWords || (best !== null && total >= best.total) || doc.touched.has(a) || doc.touched.has(b)) continue;
        const merged = mergeSentences(a, b);
        if (merged !== null) best = { seg, line, at, total, merged };
      }
    }
  }
  if (best === null) return false;
  const l = doc.line(best);
  doc.touched.add(best.merged);
  l.sentences.splice(best.at, 2, best.merged);
  l.seps.splice(best.at, 2, l.seps[best.at + 1] ?? '');
  return true;
}

// ---------------------------------------------------------------- entry point

/** Apply the deterministic edits for the targeted features. `[]` features or nothing to edit = the text unchanged. */
export function deterministicRewrite(text: string, features: readonly FeatureName[]): RewriteResult {
  const applied: Record<string, number> = {};
  let current = text;
  if (features.includes('cliche')) {
    const segments = splitProtected(current);
    current = join(
      segments.map((seg, i) => {
        if (seg.protected) return seg;
        const prev = segments[i - 1];
        const starts = i === 0 || (prev !== undefined && prev.text.endsWith('\n'));
        return { protected: false, text: clicheSegment(seg.text, starts, applied) };
      }),
    );
  }
  const wantsRhythm = features.includes('burstiness');
  const wantsPunct = features.includes('punctuation');
  if (wantsRhythm || wantsPunct) {
    const doc = new Doc(current);
    let budget = HUMANIZE_RHYTHM.maxEditsPerIteration;
    if (wantsRhythm && budget > 0 && splitLongest(doc)) {
      applied.split = (applied.split ?? 0) + 1;
      budget--;
    }
    const merges = (wantsRhythm ? 1 : 0) + (wantsPunct ? 2 : 0);
    for (let k = 0; k < merges && budget > 0; k++) {
      if (!mergeShortest(doc, HUMANIZE_RHYTHM.mergeMaxWords)) break;
      applied.merged = (applied.merged ?? 0) + 1;
      budget--;
    }
    current = doc.toString();
  }
  return { text: current, applied: current === text ? {} : applied };
}
