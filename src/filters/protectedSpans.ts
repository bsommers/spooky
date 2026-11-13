// Protected spans (STY-04): regions of markdown text that a prose-editing filter must leave byte-identical.
//
// Protected: fenced code blocks (``` and ~~~, an unterminated fence runs to the end of the text), inline code spans,
// URLs (`scheme://...`, trailing sentence punctuation excluded) and blockquote lines (`> ...`, "quoted blocks").
// NOT protected: indented (4-space) code blocks (indistinguishable from list continuation) and inline code that
// spans a line break (an unmatched backtick stays literal text).
// Linear time: one pass over the lines, one pass over the backtick runs of each line.

export interface Segment {
  protected: boolean;
  text: string;
}

const FENCE_RE = /^ {0,3}(`{3,}|~{3,})(.*)$/;
const BLOCKQUOTE_RE = /^ {0,3}>/;
const URL_RE = /[A-Za-z][A-Za-z0-9+.-]{1,15}:\/\/[^\s<>"`]+/g;
const TRAILING_PUNCT = new Set(['.', ',', ';', ':', '!', '?', "'", '"', '*', '_']);
const CLOSERS: Readonly<Record<string, string>> = { ')': '(', ']': '[', '}': '{' };

type Range = [start: number, end: number];

/** Trim sentence punctuation and unbalanced closing brackets off the end of a URL candidate. */
function trimUrl(url: string): string {
  let end = url.length;
  while (end > 0) {
    const ch = url[end - 1] as string;
    if (TRAILING_PUNCT.has(ch)) {
      end--;
      continue;
    }
    const opener = CLOSERS[ch];
    if (opener !== undefined) {
      let open = 0;
      let close = 0;
      for (let i = 0; i < end; i++) {
        if (url[i] === opener) open++;
        else if (url[i] === ch) close++;
      }
      if (close > open) {
        end--;
        continue;
      }
    }
    break;
  }
  return url.slice(0, end);
}

/** Inline code spans and URLs inside one line `text.slice(ls, le)`; offsets are absolute. */
function inlineRanges(text: string, ls: number, le: number, out: Range[]): void {
  // Backtick runs of the line, then pair each run with the next run of exactly the same length.
  const runs: { start: number; len: number }[] = [];
  for (let i = ls; i < le; ) {
    if (text.charCodeAt(i) === 96) {
      let j = i;
      while (j < le && text.charCodeAt(j) === 96) j++;
      runs.push({ start: i, len: j - i });
      i = j;
    } else {
      i++;
    }
  }
  if (runs.length > 1) {
    const nextSame: number[] = new Array<number>(runs.length).fill(-1);
    const lastByLen = new Map<number, number>();
    for (let i = runs.length - 1; i >= 0; i--) {
      const r = runs[i] as { start: number; len: number };
      nextSame[i] = lastByLen.get(r.len) ?? -1;
      lastByLen.set(r.len, i);
    }
    for (let i = 0; i < runs.length; ) {
      const k = nextSame[i] as number;
      if (k < 0) {
        i++;
        continue;
      }
      const open = runs[i] as { start: number; len: number };
      const close = runs[k] as { start: number; len: number };
      out.push([open.start, close.start + close.len]);
      i = k + 1;
    }
  }
  if (text.indexOf('://', ls) !== -1) {
    const line = text.slice(ls, le);
    for (const m of line.matchAll(URL_RE)) {
      const url = trimUrl(m[0]);
      if (url.length > 0) out.push([ls + (m.index ?? 0), ls + (m.index ?? 0) + url.length]);
    }
  }
}

/** Split `text` into alternating protected / unprotected segments. `join(splitProtected(x)) === x` always. */
export function splitProtected(text: string): Segment[] {
  const ranges: Range[] = [];
  let fence: { char: string; len: number; start: number } | null = null;
  let ls = 0;
  while (ls < text.length) {
    const nl = text.indexOf('\n', ls);
    const le = nl === -1 ? text.length : nl; // line content end (exclusive)
    const next = nl === -1 ? text.length : nl + 1; // start of the following line
    const line = text.slice(ls, le).replace(/\r$/, '');
    if (fence !== null) {
      const m = FENCE_RE.exec(line);
      if (m && (m[1] as string)[0] === fence.char && (m[1] as string).length >= fence.len && (m[2] as string).trim() === '') {
        ranges.push([fence.start, next]);
        fence = null;
      }
    } else {
      const m = FENCE_RE.exec(line);
      if (m && !((m[1] as string)[0] === '`' && (m[2] as string).includes('`'))) {
        fence = { char: (m[1] as string)[0] as string, len: (m[1] as string).length, start: ls };
      } else if (BLOCKQUOTE_RE.test(line)) {
        ranges.push([ls, next]);
      } else {
        inlineRanges(text, ls, le, ranges);
      }
    }
    ls = next;
  }
  if (fence !== null) ranges.push([fence.start, text.length]);

  // Merge overlapping or touching ranges, then slice.
  ranges.sort((a, b) => a[0] - b[0] || b[1] - a[1]);
  const merged: Range[] = [];
  for (const r of ranges) {
    const last = merged[merged.length - 1];
    if (last !== undefined && r[0] <= last[1]) last[1] = Math.max(last[1], r[1]);
    else merged.push([r[0], r[1]]);
  }
  const segments: Segment[] = [];
  let pos = 0;
  for (const [s, e] of merged) {
    if (s > pos) segments.push({ protected: false, text: text.slice(pos, s) });
    segments.push({ protected: true, text: text.slice(s, e) });
    pos = e;
  }
  if (pos < text.length) segments.push({ protected: false, text: text.slice(pos) });
  return segments;
}

/** Concatenate segments back into text. */
export function join(segments: readonly Segment[]): string {
  let out = '';
  for (const s of segments) out += s.text;
  return out;
}
