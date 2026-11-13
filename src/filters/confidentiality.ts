// Confidentiality filter (CNF-01..05): typed, deterministic, idempotent redaction of secrets and blocklisted terms.
//
// Design decisions (see also .planning/phases/02-filters/02-01-SUMMARY.md):
//  * DETECTION runs on a normalized copy of the text (NFKC + invisible characters stripped) so that evasion by
//    `AK<ZWSP>IA...` or full-width letters does not work, but REDACTION is applied to the ORIGINAL text through an
//    index map: text outside a redacted span is returned byte for byte (ligatures, NBSP, emoji variation selectors,
//    ZWJ/ZWNJ, ... are untouched). A redacted span covers every original character that produced a matched normalized
//    character, including the invisible ones hidden inside it.
//  * Every rule is collected as a [start,end) span over the normalized text; overlapping spans are UNIONED (never
//    partially redacted), so a blocklist term inside a PEM block or `Acme` vs `Acme Corp` leave no remnant.
//  * Placeholders already present in the input are a pseudo-rule: a group made only of placeholders is left as is, and
//    redaction repeats until the text stops changing, which is what makes f(f(x)) == f(x) hold by construction.
//  * No global (`g`) regex is ever used with `.test()`/`.exec()`: all scanning goes through `String.prototype.matchAll`,
//    which works on a clone, so the stored regexes keep `lastIndex === 0` forever (PROJECT.md defect 3).
//  * Built-in patterns are linear (bounded repeats, boundary look-behinds on unbounded ones). Custom rules are
//    validated at construction (no nested/ambiguous repetition, no unbounded quantifier, no backreferences, no empty
//    match, no match longer than CUSTOM_MAX_MATCH, length cap) and are applied to bounded windows of the text, which
//    caps their worst case without ever missing a match.
import { ConfigError } from '../models/errors.js';
import type { Filter, FilterResult, OnError, PipelineContext, Stage } from '../models/types.js';

