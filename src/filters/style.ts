// Style filter (STY-01..04): a deterministic editor for post-generation text.
//   1. phrase edits   : delete or replace configured cliche phrases (+ persona banned phrases from ctx)
//   2. repair         : casing, commas and spacing around every edit site (and ONLY there)
//   3. rhythm check   : flag runs of near-equal-length sentences and break them up, driven by the author profile
// Only unprotected segments are edited (fences, inline code, URLs, blockquotes are byte-identical, see protectedSpans.ts).
// Pure given (text, ctx): no randomness, no regex state (all scanning is matchAll on module-level or per-call regexes).
import { DEFAULT_RHYTHM } from '../../config/phrases.js';
import { ConfigError } from '../models/errors.js';
import type { Filter, FilterResult, OnError, PipelineContext, Stage, StylometricProfile } from '../models/types.js';
import { join, splitProtected } from './protectedSpans.js';

export interface PhraseEntry {
  /** Literal phrase (not a regex). Leading/trailing punctuation and whitespace are ignored. */
  pattern: string;
  /** Substitute instead of deleting. Casing of the match (lower / Capitalized / UPPER) is carried over. */
  replacement?: string;
}

export interface RhythmSettings {
  runMin: number;
  tolerance: number;
  minSplitWords: number;
}

export interface StyleOptions {
  phrases: readonly PhraseEntry[];
  /** Default 'skip': a style bug must not block output. Taken from the pipeline config entry. */
  onError?: OnError;
  rhythm?: Partial<RhythmSettings>;
}

// ---------------------------------------------------------------- phrase matching

interface CompiledPhrases {
  rx: RegExp | null;
  /** normalized phrase -> replacement (undefined = delete) */
  actions: ReadonlyMap<string, string | undefined>;
}

const EDGE_PUNCT_RE = /^[\s,;:.!?]+|[\s,;:.!?]+$/g;

function cleanPhrase(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const p = raw.replace(EDGE_PUNCT_RE, '');
  return /[\p{L}\p{N}]/u.test(p) ? p : null;
}

function normKey(s: string): string {
  return s.toLowerCase().replace(/[ \t]+/g, ' ').replace(/’/g, "'");
}

function escapeLiteral(s: string): string {
  return s.replace(/[\\^$.*+?()[\]{}|/]/g, '\\$&');
}

