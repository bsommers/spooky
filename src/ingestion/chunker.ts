// Corpus chunker (SRC-02): splits text into overlapping pieces for retrieval. Boundary preference, strongest first:
// paragraph break, sentence end, whitespace, then a hard cut (only when the window holds no break at all, e.g. a
// 5k-character run with no spaces). Pure and deterministic; sizes are in UTF-16 code units (`String.length`) and a hard
// cut never splits a surrogate pair.
//
// Cost: every chunk inspects one window of `size + 1` units, so the whole pass is O(n * size / stride). Nothing
// searches the text outside the current window (a `lastIndexOf` over the full string would be quadratic).
import { ConfigError, InputTooLargeError } from '../models/errors.js';

export interface ChunkOptions {
  /** Maximum chunk length in UTF-16 units. Integer >= 1. A chunk may exceed it by one unit only to keep a surrogate pair whole. */
  size: number;
  /** Units shared by consecutive chunks (aligned to a word start when possible). Integer, 0 <= overlap < size. */
  overlap: number;
  /** Abort with `InputTooLargeError` as soon as more chunks than this have been produced (guards untrusted input). */
  maxChunks?: number;
}

const SENTENCE_END = /[.!?…][)"'”’\]]*(?=\s)|[。！？][)"'”’」』]*/g;

function isSpace(code: number): boolean {
  return (
    (code >= 9 && code <= 13) ||
    code === 32 ||
    code === 0x85 ||
    code === 0xa0 ||
    code === 0x1680 ||
    (code >= 0x2000 && code <= 0x200a) ||
    code === 0x2028 ||
    code === 0x2029 ||
    code === 0x202f ||
    code === 0x205f ||
    code === 0x3000 ||
    code === 0xfeff
  );
}

const isHigh = (code: number): boolean => code >= 0xd800 && code <= 0xdbff;
const isLow = (code: number): boolean => code >= 0xdc00 && code <= 0xdfff;

function skipSpace(t: string, from: number): number {
  let i = from;
  while (i < t.length && isSpace(t.charCodeAt(i))) i++;
  return i;
}

/**
 * Exclusive end of the chunk that starts at `pos`, for text longer than `size` from `pos`. Always `> pos + overlap`,
 * which is what guarantees the next chunk starts strictly after this one did.
 */
function findEnd(t: string, pos: number, size: number, overlap: number): number {
  const win = t.slice(pos, pos + size + 1); // one extra unit: a break right after `size` units is a valid end

  const para = win.lastIndexOf('\n\n');
  if (para > overlap) return pos + para;

  let sentence = -1;
  for (const m of win.matchAll(SENTENCE_END)) {
    const e = (m.index as number) + m[0].length;
    if (e > overlap && e <= size) sentence = e;
  }
  if (sentence > 0) return pos + sentence;

  for (let i = size; i > overlap; i--) {
    if (isSpace(win.charCodeAt(i))) return pos + i;
  }

  // Hard cut. Do not land between the halves of a surrogate pair.
  let cut = size;
  if (isHigh(win.charCodeAt(cut - 1)) && isLow(win.charCodeAt(cut))) cut = cut - 1 > overlap ? cut - 1 : cut + 1;
  return pos + cut;
}

export function chunk(text: string, options: ChunkOptions): string[] {
  const { size, overlap, maxChunks } = options;
  if (typeof text !== 'string') throw new TypeError('chunk: text must be a string');
  if (!Number.isInteger(size) || size < 1) throw new ConfigError(`chunk: size must be an integer >= 1 (got ${String(size)})`);
  if (!Number.isInteger(overlap) || overlap < 0) throw new ConfigError(`chunk: overlap must be an integer >= 0 (got ${String(overlap)})`);
  if (overlap >= size) throw new ConfigError(`chunk: overlap (${overlap}) must be smaller than size (${size})`);
  if (maxChunks !== undefined && (!Number.isInteger(maxChunks) || maxChunks < 1)) {
    throw new ConfigError(`chunk: maxChunks must be an integer >= 1 (got ${String(maxChunks)})`);
  }

  const t = text.includes('\r') ? text.replace(/\r\n?/g, '\n') : text;
  const n = t.length;
  const out: string[] = [];
  let pos = skipSpace(t, 0);
  while (pos < n) {
    const end = n - pos <= size ? n : findEnd(t, pos, size, overlap);
    const piece = t.slice(pos, end).trim();
    if (piece !== '') {
      out.push(piece);
      if (maxChunks !== undefined && out.length > maxChunks) throw new InputTooLargeError(out.length, maxChunks, 'chunks');
    }
    if (end >= n || skipSpace(t, end) >= n) break; // nothing but whitespace left: another chunk would only repeat the overlap

    let next = end - overlap;
    // Begin the overlap at a word start rather than mid-word, when there is a word start before `end`.
    if (next > 0 && !isSpace(t.charCodeAt(next - 1)) && !isSpace(t.charCodeAt(next))) {
      let j = next;
      while (j < end && !isSpace(t.charCodeAt(j))) j++;
      if (j < end) next = j;
    }
    if (next > 0 && next < n && isHigh(t.charCodeAt(next - 1)) && isLow(t.charCodeAt(next))) next++;
    pos = skipSpace(t, Math.max(next, pos + 1));
  }
  return out;
}
