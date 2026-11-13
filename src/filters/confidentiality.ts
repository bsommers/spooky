// Confidentiality filter (CNF-01..05): typed, deterministic, idempotent redaction of secrets and blocklisted terms.
//
// Design decisions (see also .planning/phases/02-filters/02-01-SUMMARY.md):
//  * Redaction is applied to the NORMALIZED text (NFKC + invisible characters stripped), not mapped back onto the
//    original. The output therefore has compatibility characters folded (e.g. U+FB01 -> "fi", full-width -> ASCII) and
//    invisible characters removed. This keeps evasion by `AK<ZWSP>IA...` or full-width letters from working, and is
//    what makes the filter idempotent.
//  * Every rule is collected as a [start,end) span over the normalized text; overlapping spans are UNIONED (never
//    partially redacted), so a blocklist term inside a PEM block or `Acme` vs `Acme Corp` leave no remnant.
//  * Placeholders already present in the input are a pseudo-rule that wins ties, which is what makes f(f(x)) == f(x).
//  * No regex is ever used with `.test()`/`.exec()`: all scanning goes through `String.prototype.matchAll`, which
//    works on a clone, so the stored regexes keep `lastIndex === 0` forever (PROJECT.md defect 3).
//  * Built-in patterns are linear (bounded repeats, boundary look-behinds on unbounded ones). Custom rules are
//    validated at construction (no nested/ambiguous repetition, no backreferences, no empty match, length cap) and
//    are applied to bounded windows of the text, which caps their worst case.
import { ConfigError } from '../models/errors.js';
import type { Filter, FilterResult, OnError, PipelineContext, Stage } from '../models/types.js';

export interface CustomRule {
  /** Becomes the placeholder type: `[REDACTED:<name>]`. Lowercase letters, digits, underscore. */
  name: string;
  /** Regex source (no delimiters). Compiled with the `u` flag. */
  pattern: string;
  caseInsensitive?: boolean;
}

export interface ConfidentialityOptions {
  /** Literal terms to redact (never interpreted as regex). */
  blocklist?: readonly string[];
  /** Applies to the blocklist only. Default false. */
  caseInsensitive?: boolean;
  customRules?: readonly CustomRule[];
}

export const PLACEHOLDER_PREFIX = '[REDACTED:';
/** A redaction placeholder, e.g. `[REDACTED:aws_key]`. */
const PLACEHOLDER_RE = /\[REDACTED:[a-z0-9_]{1,40}\]/g;

const MAX_CUSTOM_PATTERN_LENGTH = 256;
const MAX_UNBOUNDED_QUANTIFIERS = 2;
/**
 * Custom rules scan the text in windows of this many UTF-16 units, advancing by half a window, which bounds a
 * quadratic-prone pattern to O(window^2) per window. Consequence: a custom-rule match is only guaranteed to be
 * found when it is at most CUSTOM_STEP (512) characters long; built-in rules are not windowed.
 */
const CUSTOM_WINDOW = 1024;
const CUSTOM_STEP = 512;
/** Backstop for the redact() fixed-point loop; real inputs converge in 2 passes. */
const MAX_PASSES = 8;
const CUSTOM_NAME_RE = /^[a-z][a-z0-9_]{0,31}$/;

// Characters that render as nothing (or reorder text) and are used to split a secret so that a pattern misses it.
const INVISIBLE_RE =
  /[\u00ad\u034f\u061c\u115f\u1160\u17b4\u17b5\u180b-\u180f\u200b-\u200f\u202a-\u202e\u2060-\u206f\u3164\ufe00-\ufe0f\ufeff\uffa0\ufff9-\ufffb\u{e0000}-\u{e007f}\u{e0100}-\u{e01ef}]/gu;
// eslint-disable-next-line no-control-regex
const ASCII_ONLY_RE = /^[\u0000-\u007f]*$/;

/** NFKC + strip invisibles, in an order that is stable under repetition (idempotent). */
export function normalizeForMatching(text: string): string {
  if (ASCII_ONLY_RE.test(text)) return text;
  return text.replace(INVISIBLE_RE, '').normalize('NFKC').replace(INVISIBLE_RE, '');
}