export interface CustomRule {
  /** Becomes the placeholder type: `[REDACTED:<name>]`. Lowercase letters, digits, underscore. */
  name: string;
  /**
   * Regex source (no delimiters). Compiled with the `u` flag. Must be able to match at most 512 characters: unbounded
   * quantifiers (`+`, `*`, `{n,}`) are rejected, use a bounded repeat such as `{1,64}`. Look-behind/look-ahead see at
   * most 64 characters of context. See assertSafePattern for the ReDoS budget.
   */
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
/**
 * ReDoS budget for custom rules. A "variable" quantifier is one whose count can differ (`+ * ? {n,m}`); fixed counts
 * (`{8}`) cannot backtrack. A variable quantifier with a max above SMALL_REPEAT_MAX (or no max) is "large"; a rule may
 * have at most MAX_LARGE_QUANTIFIERS of them. Chained large quantifiers are the polynomial blow-up (`a{1,500}` x4 is
 * O(n^4); even `a+a+b` costs ~0.2 s per 1 KiB window). On top of that, the product of every variable quantifier's
 * choice count (large counts as LARGE_QUANTIFIER_COST, a small one as max-min+1) may not exceed MAX_VARIABLE_COST.
 */
const SMALL_REPEAT_MAX = 16;
const MAX_LARGE_QUANTIFIERS = 1;
const LARGE_QUANTIFIER_COST = 64;
const MAX_VARIABLE_COST = 256;
/**
 * Longest match a custom rule may produce (UTF-16 units). Enforced at construction from the pattern itself: a pattern
 * with an unbounded quantifier, or whose longest possible match exceeds this, is rejected, so a custom secret can never
 * be longer than what the windowed scan below is guaranteed to see.
 */
const CUSTOM_MAX_MATCH = 512;
/**
 * Custom rules scan the text window by window, which bounds the cost of a backtracking pattern to the window size.
 * Match STARTS in [from, from + CUSTOM_STEP) belong to a window; the window slice also carries CUSTOM_CONTEXT units of
 * real text on each side of that range (look-behind / look-ahead / `\b` see them; `^` only matches at the true start
 * of the text; matches that start in the left context are discarded and found by the previous window).
 * Look-around reaches at most CUSTOM_CONTEXT units beyond the match.
 */
const CUSTOM_STEP = 512;
const CUSTOM_CONTEXT = 64;
/** Backstop for the redact() fixed-point loop; real inputs converge in 2 passes. */
const MAX_PASSES = 8;
const CUSTOM_NAME_RE = /^[a-z][a-z0-9_]{0,31}$/;

// Characters that render as nothing (or reorder text) and are used to split a secret so that a pattern misses it.
const INVISIBLE_RE =
  /[\u00ad\u034f\u061c\u115f\u1160\u17b4\u17b5\u180b-\u180f\u200b-\u200f\u202a-\u202e\u2060-\u206f\u3164\ufe00-\ufe0f\ufeff\uffa0\ufff9-\ufffb\u{e0000}-\u{e007f}\u{e0100}-\u{e01ef}]/gu;
// eslint-disable-next-line no-control-regex
const ASCII_ONLY_RE = /^[\u0000-\u007f]*$/;

/**
 * Code points that attach to the previous one when normalizing: combining marks, conjoining Hangul jamo and the
 * invisible characters (which are stripped). Normalizing segment by segment, with a boundary before every other code
 * point, gives the same result as normalizing the whole string for everything that matters to detection while keeping a
 * map back to the original indices.
 */
const CONTINUATION_RE = /^[\p{M}ᄀ-ᇿꥠ-꥿ힰ-퟿]$/u;
const INVISIBLE_ONE_RE = new RegExp(`^${INVISIBLE_RE.source}$`, 'u');

interface Normalized {
  norm: string;
  /** For each UTF-16 index of `norm`, the original [start, end) of the segment it came from; null = identity map. */
  starts: number[] | null;
  ends: number[] | null;
}

function normalizeSegment(raw: string): string {
  return raw.replace(INVISIBLE_RE, '').normalize('NFKC').replace(INVISIBLE_RE, '');
}

/** NFKC + strip invisibles, segment by segment, remembering where every normalized character came from. */
function normalizeWithMap(text: string): Normalized {
  if (ASCII_ONLY_RE.test(text)) return { norm: text, starts: null, ends: null };
  const parts: string[] = [];
  const starts: number[] = [];
  const ends: number[] = [];
  let segStart = 0;
  const flush = (segEnd: number): void => {
    if (segEnd <= segStart) return;
    const n = normalizeSegment(text.slice(segStart, segEnd));
    parts.push(n);
    for (let k = 0; k < n.length; k++) {
      starts.push(segStart);
      ends.push(segEnd);
    }
    segStart = segEnd;
  };
  let i = 0;
  while (i < text.length) {
    const cp = text.codePointAt(i) as number;
    const ch = String.fromCodePoint(cp);
    if (i > segStart && !(CONTINUATION_RE.test(ch) || INVISIBLE_ONE_RE.test(ch))) flush(i);
    i += ch.length;
  }
  flush(text.length);
  return { norm: parts.join(''), starts, ends };
}

/** NFKC + strip invisibles, in an order that is stable under repetition (idempotent). */
export function normalizeForMatching(text: string): string {
  return normalizeWithMap(text).norm;
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
/**
 * A secret's value: quoted (any length up to a line, the closing quote is optional so an unterminated quote still
 * redacts to the end of the line instead of leaking) or bare. A bare value runs to whitespace, a quote or `&`; it may
 * contain `,` and `;` because passwords do (`password=abc,def`).
 */
const QUOTED_VALUE_MAX = 65_536;
const VALUE_QUOTED_OR_BARE = `(?:"([^"\\n]{1,${QUOTED_VALUE_MAX}})"?|'([^'\\n]{1,${QUOTED_VALUE_MAX}})'?|([^\\s"'&]{4,}))`;

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
    // user:password up to the LAST `@` of the authority (a password may contain `@` or `/`): the lazy password stops
    // at the first `@` that is followed by a host and then `/ ? # :` or the end.
    rx: /(?<=[A-Za-z][A-Za-z0-9+.-]{1,15}:\/\/)([^\s/@:]{1,128}:[^\s?#]{1,1024}?)(?=@[^@\s/?#]{0,255}(?:[/?#:\s]|$))/gud,
    valueGroups: [1],
  },
  {
    type: 'secret_assignment',
    rx: new RegExp(
      `(?:(?:password|passwd|pwd|secret|api[_-]?key|apikey|private[_-]?key|credentials?)[A-Za-z0-9_.-]{0,30}|token)["']?[ \\t]{0,5}[:=]\\s{0,40}${VALUE_QUOTED_OR_BARE}`,
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
 * Reject patterns that can blow up the backtracking engine or that can match more than the windowed scan can see.
 * Conservative on purpose: a legitimate token pattern (`EMP-\d{6}`, `[A-Z]{3}-[0-9a-f]{8}`, `internal-\d{1,32}`) passes;
 * ambiguous repetition, unbounded quantifiers and matches longer than CUSTOM_MAX_MATCH do not.
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
    /** longest completed alternative so far, and the length of the one being parsed (UTF-16 units) */
    maxAlt: number;
    cur: number;
    zeroWidth: boolean;
  }
  const frame = (zeroWidth = false): Group => ({ hasAlt: false, hasQuant: false, maxAlt: 0, cur: 0, zeroWidth });
  const stack: Group[] = [frame()];
  const top = (): Group => stack[stack.length - 1] as Group;

  interface Quant {
    next: number;
    min: number;
    max: number;
  }
  let largeCount = 0;
  let cost = 1;
  /** Charge a quantifier against the ReDoS budget. */
  const charge = (q: Quant): void => {
    if (q.max === Infinity) {
      fail('unbounded quantifiers (+, *, {n,}) are not allowed; use a bounded repeat such as {1,64}');
    }
    if (q.max <= q.min) return; // fixed count: no choice, no backtracking
    const large = q.max > SMALL_REPEAT_MAX;
    if (large && ++largeCount > MAX_LARGE_QUANTIFIERS) {
      fail(`more than ${MAX_LARGE_QUANTIFIERS} large (max > ${SMALL_REPEAT_MAX}) quantifier`);
    }
    cost *= large ? LARGE_QUANTIFIER_COST : q.max - q.min + 1;
    if (cost > MAX_VARIABLE_COST) fail('quantifiers are too ambiguous together (backtracking budget exceeded)');
  };

  /** Parse a quantifier at `i`; null if none. */
  const quantifierAt = (i: number): Quant | null => {
    const ch = pattern[i];
    let next: number;
    let min: number;
    let max: number;
    if (ch === '*' || ch === '+') {
      next = i + 1;
      min = ch === '*' ? 0 : 1;
      max = Infinity;
    } else if (ch === '?') {
      next = i + 1;
      min = 0;
      max = 1;
    } else if (ch === '{') {
      const m = /^\{(\d+)(?:(,)(\d*))?\}/.exec(pattern.slice(i, i + 24));
      if (!m) return null;
      min = Number(m[1]);
      max = m[2] === undefined ? min : m[3] === '' ? Infinity : Number(m[3]);
      next = i + m[0].length;
    } else {
      return null;
    }
    if (pattern[next] === '?') next++; // lazy suffix
    return { next, min, max };
  };

  /** An atom of `width` UTF-16 units ends at `at`; applies a following quantifier and returns the next index. */
  const atom = (width: number, at: number): number => {
    const q = quantifierAt(at);
    let len = width;
    let next = at;
    if (q) {
      top().hasQuant = true;
      charge(q);
      next = q.next;
      len = width * q.max; // q.max is finite here (charge rejects Infinity)
    }
    top().cur += len;
    return next;
  };

  for (let i = 0; i < pattern.length; ) {
    const ch = pattern[i] as string;
    if (ch === '\\') {
      const nx = pattern[i + 1];
      if (nx !== undefined && /[1-9]/.test(nx)) fail('backreferences are not allowed');
      if (nx === 'k') fail('named backreferences are not allowed');
      if (nx === 'b' || nx === 'B') {
        i += 2; // zero-width assertion
        continue;
      }
      let end = i + 2;
      let width = 1;
      if ((nx === 'p' || nx === 'P' || nx === 'u') && pattern[end] === '{') {
        const close = pattern.indexOf('}', end);
        end = close === -1 ? pattern.length : close + 1;
        width = 2; // may be an astral code point
      } else if (nx === 'u' && /^[0-9a-fA-F]{4}/.test(pattern.slice(end, end + 4))) {
        end += 4;
        width = 2; // may be half of an astral pair
      } else if (nx === 'x' && /^[0-9a-fA-F]{2}/.test(pattern.slice(end, end + 2))) {
        end += 2;
      } else if (nx === 'c' && /[A-Za-z]/.test(pattern[end] ?? '')) {
        end += 1;
      } else if (nx === 'D' || nx === 'W' || nx === 'S') {
        width = 2; // negated classes can match an astral code point
      }
      i = atom(width, end);
      continue;
    }
    if (ch === '[') {
      let j = i + 1;
      if (pattern[j] === '^') j++;
      if (pattern[j] === ']') j++;
      while (j < pattern.length && pattern[j] !== ']') j += pattern[j] === '\\' ? 2 : 1;
      const inner = pattern.slice(i + 1, j);
      const wide = inner.startsWith('^') || /[^\u0000-\u007f]|\\[pPDWS]|\\u/.test(inner);
      i = atom(wide ? 2 : 1, j + 1);
      continue;
    }
    if (ch === '(') {
      i++;
      let zeroWidth = false;
      if (pattern[i] === '?') {
        i++;
        if (pattern[i] === '<' && pattern[i + 1] !== '=' && pattern[i + 1] !== '!') {
          const close = pattern.indexOf('>', i);
          i = close === -1 ? pattern.length : close + 1;
        } else {
          zeroWidth = pattern[i] === '=' || pattern[i] === '!' || (pattern[i] === '<' && (pattern[i + 1] === '=' || pattern[i + 1] === '!'));
          i += pattern[i] === '<' ? 2 : 1; // `:` `=` `!` or `<=` `<!`
        }
      }
      stack.push(frame(zeroWidth));
      continue;
    }
    if (ch === ')') {
      if (stack.length === 1) fail('unbalanced parenthesis');
      const g = stack.pop() as Group;
      i++;
      const inner = g.zeroWidth ? 0 : Math.max(g.maxAlt, g.cur);
      const q = quantifierAt(i);
      let len = inner;
      if (q) {
        if (q.max > 1 && (g.hasAlt || g.hasQuant)) fail('a repeated group may not contain alternation or another quantifier');
        charge(q);
        i = q.next;
        top().hasQuant = true;
        len = inner * q.max;
      }
      top().cur += len;
      top().hasAlt = top().hasAlt || g.hasAlt;
      top().hasQuant = top().hasQuant || g.hasQuant;
      continue;
    }
    if (ch === '|') {
      const t = top();
      t.hasAlt = true;
      t.maxAlt = Math.max(t.maxAlt, t.cur);
      t.cur = 0;
      i++;
      continue;
    }
    if (ch === '^' || ch === '$') {
      i++; // zero-width anchor (never quantifiable)
      continue;
    }
    const code = ch.charCodeAt(0);
    const pair = code >= 0xd800 && code <= 0xdbff && /[\udc00-\udfff]/.test(pattern[i + 1] ?? '');
    i = atom(ch === '.' || pair ? 2 : 1, i + (pair ? 2 : 1));
  }
  if (stack.length !== 1) fail('unbalanced parenthesis');
  const longest = Math.max(top().maxAlt, top().cur);
  if (longest > CUSTOM_MAX_MATCH) {
    fail(`pattern can match up to ${longest} characters; the limit is ${CUSTOM_MAX_MATCH}`);
  }
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
   * Pure, synchronous core. Returns the redacted text plus per-type redaction counts. Text outside a redacted span is
   * returned unchanged; detection (not output) uses the normalized form.
   *
   * Redaction is iterated to a fixed point: replacing a secret with a placeholder can change where a contextual rule
   * (`token: <value>`) sees a value end, so a single pass is not always stable. Each changing pass removes at least one
   * non-placeholder character, so this terminates; the cap is a backstop that fails closed instead of looping.
   * `redact(redact(x).text).text === redact(x).text` therefore holds by construction (CNF-05).
   */
  redact(text: string): { text: string; counts: Record<string, number> } {
    if (typeof text !== 'string') throw new TypeError('confidentiality: input must be a string');
    let current = text;
    const totals = new Map<string, number>();
    for (let pass = 0; pass < MAX_PASSES; pass++) {
      const r = this.pass(current);
      if (r.text === current) return { text: current, counts: Object.fromEntries(totals) };
      for (const [type, n] of Object.entries(r.counts)) totals.set(type, (totals.get(type) ?? 0) + n);
      current = r.text;
    }
    throw new Error('confidentiality: redaction did not reach a fixed point');
  }

  /** One redaction pass: detect on the normalized text, replace the matching spans of the original text. */
  private pass(orig: string): { text: string; counts: Record<string, number> } {
    const { norm, starts, ends } = normalizeWithMap(orig);
    const spans: Span[] = [];
    const hasPlaceholder = norm.includes(PLACEHOLDER_PREFIX);

    this.rules.forEach((rule, prio) => {
      if (prio === 0 && !hasPlaceholder) return;
      if (rule.windowed && norm.length > CUSTOM_STEP + CUSTOM_MAX_MATCH) {
        for (let from = 0; from < norm.length; from += CUSTOM_STEP) {
          const ws = Math.max(0, from - CUSTOM_CONTEXT);
          const we = from + CUSTOM_STEP + CUSTOM_MAX_MATCH + CUSTOM_CONTEXT;
          this.collect(rule, prio, norm.slice(ws, we), ws, spans, [from, from + CUSTOM_STEP]);
        }
      } else {
        this.collect(rule, prio, norm, 0, spans);
      }
    });

    if (spans.length === 0) return { text: orig, counts: {} };

    // normalized [start,end) -> original [start,end): the whole segment a normalized character came from
    const origStart = (n: number): number => (starts === null ? n : (starts[n] as number));
    const origEnd = (n: number): number => (ends === null ? n : (ends[n - 1] as number));

    spans.sort((a, b) => a.start - b.start || b.end - a.end || a.prio - b.prio);
    const counts = new Map<string, number>();
    const out: string[] = [];
    let pos = 0; // position in the ORIGINAL text
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
      i = j;
      // Two groups can touch the same original segment (e.g. a ligature); the part already consumed is not redone.
      const os = Math.max(pos, origStart(first.start));
      const oe = origEnd(end);
      if (oe <= os) continue;
      out.push(orig.slice(pos, os));
      if (coveredTo === end) {
        // The group is nothing but existing placeholder(s) (other rules matched inside or across them): leave it.
        out.push(orig.slice(os, oe));
      } else {
        const type = (label ?? first).type;
        out.push(`${PLACEHOLDER_PREFIX}${type}]`);
        counts.set(type, (counts.get(type) ?? 0) + 1);
      }
      pos = oe;
    }
    out.push(orig.slice(pos));
    return { text: out.join(''), counts: Object.fromEntries(counts) };
  }

  /** `startRange` keeps only matches whose absolute start is in [lo, hi): the rest belong to a neighbouring window. */
  private collect(rule: Rule, prio: number, hay: string, offset: number, spans: Span[], startRange?: [number, number]): void {
    for (const m of hay.matchAll(rule.rx)) {
      if (startRange !== undefined && (m.index + offset < startRange[0] || m.index + offset >= startRange[1])) continue;
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