function compilePhrases(entries: readonly { phrase: string; replacement?: string }[]): CompiledPhrases {
  const actions = new Map<string, string | undefined>();
  const alts: { key: string; src: string }[] = [];
  for (const e of entries) {
    const key = normKey(e.phrase.replace(/\s+/g, ' '));
    if (actions.has(key)) continue;
    actions.set(key, e.replacement === '' ? undefined : e.replacement);
    const src = e.phrase
      .split(/\s+/)
      .map((w) => escapeLiteral(w).replace(/['’]/g, "['\\u2019]"))
      .join('[ \\t]+');
    alts.push({ key, src });
  }
  if (alts.length === 0) return { rx: null, actions };
  alts.sort((a, b) => b.key.length - a.key.length || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  const rx = new RegExp(`(?<![\\p{L}\\p{N}_])(?:${alts.map((a) => a.src).join('|')})(?![\\p{L}\\p{N}_])`, 'giu');
  return { rx, actions };
}

const isHS = (c: string | undefined): boolean => c === ' ' || c === '\t';
const stripLeadingHS = (s: string): string => s.replace(/^[ \t]+/, '');
const capitalizeFirst = (s: string): string => s.replace(/^\p{Ll}/u, (c) => c.toUpperCase());
const lowerFirst = (s: string): string => s.replace(/^\p{Lu}/u, (c) => c.toLowerCase());
const CLOSE_PUNCT = new Set(['.', ',', ';', ':', '!', '?', ')', ']', '}']);
const OPENERS_RE = /[(\[{"'“‘]/;

function matchCase(original: string, replacement: string): string {
  const letters = original.replace(/[^\p{L}]/gu, '');
  if (letters.length >= 2 && letters === letters.toUpperCase() && letters !== letters.toLowerCase()) {
    return replacement.toUpperCase();
  }
  const first = /\p{L}/u.exec(original)?.[0];
  if (first !== undefined && first !== first.toLowerCase()) return capitalizeFirst(replacement);
  return replacement;
}

const LINE_START_PREFIX_RE = /^[ \t]*(?:(?:[-*+]|\d{1,3}[.)]|#{1,6})[ \t]+)?$/;
const SENTENCE_END_TAIL_RE = /[.!?][)"'”’\]]*[ \t]+$/;

/** Is the position `a` in `text` the start of a sentence (start of text/line/list item or after a terminator)? */
function isSentenceStart(text: string, a: number, segmentStartsSentence: boolean): boolean {
  const ls = a === 0 ? 0 : text.lastIndexOf('\n', a - 1) + 1;
  if (LINE_START_PREFIX_RE.test(text.slice(ls, a))) return ls === 0 ? segmentStartsSentence : true;
  return SENTENCE_END_TAIL_RE.test(text.slice(Math.max(ls, a - 12), a));
}

interface EditResult {
  text: string;
  removed: number;
  replaced: number;
}

/** Apply all phrase matches in `text` right to left, so each edit sees its right-hand side already final. */
function applyPhrases(text: string, phrases: CompiledPhrases, startsSentence: boolean, endsText: boolean): EditResult {
  const rx = phrases.rx;
  if (rx === null) return { text, removed: 0, replaced: 0 };
  const matches = [...text.matchAll(rx)];
  if (matches.length === 0) return { text, removed: 0, replaced: 0 };

  let acc = '';
  let pos = text.length;
  let removed = 0;
  let replaced = 0;
  for (let k = matches.length - 1; k >= 0; k--) {
    const m = matches[k] as RegExpMatchArray;
    const start = m.index as number;
    const end = start + m[0].length;
    const action = phrases.actions.get(normKey(m[0]));
    const gap = text.slice(end, pos);

    if (action !== undefined) {
      acc = matchCase(m[0], action) + gap + acc;
      pos = start;
      replaced++;
      continue;
    }

    removed++;
    let right = gap + acc;
    let cut = start; // text[0..cut) is kept
    let capitalize = false;

    // comma directly before / after the phrase
    let leadLen = 0;
    if (cut > 0) {
      let b = cut;
      while (b > 0 && isHS(text[b - 1])) b--;
      if (b > 0 && text[b - 1] === ',') leadLen = cut - (b - 1);
    }
    let trailLen = 0;
    {
      let t = 0;
      while (isHS(right[t])) t++;
      if (right[t] === ',') trailLen = t + 1;
    }

    const sentenceStart = isSentenceStart(text, start, startsSentence);
    if (sentenceStart) {
      right = stripLeadingHS(right.slice(trailLen));
      const term = /^[.!?]+[ \t]*/.exec(right); // a sentence that was only the phrase
      if (term) right = right.slice(term[0].length);
      capitalize = true;
    } else if (leadLen > 0 && trailLen > 0) {
      cut -= leadLen; // drop both commas: "a, moreover, b" -> "a b"
      right = stripLeadingHS(right.slice(trailLen));
    } else if (leadLen > 0) {
      right = stripLeadingHS(right);
      const f = right[0];
      if ((right === '' && endsText) || f === '\n' || f === '\r' || (f !== undefined && CLOSE_PUNCT.has(f))) {
        cut -= leadLen; // "a, moreover." -> "a."
      }
    } else {
      right = stripLeadingHS(trailLen > 0 ? right.slice(trailLen) : right);
    }

    // join the kept left part and the right part with the right amount of whitespace
    let sep = '';
    const first = right[0];
    if (sentenceStart) {
      sep = '';
    } else if (right === '') {
      if (endsText) while (cut > 0 && isHS(text[cut - 1])) cut--;
    } else if (first === '\n' || first === '\r' || (first !== undefined && CLOSE_PUNCT.has(first))) {
      while (cut > 0 && isHS(text[cut - 1])) cut--;
    } else {
      const prev = cut > 0 ? (text[cut - 1] as string) : '';
      sep = cut === 0 || /\s/.test(prev) || OPENERS_RE.test(prev) ? '' : ' ';
    }
    acc = sep + (capitalize ? capitalizeFirst(right) : right);
    pos = cut;
  }
  return { text: text.slice(0, pos) + acc, removed, replaced };
}

// ---------------------------------------------------------------- rhythm

interface Sentence {
  text: string;
  /** whitespace that follows the sentence (may be '' for the last one) */
  sep: string;
}

const SENTENCE_BOUNDARY_RE = /([.!?]+["'”’)\]]*)([ \t]+)(?=["'“‘(\[]?[\p{Lu}\p{N}])/gu;
const ABBREVIATIONS = new Set([
  'mr', 'mrs', 'ms', 'dr', 'prof', 'sr', 'jr', 'vs', 'st', 'no', 'fig', 'inc', 'ltd', 'co', 'cf', 'approx', 'dept', 'e.g', 'i.e',
]);
const SAFE_TO_LOWERCASE = new Set([
  'The', 'A', 'An', 'It', 'This', 'That', 'These', 'Those', 'There', 'Then', 'We', 'They', 'He', 'She', 'You', 'His', 'Her',
  'Its', 'Our', 'Their', 'In', 'On', 'At', 'For', 'As', 'With', 'Some', 'Many', 'Each', 'Every', 'Most', 'Both', 'All', 'Here',
]);
const SPLIT_POINT_RE = /,[ \t]+(?:and|but|so(?![ \t]+that\b)|yet)[ \t]+|;[ \t]+/giu;

function countWords(text: string): number {
  let n = 0;
  for (const w of text.split(/\s+/)) if (/[\p{L}\p{N}]/u.test(w)) n++;
  return n;
}

function endsWithAbbreviation(sentence: string): boolean {
  const m = /(\S+)$/.exec(sentence);
  if (!m) return false;
  const token = (m[1] as string).replace(/\.+$/, '').replace(/^[("'“‘[]+/, '').toLowerCase();
  if (ABBREVIATIONS.has(token)) return true;
  return /^\p{L}$/u.test(token) && token !== 'i' && token !== 'a';
}

/** Lossless: `sentences.map(s => s.text + s.sep).join('') === body`. */
function splitSentences(body: string): Sentence[] {
  const out: Sentence[] = [];
  let last = 0;
  for (const m of body.matchAll(SENTENCE_BOUNDARY_RE)) {
    const end = (m.index as number) + (m[1] as string).length;
    const text = body.slice(last, end);
    if (m[1] === '.' && endsWithAbbreviation(text)) continue;
    out.push({ text, sep: m[2] as string });
    last = end + (m[2] as string).length;
  }
  const rest = body.slice(last);
  const trimmed = rest.replace(/[ \t\r]+$/, '');
  out.push({ text: trimmed, sep: rest.slice(trimmed.length) });
  return out;
}

/** Inclusive [start,end] index pairs of runs of >= runMin consecutive sentences all within +-tolerance of the run mean. */
function findRuns(words: readonly number[], runMin: number, tolerance: number): [number, number][] {
  const runs: [number, number][] = [];
  let i = 0;
  while (i < words.length) {
    let sum = 0;
    let mn = Infinity;
    let mx = -Infinity;
    let best = -1;
    for (let j = i; j < words.length; j++) {
      const w = words[j] as number;
      if (w === 0) break;
      sum += w;
      mn = Math.min(mn, w);
      mx = Math.max(mx, w);
      const mean = sum / (j - i + 1);
      if (mn >= mean * (1 - tolerance) && mx <= mean * (1 + tolerance)) best = j;
      else break;
    }
    if (best - i + 1 >= runMin) {
      runs.push([i, best]);
      i = best + 1;
    } else {
      i++;
    }
  }
  return runs;
}

/** Split one long sentence at the clause break nearest its middle. Null when no safe break exists. */
function splitSentence(s: Sentence, minWords: number): Sentence[] | null {
  if (countWords(s.text) < minWords) return null;
  let best: { left: string; right: string; dist: number } | null = null;
  for (const m of s.text.matchAll(SPLIT_POINT_RE)) {
    const idx = m.index as number;
    const left = s.text.slice(0, idx);
    const right = s.text.slice(idx + 1).trimStart();
    const isAnd = /^,[ \t]+and/i.test(m[0]);
    const lw = countWords(left);
    const rw = countWords(right);
    if (lw < (isAnd ? 4 : 3) || rw < (isAnd ? 5 : 3)) continue; // "A, B, and C" is a list, not two clauses
    const dist = Math.abs(idx - s.text.length / 2);
    if (best === null || dist < best.dist) best = { left, right, dist };
  }
  if (best === null) return null;
  return [
    { text: `${best.left}.`, sep: ' ' },
    { text: capitalizeFirst(best.right), sep: s.sep },
  ];
}

/** Join two short sentences with a semicolon; only when the second can be safely lower-cased. */
function mergeSentences(a: Sentence, b: Sentence): Sentence | null {
  if (!a.text.endsWith('.') || a.text.endsWith('..') || endsWithAbbreviation(a.text)) return null;
  const firstWord = /^[\p{L}']+/u.exec(b.text)?.[0];
  if (firstWord === undefined || !SAFE_TO_LOWERCASE.has(firstWord)) return null;
  return { text: `${a.text.slice(0, -1)}; ${lowerFirst(b.text)}`, sep: b.sep };
}

interface RhythmOutcome {
  text: string;
  runs: number;
  edits: number;
}

function rhythmBody(body: string, profile: StylometricProfile, rs: RhythmSettings): RhythmOutcome {
  const sentences = splitSentences(body);
  if (sentences.length < rs.runMin) return { text: body, runs: 0, edits: 0 };
  const words = sentences.map((s) => countWords(s.text));
  const runs = findRuns(words, rs.runMin, rs.tolerance);
  if (runs.length === 0) return { text: body, runs: 0, edits: 0 };

  const replacement: (Sentence[] | undefined)[] = new Array<Sentence[] | undefined>(sentences.length).fill(undefined);
  const consumed = new Set<number>();
  let edits = 0;
  for (const [r0, r1] of runs) {
    let sum = 0;
    for (let k = r0; k <= r1; k++) sum += words[k] as number;
    const longRun = sum / (r1 - r0 + 1) > profile.avgSentenceLength;
    for (let p = r0 + 1; p <= r1; p += 2) {
      if (longRun) {
        const parts = splitSentence(sentences[p] as Sentence, rs.minSplitWords);
        if (parts) {
          replacement[p] = parts;
          edits++;
        }
      } else if (p + 1 <= r1) {
        const merged = mergeSentences(sentences[p] as Sentence, sentences[p + 1] as Sentence);
        if (merged) {
          replacement[p] = [merged];
          consumed.add(p + 1);
          edits++;
        }
      }
    }
  }
  if (edits === 0) return { text: body, runs: runs.length, edits: 0 };
  let text = '';
  sentences.forEach((s, idx) => {
    if (consumed.has(idx)) return;
    for (const part of replacement[idx] ?? [s]) text += part.text + part.sep;
  });
  return { text, runs: runs.length, edits };
}

const NON_PROSE_LINE_RE = /^(?:[-*+][ \t]|\d{1,3}[.)][ \t]|#{1,6}[ \t]|\||>|(?:-{3,}|\*{3,}|_{3,}|={3,})[ \t]*$)/;

function rhythmSegment(text: string, profile: StylometricProfile, rs: RhythmSettings): RhythmOutcome {
  const lines = text.split('\n');
  let runs = 0;
  let edits = 0;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] as string;
    const lead = /^[ \t]*/.exec(line)?.[0] ?? '';
    const body = line.slice(lead.length);
    if (body.trim() === '' || NON_PROSE_LINE_RE.test(body)) continue;
    const r = rhythmBody(body, profile, rs);
    runs += r.runs;
    edits += r.edits;
    if (r.edits > 0) lines[i] = lead + r.text;
  }
  return { text: edits > 0 ? lines.join('\n') : text, runs, edits };
}

// ---------------------------------------------------------------- the filter

export class StyleFilter implements Filter {
  readonly name = 'style';
  readonly stages: readonly Stage[] = ['post'];
  readonly onError: OnError;

  private readonly entries: readonly { phrase: string; replacement?: string }[];
  private readonly base: CompiledPhrases;
  private readonly rhythm: RhythmSettings;

  constructor(options: StyleOptions) {
    this.onError = options.onError ?? 'skip';
    const entries: { phrase: string; replacement?: string }[] = [];
    const seen = new Map<string, string | undefined>();
    for (const e of options.phrases) {
      const phrase = cleanPhrase(e?.pattern);
      if (phrase === null) {
        throw new ConfigError(`style phrase ${JSON.stringify(e?.pattern)} must contain at least one letter or digit`);
      }
      if (e.replacement !== undefined && typeof e.replacement !== 'string') {
        throw new ConfigError(`style phrase "${phrase}": replacement must be a string`);
      }
      const key = normKey(phrase.replace(/\s+/g, ' '));
      if (seen.has(key)) {
        if (seen.get(key) !== e.replacement) throw new ConfigError(`style phrase "${phrase}" is listed twice with different replacements`);
        continue;
      }
      seen.set(key, e.replacement);
      entries.push(e.replacement === undefined ? { phrase } : { phrase, replacement: e.replacement });
    }
    this.entries = entries;
    this.base = compilePhrases(entries);
    this.rhythm = { ...DEFAULT_RHYTHM, ...options.rhythm };
  }

  private phrasesFor(ctx: PipelineContext): CompiledPhrases {
    const extras = ctx.extraBannedPhrases;
    if (!Array.isArray(extras) || extras.length === 0) return this.base;
    const extra: { phrase: string }[] = [];
    for (const raw of extras as readonly unknown[]) {
      const phrase = cleanPhrase(raw);
      if (phrase !== null) extra.push({ phrase });
    }
    if (extra.length === 0) return this.base;
    return compilePhrases([...this.entries, ...extra]); // base entries first: on a duplicate the configured action wins
  }

  async process(text: string, ctx: PipelineContext): Promise<FilterResult> {
    const phrases = this.phrasesFor(ctx);
    const profile = ctx.profile;
    const usable =
      profile !== undefined &&
      Number.isFinite(profile.avgSentenceLength) &&
      profile.avgSentenceLength > 0 &&
      Number.isFinite(profile.sentenceLengthStdDev) &&
      profile.sentenceLengthStdDev >= 0;
    let rhythmMode: 'skipped' | 'natural' | 'applied' = 'skipped';
    if (usable) {
      rhythmMode = profile.sentenceLengthStdDev / profile.avgSentenceLength <= this.rhythm.tolerance ? 'natural' : 'applied';
    }

    const segments = splitProtected(text);
    let removed = 0;
    let replaced = 0;
    let runs = 0;
    let edits = 0;
    let startsSentence = true;
    const out = segments.map((seg, idx) => {
      if (seg.protected) {
        startsSentence = seg.text.endsWith('\n');
        return seg;
      }
      let t = seg.text;
      const r = applyPhrases(t, phrases, startsSentence, idx === segments.length - 1);
      t = r.text;
      removed += r.removed;
      replaced += r.replaced;
      if (rhythmMode === 'applied' && usable) {
        const rr = rhythmSegment(t, profile, this.rhythm);
        t = rr.text;
        runs += rr.runs;
        edits += rr.edits;
      }
      startsSentence = false;
      return { protected: false, text: t };
    });

    const content = join(out);
    const metadata: FilterResult['metadata'] = { phrases_removed: removed, phrases_replaced: replaced, rhythm: rhythmMode };
    if (rhythmMode === 'applied') {
      metadata.rhythm_runs = runs;
      metadata.rhythm_edits = edits;
    }
    return { content, modified: content !== text, metadata };
  }
}