interface Rule {
  type: string;
  rx: RegExp;
  /** When set, only the first defined capture group among these is redacted (keeps `name=` / `user:`). */
  valueGroups?: readonly number[];
  /** Custom rules are applied window by window. */
  windowed?: boolean;
}

const B = '(?<![A-Za-z0-9])';
const VALUE_QUOTED_OR_BARE = `(?:"([^"\\n]{1,256})"|'([^'\\n]{1,256})'|([^\\s"',;&]{4,}))`;

/** Built-in rules, in tie-break priority order (earlier wins when two rules cover exactly the same span). */
const BUILTIN_RULES: readonly Rule[] = [
  {
    type: 'private_key',
    // header .. footer; a header with no footer (truncated paste) redacts to the end of the text.
    rx: /-----BEGIN (?:[A-Z0-9]{1,20} ){0,4}PRIVATE KEY(?: BLOCK)?-----(?:[\s\S]*?-----END (?:[A-Z0-9]{1,20} ){0,4}PRIVATE KEY(?: BLOCK)?-----|[\s\S]*)/gu,
  },
  { type: 'aws_key', rx: /(?:AKIA|ASIA|AGPA|AIDA|AIPA|ANPA|ANVA|AROA)[A-Z0-9]{16}/gu },
  {
    type: 'github_token',
    rx: /(?:gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{22,})/gu, // distinctive prefix: no left boundary, so `x<ZWSP>ghp_...` is still caught
  },
  { type: 'api_key', rx: new RegExp(`${B}sk-[A-Za-z0-9_-]{20,}`, 'gu') },
  { type: 'slack_token', rx: /(?:xox[abprs]|xapp)-[A-Za-z0-9-]{10,}/gu },
  { type: 'jwt', rx: /(?<![A-Za-z0-9_-])eyJ[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]*/gu },
  { type: 'bearer_token', rx: new RegExp(`${B}bearer[ \\t]{1,20}[A-Za-z0-9._~+/=-]{6,}`, 'giu') },
];

/** Contextual rules: they redact the VALUE and keep the name, so the surrounding structure stays readable. */
const CONTEXT_RULES: readonly Rule[] = [
  {
    type: 'url_credential',
    rx: /(?<=[?&;#])(?:access_token|id_token|refresh_token|auth_token|api_key|apikey|api-key|token|key|secret|client_secret|password|passwd|pwd|signature|sig|auth)=([^&\s"'<>#]+)/giud,
    valueGroups: [1],
  },
  {
    type: 'url_credential',
    rx: /(?<=[A-Za-z][A-Za-z0-9+.-]{1,15}:\/\/)([^\s/@:]{1,128}:[^\s/@]{1,256})(?=@)/gud,
    valueGroups: [1],
  },
  {
    type: 'secret_assignment',
    rx: new RegExp(
      `(?:(?:password|passwd|pwd|secret|api[_-]?key|apikey|private[_-]?key|credentials?)[A-Za-z0-9_.-]{0,30}|token)["']?[ \\t]{0,5}[:=][ \\t]{0,5}${VALUE_QUOTED_OR_BARE}`,
      'giud',
    ),
    valueGroups: [1, 2, 3],
  },
];

const RESERVED_TYPES = new Set<string>([...BUILTIN_RULES, ...CONTEXT_RULES].map((r) => r.type).concat('blocklist'));

interface Span {
  start: number;
  end: number;
  /** index into the rule table; 0 is the existing-placeholder pseudo-rule */
  prio: number;
  type: string;
}

function escapeLiteral(term: string): string {
  return term.replace(/[\\^$.*+?()[\]{}|/]/g, '\\$&');
}

/**
 * Reject patterns that can blow up the backtracking engine. Conservative on purpose: a legitimate token pattern
 * (`EMP-\d{6}`, `[A-Z]{3}-[0-9a-f]{8}`) passes; ambiguous repetition does not.
 */
function assertSafePattern(name: string, pattern: string): void {
  const fail = (why: string): never => {
    throw new ConfigError(`custom rule "${name}": ${why}`, [{ path: `customRules.${name}.pattern`, message: why }]);
  };
  if (pattern.length === 0) fail('pattern is empty');
  if (pattern.length > MAX_CUSTOM_PATTERN_LENGTH) fail(`pattern longer than ${MAX_CUSTOM_PATTERN_LENGTH} characters`);

  interface Group {
    hasAlt: boolean;
    hasQuant: boolean;
  }
  const stack: Group[] = [{ hasAlt: false, hasQuant: false }];
  const top = (): Group => stack[stack.length - 1] as Group;
  let unbounded = 0;

  /** Parse a quantifier at `i`; returns [nextIndex, repeating, isUnbounded] or null if none. */
  const quantifierAt = (i: number): [number, boolean, boolean] | null => {
    const ch = pattern[i];
    let next: number;
    let repeating: boolean;
    let isUnbounded: boolean;
    if (ch === '*' || ch === '+') {
      next = i + 1;
      repeating = true;
      isUnbounded = true;
    } else if (ch === '?') {
      next = i + 1;
      repeating = false;
      isUnbounded = false;
    } else if (ch === '{') {
      const m = /^\{(\d+)(?:(,)(\d*))?\}/.exec(pattern.slice(i, i + 24));
      if (!m) return null;
      const min = Number(m[1]);
      const max = m[2] === undefined ? min : m[3] === '' ? Infinity : Number(m[3]);
      next = i + m[0].length;
      isUnbounded = max === Infinity;
      repeating = max > 1;
    } else {
      return null;
    }
    if (pattern[next] === '?') next++; // lazy suffix
    return [next, repeating, isUnbounded];
  };

  for (let i = 0; i < pattern.length; ) {
    const ch = pattern[i] as string;
    if (ch === '\\') {
      const nx = pattern[i + 1];
      if (nx !== undefined && /[1-9]/.test(nx)) fail('backreferences are not allowed');
      if (nx === 'k') fail('named backreferences are not allowed');
      i += 2;
      // an escaped atom may itself be quantified
      const q = quantifierAt(i);
      if (q) {
        top().hasQuant = true;
        if (q[2]) unbounded++;
        i = q[0];
      }
      continue;
    }
    if (ch === '[') {
      let j = i + 1;
      if (pattern[j] === '^') j++;
      if (pattern[j] === ']') j++;
      while (j < pattern.length && pattern[j] !== ']') j += pattern[j] === '\\' ? 2 : 1;
      i = j + 1;
      const q = quantifierAt(i);
      if (q) {
        top().hasQuant = true;
        if (q[2]) unbounded++;
        i = q[0];
      }
      continue;
    }
    if (ch === '(') {
      stack.push({ hasAlt: false, hasQuant: false });
      i++;
      if (pattern[i] === '?') {
        i++;
        if (pattern[i] === '<' && pattern[i + 1] !== '=' && pattern[i + 1] !== '!') {
          const close = pattern.indexOf('>', i);
          i = close === -1 ? pattern.length : close + 1;
        } else {
          i += pattern[i] === '<' ? 2 : 1; // `:` `=` `!` or `<=` `<!`
        }
      }
      continue;
    }
    if (ch === ')') {
      if (stack.length === 1) fail('unbalanced parenthesis');
      const g = stack.pop() as Group;
      i++;
      const q = quantifierAt(i);
      if (q) {
        if (q[1] && (g.hasAlt || g.hasQuant)) fail('a repeated group may not contain alternation or another quantifier');
        if (q[2]) unbounded++;
        i = q[0];
        top().hasQuant = true;
      }
      top().hasAlt = top().hasAlt || g.hasAlt;
      top().hasQuant = top().hasQuant || g.hasQuant;
      continue;
    }
    if (ch === '|') {
      top().hasAlt = true;
      i++;
      continue;
    }
    i++;
    const q = quantifierAt(i); // quantifier directly after this atom
    if (q) {
      top().hasQuant = true;
      if (q[2]) unbounded++;
      i = q[0];
    }
  }
  if (stack.length !== 1) fail('unbalanced parenthesis');
  if (unbounded > MAX_UNBOUNDED_QUANTIFIERS) fail(`more than ${MAX_UNBOUNDED_QUANTIFIERS} unbounded quantifiers`);
}

function compileCustom(rule: CustomRule): Rule {
  if (typeof rule?.name !== 'string' || !CUSTOM_NAME_RE.test(rule.name)) {
    throw new ConfigError(`custom rule name must match ${String(CUSTOM_NAME_RE)}`, [
      { path: 'customRules.name', message: `invalid name ${JSON.stringify(rule?.name)}` },
    ]);
  }
  if (RESERVED_TYPES.has(rule.name)) {
    throw new ConfigError(`custom rule name "${rule.name}" collides with a built-in redaction type`);
  }
  if (typeof rule.pattern !== 'string') throw new ConfigError(`custom rule "${rule.name}": pattern must be a string`);
  assertSafePattern(rule.name, rule.pattern);
  let rx: RegExp;
  try {
    rx = new RegExp(rule.pattern, rule.caseInsensitive ? 'giu' : 'gu');
  } catch (err) {
    throw new ConfigError(`custom rule "${rule.name}": invalid regular expression (${(err as Error).message})`, [
      { path: `customRules.${rule.name}.pattern`, message: 'invalid regular expression' },
    ]);
  }
  // A pattern that can match the empty string would "match" everywhere.
  for (const _ of ''.matchAll(rx)) throw new ConfigError(`custom rule "${rule.name}": pattern matches the empty string`);
  return { type: rule.name, rx, windowed: true };
}

export class ConfidentialityFilter implements Filter {
  readonly name = 'confidentiality';
  readonly stages: readonly Stage[] = ['pre', 'post'];
  /** Not configurable: a confidentiality filter that can be told to pass text through on error is a leak. */
  readonly onError: OnError = 'fail-closed';

  private readonly rules: readonly Rule[]; // index === span.prio; [0] is the placeholder pseudo-rule

  constructor(options: ConfidentialityOptions = {}) {
    const rules: Rule[] = [{ type: '__placeholder__', rx: PLACEHOLDER_RE }];
    rules.push(...BUILTIN_RULES);

    const seen = new Set<string>();
    const terms: string[] = [];
    for (const raw of options.blocklist ?? []) {
      if (typeof raw !== 'string') throw new ConfigError('blocklist entries must be strings');
      const term = normalizeForMatching(raw).trim();
      if (term === '') throw new ConfigError('blocklist entries must not be blank');
      const key = options.caseInsensitive ? term.toLowerCase() : term;
      if (!seen.has(key)) {
        seen.add(key);
        terms.push(term);
      }
    }
    if (terms.length > 0) {
      terms.sort((a, b) => b.length - a.length || (a < b ? -1 : a > b ? 1 : 0)); // longest first, then stable
      rules.push({
        type: 'blocklist',
        rx: new RegExp(terms.map(escapeLiteral).join('|'), options.caseInsensitive ? 'giu' : 'gu'),
      });
    }

    const names = new Set<string>();
    for (const cr of options.customRules ?? []) {
      const compiled = compileCustom(cr);
      if (names.has(compiled.type)) throw new ConfigError(`duplicate custom rule name "${compiled.type}"`);
      names.add(compiled.type);
      rules.push(compiled);
    }
    rules.push(...CONTEXT_RULES);
    this.rules = rules;
  }

  /**
   * Pure, synchronous core. Returns the redacted (and normalized) text plus per-type redaction counts.
   *
   * Redaction is iterated to a fixed point: replacing a secret with a placeholder can change where a contextual rule
   * (`token: <value>`) sees a value end, so a single pass is not always stable. Each changing pass removes at least one
   * non-placeholder character, so this terminates; the cap is a backstop that fails closed instead of looping.
   * `redact(redact(x).text).text === redact(x).text` therefore holds by construction (CNF-05).
   */
  redact(text: string): { text: string; counts: Record<string, number> } {
    if (typeof text !== 'string') throw new TypeError('confidentiality: input must be a string');
    let current = normalizeForMatching(text);
    const totals = new Map<string, number>();
    for (let pass = 0; pass < MAX_PASSES; pass++) {
      const r = this.pass(current);
      if (r.text === current) return { text: current, counts: Object.fromEntries(totals) };
      for (const [type, n] of Object.entries(r.counts)) totals.set(type, (totals.get(type) ?? 0) + n);
      current = r.text;
    }
    throw new Error('confidentiality: redaction did not reach a fixed point');
  }

  /** One redaction pass over already-normalized text. */
  private pass(norm: string): { text: string; counts: Record<string, number> } {
    const spans: Span[] = [];
    const hasPlaceholder = norm.includes(PLACEHOLDER_PREFIX);

    this.rules.forEach((rule, prio) => {
      if (prio === 0 && !hasPlaceholder) return;
      if (rule.windowed && norm.length > CUSTOM_WINDOW) {
        for (let from = 0; from < norm.length; from += CUSTOM_STEP) {
          this.collect(rule, prio, norm.slice(from, from + CUSTOM_WINDOW), from, spans);
          if (from + CUSTOM_WINDOW >= norm.length) break;
        }
      } else {
        this.collect(rule, prio, norm, 0, spans);
      }
    });

    if (spans.length === 0) return { text: norm, counts: {} };

    spans.sort((a, b) => a.start - b.start || b.end - a.end || a.prio - b.prio);
    const counts = new Map<string, number>();
    const out: string[] = [];
    let pos = 0;
    let i = 0;
    while (i < spans.length) {
      const first = spans[i] as Span;
      let end = first.end;
      // Label = the most specific (lowest priority number) real rule in the group, so `token: <jwt>` is a `jwt`.
      let label: Span | null = first.prio === 0 ? null : first;
      // How far existing placeholders cover the group contiguously from its start.
      let coveredTo = first.prio === 0 ? first.end : first.start;
      let j = i + 1;
      while (j < spans.length && (spans[j] as Span).start < end) {
        const s = spans[j] as Span;
        if (s.prio === 0) {
          if (s.start <= coveredTo) coveredTo = Math.max(coveredTo, s.end);
        } else if (label === null || s.prio < label.prio) {
          label = s;
        }
        end = Math.max(end, s.end);
        j++;
      }
      out.push(norm.slice(pos, first.start));
      if (coveredTo === end) {
        // The group is nothing but existing placeholder(s) (other rules matched inside or across them): leave it.
        out.push(norm.slice(first.start, end));
      } else {
        const type = (label ?? first).type;
        out.push(`${PLACEHOLDER_PREFIX}${type}]`);
        counts.set(type, (counts.get(type) ?? 0) + 1);
      }
      pos = end;
      i = j;
    }
    out.push(norm.slice(pos));
    return { text: out.join(''), counts: Object.fromEntries(counts) };
  }

  private collect(rule: Rule, prio: number, hay: string, offset: number, spans: Span[]): void {
    for (const m of hay.matchAll(rule.rx)) {
      let start = m.index;
      let end = m.index + m[0].length;
      if (rule.valueGroups !== undefined) {
        const indices = (m as RegExpMatchArray & { indices?: ([number, number] | undefined)[] }).indices;
        for (const g of rule.valueGroups) {
          const range = indices?.[g];
          if (range !== undefined) {
            [start, end] = range;
            break;
          }
        }
      }
      if (end > start) spans.push({ start: start + offset, end: end + offset, prio, type: rule.type });
    }
  }

  async process(text: string, _ctx: PipelineContext): Promise<FilterResult> {
    const { text: content, counts } = this.redact(text);
    return { content, modified: content !== text, metadata: counts };
  }
}
